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
from typing import Callable, List, Optional

from services.attendance_calc import ATHLETE_CATEGORIES
from services.time_utils import local_date_str


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
    tour_ytd_days, pending_tour_days, lop_ytd_days, plus a
    `leave_full_count` / `leave_half_count` breakdown of approved rows
    for the summary card (added 30 Jun 2026, half-day launch).

    Refactored Feb 2026 to use guard clauses so each row-type is a
    self-contained early-continue block — cyclomatic complexity dropped
    from 16 → ~6 and no branch sits deeper than 2 levels."""
    agg = {
        "paid_used": 0.0,
        "pending_leave_days": 0.0,
        "future_approved_leave_days": 0.0,
        "tour_ytd_days": 0,
        "pending_tour_days": 0,
        "lop_ytd_days": 0.0,
        "leave_full_count": 0,
        "leave_half_count": 0,
    }
    for L in rows:
        n = _days_inclusive(L["start_date"], L["end_date"])
        row_type = L.get("type")
        status = L.get("status")

        if row_type == "leave" and status == "approved":
            _tally_approved_leave(agg, L, n, today)
            continue
        if row_type == "leave" and status == "pending":
            agg["pending_leave_days"] += n
            continue
        if row_type == "tour" and status == "approved":
            agg["tour_ytd_days"] += n
            continue
        if row_type == "tour" and status == "pending":
            agg["pending_tour_days"] += n
            continue
        # Legacy comp_off rows are accounted in compute_comp_off_balance.
    return agg


def _tally_approved_leave(agg: dict, L: dict, n: int, today: str) -> None:
    """Update the running aggregate for one approved-leave row. Split out
    from _bucket_leave_rows so the loop body stays trivially readable."""
    # Paid-leave used — prefer the ladder-stamped value, fall back to
    # the whole window for legacy rows without a stamp.
    agg["paid_used"] += (
        float(L["paid_leave_used"])
        if L.get("paid_leave_used") is not None
        else n
    )
    if L.get("lop_days") is not None:
        agg["lop_ytd_days"] += float(L["lop_days"])
    # Future-approved (starts after today) is still a commitment the
    # member should see — applied & not yet taken.
    if L["start_date"] > today:
        agg["future_approved_leave_days"] += n
    # Half-vs-full breakdown for the summary card.
    if L.get("half_day"):
        agg["leave_half_count"] += 1
    else:
        agg["leave_full_count"] += 1


def _split_comp_off_sources(co: dict) -> tuple[int, int, int]:
    """Return `(from_attendance, from_tours, from_opening)` from a
    comp-off breakdown so the summary card can show
    `"X (Y from tours, Z opening)"` without re-walking the list."""
    breakdown = co.get("breakdown") or []
    from_tours = sum(1 for b in breakdown if b.get("kind") == "tour_weekly_off")
    from_opening = sum(int(b.get("count") or 0) for b in breakdown
                       if b.get("kind") == "opening")
    from_attendance = int(co["accrued"]) - from_tours - from_opening
    return from_attendance, from_tours, from_opening


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
        year = local_date_str(None)[:4]
    yr_start, yr_end = f"{year}-01-01", f"{year}-12-31"
    opening = user.get("leave_balance_opening")
    tracked = (user.get("category") != "athlete") and (opening is not None)

    rows = await db.leaves.find({
        "user_id": user["id"],
        "start_date": {"$gte": yr_start, "$lte": yr_end},
        "type": {"$in": ["leave", "tour", "comp_off"]},
    }, {"_id": 0, "type": 1, "status": 1, "start_date": 1, "end_date": 1,
        "paid_leave_used": 1, "lop_days": 1, "comp_off_used": 1,
        "half_day": 1}).to_list(2000)

    today = local_date_str(None)
    buckets = _bucket_leave_rows(rows, today)
    paid_avail = max(0.0, float(opening) - buckets["paid_used"]) if tracked else 0

    absent_ytd_days = 0
    if user.get("category") not in ATHLETE_CATEGORIES:
        absent_ytd_days = await _absent_days_ytd(db, user, co["weekly_off"])

    # Split the comp-off accrual into its three sources so the member-side
    # "My Leave & Tour" stats card can show "X (Y from tours, Z opening)"
    # without re-walking the breakdown on the frontend. Added 28 Jun 2026.
    from_attendance, from_tours, from_opening = _split_comp_off_sources(co)

    return {
        "comp_off": {
            "accrued": co["accrued"],
            "used": co["used"],
            "available": co["available"],
            "from_attendance": from_attendance,
            "from_tours": from_tours,
            "from_opening": from_opening,
        },
        "paid_leave": {
            "opening": opening,
            "used": buckets["paid_used"],
            "available": paid_avail,
            "tracked": tracked,
            # Row-count breakdown of the "used" number so the summary
            # card can render "X leaves used (F full + H half)".
            "full_count": buckets["leave_full_count"],
            "half_count": buckets["leave_half_count"],
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


async def compute_pay_balances(db, user: dict, year: Optional[str] = None) -> dict:
    """Lightweight subset of compute_balance_summary for payroll feeds.

    Returns ONLY the two numbers a payroll pull needs — paid-leave
    available and comp-off available — using the exact same maths as
    compute_balance_summary, but SKIPS the expensive YTD absent-day walk
    (`_absent_days_ytd`: 3 queries + a ~250-day loop per member) and the
    dashboard aggregates the feed never reads. Values are byte-identical
    to compute_balance_summary's `paid_leave.available` / `comp_off.available`.
    """
    co = await compute_comp_off_balance(db, user, year=year)
    if not year:
        year = local_date_str(None)[:4]
    yr_start, yr_end = f"{year}-01-01", f"{year}-12-31"
    opening = user.get("leave_balance_opening")
    tracked = (user.get("category") != "athlete") and (opening is not None)
    rows = await db.leaves.find({
        "user_id": user["id"],
        "start_date": {"$gte": yr_start, "$lte": yr_end},
        "type": {"$in": ["leave", "tour", "comp_off"]},
    }, {"_id": 0, "type": 1, "status": 1, "start_date": 1, "end_date": 1,
        "paid_leave_used": 1, "lop_days": 1, "comp_off_used": 1,
        "half_day": 1}).to_list(2000)
    buckets = _bucket_leave_rows(rows, local_date_str(None))
    paid_avail = max(0.0, float(opening) - buckets["paid_used"]) if tracked else 0
    return {"paid_available": paid_avail, "comp_available": co["available"]}



def _expand_ranges_to_isos(
    rows: list, *, clip_lo: date, clip_hi: date,
    keep: Optional[Callable[[dict], bool]] = None,
) -> set:
    """Explode a list of `{start_date, end_date, …}` rows into the set of
    ISO date strings each row covers, clipped to `[clip_lo, clip_hi]`.
    Optional `keep(row) -> bool` filter runs before the expansion so
    e.g. break-scope rules can be applied without a second loop."""
    out: set = set()
    for row in rows:
        if keep and not keep(row):
            continue
        try:
            sd = date.fromisoformat(row["start_date"])
            ed = date.fromisoformat(row["end_date"])
        except Exception:
            continue
        d = max(sd, clip_lo)
        stop = min(ed, clip_hi)
        while d <= stop:
            out.add(d.isoformat())
            d = date.fromordinal(d.toordinal() + 1)
    return out


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

    Refactored Feb 2026 — the three near-identical date-range expansion
    loops were pulled into `_expand_ranges_to_isos`. Main body is now
    a straight-line pipeline: fetch → build 3 sets → walk YTD → count.
    """
    today_d = date.fromisoformat(local_date_str(None))
    yr_start = date(today_d.year, 1, 1)
    if today_d < yr_start:
        return 0

    # ── Attendance ISOs (already a set of iso strings from Mongo). ──
    atts = await db.attendance.find(
        {"user_id": user["id"],
         "date": {"$gte": yr_start.isoformat(), "$lte": today_d.isoformat()}},
        {"_id": 0, "date": 1},
    ).to_list(500)
    att_set = {a["date"] for a in atts}

    # ── Approved leave/tour ranges → covered ISOs. ──
    leaves_approved = await db.leaves.find({
        "user_id": user["id"], "status": "approved",
        "type": {"$in": ["leave", "tour"]},
        "start_date": {"$lte": today_d.isoformat()},
        "end_date":   {"$gte": yr_start.isoformat()},
    }, {"_id": 0, "start_date": 1, "end_date": 1}).to_list(500)
    leave_set = _expand_ranges_to_isos(leaves_approved, clip_lo=yr_start, clip_hi=today_d)

    # ── Breaks matching the member's scope. ──
    breaks = await db.breaks.find({
        "start_date": {"$lte": today_d.isoformat()},
        "end_date":   {"$gte": yr_start.isoformat()},
    }, {"_id": 0, "scope": 1, "start_date": 1, "end_date": 1, "institution": 1,
        "fleet": 1, "category": 1, "member_ids": 1}).to_list(500)
    break_set = _expand_ranges_to_isos(
        breaks, clip_lo=yr_start, clip_hi=today_d,
        keep=lambda B: _break_covers_user(B, user),
    )

    # ── Walk YTD counting weekdays with no coverage. ──
    wo = (weekly_off or "sunday").lower()
    absent = 0
    d = yr_start
    while d <= today_d:
        if WEEKDAY_KEY[d.weekday()] != wo:
            iso = d.isoformat()
            if iso not in att_set and iso not in leave_set and iso not in break_set:
                absent += 1
        d = date.fromordinal(d.toordinal() + 1)
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


