"""
Reports endpoints — split out of `server.py`. Hours report, payroll report,
daily leave/tour report, and the CSV/PDF exports for each.

Heavy lifting (the `compute_hours_report` SQL-shaped aggregation) still lives
in `server.py` and is passed in via the factory. Same for `enrich_leaves`,
which is sourced from `routes.leaves` after that router is mounted.
"""
from __future__ import annotations

import csv
import io
from datetime import date, datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Response

from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_RIGHT

from services.time_utils import local_date_str
import breaks as _breaks_module


def _pdf_from_table(
    title: str,
    headers: List[str],
    data: List[List[str]],
    subtitle: str = "",
    *,
    orientation: str = "portrait",
    col_widths: Optional[List[float]] = None,
    meta: Optional[dict] = None,
) -> bytes:
    """Build a tabular PDF. ``orientation`` accepts "portrait" (default)
    or "landscape"; landscape is what wide attendance tables want so the
    left-most columns (member name!) don't clip off the page.

    ``meta`` optionally provides a small key-value header block above the
    table — used by the monthly attendance report to declare the period,
    generation timestamp, and record count so a printed sheet is
    self-explanatory when it lands on the treasurer's desk.
    """
    buf = io.BytesIO()
    pagesize = landscape(A4) if orientation == "landscape" else A4
    doc = SimpleDocTemplate(
        buf, pagesize=pagesize,
        topMargin=15 * mm, bottomMargin=12 * mm,
        # 15 mm gutter on the left kept printers happy — the 10 mm we
        # used earlier was clipping the first character of long member
        # names on standard office printers (user report, 3 Jul 2026).
        leftMargin=15 * mm, rightMargin=12 * mm,
    )
    styles = getSampleStyleSheet()
    title_style = ParagraphStyle(
        "ReportTitle", parent=styles["Title"], fontSize=16, spaceAfter=2,
        alignment=TA_LEFT,
    )
    meta_style = ParagraphStyle(
        "ReportMeta", parent=styles["Normal"], fontSize=9,
        textColor=colors.HexColor("#475569"), leading=12,
    )
    elems = [Paragraph(title, title_style)]
    if subtitle:
        elems.append(Paragraph(subtitle, meta_style))
    if meta:
        # Two-column mini table: label · value. Kept tight so it doesn't
        # steal vertical space from the main data table below.
        mrows = [[Paragraph(f"<b>{k}</b>", meta_style), Paragraph(str(v), meta_style)]
                 for k, v in meta.items()]
        mtbl = Table(mrows, colWidths=[35 * mm, 130 * mm], hAlign="LEFT")
        mtbl.setStyle(TableStyle([
            ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
            ("TOPPADDING", (0, 0), (-1, -1), 1),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ]))
        elems.append(Spacer(1, 3 * mm))
        elems.append(mtbl)
    elems.append(Spacer(1, 5 * mm))
    table_data = [headers] + (data if data else [["No records"] + [""] * (len(headers) - 1)])
    t = Table(table_data, repeatRows=1, colWidths=col_widths)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F2937")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTSIZE", (0, 0), (-1, 0), 9),
        ("FONTSIZE", (0, 1), (-1, -1), 8),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#D1D5DB")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F3F4F6")]),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        # Left-align the Name column (col 0 in the reordered layout)
        # for readability; right-align the rest for number columns.
        ("ALIGN", (0, 1), (0, -1), "LEFT"),
        ("ALIGN", (1, 1), (-1, -1), "CENTER"),
    ]))
    elems.append(t)

    # Small footer with generation timestamp — printed sheets tend to
    # linger, and a "generated 2 Jul 2026 11:04 IST" line saves everyone
    # from arguing whether the numbers are stale.
    footer = ParagraphStyle(
        "Footer", parent=styles["Normal"], fontSize=7,
        textColor=colors.HexColor("#94A3B8"), alignment=TA_RIGHT,
    )
    elems.append(Spacer(1, 5 * mm))
    elems.append(Paragraph(
        f"Generated {datetime.now().strftime('%d %b %Y %H:%M')} · iShowedUp",
        footer,
    ))
    doc.build(elems)
    return buf.getvalue()


