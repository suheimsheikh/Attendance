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


def _bucket_leave_rows(rows: list, today: str) -> dict:
    """Walk a year's worth of leave/tour rows for one member and bucket the
    aggregates we need for the balance summary. Single-pass so the caller
    can stay flat. Returns paid_used, pending_leave_days, future_approved_leave_days,
    tour_ytd_days, pending_tour_days, lop_ytd_days."""
    paid_used = 0.0
    pending_leave_days = 0.0
    future_approved_leave_days = 0.0
    tour_ytd_days = 0
    pending_tour_days = 0
    lop_ytd_days = 0.0
    for L in rows:
        n = _days_inclusive(L["start_date"], L["end_date"])
        if L["type"] == "leave":
            if L["status"] == "approved":
                # Paid-leave used — prefer the ladder-stamped value, fall
                # back to the whole window for legacy rows.
                paid_used += float(L["paid_leave_used"]) if L.get("paid_leave_used") is not None else n
                if L.get("lop_days") is not None:
                    lop_ytd_days += float(L["lop_days"])
                # Future-approved (starts after today) still counts as a
                # commitment the member should see — applied & not yet taken.
                if L["start_date"] > today:
                    future_approved_leave_days += n
            elif L["status"] == "pending":
                pending_leave_days += n
        elif L["type"] == "tour":
            if L["status"] == "approved":
                tour_ytd_days += n
            elif L["status"] == "pending":
                pending_tour_days += n
        # Legacy `comp_off` rows are accounted in compute_comp_off_balance.
    return {
        "paid_used": paid_used,
        "pending_leave_days": pending_leave_days,
        "future_approved_leave_days": future_approved_leave_days,
        "tour_ytd_days": tour_ytd_days,
        "pending_tour_days": pending_tour_days,
        "lop_ytd_days": lop_ytd_days,
    }


async def compute_balance_summary(db, user: dict, year: Optional[str] = None) -> dict:
    """One-shot summary of every balance an apply-leave form needs.

    Returns the live values for both pools — comp-off (accrued via
    weekly-off attendance) and paid leave (opening − used) — plus the
    combined total. Used by the unified Leave application UX where comp-off
    drains first and the leave balance second.

    Also surfaces a small set of YTD aggregates that the member's
    "My Leave & Tour" header dashboard needs so they have full context
    BEFORE applying for more leave (pending + future-approved that
    haven't started yet, total tour days, total LOP, approximate
    absent days).
    """
    co = await compute_comp_off_balance(db, user, year=year)
    if not year:
        year = str(date.today().year)
    yr_start, yr_end = f"{year}-01-01", f"{year}-12-31"
    opening = user.get("leave_balance_opening")
    tracked = (user.get("category") != "athlete") and (opening is not None)

    rows = await db.leaves.find({
        "user_id": user["id"],
        "start_date": {"$gte": yr_start, "$lte": yr_end},
        "type": {"$in": ["leave", "tour", "comp_off"]},
    }, {"_id": 0, "type": 1, "status": 1, "start_date": 1, "end_date": 1,
        "paid_leave_used": 1, "lop_days": 1, "comp_off_used": 1}).to_list(2000)

    today = date.today().isoformat()
    buckets = _bucket_leave_rows(rows, today)
    paid_avail = max(0.0, float(opening) - buckets["paid_used"]) if tracked else 0

    absent_ytd_days = 0
    if user.get("category") != "athlete":
        absent_ytd_days = await _absent_days_ytd(db, user, co["weekly_off"])

    return {
        "comp_off": {"accrued": co["accrued"], "used": co["used"], "available": co["available"]},
        "paid_leave": {
            "opening": opening,
            "used": buckets["paid_used"],
            "available": paid_avail,
            "tracked": tracked,
        },
        "total_available": int(co["available"]) + int(paid_avail),
        "pending_leave_days": buckets["pending_leave_days"],
        "future_approved_leave_days": buckets["future_approved_leave_days"],
        "tour_ytd_days": buckets["tour_ytd_days"],
        "pending_tour_days": buckets["pending_tour_days"],
        "lop_ytd_days": buckets["lop_ytd_days"],
        "absent_ytd_days": absent_ytd_days,
        "weekly_off": co["weekly_off"],
        "weekly_off_source": co["weekly_off_source"],
    }