def split_leave_days(requested, comp_off_avail: int, paid_avail: float) -> dict:
    """Split a requested leave (calendar days, may be fractional for
    half-days) across the deduction ladder.

    Order:
      • Comp-off first (whole-days only — comp-off is atomic; the
        half-day remainder always falls to paid leave).
      • Paid leave next.
      • Anything left is LOP.

    Returns a dict ready to stamp on the leave document. `comp_off_used`
    stays an `int`; `paid_leave_used` and `lop_days` may be fractional
    (0.5) for a half-day.
    """
    try:
        requested_f = max(0.0, float(requested))
    except (TypeError, ValueError):
        requested_f = 0.0
    co = min(int(requested_f), max(0, int(comp_off_avail)))
    remaining = requested_f - co
    paid = min(remaining, max(0.0, float(paid_avail)))
    lop = max(0.0, remaining - paid)
    return {
        "comp_off_used": co,
        "paid_leave_used": round(paid, 1),
        "lop_days": round(lop, 1),
    }


async def _resolve_weekly_off(db, user: dict) -> str:
    """Return the effective weekly-off weekday for `user` — member-level
    setting wins, otherwise the org default from Office Settings, finally
    "sunday" if neither is configured."""
    wo = (user.get("weekly_off") or "").lower()
    if wo:
        return wo
    office = await db.config.find_one(
        {"id": "office"}, {"_id": 0, "default_weekly_off": 1}
    )
    return (office or {}).get("default_weekly_off") or "sunday"


