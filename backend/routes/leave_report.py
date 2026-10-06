"""Daily leave/tour WhatsApp report — a once-a-day nudge for admins.

When an admin logs in the frontend shows a small prompt listing everyone
on leave or tour (name · till date · N more days) and lets them post it to
the YCH Attendance WhatsApp group (manual share — Meta bans group-posting
via API). The FIRST admin to post marks the day done so no other admin is
prompted; if nobody has posted yet, every admin keeps getting prompted.

This module only owns the daily "posted?" lock. The leave/tour data itself
is fetched by the frontend from the existing /muster/daily-roster endpoint.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from services.time_utils import now_utc, office_today_str


def make_router(db, require_admin) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/leave-report/today-status")
    async def today_status(admin: dict = Depends(require_admin)):
        d = await office_today_str(db)
        doc = await db.daily_leave_report_log.find_one({"date": d}, {"_id": 0})
        return {
            "date": d,
            "posted": bool(doc),
            "posted_by_name": (doc or {}).get("posted_by_name"),
            "posted_at": (doc or {}).get("posted_at"),
        }

    @router.post("/leave-report/mark-posted")
    async def mark_posted(admin: dict = Depends(require_admin)):
        """Mark today's leave/tour report as posted. Idempotent — the first
        admin to call it wins ($setOnInsert), so a later admin's call never
        overwrites who actually posted it."""
        d = await office_today_str(db)
        await db.daily_leave_report_log.update_one(
            {"date": d},
            {"$setOnInsert": {
                "date": d,
                "posted_at": now_utc().isoformat(),
                "posted_by": admin.get("id"),
                "posted_by_name": admin.get("full_name") or admin.get("email"),
            }},
            upsert=True,
        )
        doc = await db.daily_leave_report_log.find_one({"date": d}, {"_id": 0})
        return {"ok": True, **(doc or {"date": d, "posted": True})}

    return router
