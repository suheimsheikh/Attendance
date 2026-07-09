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
from services.permissions import is_super_admin
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

    @router.get("/reports/monthly-composite")
    async def monthly_composite(
        month: str,
        category: Optional[str] = None,
        fleet: Optional[str] = None,
        institution: Optional[str] = None,
        admin: dict = Depends(require_admin),
    ):
        """Composite month-to-date report — one row per member with the
        full set of numeric fields that show in each per-member ledger
        modal (Attendance, Overtime, Comp-off, Leave), scoped to the
        1st of the month → today.

        Column groups follow the ledger modals:
          • **Attendance** — Present, Half day, Late, Leave, Tour,
            Posting, Comp-off, Weekly off, Holiday, Absent.
          • **Overtime** — sessions (rows with OT > 0), early minutes,
            late minutes, total minutes, approved minutes.
          • **Comp-off** — earned only (user request: no availed).
          • **Leave** — applied days, availed days, rejected days,
            paid-leave used, comp-off used, LOP days, opening balance
            (YTD annual), taken YTD, remaining.

        `month` must be YYYY-MM. The report window is always **1st of
        the month → today** (never the whole future month) — matches
        the Attendance report clamp. Filter params mirror the
        Attendance report's category/fleet/institution pills.
        """
        try:
            y, m = (int(x) for x in month.split("-"))
            start_d = date(y, m, 1)
            end_full = (date(y + 1, 1, 1) if m == 12 else date(y, m + 1, 1)) - timedelta(days=1)
        except (ValueError, AttributeError):
            raise HTTPException(status_code=400, detail="month must be YYYY-MM")
        # Clamp end date to today when the requested month is the
        # current one — otherwise mid-month runs would over-count
        # Absent days for the future portion of the month.
        office = await db.config.find_one({"id": "office"})
        today_iso = local_date_str(office)
        today_d = date.fromisoformat(today_iso)
        end_d = min(end_full, today_d) if start_d <= today_d <= end_full else end_full
        start_iso, end_iso = start_d.isoformat(), end_d.isoformat()

        # --- Roster gate — matches Attendance report filter pills. ---
        users = await db.users.find(
            {"status": {"$ne": "left"}},
            {"_id": 0, "id": 1, "full_name": 1, "rank": 1, "category": 1,
             "fleet": 1, "institution": 1, "weekly_off": 1, "email": 1,
             "leave_balance_opening": 1},
        ).to_list(2000)
        athlete_like = await _athlete_like_keys(db)
        if category == "athlete":
            users = [u for u in users if u.get("category") in athlete_like]
        elif category == "elite":
            users = [u for u in users if u.get("category") == "elite"]
        elif category == "rest":
            users = [u for u in users if u.get("category") not in athlete_like]
        elif category == "payroll":
            users = [u for u in users if u.get("category") in {"staff", "coach"}]
        if fleet:
            if fleet == "__none__":
                users = [u for u in users if not u.get("fleet")]
            else:
                users = [u for u in users if (u.get("fleet") or "").lower() == fleet.lower()]
        if institution:
            if institution == "__none__":
                users = [u for u in users if not u.get("institution")]
            else:
                users = [u for u in users if u.get("institution") == institution]

        user_ids = [u["id"] for u in users]
        if not user_ids:
            return {"month": month, "start": start_iso, "end": end_iso, "rows": []}

        # --- Bulk fetches — one query per collection, in-memory bucket per user. ---
        default_wo = ((office or {}).get("default_weekly_off") or "sunday").lower()
        from holidays import WEEKDAY_KEY  # module constant

        att_docs = await db.attendance.find(
            {"user_id": {"$in": user_ids},
             "date": {"$gte": start_iso, "$lte": end_iso}},
            {"_id": 0, "user_id": 1, "date": 1, "check_in_at": 1,
             "is_late": 1, "is_half_day": 1,
             "overtime_total_min": 1, "overtime_early_min": 1,
             "overtime_late_min": 1, "overtime_status": 1},
        ).to_list(20000)
        leave_docs = await db.leaves.find(
            {"user_id": {"$in": user_ids},
             "start_date": {"$lte": end_iso}, "end_date": {"$gte": start_iso}},
            {"_id": 0, "user_id": 1, "type": 1, "status": 1,
             "start_date": 1, "end_date": 1, "comp_off_used": 1,
             "paid_leave_used": 1, "lop_days": 1},
        ).to_list(20000)
        # YTD approved leaves (Jan 1 — today) to compute leave-balance
        # remaining, same math as /reports/payroll and the LeaveLedger
        # modal's totals.opening / totals.remaining fields.
        ytd_start = f"{y}-01-01"
        ytd_leaves = await db.leaves.find(
            {"user_id": {"$in": user_ids},
             "type": "leave", "status": "approved",
             "start_date": {"$lte": today_iso}, "end_date": {"$gte": ytd_start}},
            {"_id": 0, "user_id": 1, "start_date": 1, "end_date": 1,
             "paid_leave_used": 1},
        ).to_list(20000)
        ytd_taken_by_user: dict = {}
        for L in ytd_leaves:
            if L.get("paid_leave_used") is not None:
                n = float(L["paid_leave_used"])
            else:
                try:
                    n = (date.fromisoformat(L["end_date"])
                         - date.fromisoformat(L["start_date"])).days + 1
                except (ValueError, KeyError):
                    n = 1
            ytd_taken_by_user[L["user_id"]] = ytd_taken_by_user.get(L["user_id"], 0.0) + n
        holidays_docs = await db.holidays.find(
            {"date": {"$gte": start_iso, "$lte": end_iso}},
            {"_id": 0, "date": 1},
        ).to_list(200)
        holiday_dates = {h["date"] for h in holidays_docs}
        # Posting date-set per user for the month (comp-off doesn't accrue during postings).
        posting_by_user: dict = {}
        for L in leave_docs:
            if L.get("type") == "posting" and L.get("status") == "approved":
                try:
                    s = max(date.fromisoformat(L["start_date"]), start_d)
                    e = min(date.fromisoformat(L["end_date"]), end_d)
                except (ValueError, KeyError):
                    continue
                dset = posting_by_user.setdefault(L["user_id"], set())
                cur = s
                while cur <= e:
                    dset.add(cur.isoformat())
                    cur += timedelta(days=1)

        # Bucket attendance + leaves by user for O(1) per-user lookups below.
        att_by_user: dict = {}
        for a in att_docs:
            att_by_user.setdefault(a["user_id"], []).append(a)
        leaves_by_user: dict = {}
        for L in leave_docs:
            leaves_by_user.setdefault(L["user_id"], []).append(L)

        def _leave_on(uid: str, iso: str) -> Optional[dict]:
            for L in leaves_by_user.get(uid, []):
                if (L.get("status") == "approved"
                        and L.get("start_date") <= iso <= L.get("end_date")):
                    return L
            return None

        out = []
        for u in users:
            uid = u["id"]
            weekly_off = (u.get("weekly_off") or default_wo).lower()
            atts = {a["date"]: a for a in att_by_user.get(uid, [])}
            posting_set = posting_by_user.get(uid, set())

            # --- Attendance ledger counts (same classification as the
            #     per-member modal). ---
            counts = {
                "Present": 0, "Half day": 0, "Late": 0,
                "Leave": 0, "Tour": 0, "Posting": 0, "Comp-off": 0,
                "Weekly off": 0, "Holiday": 0, "Absent": 0,
            }
            ot_sessions = 0
            ot_minutes = 0
            ot_early_min = 0
            ot_late_min = 0
            ot_approved_min = 0
            ot_pending_min = 0
            comp_off_earned = 0
            cur = start_d
            while cur <= end_d:
                iso = cur.isoformat()
                dow_idx = cur.weekday()
                att = atts.get(iso)
                lv = _leave_on(uid, iso)
                on_weekly_off = WEEKDAY_KEY[dow_idx] == weekly_off

                if att and att.get("check_in_at"):
                    if att.get("is_half_day"):
                        counts["Half day"] += 1
                    elif att.get("is_late"):
                        counts["Late"] += 1
                    else:
                        counts["Present"] += 1
                    ot_min = int(att.get("overtime_total_min") or 0)
                    if ot_min > 0:
                        ot_sessions += 1
                        ot_minutes += ot_min
                        ot_early_min += int(att.get("overtime_early_min") or 0)
                        ot_late_min += int(att.get("overtime_late_min") or 0)
                        ot_status = (att.get("overtime_status") or "").lower()
                        if ot_status == "approved":
                            ot_approved_min += ot_min
                        elif ot_status in ("pending", ""):
                            ot_pending_min += ot_min
                    # Comp-off earned — attendance on weekly-off outside
                    # posting windows (mirrors the comp-off ledger).
                    if on_weekly_off and iso not in posting_set:
                        comp_off_earned += 1
                elif lv:
                    lt = (lv.get("type") or "").lower()
                    if lt == "tour":
                        counts["Tour"] += 1
                        # Tour on weekly-off also accrues (mirrors ledger).
                        if on_weekly_off:
                            comp_off_earned += 1
                    elif lt == "posting":
                        counts["Posting"] += 1
                    elif lt == "comp_off":
                        counts["Comp-off"] += 1
                    else:
                        counts["Leave"] += 1
                elif on_weekly_off:
                    counts["Weekly off"] += 1
                elif iso in holiday_dates:
                    counts["Holiday"] += 1
                else:
                    counts["Absent"] += 1
                cur += timedelta(days=1)

            # --- Leave ledger counts (only type=leave, split by status). ---
            leave_applied = leave_availed = leave_rejected = 0
            paid_leave_used = 0.0
            comp_off_used_in_leaves = 0
            lop_days = 0.0
            for L in leaves_by_user.get(uid, []):
                if (L.get("type") or "").lower() != "leave":
                    continue
                # Clamp to month window.
                try:
                    s = max(date.fromisoformat(L["start_date"]), start_d)
                    e = min(date.fromisoformat(L["end_date"]), end_d)
                except (ValueError, KeyError):
                    continue
                if e < s:
                    continue
                qty = (e - s).days + 1
                status = (L.get("status") or "pending").lower()
                if status == "approved":
                    leave_availed += qty
                    paid_leave_used += float(L.get("paid_leave_used") or 0)
                    comp_off_used_in_leaves += int(L.get("comp_off_used") or 0)
                    lop_days += float(L.get("lop_days") or 0)
                elif status == "rejected":
                    leave_rejected += qty
                else:
                    leave_applied += qty

            opening = float(u.get("leave_balance_opening") or 0)
            taken_ytd = round(ytd_taken_by_user.get(uid, 0.0), 1)
            remaining = round(opening - taken_ytd, 1)

            out.append({
                "member_id": uid,
                "member_name": u.get("full_name"),
                "rank": u.get("rank"),
                "category": u.get("category"),
                "fleet": u.get("fleet"),
                "institution": u.get("institution"),
                # Attendance figures
                "present": counts["Present"],
                "half_day": counts["Half day"],
                "late": counts["Late"],
                "leave_days": counts["Leave"],
                "tour": counts["Tour"],
                "posting": counts["Posting"],
                "comp_off_days": counts["Comp-off"],
                "weekly_off": counts["Weekly off"],
                "holiday": counts["Holiday"],
                "absent": counts["Absent"],
                # Overtime figures
                "ot_sessions": ot_sessions,
                "ot_minutes": ot_minutes,
                "ot_early_min": ot_early_min,
                "ot_late_min": ot_late_min,
                "ot_approved_min": ot_approved_min,
                "ot_pending_min": ot_pending_min,
                # Comp-off ledger (earned only, per user request)
                "comp_off_earned": comp_off_earned,
                # Leave ledger figures
                "leave_applied": leave_applied,
                "leave_availed": leave_availed,
                "leave_rejected": leave_rejected,
                "paid_leave_used": round(paid_leave_used, 1),
                "comp_off_used": comp_off_used_in_leaves,
                "lop_days": round(lop_days, 1),
                "leave_opening": opening,
                "leave_taken_ytd": taken_ytd,
                "leave_remaining": remaining,
            })

        out.sort(key=lambda r: (r["member_name"] or "").lower())
        return {"month": month, "start": start_iso, "end": end_iso, "rows": out}

    @router.get("/reports/monthly-composite/export")
    async def export_monthly_composite(
        month: str, fmt: str = "csv",
        category: Optional[str] = None,
        fleet: Optional[str] = None,
        institution: Optional[str] = None,
        admin: dict = Depends(require_admin),
    ):
        """CSV / PDF export of the composite monthly report — matches
        the on-screen table columns 1:1."""
        data = await monthly_composite(month, category, fleet, institution, admin)
        rows = data["rows"]

        def _hm(minutes: int) -> str:
            if not minutes:
                return "—"
            h, mm = divmod(int(minutes), 60)
            return f"{h}h {mm}m" if h > 0 else f"{mm}m"

        headers = [
            "Name", "Rank", "Category",
            # Attendance
            "Present", "Half day", "Late", "Absent",
            "Leave", "Tour", "Posting", "Comp-off", "Weekly off", "Holiday",
            # Overtime — full detail
            "OT sess", "OT early", "OT late", "OT total", "OT approved", "OT pending",
            # Comp-off (earned only)
            "CO earned",
            # Leave ledger — full detail
            "Lv applied", "Lv availed", "Lv rejected",
            "Paid used", "CO used", "LOP",
            "Lv opening", "Lv taken YTD", "Lv remaining",
        ]
        table = []
        for r in rows:
            table.append([
                r.get("member_name") or "",
                r.get("rank") or "",
                (r.get("category") or "").title(),
                str(r["present"]), str(r["half_day"]), str(r["late"]), str(r["absent"]),
                str(r["leave_days"]), str(r["tour"]), str(r["posting"]),
                str(r["comp_off_days"]), str(r["weekly_off"]), str(r["holiday"]),
                str(r["ot_sessions"]),
                _hm(r["ot_early_min"]), _hm(r["ot_late_min"]),
                _hm(r["ot_minutes"]),
                _hm(r["ot_approved_min"]), _hm(r["ot_pending_min"]),
                str(r["comp_off_earned"]),
                str(r["leave_applied"]), str(r["leave_availed"]), str(r["leave_rejected"]),
                f"{r['paid_leave_used']:.1f}", str(r["comp_off_used"]),
                f"{r['lop_days']:.1f}",
                f"{r['leave_opening']:.1f}", f"{r['leave_taken_ytd']:.1f}",
                f"{r['leave_remaining']:.1f}",
            ])

        filename_stem = f"monthly_composite_{month}"
        if fmt == "csv":
            return _csv_response(headers, table, f"{filename_stem}.csv")

        office = await db.config.find_one({"id": "office"})
        academy = (office or {}).get("office_name") or "iShowedUp"
        meta = {
            "Academy": academy,
            "Report": "Monthly Composite Ledger (MTD)",
            "Month": month,
            "Range": f"{data['start']} → {data['end']}",
            "Members": str(len(rows)),
            "Filters": ", ".join(filter(None, [
                f"Category: {category}" if category else None,
                f"Fleet: {fleet}" if fleet else None,
                f"Institution: {institution}" if institution else None,
            ])) or "None",
            "Generated by": admin.get("full_name") or admin.get("email") or "Admin",
        }
        # 29 columns @ A3-landscape (~397mm usable). Tight but fits at font_size=6.
        col_widths_mm = [
            32, 16, 14,                              # Name / Rank / Category
            10, 10, 10, 10,                          # Attendance base (4)
            10, 10, 10, 10, 12, 10,                  # Leave/Off group (6)
            11, 14, 14, 14, 15, 15,                  # OT (6)
            12,                                      # CO earned (1)
            12, 12, 12,                              # Lv applied/availed/rejected (3)
            12, 11, 11,                              # Paid / CO used / LOP (3)
            12, 12, 12,                              # Lv opening / taken / remaining (3)
        ]
        # A3 landscape — table is wide even after tight cols.
        from reportlab.lib.pagesizes import A3
        pdf = _pdf_from_table(
            "Monthly Composite Report",
            headers, table,
            subtitle=f"{month} · {len(rows)} members",
            orientation="landscape",
            col_widths=[w * mm for w in col_widths_mm],
            meta=meta,
            pagesize_override=landscape(A3),
            font_size=6,
        )
        return Response(
            content=pdf, media_type="application/pdf",
            headers={"Content-Disposition":
                     f"attachment; filename={filename_stem}.pdf"},
        )

    @router.get("/reports/attendance-ledger")
    async def attendance_ledger(
        member_id: str, start: str, end: str,
        admin: dict = Depends(require_admin),
    ):
        """Date-wise attendance detail for one member across a range,
        used by the double-click drill-down modal on the Attendance
        report (04 Feb 2026). One row per calendar date in the range,
        classified as:
          • Present / Half day / Late — has an attendance row
          • Leave / Tour / Posting    — covered by an approved leave
          • Weekly off                — matches the member's weekly_off
          • Holiday                   — matches the office holiday list
          • Absent                    — none of the above

        Rows carry check-in/out times where relevant, and the leave
        reason where applicable. Range is inclusive of both ends.
        """
        try:
            d0 = date.fromisoformat(start)
            d1 = date.fromisoformat(end)
        except ValueError:
            raise HTTPException(status_code=400, detail="start/end must be YYYY-MM-DD")
        if d1 < d0:
            raise HTTPException(status_code=400, detail="end must be >= start")
        u = await db.users.find_one(
            {"id": member_id},
            {"_id": 0, "full_name": 1, "category": 1, "weekly_off": 1, "rank": 1},
        )
        if not u:
            raise HTTPException(status_code=404, detail="Member not found")

        office = await db.config.find_one({"id": "office"})
        default_wo = ((office or {}).get("default_weekly_off") or "sunday").lower()
        weekly_off = (u.get("weekly_off") or default_wo).lower()
        from holidays import WEEKDAY_KEY  # local import — module-scoped constant
        DOW_LABEL = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

        atts = {a["date"]: a for a in await db.attendance.find(
            {"user_id": member_id, "date": {"$gte": start, "$lte": end}},
            {"_id": 0, "date": 1, "check_in_at": 1, "check_out_at": 1,
             "is_late": 1, "is_half_day": 1, "overtime_total_min": 1,
             "work_start_at_session": 1, "work_end_at_session": 1},
        ).to_list(400)}
        leaves = await db.leaves.find(
            {"user_id": member_id, "status": "approved",
             "start_date": {"$lte": end}, "end_date": {"$gte": start}},
            {"_id": 0, "type": 1, "start_date": 1, "end_date": 1, "reason": 1},
        ).to_list(200)
        # Holiday list — pull all holidays that fall in the range (small
        # collection, no index concerns).
        hols = {h["date"]: h.get("label") for h in await db.holidays.find(
            {"date": {"$gte": start, "$lte": end}},
            {"_id": 0, "date": 1, "label": 1},
        ).to_list(200)}

        def _hhmm(iso):
            return iso[11:16] if iso and len(iso) >= 16 else ""

        def _leave_on(iso):
            for lv in leaves:
                if lv["start_date"] <= iso <= lv["end_date"]:
                    return lv
            return None

        rows = []
        cur = d0
        counts = {"Present": 0, "Half day": 0, "Late": 0,
                  "Leave": 0, "Tour": 0, "Posting": 0,
                  "Comp-off": 0, "Weekly off": 0, "Holiday": 0, "Absent": 0}
        while cur <= d1:
            iso = cur.isoformat()
            dow_idx = cur.weekday()          # 0=Mon
            dow_lbl = DOW_LABEL[dow_idx]
            att = atts.get(iso)
            lv = _leave_on(iso)
            holiday_label = hols.get(iso)

            status = None
            check_in = check_out = reason = ""
            if att and att.get("check_in_at"):
                check_in = _hhmm(att.get("check_in_at"))
                check_out = _hhmm(att.get("check_out_at"))
                if att.get("is_half_day"):
                    status = "Half day"
                elif att.get("is_late"):
                    status = "Late"
                else:
                    status = "Present"
            elif lv:
                lt = (lv.get("type") or "").lower()
                if lt == "tour":
                    status = "Tour"
                elif lt == "posting":
                    status = "Posting"
                elif lt == "comp_off":
                    status = "Comp-off"
                else:
                    status = "Leave"
                reason = lv.get("reason") or ""
            elif WEEKDAY_KEY[dow_idx] == weekly_off:
                status = "Weekly off"
            elif holiday_label:
                status = "Holiday"
                reason = holiday_label
            else:
                status = "Absent"
            counts[status] = counts.get(status, 0) + 1
            rows.append({
                "date": iso,
                "dow": dow_lbl,
                "status": status,
                "check_in": check_in,
                "check_out": check_out,
                "reason": reason,
            })
            cur += timedelta(days=1)

        return {
            "member_id": member_id,
            "member_name": u.get("full_name"),
            "category": u.get("category"),
            "start": start,
            "end": end,
            "weekly_off": weekly_off,
            "counts": counts,
            "rows": rows,
        }

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

    def _ddmmyyyy(iso: str) -> str:
        try:
            y, m, d = iso.split("-")
            return f"{d}/{m}/{y}"
        except Exception:
            return iso

    @router.get("/reports/comp-off-ledger/export")
    async def export_comp_off_ledger(
        member_id: str, year: int, fmt: str = "pdf",
        admin: dict = Depends(require_admin),
    ):
        """PDF/CSV of the comp-off ledger — mirrors the on-screen modal.
        Added 04 Feb 2026 alongside OT-ledger download so admins can hand
        a printable balance to any member applying for leave."""
        data = await comp_off_ledger(member_id, year, admin)
        rows = data["rows"]
        totals = data["totals"]
        member_name = data.get("member_name") or "Member"
        headers = ["Date", "Day", "Kind", "Qty", "Note"]
        table = [[
            _ddmmyyyy(r.get("date", "")), r.get("dow", ""),
            (r.get("kind") or "").title(), str(r.get("qty") or ""),
            r.get("note") or "",
        ] for r in rows]
        # Totals summary row.
        table.append([
            "Totals", "", "",
            f"E:{totals.get('earned',0)} A:{totals.get('applied',0)} Apv:{totals.get('approved',0)} Avail:{totals.get('available',0)}",
            "",
        ])
        if fmt == "csv":
            return _csv_response(headers, table, f"comp_off_ledger_{member_id}_{year}.csv")
        office = await db.config.find_one({"id": "office"})
        academy = (office or {}).get("office_name") or "iShowedUp"
        meta = {
            "Academy": academy,
            "Member": member_name,
            "Category": ((data or {}).get("category") or "").title() or "—",
            "Year": str(year),
            "Weekly off": (data.get("weekly_off") or "").title(),
            "Earned": str(totals.get("earned", 0)),
            "Approved (used)": str(totals.get("approved", 0)),
            "Available": str(totals.get("available", 0)),
            "Generated by": admin.get("full_name") or admin.get("email") or "Admin",
        }
        col_widths_mm = [25, 18, 32, 25, 130]
        pdf = _pdf_from_table(
            f"Comp-off Ledger — {member_name}",
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
                     f"attachment; filename=comp_off_ledger_{member_name.replace(' ', '_')}_{year}.pdf"},
        )

    @router.get("/reports/leave-ledger/export")
    async def export_leave_ledger(
        member_id: str, year: int, fmt: str = "pdf",
        admin: dict = Depends(require_admin),
    ):
        """PDF/CSV of the leave ledger — mirrors the on-screen modal."""
        data = await leave_ledger(member_id, year, admin)
        rows = data["rows"]
        totals = data["totals"]
        member_name = data.get("member_name") or "Member"
        headers = ["Start", "End", "Day", "Type", "Kind", "Qty", "Paid", "Comp-off", "LOP", "Reason", "Admin note"]
        table = [[
            _ddmmyyyy(r.get("start_date", "")),
            _ddmmyyyy(r.get("end_date", "")),
            r.get("dow", ""),
            (r.get("type") or "").title(),
            (r.get("kind") or "").title(),
            str(r.get("qty") or ""),
            f"{r.get('paid_leave_used') or 0:.1f}",
            str(r.get("comp_off_used") or 0),
            f"{r.get('lop_days') or 0:.1f}",
            r.get("reason") or "",
            r.get("admin_note") or "",
        ] for r in rows]
        table.append([
            "Totals", "", "", "", "",
            f"Applied:{totals.get('applied',0)} Availed:{totals.get('availed',0)} Rejected:{totals.get('rejected',0)}",
            "", "", "", "", "",
        ])
        if fmt == "csv":
            return _csv_response(headers, table, f"leave_ledger_{member_id}_{year}.csv")
        office = await db.config.find_one({"id": "office"})
        academy = (office or {}).get("office_name") or "iShowedUp"
        meta = {
            "Academy": academy,
            "Member": member_name,
            "Category": ((data or {}).get("category") or "").title() or "—",
            "Year": str(year),
            "Opening balance": str(totals.get("opening", 0)),
            "Taken YTD": str(totals.get("taken_ytd", 0)),
            "Remaining": str(totals.get("remaining", 0)),
            "Generated by": admin.get("full_name") or admin.get("email") or "Admin",
        }
        col_widths_mm = [22, 22, 15, 22, 22, 15, 15, 20, 15, 55, 45]
        pdf = _pdf_from_table(
            f"Leave Ledger — {member_name}",
            headers, table,
            subtitle=f"Calendar year {year}",
            orientation="landscape",
            col_widths=[w * mm for w in col_widths_mm],
            meta=meta,
            font_size=7,
        )
        return Response(
            content=pdf, media_type="application/pdf",
            headers={"Content-Disposition":
                     f"attachment; filename=leave_ledger_{member_name.replace(' ', '_')}_{year}.pdf"},
        )

    return router