def _expand_date_ranges(rows, yr_start: str, yr_end: str) -> set:
    """Flatten a list of `{start_date, end_date}` rows into the set of
    ISO date strings the ranges cover, clipped to [yr_start, yr_end].
    Used to project posting windows (R2) into the day-set the accrual
    loop tests against."""
    out: set = set()
    try:
        ys = date.fromisoformat(yr_start)
        ye = date.fromisoformat(yr_end)
    except Exception:
        return out
    for r in rows:
        try:
            s = max(date.fromisoformat(r["start_date"]), ys)
            e = min(date.fromisoformat(r["end_date"]), ye)
        except Exception:
            continue
        cur = s
        while cur <= e:
            out.add(cur.isoformat())
            cur = date.fromordinal(cur.toordinal() + 1)
    return out


def _accrual_from_attendance(distinct_dates, weekly_off: str,
                             posting_dates: set):
    """+1 per attended weekly-off date that isn't blanked by a posting
    window. Returns (count, breakdown_rows)."""
    count = 0
    rows = []
    for ds in distinct_dates:
        try:
            wd = WEEKDAY_KEY[date.fromisoformat(ds).weekday()]
        except Exception:
            continue
        if wd != weekly_off or ds in posting_dates:
            continue
        count += 1
        rows.append({"date": ds, "kind": "weekly_off"})
    return count, rows


def _accrual_from_tours(tour_rows, weekly_off: str, today_iso: str,
                        att_seen: set, yr_start: str, yr_end: str):
    """+1 per past-or-today weekly-off date inside an approved tour
    window, deduped against the attendance set (so we don't double-count
    a date that already accrued via on-campus attendance) and against
    overlapping tours. Returns (count, breakdown_rows)."""
    seen: set = set()
    count = 0
    rows = []
    try:
        ys = date.fromisoformat(yr_start)
        ye = date.fromisoformat(yr_end)
    except Exception:
        return count, rows
    for L in tour_rows:
        try:
            s = max(date.fromisoformat(L["start_date"]), ys)
            e = min(date.fromisoformat(L["end_date"]), ye)
        except Exception:
            continue
        cur = s
        while cur <= e:
            ds = cur.isoformat()
            if (ds not in seen
                    and ds not in att_seen
                    and ds <= today_iso
                    and WEEKDAY_KEY[cur.weekday()] == weekly_off):
                count += 1
                rows.append({"date": ds, "kind": "tour_weekly_off"})
                seen.add(ds)
            cur = date.fromordinal(cur.toordinal() + 1)
    return count, rows


