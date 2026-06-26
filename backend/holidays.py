"""
Comp-Off balance.

Comp-off credits accrue when a member has attendance on a day that's their
weekly off (either their personal `weekly_off`, or — if not set — the
office-wide `default_weekly_off` fallback configured on Office Settings).

The Holidays/public-holiday system was removed on 26 Jun 2026 (see PRD).
Compensating a member for working on a public holiday is now handled
manually by the admin bumping the member's `leave_balance_opening`.
"""
from __future__ import annotations

from datetime import date
from typing import List, Optional


WEEKDAY_KEY = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def _days_inclusive(start_iso: str, end_iso: str) -> int:
    try:
        return (date.fromisoformat(end_iso) - date.fromisoformat(start_iso)).days + 1
    except Exception:
        return 1


async def compute_balance_summary(db, user: dict, year: Optional[str] = None) -> dict:
    """One-shot summary of every balance an apply-leave form needs.

    Returns the live values for both pools — comp-off (accrued via
    weekly-off attendance) and paid leave (opening − used) — plus the
    combined total. Used by the unified Leave application UX where comp-off
    drains first and the leave balance second.

    Output shape:
        {
            "comp_off": {"accrued", "used", "available"},
            "paid_leave": {"opening", "used", "available", "tracked": bool},
            "total_available": int,
        }
    """
    co = await compute_comp_off_balance(db, user, year=year)
    if not year:
        year = str(date.today().year)
    yr_start, yr_end = f"{year}-01-01", f"{year}-12-31"
    opening = user.get("leave_balance_opening")
    tracked = (user.get("category") != "athlete") and (opening is not None)
    paid_used = 0
    if tracked:
        approved = await db.leaves.find({
            "user_id": user["id"], "status": "approved", "type": "leave",
            "start_date": {"$gte": yr_start, "$lte": yr_end},
        }, {"_id": 0, "start_date": 1, "end_date": 1, "paid_leave_used": 1}).to_list(500)
        for L in approved:
            if "paid_leave_used" in L and L["paid_leave_used"] is not None:
                paid_used += float(L["paid_leave_used"])
            else:
                # Legacy row created before the ladder-stamp landed. Treat
                # the whole leave window as paid days (the old behaviour).
                paid_used += _days_inclusive(L["start_date"], L["end_date"])
    paid_avail = max(0.0, float(opening) - paid_used) if tracked else 0
    return {
        "comp_off": {"accrued": co["accrued"], "used": co["used"], "available": co["available"]},
        "paid_leave": {
            "opening": opening,
            "used": paid_used,
            "available": paid_avail,
            "tracked": tracked,
        },
        "total_available": int(co["available"]) + int(paid_avail),
        "weekly_off": co["weekly_off"],
        "weekly_off_source": co["weekly_off_source"],
    }


def split_leave_days(requested: int, comp_off_avail: int, paid_avail: float) -> dict:
    """Split a requested leave (calendar days) across the deduction ladder.

    Order: comp-off first, paid leave second, anything left = LOP.
    Returns a dict ready to stamp on the leave document — callers can
    spread this onto the create payload.
    """
    requested = max(0, int(requested))
    co = min(requested, max(0, int(comp_off_avail)))
    paid = min(requested - co, max(0.0, float(paid_avail)))
    lop = max(0, requested - co - int(paid))
    return {"comp_off_used": co, "paid_leave_used": paid, "lop_days": lop}


