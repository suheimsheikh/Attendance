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
import random
from datetime import date, datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["daily-content"])


# ---------------------------------------------------------------------------
# Static fallback pool — used when LLM is unreachable or rate-limited.
# Keeps the UI useful even if the AI service is down.
# ---------------------------------------------------------------------------
FALLBACK_QUOTES = [
    {"en": "Smooth seas do not make skillful sailors.",
     "te": "ప్రశాంతమైన సముద్రాలు నేర్పుగల నావికులను తయారు చేయవు.",
     "author": "African proverb"},
    {"en": "Show up. Show up. Show up. After a while the muse shows up too.",
     "te": "హాజరవ్వండి. హాజరవ్వండి. హాజరవ్వండి. కొంత కాలానికి స్ఫూర్తి కూడా హాజరవుతుంది.",
     "author": "Isabel Allende"},
    {"en": "Discipline is choosing between what you want now and what you want most.",
     "te": "క్రమశిక్షణ అంటే ఇప్పుడు కావాల్సినదానికీ చివరికి కావాల్సినదానికీ మధ్య ఎంపిక చేసుకోవడం.",
     "author": "Abraham Lincoln"},
    {"en": "Adapt your sails to the winds you meet, never the other way around.",
     "te": "ఎదురయ్యే గాలులకు మీ తెరచాపలను సర్దుబాటు చేయండి — గాలులు మిమ్మల్ని కాదు.",
     "author": "Yacht Club of Hyderabad"},
    {"en": "Energy and persistence conquer all things.",
     "te": "శక్తీ, పట్టుదలా అన్నింటినీ జయిస్తాయి.",
     "author": "Benjamin Franklin"},
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


def _today_str() -> str:
    return date.today().isoformat()


def _kind_for(d: date) -> str:
    # Odd ordinal → 'word'; even ordinal → 'quote'. Stable alternation
    # without any client coordination.
    return "word" if (d.toordinal() % 2 == 1) else "quote"


# ---------------------------------------------------------------------------
# LLM call — Gemini via Emergent universal key. Single short request.
# ---------------------------------------------------------------------------
async def _generate_quote_with_llm() -> Optional[Dict[str, Any]]:
    key = os.environ.get("EMERGENT_LLM_KEY")
    if not key:
        return None
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
    except Exception as exc:  # pragma: no cover - import guard
        logger.warning("emergentintegrations not available: %s", exc)
        return None

    system = (
        "You write short bilingual motivational quotes for a competitive youth "
        "sailing academy in Hyderabad, India. Audience: athletes aged 10-25, "
        "their coaches, and admin staff. Tone: simple, energetic, encouraging. "
        "Sailing / sports / discipline / showing-up themes preferred but not required."
    )
    prompt = (
        "Reply with ONLY a JSON object (no markdown, no commentary) with these keys:\n"
        "  en       — string, the quote in English (max 15 words)\n"
        "  te       — string, the same quote translated to Telugu (script తెలుగు)\n"
        "  author   — string, attribution (real author or 'Yacht Club of Hyderabad' if you wrote it)\n"
        "Be specific — avoid generic clichés. No quotes around the values inside the JSON values themselves."
    )
    try:
        chat = LlmChat(
            api_key=key,
            session_id=f"daily-quote-{_today_str()}",
            system_message=system,
        ).with_model("gemini", "gemini-3.1-pro-preview")
        text = await chat.send_message(UserMessage(text=prompt))
        return _parse_json(text)
    except Exception as exc:
        logger.exception("Gemini quote generation failed: %s", exc)
        return None


async def _generate_word_with_llm() -> Optional[Dict[str, Any]]:
    key = os.environ.get("EMERGENT_LLM_KEY")
    if not key:
        return None
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage
    except Exception as exc:  # pragma: no cover
        logger.warning("emergentintegrations not available: %s", exc)
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
            session_id=f"daily-word-{_today_str()}",
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


# ---------------------------------------------------------------------------
# Public route
# ---------------------------------------------------------------------------
def make_router(db) -> APIRouter:
    """Bind the route to a Motor `db` and return the router for inclusion."""

    @router.get("/daily-content")
    async def daily_content():
        today = _today_str()
        kind = _kind_for(date.today())
        cached = await db.daily_content.find_one({"date": today, "kind": kind}, {"_id": 0})
        if cached:
            return cached

        # Cache miss → call Gemini.
        generated: Optional[Dict[str, Any]] = None
        source = "llm"
        try:
            generated = (
                await _generate_word_with_llm() if kind == "word"
                else await _generate_quote_with_llm()
            )
        except Exception as exc:  # defensive: should be caught inside helpers
            logger.exception("daily-content LLM dispatch failed: %s", exc)

        # Validate shape — fall back if malformed.
        if not (
            isinstance(generated, dict)
            and isinstance(generated.get("en"), str)
            and isinstance(generated.get("te"), str)
            and generated["en"].strip() and generated["te"].strip()
        ):
            generated = None

        if not generated:
            source = "fallback"
            pool = FALLBACK_WORDS if kind == "word" else FALLBACK_QUOTES
            # Deterministic-per-day fallback so users don't see two different
            # fallback items if they refresh.
            generated = dict(pool[date.today().toordinal() % len(pool)])

        doc = {
            "date": today,
            "kind": kind,
            "en": generated["en"].strip(),
            "te": generated["te"].strip(),
            "source": source,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        if kind == "word":
            for k in ("example_en", "example_te"):
                if isinstance(generated.get(k), str) and generated[k].strip():
                    doc[k] = generated[k].strip()
        else:
            if isinstance(generated.get("author"), str) and generated["author"].strip():
                doc["author"] = generated["author"].strip()

        try:
            await db.daily_content.update_one(
                {"date": today, "kind": kind},
                {"$set": doc},
                upsert=True,
            )
        except Exception as exc:
            # Don't fail the request just because cache write blew up.
            logger.warning("daily_content cache write failed: %s", exc)

        return doc

    return router
