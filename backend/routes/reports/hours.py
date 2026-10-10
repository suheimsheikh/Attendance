"""Reports routes — hours. Split out of routes/reports/__init__.py (Oct 2026); behaviour unchanged."""
from __future__ import annotations

from routes.reports.common import (
    Depends,
    Optional,
    Response,
    _csv_response,
    _pdf_from_table,
    date,
    is_super_admin,
    local_date_str,
    mm,
    timedelta,
)


def register(router, *, _athlete_like_keys, compute_hours_report, db, enrich_leaves, get_current_user, require_admin):
    @router.get("/reports/hours")
    async def hours_report(start: str, end: str, admin: dict = Depends(require_admin)):
        rows = await compute_hours_report(start, end)
        return {"start": start, "end": end, "rows": rows}

    @router.get("/reports/payroll")
    async def payroll_report(
        month: Optional[str] = None,
        category: Optional[str] = None,
        fleet: Optional[str] = None,
        admin: dict = Depends(require_admin),
    ):
        """Monthly attendance & payroll report. `month` = YYYY-MM
        (defaults to the previous calendar month so a 1st-of-month run
        pulls last month's numbers).

        As of 7 Jul 2026 this is the *unified* monthly view used by the
        merged Reports > Attendance tab — it now returns EVERY member
        by default (athletes + staff + coaches + executives) with the
        leave-balance decoration attached. The optional `category`
        filter follows the same vocabulary as /reports/hours:
          - `athlete` → athletes only
          - `rest`    → staff + coach + executive (drops athletes)
          - `payroll` → legacy alias for staff + coach only
        And `fleet` filters athlete rows by class-wise fleet name.
        """
        office = await db.config.find_one({"id": "office"})
        today = date.fromisoformat(local_date_str(office))
        if not month:
            first_this = today.replace(day=1)
            last_prev = first_this - timedelta(days=1)
            month = f"{last_prev.year:04d}-{last_prev.month:02d}"
        y, m = (int(x) for x in month.split("-"))
        start_d = date(y, m, 1)
        if m == 12:
            end_d = date(y + 1, 1, 1) - timedelta(days=1)
        else:
            end_d = date(y, m + 1, 1) - timedelta(days=1)
        # Clamp end-date to `today` when the caller asked for the
        # *current* calendar month — otherwise the mid-month running-
        # total view over-counts absent/off days (e.g. Attendance % on
        # 7 Jul 2026 divides by the whole 31-day July instead of the
        # elapsed 7). Past / future months keep their full spans.
        if start_d <= today <= end_d:
            end_d = today
        start_iso, end_iso = start_d.isoformat(), end_d.isoformat()
        rows = await compute_hours_report(start_iso, end_iso)
        # Athlete-like category set — pulls from categories master so Elite
        # (and any future admin-added athlete-like custom category) is bucketed
        # WITH athletes, not with Staff & Coaches. Fixes 15 Jul 2026 user
        # report "In the staff and coaches filter a lot of athletes appear".
        athlete_like = await _athlete_like_keys(db)
        # Category filter — merged 7 Jul 2026 to match /reports/hours.
        # `category` here is a QUERY PARAM string (`?category=athlete`),
        # not a DB field. Actual filter on the next line uses the
        # athlete-like set correctly. cat-health-ok
        if category == "athlete":
            rows = [r for r in rows if r.get("category") in athlete_like]
        elif category == "rest":
            rows = [r for r in rows if r.get("category") not in athlete_like]
        elif category == "payroll":
            rows = [r for r in rows if r.get("category") in {"staff", "coach"}]
        # Fleet (class-wise) filter — mirrors the Hours export.
        if fleet:
            if fleet == "__none__":
                rows = [r for r in rows if not r.get("fleet")]
            else:
                rows = [r for r in rows if (r.get("fleet") or "").lower() == fleet.lower()]
        # Attach leave balance (annual taken vs opening, computed from full year-to-date)
        users = await db.users.find({}, {"_id": 0, "id": 1, "leave_balance_opening": 1}).to_list(2000)
        opening_map = {u["id"]: float(u.get("leave_balance_opening") or 0) for u in users}
        leaves = await db.leaves.find({
            "status": "approved", "type": "leave",
            "start_date": {"$gte": f"{y}-01-01", "$lte": f"{y}-12-31"},
        }, {"_id": 0}).to_list(20000)
        ytd_taken: dict = {}
        for leave in leaves:
            # Half-day leaves (FN/PN) cost 0.5, matching the canonical
            # deduction used everywhere else (leaves.py). Previously every
            # single-day leave counted as 1, silently eating 0.5 of paid
            # balance per half-day leave (28 Sep 2026 code-review fix).
            if leave.get("half_day"):
                n = 0.5
            else:
                try:
                    n = (date.fromisoformat(leave["end_date"]) - date.fromisoformat(leave["start_date"])).days + 1
                except Exception:
                    n = 1
            ytd_taken[leave["user_id"]] = ytd_taken.get(leave["user_id"], 0) + n
        for r in rows:
            opening = opening_map.get(r["member_id"], 0.0)
            taken = float(ytd_taken.get(r["member_id"], 0))
            r["leave_balance_opening"] = opening
            r["leave_balance_taken_ytd"] = taken
            r["leave_balance_remaining"] = round(opening - taken, 1)
        return {"month": month, "start": start_iso, "end": end_iso, "rows": rows}

    @router.get("/reports/daily")
    async def daily_report(on: Optional[str] = None, user: dict = Depends(get_current_user)):
        """Daily leave & tour report for a given date (default today)."""
        if not on:
            office = await db.config.find_one({"id": "office"})
            on = local_date_str(office)
        leaves = await db.leaves.find({
            "status": "approved",
            "start_date": {"$lte": on},
            "end_date": {"$gte": on},
        }, {"_id": 0}).to_list(1000)
        leaves = await enrich_leaves(leaves)
        on_leave = [leave for leave in leaves if leave["type"] == "leave"]
        # R2 (30 Jun 2026): Postings ride in the on_tour bucket so the
        # daily report's "On Tour" tile gives admins a single view of who's
        # off-base. The row carries `type=posting` so the frontend can
        # label it "POSTED" rather than "Tour".
        on_tour = [leave for leave in leaves if leave["type"] in ("tour", "posting")]
        return {"date": on, "on_leave": on_leave, "on_tour": on_tour}

    @router.get("/reports/hours/export")
    async def export_hours(start: str, end: str, fmt: str = "csv",
                          category: Optional[str] = None,
                          fleet: Optional[str] = None,
                          institution: Optional[str] = None,
                          admin: dict = Depends(require_admin)):
        rows = await compute_hours_report(start, end)
        # Super-admin gating (04 Feb 2026). The Hours group (Total/Avg
        # hours) is privacy-sensitive. Regular admins get the same
        # 17-column report minus the last 2 columns.
        show_hours = is_super_admin(admin)

        # Apply the same filters the admin has set on the UI so the
        # downloaded PDF/CSV matches what they see (30 Jun 2026 late).
        # `category` is a QUERY PARAM, not a DB field. Values map to
        # the on-screen chip clicks: 'athlete' + 'elite' + 'rest'
        # + 'escorts' + any custom key. 04 Feb 2026: elite added as a
        # distinct chip; institution filter added. cat-health-ok
        athlete_like = await _athlete_like_keys(db)
        if category == "athlete":
            rows = [r for r in rows if r.get("category") in athlete_like]
        elif category == "elite":
            rows = [r for r in rows if r.get("category") == "elite"]
        elif category == "rest":
            rows = [r for r in rows if r.get("category") not in athlete_like]
        if fleet:
            if fleet == "__none__":
                rows = [r for r in rows if not r.get("fleet")]
            else:
                rows = [r for r in rows if (r.get("fleet") or "").lower() == fleet.lower()]
        if institution:
            rows = [r for r in rows if (r.get("institution") or "") == institution]

        # 4 Feb 2026 — column set expanded to mirror the on-screen table
        # exactly (17 columns, grouped). Escort columns were removed at
        # the user's request ("not sure why they are there"). Overtime
        # + Comp-Off collapsed from 3 sub-columns each to a single
        # column each (04 Feb 2026 later request) — the OT and CO
        # ledger drill-downs still carry the full applied/approved
        # breakdown per session.
        def _attn_tot(r):
            return (r.get("days_present", 0) + r.get("days_leave", 0)
                    + r.get("days_tour", 0) + r.get("days_off", 0))
        def _n(v):
            return v if v else ""
        def _h(v):
            if not v:
                return ""
            f = float(v)
            s = f"{f:.2f}".rstrip("0").rstrip(".")
            return f"{s}h"
        # Leave / Comp-Off derived fields — mirror the calcs in the
        # Reports.jsx table so the printed values line up with what
        # admins see on-screen.
        def _lv_open(r):
            return r.get("leave_opening_balance", 0)
        def _lv_coff(r):
            return max(0, r.get("comp_off_earned", 0) - r.get("comp_off_used", 0))
        def _lv_total(r):
            return _lv_open(r) + _lv_coff(r)
        def _lv_avld(r):
            return r.get("days_leave", 0)
        def _lv_close(r):
            return _lv_total(r) - _lv_avld(r)

        # 17 column headers matching on-screen sub-header row. Hours
        # group (last 2) omitted for non-super-admins.
        headers = [
            "Member", "Cat",
            # Attendance (8) — group tint emerald
            "Pres", "Lv", "Tour", "Off", "Late", "Half", "Abs", "Tot",
            # Leave (5) — amber
            "Open", "COff", "Total", "Avld", "Close",
            # Overtime (1) — violet
            "OT",
            # Comp-Off (1) — sky
            "CO",
        ]
        if show_hours:
            headers += ["Tot h", "Avg h"]

        def _row(r):
            base = [
                r["member_name"],
                (r.get("category") or "").title(),
                _n(r.get("days_present", 0)),
                _n(r.get("days_leave", 0)),
                _n(r.get("days_tour", 0)),
                _n(r.get("days_off", 0)),
                _n(r.get("late_days", 0)),
                _n(r.get("half_days", 0)),
                _n(r.get("days_absent", 0)),
                _n(_attn_tot(r)),
                _n(_lv_open(r)),
                _n(_lv_coff(r)),
                _n(_lv_total(r)),
                _n(_lv_avld(r)),
                _n(_lv_close(r)),
                _h(r.get("overtime_hours_served", 0)),
                _n(r.get("comp_off_earned", 0)),
            ]
            if show_hours:
                base += [
                    _h(r.get("total_hours", 0)),
                    _h(r.get("avg_hours_per_day", 0)),
                ]
            return base
        table = [_row(r) for r in rows]

        if fmt == "pdf":
            office = await db.config.find_one({"id": "office"})
            academy = (office or {}).get("office_name") or "iShowedUp"
            def _ddmmyyyy(iso: str) -> str:
                try:
                    y, m, d = iso.split("-")
                    return f"{d}/{m}/{y[-2:]}"
                except Exception:
                    return iso
            period_disp = f"{_ddmmyyyy(start)}  to  {_ddmmyyyy(end)}"
            try:
                d0 = date.fromisoformat(start)
                d1 = date.fromisoformat(end)
                elapsed = (d1 - d0).days + 1
            except Exception:
                elapsed = 0
            # Filter descriptor — mirrors the chip label on-screen so
            # the printed sheet is self-describing.
            cat_label = {
                "athlete": "Athletes",
                "elite":   "Elite Squad",
                "rest":    "Staff & Coaches (incl. Executive)",
                "escorts": "Escorts (separate table on-screen)",
            }.get(category, "All")
            meta = {
                "Academy": academy,
                "Period": period_disp,
                "Days elapsed": str(elapsed),
                "Category": cat_label,
                "Fleet": "(No fleet)" if fleet == "__none__" else (fleet or "All"),
                "Institution": institution or "All",
                "Members": str(len(rows)),
                "Generated by": admin.get("full_name") or admin.get("email") or "Admin",
            }
            # Column widths (mm) matched to the header count.
            base_widths = [45, 22,
                           15, 12, 14, 12, 14, 14, 14, 16,
                           15, 15, 17, 15, 17,
                           22,
                           22]
            base_groups = [
                ("", 2, None),
                ("Attendance", 8, "#D1FAE5"),   # emerald-100
                ("Leave", 5, "#FEF3C7"),         # amber-100
                ("Overtime", 1, "#EDE9FE"),      # violet-100
                ("Comp-Off", 1, "#E0F2FE"),      # sky-100
            ]
            if show_hours:
                col_widths_mm = base_widths + [15, 15]
                grouped_headers = base_groups + [("Hours", 2, "#E0E7FF")]
            else:
                col_widths_mm = base_widths
                grouped_headers = base_groups
            pdf = _pdf_from_table(
                "Attendance Report",
                headers, table,
                subtitle=period_disp,
                orientation="landscape",
                col_widths=[w * mm for w in col_widths_mm],
                meta=meta,
                grouped_headers=grouped_headers,
                font_size=8,
            )
            return Response(content=pdf, media_type="application/pdf",
                            headers={"Content-Disposition": f"attachment; filename=attendance_{start}_{end}.pdf"})
        return _csv_response(headers, table, f"attendance_{start}_{end}.csv")

    @router.get("/reports/daily/export")
    async def export_daily(on: Optional[str] = None, fmt: str = "csv", user: dict = Depends(get_current_user)):
        if not on:
            office = await db.config.find_one({"id": "office"})
            on = local_date_str(office)
        leaves = await db.leaves.find({
            "status": "approved",
            "start_date": {"$lte": on},
            "end_date": {"$gte": on},
        }, {"_id": 0}).to_list(1000)
        leaves = await enrich_leaves(leaves)
        headers = ["Name", "Type", "Location", "From", "Till", "Reason"]
        table = [[leave["member_name"], leave["type"].title(), leave.get("location") or "-",
                  leave["start_date"], leave["end_date"], leave.get("reason") or "-"] for leave in leaves]
        if fmt == "pdf":
            pdf = _pdf_from_table("Daily Leave & Tour Report", headers, table, f"Date: {on}")
            return Response(content=pdf, media_type="application/pdf",
                            headers={"Content-Disposition": f"attachment; filename=daily_{on}.pdf"})
        return _csv_response(headers, table, f"daily_{on}.csv")

    return {}
