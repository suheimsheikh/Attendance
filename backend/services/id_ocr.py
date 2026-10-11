"""Read the PAN / Aadhaar / passport / birth-certificate number + holder name off an uploaded scan with
Gemini vision (Emergent LLM key). Best-effort: any failure → None, the
upload itself never fails because of OCR (Oct 2026)."""
from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import uuid
from typing import Optional

from emergentintegrations.llm.chat import FileContentWithMimeType, LlmChat, StreamDone, TextDelta, UserMessage

logger = logging.getLogger(__name__)
MODEL = ("gemini", "gemini-3.5-flash")
_PROMPT = {
    "pan": "This is an Indian PAN card scan. Reply ONLY with JSON "
           '{"number": "<10-char PAN, e.g. ABCDE1234F, or null>", "name": "<card holder name or null>", '
           '"father_name": "<father\'s name if printed or null>", '
           '"dob": "<date of birth as YYYY-MM-DD or null>"}.',
    "aadhaar": "This is an Indian Aadhaar card scan (front and/or back). Reply ONLY with JSON "
               '{"number": "<12-digit Aadhaar number, digits only, or null>", "name": "<card holder name or null>", '
               '"father_name": "<father\'s / guardian name if printed (often after S/O or C/O) or null>", '
               '"dob": "<full date of birth as YYYY-MM-DD, or null if only a year of birth is printed>"}.',
    "passport": "This is a passport scan (data page, read the bottom father/mother fields too). Reply ONLY with JSON "
                '{"number": "<passport number, letters/digits only, or null>", "surname": "<Surname field exactly as printed or null>", '
                '"given_names": "<Given name(s) field exactly as printed or null>", "expiry": "<Date of expiry as YYYY-MM-DD or null>", '
                '"father_name": "<Name of Father exactly as printed or null>", "mother_name": "<Name of Mother exactly as printed or null>", '
                '"dob": "<Date of birth as YYYY-MM-DD or null>"}.',
    "birth": "This is a birth certificate. Reply ONLY with JSON "
             '{"number": "<registration / certificate number or null>", "name": "<name of the CHILD (not the parents) exactly as printed, or null>", '
             '"father_name": "<father\'s name exactly as printed or null>", "mother_name": "<mother\'s name exactly as printed or null>", '
             '"dob": "<date of birth as YYYY-MM-DD or null>"}.',
    "marksheet": "This is a school / college / exam marksheet or report card. Reply ONLY with JSON "
                 '{"name": "<student name exactly as printed, or null>", "exam_name": "<exam name, e.g. SSC Class X Board Exam, or null>", '
                 '"month": <exam month 1-12 or null>, "year": <exam year as 4 digits or null>, '
                 '"board": "<board / university / school name or null>", "result": "<overall percentage, CGPA or grade as printed, or null>"}.',
    "auto": "This is a scan of an Indian PAN card, Aadhaar card, a passport data page or a birth certificate. Reply ONLY with JSON "
            '{"type": "pan" | "aadhaar" | "passport" | "birth" | null, "number": "<PAN like ABCDE1234F, 12-digit Aadhaar digits only, '
            'passport number, or birth registration number; null if unreadable>", "name": "<holder name (for a birth certificate: the child) or null>", '
            '"surname": "<passport Surname or null>", "given_names": "<passport Given name(s) or null>", '
            '"expiry": "<passport Date of expiry YYYY-MM-DD or null>", "dob": "<holder\'s full date of birth YYYY-MM-DD or null>"}.',
}
_EXT = {"application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}


def _parse(text: str) -> dict:
    m = re.search(r"\{.*\}", text or "", re.S)
    return json.loads(m.group(0)) if m else {}


def _clean_number(card: str, raw) -> Optional[str]:
    if card == "birth":
        v = " ".join(str(raw or "").split()).upper()
        return v[:40] if v and v != "NULL" else None
    if card == "passport":
        v = re.sub(r"[^A-Za-z0-9]", "", str(raw or "")).upper()
        return v if re.fullmatch(r"[A-Z0-9]{6,9}", v) else None
    if card == "pan":
        v = re.sub(r"[^A-Za-z0-9]", "", str(raw or "")).upper()
        return v if re.fullmatch(r"[A-Z]{5}[0-9]{4}[A-Z]", v) else None
    v = re.sub(r"\D", "", str(raw or ""))
    return v if len(v) == 12 else None


def name_score(card_name: Optional[str], expected: Optional[str]) -> float:
    """Share of the card's 3+ letter words found in `expected` (0..1)."""
    words = lambda s: {w for w in re.findall(r"[a-z]+", (s or "").lower()) if len(w) >= 3}
    a, b = words(card_name), words(expected)
    squash = lambda x: re.sub(r"[^a-z]", "", (x or "").lower())
    ca, cb = squash(card_name), squash(expected)
    if len(ca) >= 6 and len(cb) >= 6 and (ca in cb or cb in ca):  # OCR sometimes drops spaces
        return 1.0
    return len(a & b) / len(a) if a and b else 0.0


def _norm(s: Optional[str]) -> str:
    return " ".join((s or "").upper().split())


def name_exact(card_name: Optional[str], expected: Optional[str]) -> Optional[bool]:
    """Passport rule (user, Oct 2026): same words in the same order; only case/spacing ignored."""
    return None if not _norm(card_name) or not _norm(expected) else _norm(card_name) == _norm(expected)


def _name_tokens(s: Optional[str]) -> list:
    return [t for t in re.sub(r"[^A-Za-z ]", " ", (s or "")).upper().split() if t]


def _tok_eq(a: str, b: str) -> bool:
    """Two name words match if equal, or one is a single-letter initial of the other."""
    return a == b or (len(a) == 1 and b.startswith(a)) or (len(b) == 1 and a.startswith(b))


def name_match_status(card_name: Optional[str], expected: Optional[str]) -> Optional[str]:
    """Order-independent name check (user, Jun 2026). Returns:
        'exact'    — same words (any order), nothing extra
        'close'    — matches but with an extra/missing middle name or an initial
        'mismatch' — a core word on the smaller name has no counterpart (reject)
        None       — either side blank / unreadable (can't judge)
    """
    ca, cb = _name_tokens(card_name), _name_tokens(expected)
    if not ca or not cb:
        return None
    small, large = (ca, cb) if len(ca) <= len(cb) else (cb, ca)
    used = [False] * len(large)
    for t in small:
        hit = next((i for i, u in enumerate(large) if not used[i] and u == t), -1)
        if hit < 0:
            hit = next((i for i, u in enumerate(large) if not used[i] and _tok_eq(t, u)), -1)
        if hit < 0:
            return "mismatch"
        used[hit] = True
    return "exact" if len(ca) == len(cb) and sorted(ca) == sorted(cb) else "close"


def name_matches(card_name: Optional[str], expected: Optional[str]) -> Optional[bool]:
    """Loose check: any shared word of 3+ letters. None when either side is blank."""
    words = lambda s: {w for w in re.findall(r"[a-z]+", (s or "").lower()) if len(w) >= 3}
    a, b = words(card_name), words(expected)
    return None if not a or not b else bool(a & b)


async def _ask(path: str, content_type: str, card: str) -> str:
    chat = LlmChat(api_key=os.environ["EMERGENT_LLM_KEY"], session_id=f"idocr-{uuid.uuid4().hex}",
                   system_message="You read Indian ID cards, certificates and marksheets and reply with JSON only.").with_model(*MODEL)
    text = ""
    msg = UserMessage(text=_PROMPT[card], file_contents=[FileContentWithMimeType(file_path=path, mime_type=content_type)])
    async for ev in chat.stream_message(msg):
        if isinstance(ev, TextDelta):
            text += ev.content
        elif isinstance(ev, StreamDone):
            break
    return text


async def read_id_card(data: bytes, content_type: str, card: str) -> Optional[dict]:
    path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=_EXT.get(content_type, ""), delete=False) as f:
            f.write(data)
            path = f.name
        out = {}
        for attempt in (1, 2):  # one retry: upstream LLM errors are usually transient
            try:
                out = _parse(await _ask(path, content_type, card))
                break
            except Exception:
                if attempt == 2:
                    raise
                logger.warning("ID OCR attempt 1 failed (%s) — retrying", card)
        kind = card if card != "auto" else (out.get("type") if out.get("type") in ("pan", "aadhaar", "passport", "birth") else None)
        name = (out.get("name") or "").strip() or None
        res = {"type": kind, "number": _clean_number(kind, out.get("number")) if kind else None, "name": name}
        if kind in ("pan", "aadhaar", "passport", "birth"):
            res["father_name"] = (out.get("father_name") or "").strip() or None
            res["mother_name"] = (out.get("mother_name") or "").strip() or None
        if kind == "passport":
            # Database names are "Given Surname", so compare in that order.
            given, sur = (out.get("given_names") or "").strip(), (out.get("surname") or "").strip()
            res["name"] = " ".join(x for x in (given, sur) if x) or name
            exp = str(out.get("expiry") or "")
            res["expiry"] = exp if re.fullmatch(r"\d{4}-\d{2}-\d{2}", exp) else None
        if kind:
            dob = str(out.get("dob") or "")
            res["dob"] = dob if re.fullmatch(r"\d{4}-\d{2}-\d{2}", dob) else None
        return res
    except Exception:
        logger.exception("ID OCR failed (%s)", card)
        return None
    finally:
        if path:
            os.unlink(path)


async def read_marksheet(data: bytes, content_type: str) -> Optional[dict]:
    """Best-effort read of a marksheet; None when the AI can't be reached."""
    path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=_EXT.get(content_type, ""), delete=False) as f:
            f.write(data)
            path = f.name
        out = _parse(await _ask(path, content_type, "marksheet"))
    except Exception:
        logger.warning("Marksheet OCR failed", exc_info=True)
        return None
    finally:
        if path:
            os.unlink(path)
    txt = lambda k, n: (" ".join(str(out.get(k) or "").split())[:n] or None) if str(out.get(k) or "").lower() != "null" else None
    num = lambda k: int(out[k]) if str(out.get(k) or "").isdigit() else None
    month, year = num("month"), num("year")
    return {"name": txt("name", 120), "exam_name": txt("exam_name", 120), "board": txt("board", 120),
            "result": txt("result", 40), "month": month if month and 1 <= month <= 12 else None,
            "year": year if year and 1980 <= year <= 2100 else None}
