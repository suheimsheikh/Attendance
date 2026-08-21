"""
Unit tests for the daily-content helpers extracted from the
`GET /api/daily-content` route (Feb 2026 complexity refactor).

Covers the pure-python parts: shape validation, doc assembly, and the
LLM-vs-fallback selection with the deterministic per-day pool index.
The DB write and Gemini call are stubbed — those live behind the
`_cache_daily_content` and `_generate_or_fallback` boundaries.

Behaviour-locks the pre-refactor semantics so a future edit that
regresses field-stripping or the fallback determinism trips CI.
"""
from __future__ import annotations

import asyncio
from datetime import date, datetime
from unittest.mock import AsyncMock

import pytest

import daily_content as dc


def _run(coro):
    """Small helper to run an async coroutine in a sync pytest test —
    the project doesn't ship pytest-asyncio, and these helpers only
    need a one-off event loop each."""
    return asyncio.run(coro)


# ── _is_valid_generated ──────────────────────────────────────────────
def test_valid_generated_requires_both_en_and_te_strings():
    assert dc._is_valid_generated({"en": "Hello", "te": "నమస్తే"})
    assert not dc._is_valid_generated({"en": "Hello"})           # missing te
    assert not dc._is_valid_generated({"en": "", "te": "నమస్తే"})  # empty en
    assert not dc._is_valid_generated({"en": "   ", "te": "నమస్తే"})  # whitespace-only
    assert not dc._is_valid_generated({"en": 42, "te": "నమస్తే"})  # wrong type
    assert not dc._is_valid_generated(None)
    assert not dc._is_valid_generated("not a dict")


# ── _build_doc ───────────────────────────────────────────────────────
def test_build_doc_word_kind_strips_and_keeps_examples():
    doc = dc._build_doc(
        "2026-02-14", "word",
        {"en": "  courage  ", "te": " ధైర్యం ",
         "example_en": " Show courage.", "example_te": "ధైర్యం చూపండి.",
         "author": "should be ignored for word"},   # noise
        "llm",
    )
    assert doc["date"] == "2026-02-14"
    assert doc["kind"] == "word"
    assert doc["en"] == "courage"
    assert doc["te"] == "ధైర్యం"
    assert doc["example_en"] == "Show courage."
    assert doc["example_te"] == "ధైర్యం చూపండి."
    assert "author" not in doc
    assert doc["source"] == "llm"
    # generated_at is set to a valid ISO string
    datetime.fromisoformat(doc["generated_at"].replace("Z", "+00:00"))


def test_build_doc_word_kind_omits_empty_examples():
    doc = dc._build_doc(
        "2026-02-14", "word",
        {"en": "grit", "te": "సహనం",
         "example_en": "   ",       # whitespace → omitted
         "example_te": None},        # not a str → omitted
        "fallback",
    )
    assert "example_en" not in doc
    assert "example_te" not in doc
    assert doc["source"] == "fallback"


def test_build_doc_quote_kind_keeps_author_ignores_examples():
    doc = dc._build_doc(
        "2026-02-15", "quote",
        {"en": "Be kind.", "te": "దయగా ఉండండి.",
         "author": "  Aesop  ",
         "example_en": "should be ignored for quote"},   # noise
        "llm",
    )
    assert doc["kind"] == "quote"
    assert doc["author"] == "Aesop"
    assert "example_en" not in doc
    assert "example_te" not in doc


def test_build_doc_quote_kind_omits_blank_author():
    doc = dc._build_doc(
        "2026-02-15", "quote",
        {"en": "Truth wins.", "te": "సత్యం గెలుస్తుంది.", "author": "  "},
        "fallback",
    )
    assert "author" not in doc


# ── _generate_or_fallback ────────────────────────────────────────────
def test_generate_or_fallback_uses_llm_when_output_valid(monkeypatch):
    """Happy path — Gemini returns a well-shaped dict, source=='llm'."""
    async def fake_word(_iso):
        return {"en": "grit", "te": "పట్టుదల"}
    monkeypatch.setattr(dc, "_generate_word_with_llm", fake_word)

    payload, source = _run(dc._generate_or_fallback(
        date(2026, 2, 14), "2026-02-14", "word"
    ))
    assert source == "llm"
    assert payload["en"] == "grit"


def test_generate_or_fallback_falls_back_when_llm_raises(monkeypatch):
    """Any exception from the LLM → fallback pool, source=='fallback'."""
    async def boom(_iso):
        raise RuntimeError("gemini down")
    monkeypatch.setattr(dc, "_generate_quote_with_llm", boom)

    payload, source = _run(dc._generate_or_fallback(
        date(2026, 2, 14), "2026-02-14", "quote"
    ))
    assert source == "fallback"
    assert payload["en"] and payload["te"]


def test_generate_or_fallback_falls_back_on_malformed_output(monkeypatch):
    """Wrong-shape LLM output (missing te) → falls back silently."""
    async def bad_shape(_iso):
        return {"en": "ok but no te"}
    monkeypatch.setattr(dc, "_generate_word_with_llm", bad_shape)

    payload, source = _run(dc._generate_or_fallback(
        date(2026, 2, 14), "2026-02-14", "word"
    ))
    assert source == "fallback"


def test_fallback_is_deterministic_per_day(monkeypatch):
    """Same date → same fallback item so a user refreshing doesn't
    see two different quotes."""
    async def boom(_iso):
        raise RuntimeError("boom")
    monkeypatch.setattr(dc, "_generate_quote_with_llm", boom)

    d = date(2026, 5, 20)
    a, _ = _run(dc._generate_or_fallback(d, d.isoformat(), "quote"))
    b, _ = _run(dc._generate_or_fallback(d, d.isoformat(), "quote"))
    assert a == b


# ── _cache_daily_content ─────────────────────────────────────────────
def test_cache_write_swallows_db_errors():
    """A cache-write failure must NOT propagate — the client already
    has the payload; a warning is enough."""
    db = type("DB", (), {})()
    db.daily_content = type("Coll", (), {})()
    db.daily_content.update_one = AsyncMock(side_effect=RuntimeError("mongo hiccup"))
    # Should NOT raise.
    _run(dc._cache_daily_content(db, {"date": "2026-02-14", "kind": "word"}))


def test_cache_write_upserts_with_correct_filter():
    """Verify the (date, kind) filter is what upserts against — protects
    the composite-key contract that avoids double-writes per day."""
    db = type("DB", (), {})()
    db.daily_content = type("Coll", (), {})()
    db.daily_content.update_one = AsyncMock(return_value=None)
    doc = {"date": "2026-02-14", "kind": "quote", "en": "x", "te": "y",
           "source": "llm", "generated_at": "2026-02-14T00:00:00Z"}
    _run(dc._cache_daily_content(db, doc))
    db.daily_content.update_one.assert_awaited_once()
    args, kwargs = db.daily_content.update_one.call_args
    assert args[0] == {"date": "2026-02-14", "kind": "quote"}
    assert args[1] == {"$set": doc}
    assert kwargs.get("upsert") is True
