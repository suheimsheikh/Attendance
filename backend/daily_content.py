"""
Bilingual daily content (motivational quote OR English-Telugu word-of-the-day)
generated once a day with Gemini via the Emergent universal LLM key and cached
in MongoDB so each day's content is only generated once across all users.

Endpoint: GET /api/daily-content
Returns: {date, kind: 'quote'|'word', en, te, author?, example_en?, example_te?, source}

Kind selection — odd ordinal day → 'word', even ordinal day → 'quote'. This
gives a stable alternating cadence without any client coordination.

Falls back to a curated static pool on LLM failure so the UI never breaks.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import date, datetime, timezone
from typing import Any, Dict, Optional
from zoneinfo import ZoneInfo

from fastapi import APIRouter

try:
    # Top-level import keeps the LLM SDK out of the request hot-path. Falling
    # back gracefully — if the SDK isn't installed the endpoint still returns
    # the static fallback pool.
    from emergentintegrations.llm.chat import LlmChat, UserMessage  # type: ignore
    _LLM_AVAILABLE = True
except Exception:  # pragma: no cover
    LlmChat = None  # type: ignore
    UserMessage = None  # type: ignore
    _LLM_AVAILABLE = False

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["daily-content"])

# Default office tz — matches server.py's DEFAULT_TZ. We read the real timezone
# from the office config doc per-request so academies in other cities work too.
DEFAULT_TZ = "Asia/Kolkata"


# ---------------------------------------------------------------------------
# Static fallback pool — used when LLM is unreachable or rate-limited.
# Keeps the UI useful even if the AI service is down.
#
# Curated to be simple + powerful — action-oriented wisdom about showing up,
# discipline, and daily habits. Broader than just sailing so it resonates
# with athletes, coaches, support staff and parents alike.
# ---------------------------------------------------------------------------
FALLBACK_QUOTES = [
    {"en": "Show up. Show up. Show up. After a while the muse shows up too.",
     "te": "హాజరవ్వండి. హాజరవ్వండి. హాజరవ్వండి. కొంత కాలానికి స్ఫూర్తి కూడా హాజరవుతుంది.",
     "author": "Isabel Allende"},
    {"en": "Discipline equals freedom.",
     "te": "క్రమశిక్షణే స్వేచ్ఛ.",
     "author": "Jocko Willink"},
    {"en": "Discipline is choosing between what you want now and what you want most.",
     "te": "క్రమశిక్షణ అంటే ఇప్పుడు కావాల్సినదానికీ చివరికి కావాల్సినదానికీ మధ్య ఎంపిక చేసుకోవడం.",
     "author": "Abraham Lincoln"},
    {"en": "Energy and persistence conquer all things.",
     "te": "శక్తీ, పట్టుదలా అన్నింటినీ జయిస్తాయి.",
     "author": "Benjamin Franklin"},
    {"en": "The secret of getting ahead is getting started.",
     "te": "ముందుకు సాగడానికి రహస్యం — మొదలుపెట్టడమే.",
     "author": "Mark Twain"},
    {"en": "Small daily improvements are the key to staggering long-term results.",
     "te": "ప్రతిరోజూ చేసే చిన్న మెరుగుదలలే దీర్ఘకాలంలో అద్భుత ఫలితాలను తెస్తాయి.",
     "author": "Robin Sharma"},
    {"en": "You don't have to be great to start, but you have to start to be great.",
     "te": "మొదలుపెట్టడానికి గొప్పగా ఉండాల్సిన అవసరం లేదు, కానీ గొప్పగా ఉండాలంటే మొదలుపెట్టాలి.",
     "author": "Zig Ziglar"},
    {"en": "Do something today that your future self will thank you for.",
     "te": "మీ భవిష్యత్ స్వరూపం మీకు కృతజ్ఞతలు చెప్పేలా ఈ రోజే ఏదైనా చేయండి.",
     "author": "Sean Patrick Flanery"},
    {"en": "You don't rise to the level of your goals. You fall to the level of your systems.",
     "te": "మీరు మీ లక్ష్యాల స్థాయికి ఎదగరు — మీ అలవాట్ల స్థాయికి దిగిపోతారు.",
     "author": "James Clear"},
    {"en": "Smooth seas do not make skillful sailors.",
     "te": "ప్రశాంతమైన సముద్రాలు నేర్పుగల నావికులను తయారు చేయవు.",
     "author": "African proverb"},
]

FALLBACK_WORDS = [
    {"en": "Persevere", "te": "పట్టుదలతో ఉండు",
     "example_en": "Champions persevere when others give up.",
     "example_te": "ఇతరులు వదిలేసినప్పుడు ఛాంపియన్లు పట్టుదలతో ఉంటారు."},
    {"en": "Discipline", "te": "క్రమశిక్షణ",
     "example_en": "Discipline beats motivation on hard days.",
     "example_te": "కష్టమైన రోజులలో క్రమశిక్షణ ప్రేరణను మించిపోతుంది."},
    {"en": "Resilient", "te": "నిలబడే శక్తి కలవాడు",
     "example_en": "A resilient sailor handles rough seas calmly.",
     "example_te": "నిలబడే శక్తి కలిగిన నావికుడు తీవ్రమైన అలలను శాంతంగా ఎదుర్కొంటాడు."},
    {"en": "Courage", "te": "ధైర్యం",
     "example_en": "Courage is being scared and showing up anyway.",
     "example_te": "ధైర్యం అంటే భయపడుతూ కూడా హాజరవ్వడం."},
    {"en": "Focus", "te": "ఏకాగ్రత",
     "example_en": "Focus turns talent into results.",
     "example_te": "ఏకాగ్రత ప్రతిభను ఫలితంగా మారుస్తుంది."},
]


def _office_today(office: Optional[dict]) -> date:
    """Calendar date in the office's local timezone — so the daily content
    flips at office midnight (not at server-host UTC midnight)."""
    tz_name = (office or {}).get("timezone") or DEFAULT_TZ
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = ZoneInfo(DEFAULT_TZ)
    return datetime.now(tz).date()


def _today_str(office: Optional[dict] = None) -> str:
    return _office_today(office).isoformat()


def _kind_for(d: date) -> str:
    # Odd ordinal → 'word'; even ordinal → 'quote'. Stable alternation
    # without any client coordination.
    return "word" if (d.toordinal() % 2 == 1) else "quote"


# ---------------------------------------------------------------------------
# LLM call — Gemini via Emergent universal key. Single short request.
# ---------------------------------------------------------------------------
async def _generate_quote_with_llm(today: str) -> Optional[Dict[str, Any]]:
    key = os.environ.get("EMERGENT_LLM_KEY")
    if not key or not _LLM_AVAILABLE:
        return None

    system = (
        "You write short bilingual motivational quotes for a youth academy "
        "in Hyderabad, India. Audience: athletes (10-25), their coaches, "
        "and admin staff. Tone: simple, powerful, energetic, encouraging. "
        "Themes welcome: discipline, showing up, daily habits, perseverance, "
        "growth, focus. Broader life wisdom is preferred over nautical "
        "clichés — keep it universal, not sailing-specific."
    )
    prompt = (
        "Reply with ONLY a JSON object (no markdown, no commentary) with these keys:\n"
        "  en       — string, the quote in English (max 15 words, prefer 8-12)\n"
        "  te       — string, the same quote translated to Telugu (script తెలుగు)\n"
        "  author   — string, attribution (real author, public-domain proverb, or 'Yacht Club of Hyderabad' if you wrote it)\n"
        "Be specific and punchy — avoid generic clichés and avoid sailing/sea/wind metaphors unless they are genuinely fresh."
    )
    try:
        chat = LlmChat(
            api_key=key,
            session_id=f"daily-quote-{today}",
            system_message=system,
        ).with_model("gemini", "gemini-3.1-pro-preview")
        text = await chat.send_message(UserMessage(text=prompt))
        return _parse_json(text)
    except Exception as exc:
        logger.exception("Gemini quote generation failed: %s", exc)
        return None


async def _generate_word_with_llm(today: str) -> Optional[Dict[str, Any]]:
    key = os.environ.get("EMERGENT_LLM_KEY")
    if not key or not _LLM_AVAILABLE:
        return None

    system = (
        "You teach English vocabulary to native Telugu-speaking youth (ages 10-25) "
        "at a sailing academy in Hyderabad. Pick ONE useful, day-to-day English word "
        "they may not know yet — useful in sports, school, or daily life. Avoid "
        "very basic words (cat, dog, run) and avoid obscure SAT-prep words."
    )
    prompt = (
        "Reply with ONLY a JSON object (no markdown, no commentary) with these keys:\n"
        "  en          — string, the English word in lowercase (1-2 words max)\n"
        "  te          — string, its Telugu translation (script తెలుగు)\n"
        "  example_en  — string, a short example sentence using the word (max 12 words)\n"
        "  example_te  — string, that sentence translated to Telugu\n"
        "Pick something genuinely useful and a bit interesting."
    )
    try:
        chat = LlmChat(
            api_key=key,
            session_id=f"daily-word-{today}",
            system_message=system,
        ).with_model("gemini", "gemini-3.1-pro-preview")
        text = await chat.send_message(UserMessage(text=prompt))
        return _parse_json(text)
    except Exception as exc:
        logger.exception("Gemini word generation failed: %s", exc)
        return None


def _parse_json(text: str) -> Optional[Dict[str, Any]]:
    if not text:
        return None
    s = text.strip()
    # Strip markdown fences if the model emits any
    if s.startswith("```"):
        s = s.strip("`")
        # remove any leading "json"
        if s.lower().startswith("json"):
            s = s[4:].strip()
    # Extract the first {...} blob if there's extra prose
    start = s.find("{")
    end = s.rfind("}")
    if start != -1 and end != -1 and end > start:
        s = s[start:end + 1]
    try:
        return json.loads(s)
    except Exception as exc:
        logger.warning("Failed to parse LLM JSON: %s · raw=%r", exc, text[:200])
        return None


def _is_valid_generated(generated: Any) -> bool:
    """Shape guard for the LLM output. Requires a dict with non-empty
    `en` and `te` string keys — everything else is optional per-kind."""
    return (
        isinstance(generated, dict)
        and isinstance(generated.get("en"), str)
        and isinstance(generated.get("te"), str)
        and bool(generated["en"].strip())
        and bool(generated["te"].strip())
    )


async def _generate_or_fallback(today_date: date, today_iso: str, kind: str) -> tuple[Dict[str, Any], str]:
    """Call Gemini for today's content, validate the shape, and fall back
    to the curated static pool on failure. Returns `(payload, source)`
    where source is either `"llm"` or `"fallback"`."""
    generated: Optional[Dict[str, Any]] = None
    try:
        generated = (
            await _generate_word_with_llm(today_iso) if kind == "word"
            else await _generate_quote_with_llm(today_iso)
        )
    except Exception as exc:  # defensive: should be caught inside helpers
        logger.exception("daily-content LLM dispatch failed: %s", exc)

    if _is_valid_generated(generated):
        return generated, "llm"  # type: ignore[return-value]

    # Deterministic-per-day fallback so users don't see two different
    # items if they refresh on the same day.
    pool = FALLBACK_WORDS if kind == "word" else FALLBACK_QUOTES
    return dict(pool[today_date.toordinal() % len(pool)]), "fallback"


def _build_doc(today_iso: str, kind: str, generated: Dict[str, Any], source: str) -> Dict[str, Any]:
    """Assemble the persisted document from the generated payload. Copies
    the shared `en`/`te` pair plus the kind-specific optional fields
    (example_* for words, author for quotes)."""
    doc: Dict[str, Any] = {
        "date": today_iso,
        "kind": kind,
        "en": generated["en"].strip(),
        "te": generated["te"].strip(),
        "source": source,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    if kind == "word":
        for k in ("example_en", "example_te"):
            v = generated.get(k)
            if isinstance(v, str) and v.strip():
                doc[k] = v.strip()
    else:
        author = generated.get("author")
        if isinstance(author, str) and author.strip():
            doc["author"] = author.strip()
    return doc


async def _cache_daily_content(db, doc: Dict[str, Any]) -> None:
    """Best-effort cache write. A failure here (e.g. Mongo hiccup)
    must NOT fail the request — the client already has the payload."""
    try:
        await db.daily_content.update_one(
            {"date": doc["date"], "kind": doc["kind"]},
            {"$set": doc},
            upsert=True,
        )
    except Exception as exc:
        logger.warning("daily_content cache write failed: %s", exc)


# ---------------------------------------------------------------------------
# Public route
# ---------------------------------------------------------------------------
def make_router(db) -> APIRouter:
    """Bind the route to a Motor `db` and return the router for inclusion."""

    @router.get("/daily-content")
    async def daily_content():
        # Use the office's local date so the quote/word flips at office
        # midnight (e.g. 00:00 IST) — not when the server-host UTC day rolls.
        office = await db.config.find_one({"id": "office"}, {"_id": 0, "timezone": 1})
        today_date = _office_today(office)
        today = today_date.isoformat()
        kind = _kind_for(today_date)

        cached = await db.daily_content.find_one({"date": today, "kind": kind}, {"_id": 0})
        if cached:
            return cached

        generated, source = await _generate_or_fallback(today_date, today, kind)
        doc = _build_doc(today, kind, generated, source)
        await _cache_daily_content(db, doc)
        return doc

    return router