async def compute_comp_off_balance(db, user: dict, year: Optional[str] = None) -> dict:
    """Live comp-off balance for `user`.

    Accrual:
      +1 credit per distinct calendar date the user has attendance for,
      where the date matches the user's effective weekly off:
        - `user.weekly_off` if set, else
        - `office.default_weekly_off` (default "sunday").

    Consumption:
      -1 per day of approved `comp_off` leaves (inclusive of start..end).

    `available = max(0, accrued - used)`.
    """
    if not year:
        year = str(date.today().year)

    # Resolve the effective weekly-off day, member-level wins; otherwise the
    # org-wide default from Office Settings (so admins don't have to fill in
    # every member profile manually).
    weekly_off = (user.get("weekly_off") or "").lower()
    if not weekly_off:
        office = await db.config.find_one({"id": "office"}, {"_id": 0, "default_weekly_off": 1})
        weekly_off = (office or {}).get("default_weekly_off") or "sunday"

    # Attendance in the target year.
    yr_start = f"{year}-01-01"
    yr_end = f"{year}-12-31"
    atts = await db.attendance.find(
        {"user_id": user["id"], "date": {"$gte": yr_start, "$lte": yr_end}},
        {"_id": 0, "date": 1},
    ).to_list(2000)
    distinct_dates = sorted({a["date"] for a in atts})

    breakdown: List[dict] = []
    accrued = 0
    for ds in distinct_dates:
        try:
            wd = WEEKDAY_KEY[date.fromisoformat(ds).weekday()]
        except Exception:
            continue
        if wd != weekly_off:
            continue
        accrued += 1
        breakdown.append({"date": ds, "kind": "weekly_off"})

    used_leaves = await db.leaves.find({
        "user_id": user["id"],
        "status": "approved",
        "start_date": {"$lte": yr_end},
        "end_date": {"$gte": yr_start},
        # Two shapes count toward comp-off consumption:
        #  - NEW: any leave row carrying a non-zero `comp_off_used` stamp
        #         (the unified Leave application path, comp-off-first ladder).
        #  - LEGACY: rows of the now-deprecated `type=comp_off` application,
        #         which had no stamp — the whole window counts as used.
        "$or": [{"comp_off_used": {"$gt": 0}}, {"type": "comp_off"}],
    }, {"_id": 0, "type": 1, "start_date": 1, "end_date": 1, "comp_off_used": 1}).to_list(500)
    used = 0
    for L in used_leaves:
        if "comp_off_used" in L and L["comp_off_used"] is not None:
            used += int(L["comp_off_used"])
        elif L.get("type") == "comp_off":
            used += _days_inclusive(L["start_date"], L["end_date"])

    return {
        "year": year,
        "accrued": accrued,
        "used": used,
        "available": max(0, accrued - used),
        "weekly_off": weekly_off,
        "weekly_off_source": "member" if (user.get("weekly_off") or "").lower() else "office_default",
        "breakdown": breakdown,
    }


def make_router(*_args, **_kwargs):
    """Backwards-compat shim — the dedicated Holiday CRUD router was
    removed on 26 Jun 2026. This stub keeps the `/api/me/comp-off-balance`
    + `/api/members/{id}/comp-off-balance` endpoints alive without the
    Holiday-management surface.

    Kept as a function so `server.py` doesn't need a release-coordinated
    deploy if anyone else has a stale import — it just no-ops.
    """
    from fastapi import APIRouter, Depends, HTTPException
    db, require_admin, get_current_user = _args
    router = APIRouter(prefix="/api", tags=["comp-off"])

    @router.get("/me/comp-off-balance")
    async def my_comp_off_balance(user: dict = Depends(get_current_user)):
        return await compute_comp_off_balance(db, user)

    @router.get("/me/leave-summary")
    async def my_leave_summary(user: dict = Depends(get_current_user)):
        """Unified balance summary — comp-off + paid leave — for the apply
        Leave form's deduction-ladder preview."""
        return await compute_balance_summary(db, user)

    @router.get("/members/{member_id}/leave-summary")
    async def member_leave_summary(member_id: str, _admin: dict = Depends(require_admin)):
        u = await db.users.find_one({"id": member_id}, {"_id": 0})
        if not u:
            raise HTTPException(status_code=404, detail="Member not found")
        return await compute_balance_summary(db, u)

    @router.get("/members/{member_id}/comp-off-balance")
    async def member_comp_off_balance(member_id: str, _admin: dict = Depends(require_admin)):
        u = await db.users.find_one({"id": member_id}, {"_id": 0})
        if not u:
            raise HTTPException(status_code=404, detail="Member not found")
        return await compute_comp_off_balance(db, u)

    return router
