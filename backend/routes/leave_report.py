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
        # "posted" means someone actually shared it (posted_at set) — NOT
        # merely that a claim row exists (Jun 2026). The dashboard chip
        # relies on this to keep showing "Post now" until it's truly posted.
        return {
            "date": d,
            "posted": bool(doc and doc.get("posted_at")),
            "posted_by_name": (doc or {}).get("posted_by_name"),
            "posted_at": (doc or {}).get("posted_at"),
            "claimed_by_name": (doc or {}).get("claimed_by_name"),
        }

    @router.post("/leave-report/claim")
    async def claim(admin: dict = Depends(require_admin)):
        """Claim today's leave/tour NUDGE for exactly one admin. The first
        admin to open the app each day claims it and sees the pop-up; every
        other admin is NOT shown the pop-up (user request Jun 2026 — it used
        to nag all admins). Returns {show: bool}. The dashboard 'Post now'
        chip stays available to everyone regardless, so the report can still
        be posted if the claiming admin skips it."""
        d = await office_today_str(db)
        me = admin.get("id")
        doc = await db.daily_leave_report_log.find_one({"date": d}, {"_id": 0})
        if doc:
            if doc.get("posted_at"):
                return {"show": False, "reason": "posted",
                        "posted_by_name": doc.get("posted_by_name")}
            cb = doc.get("claimed_by")
            if cb and cb != me:
                return {"show": False, "reason": "claimed",
                        "claimed_by_name": doc.get("claimed_by_name")}
        await db.daily_leave_report_log.update_one(
            {"date": d},
            {"$setOnInsert": {"date": d, "created_at": now_utc().isoformat()},
             "$set": {
                 "claimed_by": me,
                 "claimed_by_name": admin.get("full_name") or admin.get("email"),
                 "claimed_at": now_utc().isoformat(),
             }},
            upsert=True,
        )
        return {"show": True, "date": d}

    @router.post("/leave-report/mark-posted")
    async def mark_posted(admin: dict = Depends(require_admin)):
        """Mark today's leave/tour report as posted. The first admin to post
        wins — a later call never overwrites who actually posted it. Works
        whether or not a claim row already exists for the day."""
        d = await office_today_str(db)
        doc = await db.daily_leave_report_log.find_one({"date": d}, {"_id": 0})
        if doc and doc.get("posted_at"):
            return {"ok": True, **doc}  # already posted — don't overwrite
        await db.daily_leave_report_log.update_one(
            {"date": d},
            {"$setOnInsert": {"date": d, "created_at": now_utc().isoformat()},
             "$set": {
                 "posted_at": now_utc().isoformat(),
                 "posted_by": admin.get("id"),
                 "posted_by_name": admin.get("full_name") or admin.get("email"),
             }},
            upsert=True,
        )
        doc = await db.daily_leave_report_log.find_one({"date": d}, {"_id": 0})
        return {"ok": True, **(doc or {"date": d, "posted": True})}

    return router