async def _absent_days_ytd(db, user: dict, weekly_off: str) -> int:
    """Cheap-ish approximation of "absent days YTD" for the member dashboard.

    Iterates Jan 1 → today and counts each weekday where the member has
    no attendance record AND no approved leave/tour/break covers the day
    AND the day isn't their effective weekly off.

    Notes:
      - We treat join date as Jan 1; rejoiners early in the year may see
        an inflated count for their first few days. Acceptable for a
        dashboard signal — the source of truth remains the daily report.
      - Breaks are checked via the same model the Presence Board uses
        (scope = "all" | "category" | "institution" | "selected").
    """
    today_d = date.today()
    yr_start = date(today_d.year, 1, 1)
    if today_d < yr_start:
        return 0
    # Pull the small data sets once.
    atts = await db.attendance.find(
        {"user_id": user["id"],
         "date": {"$gte": yr_start.isoformat(), "$lte": today_d.isoformat()}},
        {"_id": 0, "date": 1},
    ).to_list(500)
    att_set = {a["date"] for a in atts}
    leaves_approved = await db.leaves.find({
        "user_id": user["id"], "status": "approved",
        "type": {"$in": ["leave", "tour"]},
        "start_date": {"$lte": today_d.isoformat()},
        "end_date":   {"$gte": yr_start.isoformat()},
    }, {"_id": 0, "start_date": 1, "end_date": 1}).to_list(500)
    leave_set: set = set()
    for L in leaves_approved:
        try:
            sd = date.fromisoformat(L["start_date"])
            ed = date.fromisoformat(L["end_date"])
        except Exception:
            continue
        d = max(sd, yr_start)
        while d <= min(ed, today_d):
            leave_set.add(d.isoformat())
            d = d.fromordinal(d.toordinal() + 1)
    # Breaks — fetched matching the member's scope.
    breaks = await db.breaks.find({
        "start_date": {"$lte": today_d.isoformat()},
        "end_date":   {"$gte": yr_start.isoformat()},
    }, {"_id": 0, "scope": 1, "start_date": 1, "end_date": 1, "institution": 1,
        "fleet": 1, "category": 1, "member_ids": 1}).to_list(500)
    break_set: set = set()
    for B in breaks:
        if not _break_covers_user(B, user):
            continue
        try:
            sd = date.fromisoformat(B["start_date"])
            ed = date.fromisoformat(B["end_date"])
        except Exception:
            continue
        d = max(sd, yr_start)
        while d <= min(ed, today_d):
            break_set.add(d.isoformat())
            d = d.fromordinal(d.toordinal() + 1)
    wo = (weekly_off or "sunday").lower()
    absent = 0
    d = yr_start
    while d <= today_d:
        if WEEKDAY_KEY[d.weekday()] != wo:
            iso = d.isoformat()
            if iso not in att_set and iso not in leave_set and iso not in break_set:
                absent += 1
        d = d.fromordinal(d.toordinal() + 1)
    return absent


def _break_covers_user(b: dict, user: dict) -> bool:
    """Mirrors the scope rules used elsewhere in the app — kept inline so
    this helper doesn't pull in the presence module."""
    scope = b.get("scope") or "all"
    if scope == "all":
        return True
    if scope == "institution":
        return (b.get("institution") or "") == (user.get("institution") or "")
    if scope == "fleet":
        return (b.get("fleet") or "") == (user.get("fleet") or "")
    if scope == "category":
        return (b.get("category") or "") == (user.get("category") or "")
    if scope == "selected":
        return user["id"] in (b.get("member_ids") or [])
    return False


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
