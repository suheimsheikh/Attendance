"""Bulk attendance deletions behind the Super-Admin sign-off gate.

Every tool that deletes attendance rows en masse (wipe-all, data-quality
auto-fixes) routes through `run_or_queue`: a Super Admin runs it at once;
any other admin gets a pending `corrections` row (entity attendance /
kind bulk_delete, needs_super_admin=True) that only a Super Admin can
approve in the unified Approvals screen — the same gate as edits.
"""
from __future__ import annotations

from typing import Dict
from uuid import uuid4

from routes.admin_audit import write_audit
from services.permissions import is_super_admin
from services.time_utils import local_date_str, now_utc


async def _wipe_all(db) -> int:
    return (await db.attendance.delete_many({})).deleted_count


_ZERO_Q = {"$expr": {"$eq": ["$check_in_at", "$check_out_at"]}, "check_out_at": {"$ne": None}}


async def _zero_duration(db) -> int:
    return (await db.attendance.delete_many(_ZERO_Q)).deleted_count


_DUP_PIPE = [
    {"$match": {"check_out_at": None}},
    {"$group": {"_id": "$user_id",
                "sessions": {"$push": {"id": "$id", "check_in_at": "$check_in_at"}},
                "n": {"$sum": 1}}},
    {"$match": {"n": {"$gt": 1}}},
]


async def _duplicate_sessions(db) -> int:
    fixed = 0
    for g in await db.attendance.aggregate(_DUP_PIPE).to_list(2000):
        sessions = sorted(g["sessions"], key=lambda s: s.get("check_in_at") or "")
        for s in sessions[1:]:
            fixed += (await db.attendance.delete_one({"id": s["id"]})).deleted_count
    return fixed


async def _count_wipe(db) -> int:
    return await db.attendance.count_documents({})


async def _count_zero(db) -> int:
    return await db.attendance.count_documents(_ZERO_Q)


async def _count_dups(db) -> int:
    return sum(g["n"] - 1 for g in await db.attendance.aggregate(_DUP_PIPE).to_list(2000))


BULK_DELETE_TOOLS: Dict[str, dict] = {
    "wipe_all": {"label": "Wipe ALL attendance", "run": _wipe_all, "count": _count_wipe},
    "session.zero_duration": {"label": "Delete zero-duration sessions", "run": _zero_duration, "count": _count_zero},
    "session.duplicate_open": {"label": "Delete duplicate open sessions", "run": _duplicate_sessions, "count": _count_dups},
}


async def run_tool(db, tool: str) -> int:
    return await BULK_DELETE_TOOLS[tool]["run"](db)


async def run_or_queue(db, admin: dict, tool: str, reason: str) -> dict:
    """Super Admin → delete now (audited). Other admins → queue for sign-off."""
    spec = BULK_DELETE_TOOLS[tool]
    affected = await spec["count"](db)
    if is_super_admin(admin):
        deleted = await spec["run"](db)
        await write_audit(
            db, actor=admin, action="attendance_bulk_delete", entity_type="attendance",
            entity_id=tool, entity_name=spec["label"], before={"rows": affected},
            after={"deleted": deleted}, reason=reason,
        )
        return {"ok": True, "queued": False, "fixed": deleted, "deleted": deleted}
    doc = {
        "id": str(uuid4()),
        "entity_type": "attendance",
        "kind": "bulk_delete",
        "entity_id": None,
        "target_date": local_date_str(None),
        "payload": {"tool": tool, "label": spec["label"], "affected_rows": affected},
        "reason": reason,
        "status": "pending",
        "requester_id": admin["id"],
        "requester_name": admin.get("full_name") or admin.get("email") or "Admin",
        "requested_at": now_utc().isoformat(),
        "decided_by_id": None, "decided_by_name": None, "decided_at": None, "admin_note": None,
        "filed_by_admin_id": admin["id"],
        "filed_by_admin_name": admin.get("full_name"),
        "needs_super_admin": True,
    }
    await db.corrections.insert_one(doc)
    doc.pop("_id", None)
    await write_audit(
        db, actor=admin, action="correction_requested", entity_type="correction",
        entity_id=doc["id"], entity_name=f"attendance/bulk_delete · {spec['label']}",
        before=None, after={"status": "pending", "needs_super_admin": True, "payload": doc["payload"]},
        reason=reason,
    )
    return {"ok": True, "queued": True, "fixed": 0, "correction_id": doc["id"], "affected_rows": affected,
            "detail": f"Queued for Super Admin approval — {affected} row(s) would be deleted"}


async def apply_bulk_delete(db, c: dict, admin: dict) -> dict:
    """Correction applier: runs the queued tool when a Super Admin approves."""
    tool = (c.get("payload") or {}).get("tool")
    if tool not in BULK_DELETE_TOOLS:
        raise ValueError(f"Unknown bulk-delete tool {tool!r}")
    deleted = await run_tool(db, tool)
    return {"tool": tool, "deleted": deleted, "applied_at": now_utc().isoformat()}
