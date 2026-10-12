"""Reports routes — employee-wise OFFICE CHECK IN / OUT TIMING CHART (PDF).

A notice-board-ready sheet listing every employee (staff / coach /
executive — athletes are camp-driven and excluded) in alphabetical
order, with their effective check-in/out time for each day of the week.
Per-DOW overrides (member → office) are resolved via the shared
`effective_hours` resolver so the sheet matches exactly what the app
uses to mark lateness. Added Jun 2026 (user request).
"""
from __future__ import annotations

from routes.reports.common import (
    Depends,
    Response,
    _pdf_from_table,
    date,
    local_date_str,
    mm,
    now_utc,
)
from services.attendance_calc import ATHLETE_CATEGORIES, effective_hours
from services.time_utils import office_tz

# Columns are Monday..Sunday; index matches datetime.weekday() (Mon=0).
_DOW_FULL = ["monday", "tuesday", "wednesday", "thursday",
             "friday", "saturday", "sunday"]
_DOW_LABEL = ["Monday", "Tuesday", "Wednesday", "Thursday",
              "Friday", "Saturday", "Sunday"]


def register(router, *, db, require_admin):
    @router.get("/reports/timing-chart.pdf")
    async def timing_chart_pdf(admin: dict = Depends(require_admin)):
        office = await db.config.find_one({"id": "office"}, {"_id": 0}) or {}
        default_wo = (office.get("default_weekly_off") or "sunday").lower()
        def_start = office.get("default_work_start") or "09:00"
        def_end = office.get("default_work_end") or "17:00"

        # Employees only (staff / coach / executive). `category` is the rule
        # bucket — anything not athlete-like is an employee. Exclude left /
        # archived so the notice board shows the current workforce.
        users = await db.users.find(
            {"archived": {"$ne": True}, "status": {"$ne": "left"},
             "active": {"$ne": False},
             "category": {"$nin": list(ATHLETE_CATEGORIES)}},
            {"_id": 0, "id": 1, "full_name": 1, "rank": 1, "category": 1,
             "weekly_off": 1, "work_start": 1, "work_end": 1,
             "dow_hours": 1, "hourly_wager": 1, "leaving_date": 1},
        ).to_list(5000)
        today_iso = local_date_str(office)
        users = [u for u in users
                 if not (u.get("leaving_date") and u["leaving_date"] < today_iso)]
        users.sort(key=lambda u: (u.get("full_name") or "").lower())

        # A reference week: Monday..Sunday ISO dates so effective_hours can
        # pick the right weekday. The actual dates don't matter — only the
        # weekday each one falls on.
        ref_monday = date.fromisoformat(today_iso)
        ref_monday = ref_monday.fromordinal(ref_monday.toordinal() - ref_monday.weekday())
        week_iso = [(ref_monday.fromordinal(ref_monday.toordinal() + i)).isoformat()
                    for i in range(7)]

        def _cell(u: dict, i: int) -> str:
            if u.get("hourly_wager"):
                return "Hourly"
            wo = (u.get("weekly_off") or default_wo).lower()
            if _DOW_FULL[i] == wo:
                return "WEEKLY OFF"
            start, end = effective_hours(u, office, week_iso[i])
            return f"{start} \u2013 {end}"

        cat_label = {"staff": "Staff", "coach": "Coach", "executive": "Executive"}
        headers = ["#", "Name", "Designation"] + _DOW_LABEL
        rows = []
        for n, u in enumerate(users, start=1):
            rows.append([
                str(n),
                u.get("full_name") or "",
                u.get("rank") or cat_label.get(u.get("category"), (u.get("category") or "").title()),
                *[_cell(u, i) for i in range(7)],
            ])

        gen_local = now_utc().astimezone(office_tz(office))
        meta = {
            "Academy": office.get("name") or "Office",
            "Default timing": f"{def_start} \u2013 {def_end}  (Weekly off: {default_wo.title()})",
            "Employees": str(len(rows)),
            "Generated": gen_local.strftime("%d/%m/%Y %H:%M"),
            "Note": "Times shown are your effective check-in/out for each day. "
                    "Please verify and report any error to the office. "
                    "WEEKLY OFF = no duty that day; Hourly = paid per hour, no fixed timing.",
        }

        # A4 landscape (~270 mm usable). #, Name, Designation, 7 DOW.
        col_widths_mm = [10, 56, 34] + [24] * 7
        pdf = _pdf_from_table(
            "OFFICE CHECK IN / OUT TIMING CHART",
            headers, rows,
            subtitle="Employee-wise weekly timings — verify and report errors to the office",
            orientation="landscape",
            col_widths=[w * mm for w in col_widths_mm],
            meta=meta,
            font_size=8,
            left_cols=[1, 2],
        )
        return Response(
            content=pdf, media_type="application/pdf",
            headers={"Content-Disposition": "inline; filename=office-timing-chart.pdf"},
        )

    return {}