def _sum_comp_off_used(used_leaves) -> int:
    """Sum approved comp-off consumption across both row shapes:
      • NEW: leave rows carrying a non-zero `comp_off_used` stamp.
      • LEGACY: rows of the now-deprecated `type=comp_off` application,
        which had no stamp — the whole window counts as used.
    """
    total = 0
    for L in used_leaves:
        if "comp_off_used" in L and L["comp_off_used"] is not None:
            total += int(L["comp_off_used"])
        elif L.get("type") == "comp_off":
            total += _days_inclusive(L["start_date"], L["end_date"])
    return total


async def compute_comp_off_balance(db, user: dict, year: Optional[str] = None) -> dict:
    """Live comp-off balance for `user`.

    Accrual sources (summed):
      • Attendance on a weekly-off day (member-effective, see
        `_resolve_weekly_off`). Excluded when the date falls inside an
        approved `posting` window (R2, 30 Jun 2026).
      • Past-or-today weekly-off date inside an approved `tour` window
        (28 Jun 2026; coaches/executives included, athletes excluded).
      • Admin-seeded `user.comp_off_opening` (carry-forward / Day-1 seed).

    Consumption:
      Approved leave rows carrying a non-zero `comp_off_used` stamp
      (unified Leave waterfall) AND legacy `type=comp_off` rows.

    `available = max(0, accrued - used)`.
    """
    if not year:
        year = local_date_str(None)[:4]

    weekly_off = await _resolve_weekly_off(db, user)
    yr_start = f"{year}-01-01"
    yr_end = f"{year}-12-31"

    # Bulk-fetch the three input sets in parallel (motor returns awaitable
    # cursors; we collect them into to_list calls below).
    atts = await db.attendance.find(
        {"user_id": user["id"], "date": {"$gte": yr_start, "$lte": yr_end}},
        {"_id": 0, "date": 1},
    ).to_list(2000)
    distinct_dates = sorted({a["date"] for a in atts})

    posting_rows = await db.leaves.find({
        "user_id": user["id"],
        "type": "posting",
        "status": "approved",
        "start_date": {"$lte": yr_end},
        "end_date": {"$gte": yr_start},
    }, {"_id": 0, "start_date": 1, "end_date": 1}).to_list(200)
    posting_dates = _expand_date_ranges(posting_rows, yr_start, yr_end)

    # ── Accrual: source 1 — attended weekly-off dates ────────────────
    breakdown: List[dict] = []
    att_accrued, att_rows = _accrual_from_attendance(
        distinct_dates, weekly_off, posting_dates,
    )
    breakdown.extend(att_rows)
    accrued = att_accrued

    # ── Accrual: source 2 — past tour weekly-off dates ───────────────
    if (user.get("category") or "").lower() not in ATHLETE_CATEGORIES:
        tour_rows = await db.leaves.find({
            "user_id": user["id"],
            "type": "tour",
            "status": "approved",
            "start_date": {"$lte": yr_end},
            "end_date": {"$gte": yr_start},
        }, {"_id": 0, "start_date": 1, "end_date": 1}).to_list(500)
        today_iso = local_date_str(None)
        att_seen = set(distinct_dates)
        tour_accrued, tour_rows_out = _accrual_from_tours(
            tour_rows, weekly_off, today_iso, att_seen, yr_start, yr_end,
        )
        accrued += tour_accrued
        breakdown.extend(tour_rows_out)

    # ── Accrual: source 3 — admin-seeded opening balance ─────────────
    opening_co = int(user.get("comp_off_opening") or 0)
    if opening_co > 0:
        accrued += opening_co
        breakdown.append({"date": None, "kind": "opening", "count": opening_co})

    # ── Consumption ──────────────────────────────────────────────────
    used_leaves = await db.leaves.find({
        "user_id": user["id"],
        "status": "approved",
        "start_date": {"$lte": yr_end},
        "end_date": {"$gte": yr_start},
        "$or": [{"comp_off_used": {"$gt": 0}}, {"type": "comp_off"}],
    }, {"_id": 0, "type": 1, "start_date": 1, "end_date": 1,
        "comp_off_used": 1}).to_list(500)
    used = _sum_comp_off_used(used_leaves)

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
