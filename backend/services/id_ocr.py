"""Read the PAN / Aadhaar number + holder name off an uploaded scan with
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
           '{"number": "<10-char PAN, e.g. ABCDE1234F, or null>", "name": "<card holder name or null>"}.',
    "aadhaar": "This is an Indian Aadhaar card scan (front and/or back). Reply ONLY with JSON "
               '{"number": "<12-digit Aadhaar number, digits only, or null>", "name": "<card holder name or null>"}.',
}
_EXT = {"application/pdf": ".pdf", "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}


def _parse(text: str) -> dict:
    m = re.search(r"\{.*\}", text or "", re.S)
    return json.loads(m.group(0)) if m else {}


def _clean_number(card: str, raw) -> Optional[str]:
    if card == "pan":
        v = re.sub(r"[^A-Za-z0-9]", "", str(raw or "")).upper()
        return v if re.fullmatch(r"[A-Z]{5}[0-9]{4}[A-Z]", v) else None
    v = re.sub(r"\D", "", str(raw or ""))
    return v if len(v) == 12 else None


def name_matches(card_name: Optional[str], expected: Optional[str]) -> Optional[bool]:
    """Loose check: any shared word of 3+ letters. None when either side is blank."""
    words = lambda s: {w for w in re.findall(r"[a-z]+", (s or "").lower()) if len(w) >= 3}
    a, b = words(card_name), words(expected)
    return None if not a or not b else bool(a & b)


async def read_id_card(data: bytes, content_type: str, card: str) -> Optional[dict]:
    path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=_EXT.get(content_type, ""), delete=False) as f:
            f.write(data)
            path = f.name
        chat = LlmChat(api_key=os.environ["EMERGENT_LLM_KEY"], session_id=f"idocr-{uuid.uuid4().hex}",
                       system_message="You read Indian ID cards and reply with JSON only.").with_model(*MODEL)
        text = ""
        msg = UserMessage(text=_PROMPT[card], file_contents=[FileContentWithMimeType(file_path=path, mime_type=content_type)])
        async for ev in chat.stream_message(msg):
            if isinstance(ev, TextDelta):
                text += ev.content
            elif isinstance(ev, StreamDone):
                break
        out = _parse(text)
        return {"number": _clean_number(card, out.get("number")), "name": (out.get("name") or "").strip() or None}
    except Exception:
        logger.exception("ID OCR failed (%s)", card)
        return None
    finally:
        if path:
            os.unlink(path)
