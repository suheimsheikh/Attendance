"""
Attendance dedupe / repair tool (Jun 2026).

Cleans up the fallout of the "auto check-in after check-out" bug, which
created extra same-day check-in rows (many wrongly flagged late). Under the
new one-check-in-per-day rule each member should have exactly ONE attendance
row per office-local day, so this tool:

  • keeps the FIRST check-in of each day,
  • carries the day's LAST check-out onto that kept row (so the real span is
    preserved) and recomputes hours + late,
  • archives every removed row into `attendance_removed` (reversible) and
    writes an audit entry.

Two endpoints — a safe dry-run preview and a Super-Admin-only apply:

  • GET  /api/admin/tools/attendance-dedupe/preview
  • POST /api/admin/tools/attendance-dedupe/apply
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from routes.admin_audit import write_audit
from services.attendance_calc import compute_late
from services.permissions import is_super_admin
from services.time_utils import local_date_str, now_utc, office_tz


def make_router(db, require_admin) -> APIRouter:
    router = APIRouter(prefix="/api")

    def _parse(dt_str, tz):
        """ISO string → tz-aware UTC datetime. Naive strings are assumed to
        be office-local wall clock. Returns None when empty/unparseable."""
        if not dt_str:
            return None
        try:
            d = datetime.fromisoformat(dt_str)
        except Exception:
            return None
        if d.tzinfo is None:
            d = d.replace(tzinfo=tz)
        return d.astimezone(timezone.utc)

    async def _plan(db):
        """Build the dedupe plan without mutating anything."""
        office = await db.config.find_one({"id": "office"}, {"_id": 0})
        tz = office_tz(office)
        users = {u["id"]: u for u in await db.users.find({}, {"_id": 0}).to_list(5000)}

        groups: dict = {}
        async for a in db.attendance.find(
            {},
            {"_id": 0, "id": 1, "user_id": 1, "date": 1, "check_in_at": 1,
             "check_out_at": 1, "late": 1, "late_minutes": 1, "method": 1},
        ):
            groups.setdefault((a["user_id"], a["date"]), []).append(a)

        plan = []
        total_remove = 0
        members = set()
        for (uid, d), rows in groups.items():
            if len(rows) < 2:
                continue
            rows.sort(key=lambda r: (_parse(r.get("check_in_at"), tz) or datetime.max.replace(tzinfo=timezone.utc)))
            keep = rows[0]
            extras = rows[1:]
            keep_in = _parse(keep.get("check_in_at"), tz)
            # Latest checkout across ALL rows that day → the real end of day.
            outs = [_parse(r.get("check_out_at"), tz) for r in rows]
            outs = [o for o in outs if o]
            merged_out = max(outs) if outs else None
            hours = None
            if keep_in and merged_out and merged_out > keep_in:
                hours = round((merged_out - keep_in).total_seconds() / 3600.0, 2)
            # Recompute late from the kept (first) check-in.
            is_late, late_min = (keep.get("late"), keep.get("late_minutes"))
            if keep_in:
                is_late, late_min = compute_late(office or {}, users.get(uid) or {}, keep_in)
            members.add(uid)
            total_remove += len(extras)
            plan.append({
                "user_id": uid,
                "name": (users.get(uid) or {}).get("full_name") or uid,
                "date": d,
                "keep_id": keep["id"],
                "keep_check_in": keep.get("check_in_at"),
                "keep_current_checkout": keep.get("check_out_at"),
                "merged_checkout": merged_out.isoformat() if merged_out else None,
                "hours": hours,
                "late_was": bool(keep.get("late")),
                "late_now": bool(is_late),
                "late_minutes_now": int(late_min or 0),
                "remove_ids": [r["id"] for r in extras],
                "remove_count": len(extras),
                "remove_detail": [
                    {"id": r["id"], "check_in_at": r.get("check_in_at"),
                     "check_out_at": r.get("check_out_at"),
                     "late": bool(r.get("late")), "late_minutes": r.get("late_minutes"),
                     "method": r.get("method")}
                    for r in extras
                ],
            })
        plan.sort(key=lambda p: (p["date"], p["name"]))
        return {
            "days_affected": len(plan),
            "members_affected": len(members),
            "rows_to_remove": total_remove,
            "plan": plan,
        }

    @router.get("/admin/tools/attendance-dedupe/preview")
    async def dedupe_preview(admin: dict = Depends(require_admin)):
        """Dry-run: show exactly which extra same-day rows would be removed
        and how the kept row's checkout / hours / late would be recomputed.
        Mutates nothing."""
        return await _plan(db)

    @router.post("/admin/tools/attendance-dedupe/apply")
    async def dedupe_apply(admin: dict = Depends(require_admin)):
        """Apply the dedupe: archive + remove extra rows, fix the kept row.
        Super-Admin only. Idempotent — re-running finds nothing to do once
        every day has a single row."""
        if not is_super_admin(admin):
            raise HTTPException(
                status_code=403,
                detail="Only a Super Admin can apply the attendance dedupe repair.")
        office = await db.config.find_one({"id": "office"}, {"_id": 0})
        tz = office_tz(office)
        result = await _plan(db)
        removed = 0
        fixed = 0
        stamp = now_utc().isoformat()
        for entry in result["plan"]:
            # Archive + delete each extra row.
            for rid in entry["remove_ids"]:
                doc = await db.attendance.find_one({"id": rid})
                if not doc:
                    continue
                doc.pop("_id", None)
                await db.attendance_removed.insert_one({
                    **doc,
                    "removed_at": stamp,
                    "removed_by_id": admin.get("id"),
                    "removed_by_name": admin.get("full_name"),
                    "removed_reason": "attendance-dedupe: extra same-day check-in (auto check-in bug cleanup)",
                })
                await db.attendance.delete_one({"id": rid})
                removed += 1
                await write_audit(
                    db, actor=admin, action="attendance_dedupe_remove",
                    entity_type="attendance", entity_id=rid,
                    entity_name=f"{entry['name']} · {entry['date']}",
                    before=doc, after=None,
                    reason="Extra same-day check-in removed (one-check-in-per-day repair). Archived to attendance_removed.",
                    meta={"kept_id": entry["keep_id"], "date": entry["date"]},
                )
            # Fix the kept row: carry the day's last checkout + recompute.
            keep = await db.attendance.find_one({"id": entry["keep_id"]}, {"_id": 0})
            if not keep:
                continue
            keep_in = _parse(keep.get("check_in_at"), tz)
            set_fields = {}
            if entry["merged_checkout"]:
                cur_out = _parse(keep.get("check_out_at"), tz)
                new_out = _parse(entry["merged_checkout"], tz)
                if new_out and (cur_out is None or new_out > cur_out):
                    set_fields["check_out_at"] = entry["merged_checkout"]
                    if keep_in and new_out > keep_in:
                        set_fields["hours"] = round((new_out - keep_in).total_seconds() / 3600.0, 2)
            if keep_in:
                member = await db.users.find_one({"id": keep["user_id"]}, {"_id": 0})
                is_late, late_min = compute_late(office or {}, member or {}, keep_in)
                if bool(keep.get("late")) != bool(is_late) or int(keep.get("late_minutes") or 0) != int(late_min):
                    set_fields["late"] = bool(is_late)
                    set_fields["late_minutes"] = int(late_min)
            if set_fields:
                await db.attendance.update_one({"id": entry["keep_id"]}, {"$set": set_fields})
                fixed += 1
        return {
            "ok": True,
            "rows_removed": removed,
            "kept_rows_fixed": fixed,
            "days_affected": result["days_affected"],
            "members_affected": result["members_affected"],
            "note": "Removed rows archived to attendance_removed (reversible). Each removal is in the audit log.",
        }

    return router
