"""External (server-to-server) read-only API.

Exposes a small set of endpoints that a sibling application ("YCH
Inventory") can hit to pull events (regattas) and camps from this app.
Guarded by a simple `X-API-Key` header check against the
`EXTERNAL_API_KEY` env variable — kept intentionally minimal because
it's a service-to-service integration, not a user-facing endpoint. If
the env var is unset the whole surface returns 503 so this can't
silently accept requests on a mis-configured deployment.

Added Feb 2026 in response to a cross-app data-share request. Read-only
by design — no writes, no auth-token issuance, no personal data.
"""
from __future__ import annotations

import os
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, HTTPException


def _require_external_key(x_api_key: Optional[str] = Header(default=None)) -> None:
    """Header-based API-key gate. Returns 401 on mismatch, 503 if the
    server has no key configured — a mis-configured server should NOT
    behave like an open endpoint."""
    expected = os.environ.get("EXTERNAL_API_KEY", "").strip()
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="External API disabled: EXTERNAL_API_KEY not configured on server",
        )
    supplied = (x_api_key or "").strip()
    if not supplied or supplied != expected:
        raise HTTPException(status_code=401, detail="Invalid API key")


def _clean(value):
    """Empty strings and missing keys become `null` in the response so
    the consumer never has to distinguish 'missing field' from 'empty
    string'."""
    if value is None:
        return None
    if isinstance(value, str) and not value.strip():
        return None
    return value


def _public_regatta(doc: dict) -> dict:
    """Whitelist regatta fields so we never leak internal ids /
    audit metadata to a downstream consumer. Every declared key is
    always present in the response (null if empty)."""
    return {
        "id":         _clean(doc.get("id")),
        "name":       _clean(doc.get("name")),
        "start_date": _clean(doc.get("start_date")),
        "end_date":   _clean(doc.get("end_date")),
        "level":      _clean(doc.get("level")),
        "location":   _clean(doc.get("location")),
        "country":    _clean(doc.get("country")),
        "host_org":   _clean(doc.get("host_org")),
        "notes":      _clean(doc.get("notes")),
        "source":     _clean(doc.get("source")),
    }


def _public_camp(doc: dict) -> dict:
    """Whitelist camp fields. `member_ids` is intentionally REPLACED
    with a bare `member_count` — a sibling app has no business
    receiving PII/member UUIDs across an integration boundary."""
    ids = doc.get("member_ids") or []
    days = doc.get("days_of_week")
    return {
        "id":            _clean(doc.get("id")),
        "name":          _clean(doc.get("name")),
        "institution":   _clean(doc.get("institution")),
        "start_date":    _clean(doc.get("start_date")),
        "end_date":      _clean(doc.get("end_date")),
        "start_time":    _clean(doc.get("start_time")),
        "end_time":      _clean(doc.get("end_time")),
        "days_of_week":  days if isinstance(days, list) else [],
        "member_count":  len(ids) if isinstance(ids, list) else 0,
        "notes":         _clean(doc.get("notes")),
    }


def make_router(db: Any) -> APIRouter:
    router = APIRouter(prefix="/api/external", dependencies=[Depends(_require_external_key)])

    @router.get("/health")
    async def health() -> dict:
        """Cheap ping so Inventory can verify its key + connectivity
        without pulling data. Only reachable with a valid key (the
        router-level dependency guarantees that)."""
        return {"ok": True, "app": "i-showed-up"}

    @router.get("/events")
    async def list_events() -> list[dict]:
        """All regattas / events, all dates, sorted by start_date DESC
        (newest first). Fields returned are whitelisted — no created_by /
        updated_by / audit stamps."""
        rows = await db.regattas.find({}, {"_id": 0}).sort("start_date", -1).to_list(2000)
        return [_public_regatta(r) for r in rows]

    @router.get("/camps")
    async def list_camps() -> list[dict]:
        """All camps, all dates, sorted by start_date DESC. `member_ids`
        is replaced with `member_count` so no personal identifiers
        leave this system."""
        rows = await db.camps.find({}, {"_id": 0}).sort("start_date", -1).to_list(500)
        return [_public_camp(r) for r in rows]

    return router
