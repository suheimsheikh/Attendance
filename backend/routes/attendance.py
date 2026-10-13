"""Attendance read-only routes (status, stale-session).
Phase 1 of the attendance split out of server.py (Oct 2026) — paths and behaviour unchanged."""
from __future__ import annotations


from fastapi import APIRouter, Depends

from services.attendance_calc import open_excursion as _open_excursion
from services.attendance_helpers import late_days_in_month, open_session_for as _open_session_impl
from services.time_utils import local_date_str


def make_router(db, get_current_user, require_admin) -> APIRouter:
    router = APIRouter(prefix="/api")

    async def open_session_for(user_id: str):
        return await _open_session_impl(db, user_id)

    async def _late_days_in_month(user_id: str, date_iso: str) -> int:
        return await late_days_in_month(db, user_id, date_iso)


    @router.get("/attendance/status")
    async def my_attendance_status(user: dict = Depends(get_current_user)):
        sess = await open_session_for(user["id"])
        open_exc = _open_excursion(sess) if sess else None
        late_days = await _late_days_in_month(user["id"], sess["date"]) if sess and sess.get("late") else 0
        # One-check-in-per-day: when the member has no open session but already
        # has a row for today, they've completed their day — the UI shows a
        # "Checked out for the day" state instead of offering check-in again.
        done_for_today = False
        if sess is None:
            office = await db.config.find_one({"id": "office"})
            row = await db.attendance.find_one(
                {"user_id": user["id"], "date": local_date_str(office)}, {"_id": 0, "id": 1})
            done_for_today = row is not None
        return {
            "checked_in": sess is not None,
            "on_temp_exit": open_exc is not None,
            "current_excursion": open_exc,
            "session": sess,
            "late_days_this_month": late_days,
            "done_for_today": done_for_today,
        }


    @router.get("/attendance/stale-session")
    async def stale_session(user: dict = Depends(get_current_user)):
        """If the user has an open session from a previous office-local day,
        surface it so the UI can prompt them to retroactively check out."""
        sess = await open_session_for(user["id"])
        if not sess or sess.get("forgot_checkout_skipped"):
            return {"stale": None}
        office = await db.config.find_one({"id": "office"})
        today = local_date_str(office)
        if sess.get("date") and sess["date"] >= today:
            return {"stale": None}
        from services.attendance_calc import _dow_key, _dow_override
        _dow_end = _dow_override(user, office, _dow_key(sess.get("date")))[1]
        return {"stale": {
            "session_id": sess["id"],
            "check_in_at": sess["check_in_at"],
            "date": sess.get("date"),
            "work_end": _dow_end or user.get("work_end") or "18:00",
        }}


    return router
