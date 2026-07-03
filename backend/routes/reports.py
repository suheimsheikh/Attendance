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

from fastapi import APIRouter, Depends, Response

from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_RIGHT

from services.time_utils import local_date_str


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

    @router.get("/reports/hours")
    async def hours_report(start: str, end: str, admin: dict = Depends(require_admin)):
        rows = await compute_hours_report(start, end)
        return {"start": start, "end": end, "rows": rows}

    @router.get("/reports/payroll")
    async def payroll_report(month: Optional[str] = None, admin: dict = Depends(require_admin)):
        """Monthly payroll report. `month` = YYYY-MM (defaults to the previous
        calendar month so a 1st-of-month run pulls last month's numbers)."""
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
        start_iso, end_iso = start_d.isoformat(), end_d.isoformat()
        rows = await compute_hours_report(start_iso, end_iso)
        # Payroll applies only to STAFF and COACHES — athletes / executives don't
        # draw a monthly salary, so they're excluded from the payroll listing.
        PAYROLL_CATS = {"staff", "coach"}
        rows = [r for r in rows if r.get("category") in PAYROLL_CATS]
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
        if category == "athlete":
            rows = [r for r in rows if r.get("category") == "athlete"]
        elif category == "rest":
            rows = [r for r in rows if r.get("category") != "athlete"]
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
                         "rest": "Rest (Staff / Coach / Executive)"}.get(category, "All")
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

    return router
