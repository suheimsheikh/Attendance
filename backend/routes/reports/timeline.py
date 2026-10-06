"""Reports routes — timeline. Split out of routes/reports/__init__.py (Oct 2026); behaviour unchanged."""
from __future__ import annotations

from routes.reports.common import (  # noqa: F401
    Depends,
    HTTPException,
    _TIMELINE_LABELS,
    _WEEKDAY_NAME,
    _WEEKDAY_SHORT,
    _breaks_module,
    _classify_timeline_day,
    date,
    local_date_str,
    timedelta,
)


def register(router, *, db, require_admin):
    @router.get("/reports/member-timeline")
    async def member_timeline(
        member_id: str, start: str, end: str,
        admin: dict = Depends(require_admin),
    ):
        """Day-by-day breakdown for a single member across [start, end].

        Powers the double-click drill-down modal on the Attendance table
        (7 Jul 2026 user-requested "why is X absent again?"). Every
        calendar day in the window gets one row with a primary
        `bucket` (present/absent/leave/tour/…), a human `label`, and a
        `details` list carrying the underlying record(s) — attendance
        session times, leave reasons, half-day flags, late-coming
        expected-arrivals, overtime status, etc.
        """
        user = await db.users.find_one({"id": member_id}, {"_id": 0})
        if not user:
            raise HTTPException(status_code=404, detail="Member not found")

        try:
            sd = date.fromisoformat(start)
            ed = date.fromisoformat(end)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid start/end date")
        if ed < sd:
            raise HTTPException(status_code=400, detail="end must be >= start")

        # Attendance sessions in window
        sessions = await db.attendance.find(
            {"user_id": member_id,
             "date": {"$gte": start, "$lte": end}},
            {"_id": 0},
        ).to_list(500)
        sessions_by_date = {s["date"]: s for s in sessions}

        # Leaves overlapping window (all statuses so we can show
        # pending/rejected too — admins want the full trail)
        leaves = await db.leaves.find(
            {"user_id": member_id,
             "start_date": {"$lte": end},
             "end_date": {"$gte": start}},
            {"_id": 0},
        ).to_list(500)

        def _expand(ls: str, le: str):
            try:
                a = max(date.fromisoformat(ls), sd)
                b = min(date.fromisoformat(le), ed)
            except ValueError:
                return
            while a <= b:
                yield a.isoformat()
                a += timedelta(days=1)

        leaves_by_date: dict = {}
        for lv in leaves:
            for iso in _expand(lv["start_date"], lv["end_date"]):
                leaves_by_date.setdefault(iso, []).append(lv)

        # Breaks that apply to this member
        breaks_window = await db.breaks.find(
            {"start_date": {"$lte": end}, "end_date": {"$gte": start}},
            {"_id": 0},
        ).to_list(200)
        break_dates_by_date: dict = {}
        for b in breaks_window:
            if not _breaks_module.break_applies_to(b, user):
                continue
            for iso in _expand(b["start_date"], b["end_date"]):
                break_dates_by_date.setdefault(iso, []).append(b)

        # Escort-duty days
        escort_rows = await db.escort_attendance.find(
            {"date": {"$gte": start, "$lte": end}},
            {"_id": 0, "date": 1, "check_in_athlete_ids": 1},
        ).to_list(500)
        escort_dates = {
            er["date"] for er in escort_rows
            if member_id in (er.get("check_in_athlete_ids") or [])
        }

        # Today (in the office's timezone) — powers the in-progress classification
        office = await db.config.find_one({"id": "office"})
        today_iso = local_date_str(office)

        wo_name = (user.get("weekly_off") or "monday").lower()
        wo_idx = _WEEKDAY_NAME.index(wo_name) if wo_name in _WEEKDAY_NAME else 0

        days_out = []
        cur = sd
        while cur <= ed:
            iso = cur.isoformat()
            weekday_idx = cur.weekday()
            buckets: list = []
            details: list = []

            s = sessions_by_date.get(iso)
            if s:
                buckets.append("present")
                details.append({
                    "type": "attendance",
                    "check_in_time": s.get("check_in_time"),
                    "check_out_time": s.get("check_out_time"),
                    "hours": s.get("hours"),
                    "late": bool(s.get("late")),
                    "late_minutes": s.get("late_minutes"),
                    "method": s.get("method"),
                    "auto_checkout": bool(s.get("auto_checkout")),
                    "missing_checkout": bool(s.get("missing_checkout")),
                    "needs_correction": bool(s.get("needs_correction")),
                    "overtime_total_min": s.get("overtime_total_min"),
                    "overtime_status": s.get("overtime_status"),
                    "out_of_geofence": bool(s.get("out_of_geofence")),
                })

            for lv in leaves_by_date.get(iso, []):
                if lv.get("status") not in ("approved", "pending"):
                    # Rejected/cancelled leaves are worth surfacing too
                    # so admins can see "she tried to file but it was
                    # rejected" — kept as a distinct detail entry.
                    details.append({
                        "type": lv["type"],
                        "status": lv["status"],
                        "reason": lv.get("reason"),
                        "start_date": lv["start_date"],
                        "end_date": lv["end_date"],
                    })
                    continue
                buckets.append(lv["type"])
                details.append({
                    "type": lv["type"],
                    "status": lv["status"],
                    "reason": lv.get("reason"),
                    "location": lv.get("location"),
                    "half_day": lv.get("half_day"),
                    "expected_arrival": lv.get("expected_arrival"),
                    "start_date": lv["start_date"],
                    "end_date": lv["end_date"],
                })

            for b in break_dates_by_date.get(iso, []):
                buckets.append("break")
                details.append({
                    "type": "break",
                    "name": b.get("name") or b.get("title"),
                    "start_date": b["start_date"],
                    "end_date": b["end_date"],
                })

            if iso in escort_dates:
                buckets.append("escort")
                details.append({"type": "escort"})

            is_wo = weekday_idx == wo_idx
            primary = _classify_timeline_day(
                buckets, iso=iso, today_iso=today_iso, is_weekly_off=is_wo,
            )

            days_out.append({
                "date": iso,
                "weekday": _WEEKDAY_SHORT[weekday_idx],
                "bucket": primary,
                "label": _TIMELINE_LABELS.get(primary, primary.title()),
                "buckets": list(dict.fromkeys(buckets)),  # unique, insertion order
                "details": details,
                "is_weekly_off": is_wo,
                "is_today": iso == today_iso,
            })
            cur += timedelta(days=1)

        return {
            "member_id": member_id,
            "member_name": user.get("full_name"),
            "category": user.get("category"),
            "rank": user.get("rank"),
            "weekly_off": user.get("weekly_off"),
            "fleet": user.get("fleet"),
            "start": start,
            "end": end,
            "days": days_out,
        }

    @router.get("/reports/escort-attendance")
    async def escort_attendance_report(
        start: str, end: str,
        admin: dict = Depends(require_admin),
    ):
        """Escort-only attendance summary for the Reports page. Powers
        the "Escorts" filter chip when the admin wants to see the
        parent-escorts themselves (not the athletes they accompany).

        Returns one row per escort with total present-days across the
        window plus the specific date list for the drill-down popover.
        """
        rows = await db.escort_attendance.find(
            {"date": {"$gte": start, "$lte": end}},
            {"_id": 0, "escort_id": 1, "date": 1},
        ).to_list(20000)
        by_id: dict = {}
        for r in rows:
            d = by_id.setdefault(r["escort_id"], {"dates": set()})
            d["dates"].add(r["date"])
        # Hydrate escort metadata (name / institution).
        escort_ids = list(by_id.keys())
        escorts = {
            e["id"]: e for e in await db.escorts.find(
                {"id": {"$in": escort_ids}},
                {"_id": 0, "id": 1, "name": 1, "institution": 1, "mobile": 1},
            ).to_list(len(escort_ids) + 1)
        }
        out = []
        for eid, agg in by_id.items():
            e = escorts.get(eid, {})
            out.append({
                "escort_id": eid,
                "name": e.get("name") or "(deleted)",
                "institution": e.get("institution"),
                "mobile": e.get("mobile"),
                "days_present": len(agg["dates"]),
                "dates_present": sorted(agg["dates"]),
            })
        out.sort(key=lambda r: (r["name"] or "").lower())
        return {"start": start, "end": end, "rows": out}

    return {}