def _csv_response(headers: List[str], rows: List[List], filename: str) -> Response:
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(headers)
    for r in rows:
        w.writerow(r)
    return Response(
        content=out.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


def make_router(db, require_admin, get_current_user, compute_hours_report, enrich_leaves) -> APIRouter:
    router = APIRouter(prefix="/api")

    async def _athlete_like_keys(db_) -> set:
        """Pull the set of category keys flagged `is_athlete_like=True` from
        the categories master. Falls back to the seeded pair {athlete,elite}
        if the collection isn't populated yet (fresh install / test)."""
        keys = set()
        async for c in db_.categories.find({"is_athlete_like": True}, {"_id": 0, "key": 1}):
            k = c.get("key")
            if k:
                keys.add(k)
        if not keys:
            keys = {"athlete", "elite"}
        return keys

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
                          admin: dict = Depends(require_admin)):
        rows = await compute_hours_report(start, end)

        # Apply the same filters the admin has set on the UI so the
        # downloaded PDF/CSV matches what they see (30 Jun 2026 late).
        athlete_like = await _athlete_like_keys(db)
        if category == "athlete":
            rows = [r for r in rows if r.get("category") in athlete_like]
        elif category == "rest":
            rows = [r for r in rows if r.get("category") not in athlete_like]
        if fleet:
            if fleet == "__none__":
                rows = [r for r in rows if not r.get("fleet")]
            else:
                rows = [r for r in rows if (r.get("fleet") or "").lower() == fleet.lower()]

        # Trimmed column set (user-requested 3 Jul 2026): Name leads,
        # Weekly-off / Rank / Hours / OT-pending / Overstays / CO-Pending
        # dropped. Fewer, wider columns → no more Name clipping.
        headers = ["Name", "Category", "Attendance %",
                   "Present", "Leave", "Tour", "Absent",
                   "Late", "OT Hrs", "CO Earned", "CO Used"]
        table = [[
            r["member_name"], (r.get("category") or "").title(),
            f"{r['attendance_pct']}%",
            r["days_present"],
            (r.get("days_leave", 0) + r.get("days_break", 0)),
            r.get("days_tour", 0),
            r.get("days_absent", 0),
            r.get("late_days", 0),
            r.get("overtime_hours_approved", 0),
            r.get("comp_off_earned", 0),
            r.get("comp_off_used", 0),
        ] for r in rows]

        if fmt == "pdf":
            office = await db.config.find_one({"id": "office"})
            academy = (office or {}).get("office_name") or "iShowedUp"
            # dd/mm/yyyy display for the meta block + subtitle.
            def _ddmmyyyy(iso: str) -> str:
                try:
                    y, m, d = iso.split("-")
                    return f"{d}/{m}/{y}"
                except Exception:
                    return iso
            period_disp = f"{_ddmmyyyy(start)}  to  {_ddmmyyyy(end)}"
            # Days elapsed in the reporting window (inclusive both ends).
            try:
                d0 = date.fromisoformat(start)
                d1 = date.fromisoformat(end)
                elapsed = (d1 - d0).days + 1
            except Exception:
                elapsed = 0
            # Human filter descriptors so the report is self-describing.
            cat_label = {"athlete": "Athletes",
                         "rest": "Staff & Coaches (incl. Executive)"}.get(category, "All")
            filter_label = cat_label
            if fleet:
                filter_label += f" · Fleet: {'(No fleet)' if fleet == '__none__' else fleet}"
            meta = {
                "Academy": academy,
                "Period": period_disp,
                "Days elapsed": str(elapsed),
                "Filter": filter_label,
                "Members": str(len(rows)),
                "Generated by": admin.get("full_name") or admin.get("email") or "Admin",
            }
            # Column widths (mm) for landscape A4 (usable ~277 mm after
            # margins). Sum here = 265 mm — leaves comfortable slack so
            # ReportLab doesn't force-shrink the leftmost cells.
            #   Name   Cat  Att%  Pres Leave Tour Abs  Late OT  COe  COu
            col_widths_mm = [55,   28,   22,   19,   19,   16,  19,  16,  22, 25, 24]
            pdf = _pdf_from_table(
                "Attendance Report",
                headers, table,
                subtitle=period_disp,
                orientation="landscape",
                col_widths=[w * mm for w in col_widths_mm],
                meta=meta,
            )
            return Response(content=pdf, media_type="application/pdf",
                            headers={"Content-Disposition": f"attachment; filename=hours_{start}_{end}.pdf"})
        return _csv_response(headers, table, f"hours_{start}_{end}.csv")

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
        WEEKDAY_NAME = ["monday", "tuesday", "wednesday", "thursday",
                        "friday", "saturday", "sunday"]
        WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

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
        wo_idx = WEEKDAY_NAME.index(wo_name) if wo_name in WEEKDAY_NAME else 0

        # Bucket labels — the primary bucket the row is classified under.
        LABELS = {
            "present": "Present",
            "leave": "Leave",
            "tour": "Tour",
            "posting": "Posting",
            "comp_off": "Comp-off",
            "late_coming": "Late-coming approved",
            "break": "Break / Holiday",
            "escort": "Escort duty",
            "off_weekly": "Weekly off",
            "off_in_progress": "In progress (today)",
            "absent": "Absent",
        }
        # Priority order when a day has multiple markers — earliest wins.
        PRIORITY = ["present", "leave", "tour", "posting", "comp_off",
                    "late_coming", "break", "escort"]
        # Buckets that count as "accounted" (member is NOT absent on
        # that date). Mirrors the aggregation in server.compute_hours_report.
        ACCOUNTED = {"present", "leave", "tour", "posting", "comp_off",
                     "late_coming", "break"}

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

            has_accounted = any(b in ACCOUNTED for b in buckets)
            is_wo = weekday_idx == wo_idx

            if not has_accounted:
                if is_wo:
                    primary = "off_weekly"
                elif iso == today_iso:
                    primary = "off_in_progress"
                else:
                    primary = "absent"
            else:
                primary = next((b for b in PRIORITY if b in buckets), buckets[0])

            days_out.append({
                "date": iso,
                "weekday": WEEKDAY_SHORT[weekday_idx],
                "bucket": primary,
                "label": LABELS.get(primary, primary.title()),
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

    @router.get("/reports/ot-ledger")
    async def ot_ledger(
        member_id: str, year: int,
        admin: dict = Depends(require_admin),
    ):
        """Date-wise overtime sessions for a single member across a
        calendar year. Powers the double-click OT drill-down modal on
        the Comp-off columns in the Attendance report.

        Returns every attendance row that had any OT minutes recorded,
        with early / late split, start & end times, reason, and
        approval status.
        """
        start = f"{year}-01-01"
        end = f"{year}-12-31"
        rows = await db.attendance.find(
            {"user_id": member_id,
             "date": {"$gte": start, "$lte": end},
             "overtime_total_min": {"$gt": 0}},
            {"_id": 0,
             "date": 1, "check_in_at": 1, "check_out_at": 1,
             "overtime_early_min": 1, "overtime_late_min": 1,
             "overtime_total_min": 1, "overtime_reason": 1,
             "overtime_status": 1, "overtime_admin_note": 1,
             "work_start_at_session": 1, "work_end_at_session": 1,
             "overtime_decided_by": 1, "overtime_decided_at": 1},
        ).sort("date", 1).to_list(2000)
        u = await db.users.find_one(
            {"id": member_id},
            {"_id": 0, "full_name": 1, "rank": 1, "category": 1},
        )
        total_min = sum(int(r.get("overtime_total_min") or 0) for r in rows)
        return {
            "member_id": member_id,
            "member_name": (u or {}).get("full_name"),
            "rank": (u or {}).get("rank"),
            "category": (u or {}).get("category"),
            "year": year,
            "total_minutes": total_min,
            "rows": rows,
        }

    return router
