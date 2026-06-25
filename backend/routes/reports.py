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
from datetime import date, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, Response

from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet

from services.time_utils import local_date_str


def _pdf_from_table(title: str, headers: List[str], data: List[List[str]], subtitle: str = "") -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, topMargin=20 * mm, bottomMargin=15 * mm)
    styles = getSampleStyleSheet()
    elems = [Paragraph(title, styles["Title"])]
    if subtitle:
        elems.append(Paragraph(subtitle, styles["Normal"]))
    elems.append(Spacer(1, 8 * mm))
    table_data = [headers] + (data if data else [["No records"] + [""] * (len(headers) - 1)])
    t = Table(table_data, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F2937")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#D1D5DB")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F3F4F6")]),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    elems.append(t)
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
        on_tour = [leave for leave in leaves if leave["type"] == "tour"]
        return {"date": on, "on_leave": on_leave, "on_tour": on_tour}

    @router.get("/reports/hours/export")
    async def export_hours(start: str, end: str, fmt: str = "csv", admin: dict = Depends(require_admin)):
        rows = await compute_hours_report(start, end)
        headers = ["Attendance %", "Name", "Category", "Rank", "Weekly off",
                   "Present", "Leave", "Tour", "Comp-Off", "Absent", "Total accounted", "Span",
                   "Total hrs", "OT hrs (approved)", "OT hrs (pending)",
                   "Late Days", "Overstays",
                   "Comp-Off Earned", "Comp-Off Used", "Comp-Off Pending"]
        table = [[f"{r['attendance_pct']}%", r["member_name"], r["category"], r.get("rank") or "-",
                  (r.get("weekly_off") or "monday").title(),
                  r["days_present"],
                  (r.get("days_leave", 0) + r.get("days_break", 0)),
                  r.get("days_tour", 0), r.get("comp_off_used", 0),
                  r.get("days_absent", 0), r.get("days_accounted", 0), r.get("span_days", 0),
                  r["total_hours"], r.get("overtime_hours_approved", 0), r.get("overtime_hours_pending", 0),
                  r.get("late_days", 0), r.get("overstays", 0),
                  r.get("comp_off_earned", 0), r.get("comp_off_used", 0), r.get("comp_off_pending", 0)] for r in rows]
        if fmt == "pdf":
            pdf = _pdf_from_table("Monthly Attendance Report", headers, table, f"{start} to {end}")
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
