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
    headers,
    data: List[List[str]],
    subtitle: str = "",
    *,
    orientation: str = "portrait",
    col_widths: Optional[List[float]] = None,
    meta: Optional[dict] = None,
    grouped_headers: Optional[List[tuple]] = None,
    group_colors: Optional[List[str]] = None,
    pagesize_override=None,
    font_size: int = 8,
) -> bytes:
    """Build a tabular PDF. ``orientation`` accepts "portrait" (default)
    or "landscape"; landscape is what wide attendance tables want so the
    left-most columns (member name!) don't clip off the page.

    ``meta`` optionally provides a small key-value header block above the
    table — used by the monthly attendance report to declare the period,
    generation timestamp, and record count so a printed sheet is
    self-explanatory when it lands on the treasurer's desk.

    ``grouped_headers`` optionally renders a super-header row above the
    column headers (e.g. Attendance / Leave / Overtime / Comp-Off /
    Hours) matching the on-screen grouped table. Format: list of
    (label, span, tint_hex) tuples. Span sums must equal len(headers).
    ``group_colors`` optionally tints the column headers row per group.

    ``pagesize_override`` lets the caller pass an explicit ReportLab
    pagesize (e.g. A3 in landscape when the table is very wide). If
    None, uses A4 in the given orientation.

    ``font_size`` sets the body font size — the wide monthly attendance
    PDF uses 7pt to fit 21 columns on A4 landscape.
    """
    buf = io.BytesIO()
    if pagesize_override is not None:
        pagesize = pagesize_override
    else:
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
    # Build the data table. When `grouped_headers` is provided we prepend
    # a super-header row (spanning across sub-headers) matching the
    # on-screen grouped layout — critical so the printed PDF is visually
    # identical to what admins see in the browser (04 Feb 2026 user
    # request "the pdf should be exactly the same as what's on screen
    # including filters").
    header_rows: List[List] = []
    style_ops: List[tuple] = [
        ("FONTSIZE", (0, 0), (-1, -1), font_size),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#D1D5DB")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 2),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
    ]
    if grouped_headers:
        # Row 0 = super-headers (spans). Fill each cell with the label
        # at the start of the span; empty strings after that get merged
        # via a SPAN op.
        super_row: List[str] = []
        col = 0
        # 4 Feb 2026: build the merged super-header spans. Each entry is
        # (label, span, hex_bg_or_None). Label lands in the first cell
        # of the span; the rest are blanked then SPAN-merged.
        for label, span, tint in grouped_headers:
            super_row.append(label)
            for _ in range(span - 1):
                super_row.append("")
            if span > 1:
                style_ops.append(("SPAN", (col, 0), (col + span - 1, 0)))
            if tint:
                style_ops.append(("BACKGROUND", (col, 0), (col + span - 1, 0), colors.HexColor(tint)))
                style_ops.append(("TEXTCOLOR", (col, 0), (col + span - 1, 0), colors.HexColor("#334155")))
            style_ops.append(("ALIGN", (col, 0), (col + span - 1, 0), "CENTER"))
            col += span
        header_rows.append(super_row)
        # Row 1 = column headers themselves.
        header_rows.append(list(headers))
        header_rows_count = 2
    else:
        header_rows.append(list(headers))
        header_rows_count = 1
    # Style the column-header row (last of the header rows).
    hdr_row_idx = header_rows_count - 1
    style_ops.extend([
        ("BACKGROUND", (0, hdr_row_idx), (-1, hdr_row_idx), colors.HexColor("#1F2937")),
        ("TEXTCOLOR", (0, hdr_row_idx), (-1, hdr_row_idx), colors.white),
        ("FONTSIZE", (0, hdr_row_idx), (-1, hdr_row_idx), max(font_size, 7)),
        ("FONTNAME", (0, hdr_row_idx), (-1, hdr_row_idx), "Helvetica-Bold"),
    ])
    if grouped_headers:
        # Bold the super-header row too, with a slightly larger font
        # so admins can eyeball the group at a glance.
        style_ops.extend([
            ("FONTSIZE", (0, 0), (-1, 0), max(font_size + 1, 8)),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ])
    # Row banding on data rows (start = header count).
    style_ops.extend([
        ("ROWBACKGROUNDS", (0, header_rows_count), (-1, -1),
         [colors.white, colors.HexColor("#F3F4F6")]),
        # Left-align the Name column for readability; center-align the
        # rest for tight number columns.
        ("ALIGN", (0, header_rows_count), (0, -1), "LEFT"),
        ("ALIGN", (1, header_rows_count), (-1, -1), "CENTER"),
    ])
    table_data = header_rows + (data if data else [["No records"] + [""] * (len(headers) - 1)])
    t = Table(table_data, repeatRows=header_rows_count, colWidths=col_widths)
    t.setStyle(TableStyle(style_ops))
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
        # exactly (21 columns, grouped). Escort columns were removed at
        # the user's request ("not sure why they are there"). Grouped
        # header row above the sub-headers matches the screen tinting
        # so a printed sheet is visually identical.
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

        # 21 column headers matching on-screen sub-header row.
        headers = [
            "Member", "Cat",
            # Attendance (8) — group tint emerald
            "Pres", "Lv", "Tour", "Off", "Late", "Half", "Abs", "Tot",
            # Leave (5) — amber
            "Open", "COff", "Total", "Avld", "Close",
            # Overtime (3) — violet
            "OT Srvd", "OT Appl", "OT Apprv",
            # Comp-Off (3) — sky
            "CO Srvd", "CO Appl", "CO Apprv",
            # Hours (2) — indigo
            "Tot h", "Avg h",
        ]
        table = [[
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
            _h(r.get("overtime_hours_pending", 0)),
            _h(r.get("overtime_hours_approved", 0)),
            _n(r.get("comp_off_earned", 0)),
            _n(r.get("comp_off_applied", 0)),
            _n(r.get("comp_off_used", 0)),
            _h(r.get("total_hours", 0)),
            _h(r.get("avg_hours_per_day", 0)),
        ] for r in rows]

        if fmt == "pdf":
            from reportlab.lib.pagesizes import A3
            office = await db.config.find_one({"id": "office"})
            academy = (office or {}).get("office_name") or "iShowedUp"
            def _ddmmyyyy(iso: str) -> str:
                try:
                    y, m, d = iso.split("-")
                    return f"{d}/{m}/{y}"
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
            # A3 landscape (~420mm × 297mm) fits 21 tight columns
            # without eating the Name column. Widths sum to ~395mm —
            # ReportLab absorbs the small slack.
            #                Mem  Cat |  Pres Lv Tour Off Late Half Abs Tot |  Open COff Total Avld Close |  Srvd Appl Apprv |  Srvd Appl Apprv |  Toth  Avgh
            col_widths_mm = [55, 22,
                             15, 12, 14, 12, 14, 14, 14, 18,
                             16, 16, 18, 16, 18,
                             18, 18, 20,
                             18, 18, 20,
                             18, 18]
            grouped_headers = [
                ("", 2, None),
                ("Attendance", 8, "#D1FAE5"),   # emerald-100
                ("Leave", 5, "#FEF3C7"),         # amber-100
                ("Overtime", 3, "#EDE9FE"),      # violet-100
                ("Comp-Off", 3, "#E0F2FE"),      # sky-100
                ("Hours", 2, "#E0E7FF"),         # indigo-100
            ]
            pdf = _pdf_from_table(
                "Attendance Report",
                headers, table,
                subtitle=period_disp,
                orientation="landscape",
                pagesize_override=landscape(A3),
                col_widths=[w * mm for w in col_widths_mm],
                meta=meta,
                grouped_headers=grouped_headers,
                font_size=7,
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
             "overtime_total_min": 1,
             # Legacy single-field reason kept for backward compat with
             # rows pre-8-Jul-2026 that never had the split. Post-split
             # rows carry both `overtime_early_reason` + `overtime_late_reason`.
             "overtime_reason": 1,
             "overtime_early_reason": 1, "overtime_late_reason": 1,
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

    @router.get("/reports/ot-ledger/export")
    async def export_ot_ledger(
        member_id: str, year: int, fmt: str = "pdf",
        admin: dict = Depends(require_admin),
    ):
        """PDF/CSV export of a single member's yearly OT ledger. Same
        columns as the on-screen modal: Date, Check-in, Check-out,
        Early Arrival, Late Departures, Total, Early Reason, Late
        Reason, Status. Adds a bottom "Totals" row summing the three
        minute columns.

        4 Feb 2026 — user asked for a "Download PDF" affordance on the
        OT Ledger modal so an admin can hand a copy to a member who
        contests their overtime tally.
        """
        # Reuse the same query as `ot_ledger` so PDF output can never
        # drift from what's on screen.
        start = f"{year}-01-01"
        end = f"{year}-12-31"
        rows = await db.attendance.find(
            {"user_id": member_id,
             "date": {"$gte": start, "$lte": end},
             "overtime_total_min": {"$gt": 0}},
            {"_id": 0,
             "date": 1, "check_in_at": 1, "check_out_at": 1,
             "overtime_early_min": 1, "overtime_late_min": 1,
             "overtime_total_min": 1,
             "overtime_reason": 1,
             "overtime_early_reason": 1, "overtime_late_reason": 1,
             "overtime_status": 1, "overtime_admin_note": 1},
        ).sort("date", 1).to_list(2000)
        u = await db.users.find_one(
            {"id": member_id},
            {"_id": 0, "full_name": 1, "category": 1, "rank": 1},
        )
        member_name = (u or {}).get("full_name") or "Member"

        def _ddmmyyyy(iso: str) -> str:
            try:
                y, m, d = iso.split("-")
                return f"{d}/{m}/{y}"
            except Exception:
                return iso

        def _hhmm(iso: str) -> str:
            if not iso:
                return "—"
            return iso[11:16] if len(iso) >= 16 else iso

        def _fmt_min(m: int) -> str:
            if not m:
                return "—"
            h, mm = divmod(int(m), 60)
            return f"{h}h {mm}m" if h > 0 else f"{mm}m"

        def _resolve_reasons(r: dict) -> tuple:
            # Same fallback as the frontend: legacy pre-8-Jul-2026 rows
            # only carry a merged `overtime_reason`; attribute it to
            # whichever half actually recorded minutes.
            e_min = int(r.get("overtime_early_min") or 0)
            l_min = int(r.get("overtime_late_min") or 0)
            legacy = r.get("overtime_reason") or ""
            e = r.get("overtime_early_reason") or (legacy if e_min and not l_min else "")
            L = r.get("overtime_late_reason") or (legacy if l_min and not e_min else "")
            return e, L

        headers = [
            "Date", "Check-in", "Check-out",
            "Early Arrival", "Late Departures", "Total",
            "Early reason", "Late reason", "Status",
        ]
        table = []
        for r in rows:
            e_reason, l_reason = _resolve_reasons(r)
            table.append([
                _ddmmyyyy(r.get("date", "")),
                _hhmm(r.get("check_in_at")),
                _hhmm(r.get("check_out_at")),
                _fmt_min(r.get("overtime_early_min") or 0),
                _fmt_min(r.get("overtime_late_min") or 0),
                _fmt_min(r.get("overtime_total_min") or 0),
                e_reason or "—",
                l_reason or "—",
                (r.get("overtime_status") or "—").title(),
            ])
        # Append the Totals row so the printed PDF matches the modal
        # footer exactly. Empty cells for date/times/reasons keep the
        # row visually clean.
        tot_early = sum(int(r.get("overtime_early_min") or 0) for r in rows)
        tot_late = sum(int(r.get("overtime_late_min") or 0) for r in rows)
        tot_total = sum(int(r.get("overtime_total_min") or 0) for r in rows)
        table.append([
            "Totals", "", "",
            _fmt_min(tot_early), _fmt_min(tot_late), _fmt_min(tot_total),
            "", "", "",
        ])

        if fmt == "csv":
            return _csv_response(headers, table, f"ot_ledger_{member_id}_{year}.csv")

        # PDF path — landscape A4, meta block matches the modal header.
        office = await db.config.find_one({"id": "office"})
        academy = (office or {}).get("office_name") or "iShowedUp"
        meta = {
            "Academy": academy,
            "Member": member_name,
            "Category": ((u or {}).get("category") or "").title() or "—",
            "Year": str(year),
            "Sessions": str(len(rows)),
            "Total OT": _fmt_min(tot_total),
            "Generated by": admin.get("full_name") or admin.get("email") or "Admin",
        }
        # Column widths (mm) tuned for A4 landscape (~277 mm usable).
        # Sum here = ~271 mm; reason columns eat what's left of the space.
        col_widths_mm = [22, 18, 20, 24, 26, 22, 55, 55, 22]
        pdf = _pdf_from_table(
            f"Overtime Ledger — {member_name}",
            headers, table,
            subtitle=f"Calendar year {year}",
            orientation="landscape",
            col_widths=[w * mm for w in col_widths_mm],
            meta=meta,
            font_size=8,
        )
        return Response(
            content=pdf, media_type="application/pdf",
            headers={"Content-Disposition":
                     f"attachment; filename=ot_ledger_{member_name.replace(' ', '_')}_{year}.pdf"},
        )

    @router.get("/reports/comp-off-ledger")
    async def comp_off_ledger(
        member_id: str, year: int,
        admin: dict = Depends(require_admin),
    ):
        """Date-wise comp-off ledger for a single member across a
        calendar year. Powers the double-click drill-down modal on the
        Comp-off columns in the Attendance report.

        Returns three streams merged & sorted by date:
          • `earned`   — attendance date that fell on the member's
                         weekly_off (excl. dates that land inside an
                         approved posting window).
          • `applied`  — pending comp-off leaves.
          • `approved` — approved comp-off leaves (aka "used").

        Each row carries `date`, `dow` (Mon/Tue/…), `kind`, `qty`,
        and optionally `note` (leave reason / status detail).
        """
        yr_start, yr_end = f"{year}-01-01", f"{year}-12-31"
        u = await db.users.find_one(
            {"id": member_id},
            {"_id": 0, "full_name": 1, "rank": 1, "category": 1, "weekly_off": 1},
        )
        if not u:
            raise HTTPException(status_code=404, detail="Member not found")

        office = await db.config.find_one({"id": "office"})
        default_wo = ((office or {}).get("default_weekly_off") or "sunday").lower()
        wo = (u.get("weekly_off") or default_wo).lower()

        # Import lazily — top-of-file already keeps clean.
        from holidays import WEEKDAY_KEY
        DOW_LABEL = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

        # --- Earned: attendance on weekly-off (minus posting dates) ---
        atts = await db.attendance.find(
            {"user_id": member_id,
             "date": {"$gte": yr_start, "$lte": yr_end}},
            {"_id": 0, "date": 1},
        ).to_list(5000)
        # Posting date-set for the year (comp-off doesn't accrue during postings).
        posts = await db.leaves.find(
            {"user_id": member_id, "type": "posting", "status": "approved",
             "start_date": {"$lte": yr_end}, "end_date": {"$gte": yr_start}},
            {"_id": 0, "start_date": 1, "end_date": 1},
        ).to_list(500)
        posting_set: set = set()
        for p in posts:
            try:
                s = max(date.fromisoformat(p["start_date"]), date.fromisoformat(yr_start))
                e = min(date.fromisoformat(p["end_date"]), date.fromisoformat(yr_end))
            except Exception:
                continue
            cur = s
            while cur <= e:
                posting_set.add(cur.isoformat())
                cur = date.fromordinal(cur.toordinal() + 1)

        # Approved tours that landed on weekly_off also accrue (past/today only).
        tours = await db.leaves.find(
            {"user_id": member_id, "type": "tour", "status": "approved",
             "start_date": {"$lte": yr_end}, "end_date": {"$gte": yr_start}},
            {"_id": 0, "start_date": 1, "end_date": 1},
        ).to_list(500)

        today_iso = local_date_str(office)
        att_seen: set = set()
        earned_rows: list = []
        for a in atts:
            ds = a["date"]
            try:
                dt = date.fromisoformat(ds)
            except Exception:
                continue
            if WEEKDAY_KEY[dt.weekday()] == wo and ds not in posting_set:
                earned_rows.append({
                    "date": ds, "dow": DOW_LABEL[dt.weekday()],
                    "kind": "earned", "qty": 1, "note": "Attended on weekly-off",
                })
                att_seen.add(ds)

        # Tour weekly-off accruals (deduped against att_seen, and only past-or-today).
        for t in tours:
            try:
                s = max(date.fromisoformat(t["start_date"]), date.fromisoformat(yr_start))
                e = min(date.fromisoformat(t["end_date"]), date.fromisoformat(yr_end))
            except Exception:
                continue
            cur = s
            while cur <= e:
                ds = cur.isoformat()
                if (WEEKDAY_KEY[cur.weekday()] == wo
                        and ds not in att_seen
                        and ds <= today_iso):
                    earned_rows.append({
                        "date": ds, "dow": DOW_LABEL[cur.weekday()],
                        "kind": "earned", "qty": 1, "note": "Tour on weekly-off",
                    })
                    att_seen.add(ds)
                cur = date.fromordinal(cur.toordinal() + 1)

        # --- Applied + Approved: comp_off leaves + leaves with comp_off_used ---
        comp_leaves = await db.leaves.find(
            {"user_id": member_id,
             "start_date": {"$lte": yr_end}, "end_date": {"$gte": yr_start},
             "$or": [
                 {"type": "comp_off"},
                 {"comp_off_used": {"$gt": 0}},
             ]},
            {"_id": 0, "type": 1, "status": 1, "start_date": 1, "end_date": 1,
             "reason": 1, "comp_off_used": 1},
        ).to_list(2000)
        spent_rows: list = []
        for L in comp_leaves:
            status = L.get("status") or "pending"
            kind = "approved" if status == "approved" else (
                "rejected" if status == "rejected" else "applied"
            )
            # Number of comp-off days spent by this leave.
            if L.get("comp_off_used") is not None:
                qty = int(L["comp_off_used"])
            else:
                try:
                    qty = (date.fromisoformat(L["end_date"])
                           - date.fromisoformat(L["start_date"])).days + 1
                except Exception:
                    qty = 1
            try:
                s = max(date.fromisoformat(L["start_date"]), date.fromisoformat(yr_start))
                e = min(date.fromisoformat(L["end_date"]), date.fromisoformat(yr_end))
            except Exception:
                continue
            # Emit ONE row per leave window. Show span in the note.
            spent_rows.append({
                "date": s.isoformat(),
                "dow": DOW_LABEL[s.weekday()],
                "kind": kind,
                "qty": qty,
                "note": (L.get("reason") or "").strip() or (
                    f"{s.isoformat()} → {e.isoformat()}" if s != e else ""
                ),
                "span_end": e.isoformat(),
            })

        rows = sorted(earned_rows + spent_rows, key=lambda r: (r["date"], r["kind"]))
        totals = {
            "earned":   sum(r["qty"] for r in earned_rows),
            "applied":  sum(r["qty"] for r in spent_rows if r["kind"] == "applied"),
            "approved": sum(r["qty"] for r in spent_rows if r["kind"] == "approved"),
        }
        totals["available"] = max(0, totals["earned"] - totals["approved"])
        return {
            "member_id": member_id,
            "member_name": (u or {}).get("full_name"),
            "rank": (u or {}).get("rank"),
            "category": (u or {}).get("category"),
            "weekly_off": wo,
            "year": year,
            "totals": totals,
            "rows": rows,
        }

    @router.get("/reports/leave-ledger")
    async def leave_ledger(
        member_id: str, year: int,
        admin: dict = Depends(require_admin),
    ):
        """Date-wise leave ledger for a single member across a calendar
        year. Powers the double-click drill-down modal on the Leave
        section (Open · COff · Total · Avld · Close) of the Attendance
        report.

        Returns one row per leave application, sorted chronologically,
        with kind = applied (pending) / availed (approved) / rejected.
        Totals surface the split for the year at a glance.
        """
        yr_start, yr_end = f"{year}-01-01", f"{year}-12-31"
        u = await db.users.find_one(
            {"id": member_id},
            {"_id": 0, "full_name": 1, "rank": 1, "category": 1,
             "leave_balance_opening": 1},
        )
        if not u:
            raise HTTPException(status_code=404, detail="Member not found")

        DOW_LABEL = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

        # Every leave-type row for the year — spans that touch the
        # window on either end are pulled in and clamped to the window.
        # `posting`/`comp_off`/`tour` are intentionally excluded — they
        # have their own ledgers and reports.
        leaves = await db.leaves.find(
            {"user_id": member_id, "type": "leave",
             "start_date": {"$lte": yr_end}, "end_date": {"$gte": yr_start}},
            {"_id": 0, "status": 1, "start_date": 1, "end_date": 1,
             "reason": 1, "paid_leave_used": 1, "lop_days": 1,
             "comp_off_used": 1, "admin_note": 1,
             "decided_by": 1, "decided_at": 1, "applied_at": 1},
        ).to_list(2000)

        rows: list = []
        for L in leaves:
            status = (L.get("status") or "pending").lower()
            kind = ("availed" if status == "approved"
                    else "rejected" if status == "rejected"
                    else "applied")
            try:
                s = max(date.fromisoformat(L["start_date"]), date.fromisoformat(yr_start))
                e = min(date.fromisoformat(L["end_date"]), date.fromisoformat(yr_end))
            except Exception:
                continue
            qty = (e - s).days + 1
            rows.append({
                "start_date": s.isoformat(),
                "end_date": e.isoformat(),
                "dow": DOW_LABEL[s.weekday()],
                "kind": kind,
                "qty": qty,
                "paid_leave_used": float(L.get("paid_leave_used") or 0),
                "comp_off_used": int(L.get("comp_off_used") or 0),
                "lop_days": float(L.get("lop_days") or 0),
                "reason": (L.get("reason") or "").strip() or None,
                "admin_note": (L.get("admin_note") or "").strip() or None,
            })

        rows.sort(key=lambda r: (r["start_date"], r["kind"]))
        totals = {
            "applied":  sum(r["qty"] for r in rows if r["kind"] == "applied"),
            "availed":  sum(r["qty"] for r in rows if r["kind"] == "availed"),
            "rejected": sum(r["qty"] for r in rows if r["kind"] == "rejected"),
        }
        # Leave-balance summary (mirrors the Reports table's Leave columns).
        opening = float(u.get("leave_balance_opening") or 0)
        # `paid_leave_used` is the year-to-date deduction from the leave pool
        # (approved leaves only — see the payroll_report loop).
        taken_ytd = sum(
            (r["paid_leave_used"] or r["qty"])
            for r in rows if r["kind"] == "availed"
        )
        totals["opening"] = opening
        totals["taken_ytd"] = round(taken_ytd, 1)
        totals["remaining"] = round(opening - taken_ytd, 1)
        return {
            "member_id": member_id,
            "member_name": (u or {}).get("full_name"),
            "rank": (u or {}).get("rank"),
            "category": (u or {}).get("category"),
            "year": year,
            "totals": totals,
            "rows": rows,
        }

    return router
