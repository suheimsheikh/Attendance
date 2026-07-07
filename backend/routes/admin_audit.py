"""Admin audit trail — a single source of truth for "who changed
what, when, and why".

Used across all admin-mutating endpoints (member edits, leave-balance
adjustments, office config, retroactive attendance overrides, etc.).

Design:
  • One collection: `audit_log`.
  • Every doc carries actor identity, entity identity, action label,
    optional before/after snapshots, and an optional free-text reason.
  • Writes are best-effort (never block the primary operation).
  • Reads are admin-only and paginated.

Shape:
  {
    id: str (uuid),
    at: str (ISO UTC),
    actor_id: str,
    actor_name: str,
    actor_role: "admin",
    action: str  # e.g. "member.update", "leave_balance.set",
                 #      "office.update", "attendance.override",
                 #      "member.password_reset"
    entity_type: str,
    entity_id: str,
    entity_name: Optional[str],
    changes: Optional[dict],  # {field: {before, after}}
    reason: Optional[str],
    meta: Optional[dict],     # request_id / ip / user_agent if wired
  }
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def write_audit(
    db,
    *,
    actor: dict,
    action: str,
    entity_type: str,
    entity_id: str,
    entity_name: Optional[str] = None,
    before: Optional[dict] = None,
    after: Optional[dict] = None,
    reason: Optional[str] = None,
    meta: Optional[dict] = None,
) -> None:
    """Write one audit row. Best-effort — swallows all errors so a
    failed audit write never blocks the primary operation.

    `before` / `after` may be the full document; we compute the diff
    ourselves so callers can hand us the raw snapshots without
    pre-diffing. Only keys that actually differ land in `changes`.
    """
    changes: dict[str, dict[str, Any]] = {}
    if before is not None or after is not None:
        b = before or {}
        a = after or {}
        keys = set(b.keys()) | set(a.keys())
        for k in keys:
            # Skip volatile / uninteresting fields.
            if k in ("_id", "id", "created_at", "hashed_password"):
                continue
            bv, av = b.get(k), a.get(k)
            if bv != av:
                changes[k] = {"before": bv, "after": av}
    doc = {
        "id": str(uuid.uuid4()),
        "at": _now_iso(),
        "actor_id": (actor or {}).get("id"),
        "actor_name": (actor or {}).get("full_name") or (actor or {}).get("email"),
        "actor_role": (actor or {}).get("role"),
        "action": action,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "entity_name": entity_name,
        "changes": changes or None,
        "reason": reason,
        "meta": meta or None,
    }
    try:
        await db.audit_log.insert_one(doc)
    except Exception:
        # Audit is fire-and-forget by design. A DB blip must not
        # break member edits.
        pass


def make_router(db, require_admin) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/admin/audit-log")
    async def list_audit(
        actor_id: Optional[str] = None,
        entity_id: Optional[str] = None,
        entity_type: Optional[str] = None,
        action: Optional[str] = None,
        since: Optional[str] = None,   # ISO YYYY-MM-DD
        until: Optional[str] = None,
        limit: int = Query(200, ge=1, le=1000),
        admin: dict = Depends(require_admin),
    ):
        """Paged audit-log read. Default 200 rows, most-recent first.
        Filters can stack — omit any of them to broaden the search."""
        q: dict = {}
        if actor_id:
            q["actor_id"] = actor_id
        if entity_id:
            q["entity_id"] = entity_id
        if entity_type:
            q["entity_type"] = entity_type
        if action:
            q["action"] = action
        if since:
            q.setdefault("at", {})["$gte"] = since
        if until:
            # `until` is a date; expand to end-of-day for a human-friendly filter.
            q.setdefault("at", {})["$lte"] = f"{until}T23:59:59.999999+00:00"
        rows = await db.audit_log.find(q, {"_id": 0}) \
            .sort("at", -1).limit(limit).to_list(limit)
        return {"rows": rows, "count": len(rows)}

    return router
