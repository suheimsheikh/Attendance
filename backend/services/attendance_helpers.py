"""Attendance helpers (session lookup, geofence, site resolve, one-check-in-per-day, early-out).
Moved out of server.py (Oct 2026) — behaviour unchanged. DB helpers take `db` first."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import HTTPException

from services.geo import haversine_m, resolve_site
from services.time_utils import now_utc


async def open_session_for(db, user_id: str) -> Optional[dict]:
    return await db.attendance.find_one({"user_id": user_id, "check_out_at": None}, {"_id": 0})


async def late_days_in_month(db, user_id: str, date_iso: str) -> int:
    """Distinct late days for the member in the calendar month of `date_iso`."""
    rows = await db.attendance.find(
        {"user_id": user_id, "late": True, "date": {"$gte": date_iso[:7] + "-01", "$lte": date_iso[:7] + "-31"}},
        {"_id": 0, "date": 1},
    ).to_list(200)
    return len({r["date"] for r in rows})


def geo_check(office: dict, lat: float, lng: float, reason: Optional[str]):
    """Returns (distance_m, out_of_geofence). Raises if out and no reason given."""
    dist = round(haversine_m(lat, lng, office["latitude"], office["longitude"]), 1)
    out = dist > office["radius_m"]
    if out and not (reason and reason.strip()):
        raise HTTPException(status_code=400, detail=f"OUT_OF_GEOFENCE:{int(dist)}")
    return dist, out


async def resolve_site_for(db, office: dict, lat: float, lng: float):
    """Wrap services.geo.resolve_site by pulling the active satellite sites
    from the DB. Returns (site_id, site_name, distance_m, out_of_geofence,
    nearest_label). Off-fence check-ins are stamped as the "Off-site"
    bucket (never a real site's name — that misled the Presence board when
    a far-away check-in happened to be nearest e.g. Rowing Academy); the
    nearest fence's label is returned separately for "X m from …" copy."""
    sites = await db.sites.find({"active": True}, {"_id": 0}).to_list(200)
    site_id, site_name, dist, out = resolve_site(office, lat, lng, sites)
    nearest_label = site_name or office.get("name") or "Office"
    if out:
        site_id, site_name = "offsite", "Off-site"
    return site_id, site_name, dist, out, nearest_label


async def cancel_stale_missed_checkin(db, user_id: str, date_iso: str) -> int:
    """When a real attendance row is created for a member+date, auto-cancel
    any still-pending 'missed check-in' correction for that same member+date.
    Once a row exists the correction can never be applied (it would duplicate
    the day), so we resolve it here instead of letting it 409 at approval
    time. Covers both: (a) member files a missed check-in then actually
    checks in that day, and (b) a duplicate correction whose earlier twin
    already produced the row."""
    res = await db.corrections.update_many(
        {"entity_type": "attendance", "kind": "missed_checkin", "status": "pending",
         "requester_id": user_id, "target_date": date_iso},
        {"$set": {"status": "rejected", "decided_at": now_utc().isoformat(),
                  "decided_by_name": "System (auto)",
                  "admin_note": "Auto-resolved — member now has an attendance record for this date, so no missed check-in to create."}},
    )
    return res.modified_count


async def has_checkin_today(db, user_id: str, date_str: str) -> bool:
    """One-check-in-per-day rule (Jun 2026, user-confirmed, no exceptions).
    Once a member has ANY attendance row for the office-local day, a fresh
    check-in is refused across every surface (self GPS, QR/console, muster).
    Intra-day breaks use Step Out (excursions, same row); a check-out ends
    the day. This structurally prevents the auto-checkin-after-checkout bug
    from ever creating a second session again."""
    row = await db.attendance.find_one(
        {"user_id": user_id, "date": date_str}, {"_id": 0, "id": 1})
    return row is not None


def _compute_early_out_at_checkout(ts: datetime, target: dict, office: dict) -> int:
    """Return the number of minutes a checkout is happening BEFORE the
    member's scheduled `work_end`, only when that gap is ≥ 15 min
    (matching the /me/profile-details grace-window). Returns 0 when the
    member has no `work_end` set, when the checkout is on-time or later,
    or on any parsing failure — the callers depend on 0 to mean "no
    early-out stamp needed". Extracted 14 Feb 2026 (item E of the
    medium-risk refactor pass) so this arithmetic can be unit-tested in
    isolation of the DB write path.
    """
    if target.get("hourly_wager"):
        return 0  # no set timings for hourly wagers → never an early-out
    work_end_hm = target.get("work_end")
    if not work_end_hm or ":" not in (work_end_hm or ""):
        return 0
    try:
        from services.time_utils import office_tz
        _out_local = ts.astimezone(office_tz(office))
        _out_min = _out_local.hour * 60 + _out_local.minute
        _we_parts = work_end_hm.split(":")[:2]
        _we_min = int(_we_parts[0]) * 60 + int(_we_parts[1])
        _early_by = _we_min - _out_min
        return _early_by if _early_by >= 15 else 0
    except (ValueError, TypeError, AttributeError):
        return 0


async def clear_hourly_timing_marks(db, office: dict, user_ids: list | None = None) -> int:
    """Hourly wagers have no timings: wipe Late / Early-out stamps on their
    attendance from the current month onward, skipping payroll-locked months.
    Idempotent — runs at startup and when a member is switched to hourly."""
    from services.grid_lock import get_month_lock
    from services.time_utils import local_date_str
    if user_ids is None:
        user_ids = [u["id"] async for u in db.users.find({"hourly_wager": True}, {"_id": 0, "id": 1})]
    if not user_ids:
        return 0
    month = local_date_str(office)[:7]
    q = {"user_id": {"$in": user_ids}, "date": {"$gte": f"{month}-01"},
         "$or": [{"late": True}, {"is_late": True}, {"late_minutes": {"$gt": 0}}, {"early_out_minutes": {"$gt": 0}}]}
    rows = await db.attendance.find(q, {"_id": 0, "id": 1, "date": 1}).to_list(20000)
    locked = {}
    ids = []
    for r in rows:
        m = (r.get("date") or "")[:7]
        if m not in locked:
            locked[m] = bool((await get_month_lock(db, m)).get("locked"))
        if not locked[m]:
            ids.append(r["id"])
    if ids:
        await db.attendance.update_many({"id": {"$in": ids}}, {"$set": {
            "late": False, "is_late": False, "late_minutes": 0,
            "early_out_minutes": 0, "early_out_reason": None}})
    return len(ids)
