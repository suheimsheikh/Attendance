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

from services.time_utils import local_date_str, local_hm, local_now
from services.permissions import is_super_admin
import breaks as _breaks_module


# ── member_timeline constants (module-scope so we don't rebuild them
#    on every request). ───────────────────────────────────────────────
_WEEKDAY_NAME = ["monday", "tuesday", "wednesday", "thursday",
                 "friday", "saturday", "sunday"]
_WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

# Human labels shown by the drill-down modal.
_TIMELINE_LABELS = {
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

# Precedence order for the "primary" bucket when a day is tagged with
# more than one marker (e.g. present + escort). Earliest wins.
_TIMELINE_PRIORITY = ["present", "leave", "tour", "posting", "comp_off",
                      "late_coming", "break", "escort"]

# Buckets that count as "accounted" (the member is NOT absent).
# Mirrors the aggregation in server.compute_hours_report.
_TIMELINE_ACCOUNTED = {"present", "leave", "tour", "posting", "comp_off",
                       "late_coming", "break"}


def _classify_timeline_day(
    buckets: list, *, iso: str, today_iso: str, is_weekly_off: bool,
) -> str:
    """Return the single "primary" bucket string a timeline row is
    displayed under. Extracted from member_timeline so the branching
    logic is testable in isolation.

    Rules (in order):
      1. If any marker in ACCOUNTED is present → pick the highest-
         priority marker (present > leave > tour > … > escort).
      2. Otherwise:
         a. weekly-off day       → "off_weekly"
         b. today (still running) → "off_in_progress"
         c. everything else       → "absent"
    """
    has_accounted = any(b in _TIMELINE_ACCOUNTED for b in buckets)
    if has_accounted:
        return next((b for b in _TIMELINE_PRIORITY if b in buckets),
                    buckets[0])
    if is_weekly_off:
        return "off_weekly"
    if iso == today_iso:
        return "off_in_progress"
    return "absent"


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
        # Always render the "Generated" timestamp in IST (office
        # default). `local_now(None)` uses DEFAULT_TZ = Asia/Kolkata —
        # keeps report footers consistent no matter what timezone the
        # server clock is on. 20 Feb 2026 timezone audit.
        f"Generated {local_now(None).strftime('%d %b %Y %H:%M')} IST · iShowedUp",
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

    def _ledger_window(year: Optional[int], month: Optional[str]) -> tuple[str, str, str]:
        """Resolve the (start_iso, end_iso, label) window for a ledger
        endpoint. `month` (YYYY-MM) wins over `year` — added 15 Feb 2026
        so all ledger drill-downs restrict to the current month by
        default (user request: "All ledgers should be restricted to the
        current month"). Older callers still pass `year` for
        year-wide PDF exports.
        """
        if month:
            try:
                y, m = (int(x) for x in month.split("-"))
                start_d = date(y, m, 1)
                end_d = (date(y + 1, 1, 1) if m == 12 else date(y, m + 1, 1)) - timedelta(days=1)
                return start_d.isoformat(), end_d.isoformat(), month
            except (ValueError, AttributeError):
                raise HTTPException(status_code=400, detail="month must be YYYY-MM")
        if year is not None:
            return f"{year}-01-01", f"{year}-12-31", str(year)
        raise HTTPException(status_code=400, detail="Either `month` (YYYY-MM) or `year` must be provided")

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

    async def _grid_impl(
        month: str,
        category: Optional[str] = None,
        fleet: Optional[str] = None,
        institution: Optional[str] = None,
        with_meta: bool = True,
    ):
        """Month-view calendar grid — one row per member, one cell per
        calendar day of the requested month.

        ``with_meta=False`` skips the per-cell tooltip metadata. The
        default is True to preserve the current UI contract; the CSV/PDF
        export path and any callers that don't need hover context can
        opt out to save ~30% payload size.

        Cell codes (2-letter, uppercased):
          • ``P``  present (rendered filled-green in UI)
          • ``HD`` half day
          • ``LT`` late (checked in but past grace)
          • ``LV`` on leave (approved leave type=leave)
          • ``TR`` on tour
          • ``PS`` posting
          • ``CO`` comp-off availed (approved leave type=comp_off)
          • ``WO`` weekly off
          • ``HO`` holiday
          • ``AB`` absent (rendered red)
          • ``""`` future date (no data yet)

        Window is always **1st of the month → last day of the month**;
        future dates are emitted as empty strings so the grid width is
        stable across months.
        """
        try:
            y, m = (int(x) for x in month.split("-"))
            start_d = date(y, m, 1)
            end_d = (date(y + 1, 1, 1) if m == 12 else date(y, m + 1, 1)) - timedelta(days=1)
        except (ValueError, AttributeError):
            raise HTTPException(status_code=400, detail="month must be YYYY-MM")
        start_iso, end_iso = start_d.isoformat(), end_d.isoformat()

        office = await db.config.find_one({"id": "office"})
        today_iso = local_date_str(office)
        # Live HH:MM in office tz — used below to suppress today's "AB"
        # cell until after the check-in window opens. Before work_start
        # the day hasn't earned an absent yet, so we render it blank.
        now_hm = local_now(office).strftime("%H:%M")
        default_wo = ((office or {}).get("default_weekly_off") or "sunday").lower()
        default_work_start = (office or {}).get("default_work_start") or "09:00"
        from holidays import WEEKDAY_KEY

        # --- Roster (same filter pills as Attendance report). ---
        users = await db.users.find(
            {"status": {"$ne": "left"}},
            {"_id": 0, "id": 1, "full_name": 1, "rank": 1, "category": 1,
             "fleet": 1, "institution": 1, "weekly_off": 1,
             "work_start": 1, "work_end": 1,
             # Joining/leaving dates drive the "NJ" (Not Joined) and
             # "LF" (Left) cell codes so the Grid doesn't show
             # pre-joining or post-leaving days as absent. Added
             # 14 Feb 2026 (user request).
             "joining_date": 1, "leaving_date": 1},
        ).to_list(2000)
        # Members who left BEFORE this month starts are dropped entirely —
        # they only appear up to (and including) their leaving month, where
        # post-leaving days paint LF (user request, Jun 2026).
        users = [u for u in users
                 if not (u.get("leaving_date") and u["leaving_date"] < start_iso)]
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
        days = [(start_d + timedelta(days=i)).isoformat()
                for i in range((end_d - start_d).days + 1)]
        if not user_ids:
            return {"month": month, "start": start_iso, "end": end_iso,
                    "today": today_iso, "days": days, "rows": []}

        # --- Bulk fetches (parallelised via asyncio.gather —
        # 20 Feb 2026 perf pass. All four queries are independent, so
        # firing them concurrently saves ~3 round-trip latencies on the
        # month-view Grid). ---
        import asyncio  # noqa: PLC0415 — local import, avoids module-level cost
        att_docs, leave_docs, holidays_docs, breaks_docs = await asyncio.gather(
            db.attendance.find(
                {"user_id": {"$in": user_ids},
                 "date": {"$gte": start_iso, "$lte": end_iso}},
                {"_id": 0, "user_id": 1, "date": 1, "check_in_at": 1,
                 "check_out_at": 1, "late_minutes": 1,
                 # Field is stamped as `late` on attendance docs (see
                 # server.py:2070) — NOT `is_late`. Reading the wrong
                 # name meant every real late check-in silently degraded
                 # into a plain `P` cell on the Grid while the
                 # Attendance report (which correctly reads `late`)
                 # showed them. Prod bug 20 Feb 2026.
                 "late": 1, "overtime_total_min": 1,
                 # Early-out flag stamped at checkout (13 Feb 2026);
                 # historical rows are computed on-the-fly from
                 # check_out_at + user.work_end so the Grid tally is
                 # correct for pre-feature data too.
                 "early_out_minutes": 1},
            ).to_list(20000),
            db.leaves.find(
                # Also pull leaves that were cancelled + converted to LOP
                # (24 Feb 2026 user request: Grid-initiated cancellations
                # paint LP on the affected days instead of falling back
                # to AB). The code-selector below treats these rows as
                # LP for their entire range.
                {"user_id": {"$in": user_ids},
                 "$or": [
                     {"status": "approved"},
                     {"status": "cancelled", "converted_to_lop": True},
                 ],
                 "start_date": {"$lte": end_iso}, "end_date": {"$gte": start_iso}},
                {"_id": 0, "id": 1, "user_id": 1, "type": 1, "reason": 1,
                 "half_day": 1, "decided_by": 1, "decided_at": 1,
                 "start_date": 1, "end_date": 1, "status": 1,
                 "converted_to_lop": 1, "cancelled_by": 1, "cancelled_at": 1,
                 "lop_days": 1, "paid_leave_used": 1, "comp_off_used": 1},
            ).to_list(20000),
            db.holidays.find(
                {"date": {"$gte": start_iso, "$lte": end_iso}},
                {"_id": 0, "date": 1},
            ).to_list(200),
            # Break windows that overlap the month. Audience filter
            # (`break_applies_to(user)`) is applied below — a break
            # scoped to "athletes" won't paint a staff row.
            db.breaks.find(
                {"start_date": {"$lte": end_iso}, "end_date": {"$gte": start_iso}},
                {"_id": 0},
            ).to_list(500),
        )
        holiday_dates = {h["date"] for h in holidays_docs}

        att_by_user: dict = {}
        for a in att_docs:
            att_by_user.setdefault(a["user_id"], {})[a["date"]] = a
        leaves_by_user: dict = {}
        for L in leave_docs:
            leaves_by_user.setdefault(L["user_id"], []).append(L)
        # Break lookup per user: iso date → the break doc that applies.
        # Reuses breaks.break_applies_to() so audience filtering
        # (category / individual list) stays authoritative. Storing the
        # full break gives us tooltip metadata (name, applied-by) on the
        # BK cell — Feb 2026 tooltip pass.
        breaks_by_user: dict = {}
        for u in users:
            per_date: dict = {}
            for b in breaks_docs:
                if not _breaks_module.break_applies_to(b, u):
                    continue
                bs, be = b.get("start_date"), b.get("end_date")
                if not (bs and be):
                    continue
                cur = max(bs, start_iso)
                stop = min(be, end_iso)
                while cur <= stop:
                    per_date[cur] = b
                    cur = (date.fromisoformat(cur) + timedelta(days=1)).isoformat()
            if per_date:
                breaks_by_user[u["id"]] = per_date

        # Admin name lookup — for BK cell tooltips ("applied by …"). We
        # already fetched breaks_docs; collect their unique created_by
        # ids and any leave decided_by names (leaves already store the
        # human-readable name).
        admin_ids = list({b.get("created_by") for b in breaks_docs if b.get("created_by")})
        admin_name_by_id: dict = {}
        if admin_ids:
            admin_docs = await db.users.find(
                {"id": {"$in": admin_ids}}, {"_id": 0, "id": 1, "full_name": 1},
            ).to_list(len(admin_ids))
            admin_name_by_id = {a["id"]: a.get("full_name") for a in admin_docs}

        # Map leave type → cell code.
        LEAVE_CODE = {
            "leave": "LV", "tour": "TR", "posting": "PS",
            "comp_off": "CO",
            # NOTE: `late_coming` intentionally NOT mapped to "LT" any
            # more (20 Feb 2026 fix). A late-coming *leave* means the
            # member got permission to arrive late — the actual LT cell
            # should be driven by the attendance row's `late: true`
            # stamp. If the member never checked in, the day is AB,
            # not LT. This aligns Grid LT count with Payroll's
            # `late_days` (Attendance report is the source of truth).
        }

        def _classify(uid: str, iso: str, dow_idx: int, weekly_off: str,
                      work_start: str, joining_date: Optional[str] = None,
                      leaving_date: Optional[str] = None) -> str:
            # Pre-joining / post-leaving days render as NJ / LF so the
            # Grid stays honest for members who joined mid-year or have
            # left. Both codes are excluded from every totals bucket
            # (Present / Absent / Leave / Tour / EO / LT / OT / LOP).
            # Order matters: joining check fires first so a same-day
            # (leaving < joining, corrupt data) still shows NJ.
            if joining_date and iso < joining_date:
                return "NJ"
            if leaving_date and iso > leaving_date:
                return "LF"
            if iso > today_iso:
                return ""  # future
            att = att_by_user.get(uid, {}).get(iso)
            if att and att.get("check_in_at"):
                # `late` is the canonical field on attendance docs
                # (server.py:2070). `is_half_day` was a phantom check
                # that never fired because the field was never stamped;
                # dropped so we don't confuse readers.
                if att.get("late"):
                    return "LT"
                return "P"
            # No attendance — check approved leaves.
            for L in leaves_by_user.get(uid, []):
                if L.get("start_date") <= iso <= L.get("end_date"):
                    # Grid-initiated cancellations flip the whole date
                    # range to LP so admins can see the day counts as
                    # loss-of-pay without diving into the leave record
                    # (24 Feb 2026). Applies for the ENTIRE range —
                    # unlike the partial LOP tail below which only
                    # paints the trailing `lop_days` positions.
                    if L.get("status") == "cancelled" and L.get("converted_to_lop"):
                        return "LP"
                    code = LEAVE_CODE.get((L.get("type") or "").lower(), "LV")
                    # LOP overlay (20 Feb 2026): if an APPROVED `leave`
                    # (only `leave` runs the deduction ladder) has a
                    # non-zero `lop_days` stamp, mark the tail portion
                    # of the window as "LP" — convention is that
                    # balance drains from the front (comp-off + paid),
                    # so any un-covered days fall at the END. This
                    # lets admins see LOP without diving into payroll.
                    if code == "LV":
                        lop_d = float(L.get("lop_days") or 0)
                        if lop_d > 0:
                            end_d = date.fromisoformat(L["end_date"])
                            days_from_end = (end_d - date.fromisoformat(iso)).days
                            # `days_from_end` is 0 on the last day, 1
                            # on the second-last, etc. If the current
                            # day sits in the last `lop_d` positions,
                            # it's the LOP tail.
                            if days_from_end < lop_d:
                                return "LP"
                    return code
            # Break for this member (admin-applied via /admin/breaks).
            # Painted with a dedicated BK code so admins can tell it
            # apart from a global HO (15 Feb 2026).
            if iso in breaks_by_user.get(uid, {}):
                return "BK"
            if WEEKDAY_KEY[dow_idx] == weekly_off:
                return "WO"
            if iso in holiday_dates:
                return "HO"
            # Suppress today's "AB" until the check-in window has
            # actually opened — otherwise every 8 AM open of the app
            # would mark the entire roster as absent for the day.
            if iso == today_iso and now_hm < (work_start or default_work_start):
                return ""
            return "AB"

        # Precompute day-of-week per iso for the month.
        dow_by_iso = {iso: date.fromisoformat(iso).weekday() for iso in days}

        rows = []
        for u in users:
            uid = u["id"]
            weekly_off = (u.get("weekly_off") or default_wo).lower()
            work_start = u.get("work_start") or default_work_start
            cells = [_classify(uid, iso, dow_by_iso[iso], weekly_off, work_start,
                               u.get("joining_date"), u.get("leaving_date"))
                     for iso in days]
            # Per-cell metadata — used by the frontend tooltip layer.
            # Only populate entries where there IS extra context worth
            # surfacing (break name, leave reason, late minutes, half-day
            # window, checked-in time) — keeps the payload lean.
            # `with_meta=False` short-circuits — the CSV/PDF export path
            # doesn't need any tooltip context.
            cell_meta: dict = {}
            if with_meta:
                for idx, iso in enumerate(days):
                    code = cells[idx]
                    if not code or code in ("WO", "HO", "AB", "NJ", "LF"):
                        continue
                    m: dict = {}
                    if code == "BK":
                        b = breaks_by_user.get(uid, {}).get(iso)
                        if b:
                            m["break_name"] = b.get("name")
                            applier = admin_name_by_id.get(b.get("created_by"))
                            if applier:
                                m["applied_by"] = applier
                            if b.get("created_at"):
                                m["applied_at"] = b["created_at"]
                            rng = f"{b.get('start_date')}"
                            if b.get("end_date") and b["end_date"] != b.get("start_date"):
                                rng += f" → {b['end_date']}"
                            m["range"] = rng
                    elif code in ("LV", "LP", "TR", "CO", "PS"):
                        for L in leaves_by_user.get(uid, []):
                            if L.get("start_date") <= iso <= L.get("end_date"):
                                # Grid-initiated cancellations paint LP
                                # across the entire range but the SOURCE
                                # leave is the cancelled one — skip it
                                # here so the Grid click on an LP cell
                                # still targets the cancelled leave for
                                # any future undo flow.
                                if L.get("status") == "cancelled" and not L.get("converted_to_lop"):
                                    continue
                                # 24 Feb 2026: expose the leave id so the
                                # Grid can pre-bind it into the correction
                                # modal (`entityId`), skipping the picker
                                # step and going straight to "cancel this
                                # leave". Same field is used by TR / CO /
                                # PS cells since all four are `leaves`
                                # rows differing only by `type`.
                                if L.get("id"):
                                    m["leave_id"] = L["id"]
                                if L.get("reason"):
                                    m["reason"] = L["reason"]
                                if L.get("half_day"):
                                    m["half_day"] = L["half_day"]
                                if L.get("decided_by"):
                                    m["approved_by"] = L["decided_by"]
                                # Balance-split hint on tooltips — only
                                # meaningful for `type=leave` (comp-off
                                # / tour / posting don't run the ladder).
                                paid_used = L.get("paid_leave_used")
                                lop_days = L.get("lop_days")
                                co_used = L.get("comp_off_used")
                                if any(v is not None for v in (paid_used, lop_days, co_used)):
                                    parts = []
                                    if co_used:  parts.append(f"Comp-off: {int(co_used)}d")
                                    if paid_used: parts.append(f"Paid: {paid_used}d")
                                    if lop_days:  parts.append(f"LOP: {lop_days}d")
                                    if parts:
                                        m["balance_split"] = " · ".join(parts)
                                m["range"] = (
                                    L["start_date"] if L.get("start_date") == L.get("end_date")
                                    else f"{L.get('start_date')} → {L.get('end_date')}"
                                )
                                break
                    elif code in ("P", "HD", "LT"):
                        att = att_by_user.get(uid, {}).get(iso) or {}
                        if att.get("check_in_at"):
                            m["check_in_at"] = att["check_in_at"]
                        if att.get("check_out_at"):
                            m["check_out_at"] = att["check_out_at"]
                        if code == "LT" and att.get("late_minutes"):
                            m["late_minutes"] = int(att.get("late_minutes") or 0)
                        if att.get("overtime_total_min"):
                            m["ot_minutes"] = int(att.get("overtime_total_min") or 0)
                    if m:
                        cell_meta[iso] = m
            # Per-row totals — surfaces at the end of each row in the UI.
            # Half-day + Late still count as attendance (present-like);
            # Comp-off is bucketed with Leave (both are time-off types).
            # OT minutes are summed across all attendance rows in the
            # window — surfaces as an "OT h" column at the right so
            # admins can spot high-OT staff at a glance (15 Feb 2026
            # user request).
            ot_minutes = sum(
                int((att_by_user.get(uid, {}).get(iso) or {}).get("overtime_total_min") or 0)
                for iso in days
            )
            # Early-out count (13 Feb 2026 user request) — days where
            # the member checked out ≥15 min before their scheduled
            # work_end. Uses the freshly-stamped `early_out_minutes`
            # when present; otherwise computes on-the-fly from
            # check_out_at (local HH:MM) + the member's work_end so
            # historical rows also register. Grace threshold matches
            # the Profile early-out list (server.py:_early_by >= 15)
            # and the SelfCheckIn early-out prompt threshold.
            user_work_end = u.get("work_end") or ((office or {}).get("default_work_end") or "17:00")
            _we_parts = (user_work_end or "").split(":")[:2]
            try:
                user_work_end_min = int(_we_parts[0]) * 60 + int(_we_parts[1])
            except (ValueError, IndexError):
                user_work_end_min = None

            def _is_early_out(att: dict) -> bool:
                if not att or not att.get("check_out_at"):
                    return False
                stored = att.get("early_out_minutes")
                if stored is not None:
                    return int(stored) >= 15
                if user_work_end_min is None:
                    return False
                hm = local_hm(office, att.get("check_out_at"))
                if not hm or ":" not in hm:
                    return False
                try:
                    h, m = hm.split(":")[:2]
                    out_min = int(h) * 60 + int(m)
                except (ValueError, IndexError):
                    return False
                return (user_work_end_min - out_min) >= 15

            early_out_days = sum(
                1 for iso in days if _is_early_out(att_by_user.get(uid, {}).get(iso))
            )
            totals = {
                "present":     sum(1 for c in cells if c in ("P", "HD", "LT")),
                "absent":      sum(1 for c in cells if c == "AB"),
                # LP days count toward the "leave" total (backward
                # compat with pre-20-Feb behaviour where every approved
                # leave day rolled up into LV). The dedicated `lop`
                # sub-total below breaks it out for admins who want to
                # see the split.
                "leave":       sum(1 for c in cells if c in ("LV", "CO", "LP")),
                "tour":        sum(1 for c in cells if c == "TR"),
                # Late-count is a subset of Present — surfaced as its
                # own column at the right of the totals strip so admins
                # can spot habitual late-comers at a glance (15 Feb 2026).
                "late":        sum(1 for c in cells if c == "LT"),
                # LOP-day count (20 Feb 2026) — tail portion of any
                # approved leave whose requested days exceeded the
                # comp-off + paid-leave balance. Surfaces alongside
                # payroll's `lop_days` totals so admins get the same
                # number from either angle.
                "lop":         sum(1 for c in cells if c == "LP"),
                "ot_minutes":  ot_minutes,
                # Days with an ≥15-min early departure (subset of
                # Present; unrelated to Leaves). Sits next to LT in
                # the totals strip.
                "early_out":   early_out_days,
            }
            rows.append({
                "member_id": uid,
                "member_name": u.get("full_name"),
                "rank": u.get("rank"),
                "category": u.get("category"),
                "fleet": u.get("fleet"),
                "institution": u.get("institution"),
                "work_start": u.get("work_start") or default_work_start,
                "work_end": u.get("work_end") or ((office or {}).get("default_work_end") or "17:00"),
                "cells": cells,
                "cell_meta": cell_meta,
                "totals": totals,
            })
        rows.sort(key=lambda r: (r["member_name"] or "").lower())
        return {"month": month, "start": start_iso, "end": end_iso,
                "today": today_iso, "days": days, "rows": rows}

    @router.get("/reports/calendar-grid")
    async def calendar_grid(
        month: str,
        category: Optional[str] = None,
        fleet: Optional[str] = None,
        institution: Optional[str] = None,
        with_meta: bool = True,
        admin: dict = Depends(require_admin),
    ):
        """Admin-facing month grid. Thin wrapper over `_grid_impl` so the
        same computation backs both the UI and the external `/api/grid`
        pull (added Jun 2026 for the PayCraft integration)."""
        return await _grid_impl(month, category, fleet, institution, with_meta)

    @router.get("/grid")
    async def external_grid(
        month: str,
        key: str = "",
        category: Optional[str] = None,
        fleet: Optional[str] = None,
        institution: Optional[str] = None,
    ):
        """Read-only month-grid pull for a trusted external consumer
        (PayCraft payroll). Gated by a shared secret in the `key` query
        param, compared constant-time against `GRID_API_KEY` (server-to-
        server pulls) OR `EMBED_KEY` (the read-only /embed/grid iframe).
        Returns the same JSON as the admin grid but with per-cell tooltip
        metadata dropped (lighter payload for a scheduled pull).

        If neither key is configured the endpoint 503s — a mis-configured
        server must never behave like an open, PII-leaking endpoint.
        `category` accepts the usual buckets (athlete / elite / rest /
        payroll) so PayCraft can pull just the staff+coach population.
        """
        import hmac
        import os
        valid = [k for k in (
            os.environ.get("GRID_API_KEY", "").strip(),
            os.environ.get("EMBED_KEY", "").strip(),
        ) if k]
        if not valid:
            raise HTTPException(status_code=503, detail="Grid API disabled: no GRID_API_KEY / EMBED_KEY configured on server")
        supplied = (key or "").strip()
        if not supplied or not any(hmac.compare_digest(supplied, k) for k in valid):
            raise HTTPException(status_code=401, detail="Invalid key")
        return await _grid_impl(month, category, fleet, institution, with_meta=False)

    @router.get("/reports/calendar-grid/export")
    async def export_calendar_grid(
        month: str, fmt: str = "csv",
        category: Optional[str] = None,
        fleet: Optional[str] = None,
        institution: Optional[str] = None,
        admin: dict = Depends(require_admin),
    ):
        """CSV / PDF export of the calendar-grid report."""
        data = await _grid_impl(month, category, fleet, institution, with_meta=False)
        rows = data["rows"]
        days = data["days"]
        day_headers = [d[8:10] for d in days]  # "01", "02", ..., "31"
        headers = ["#", "Name", "Rank", "Category", *day_headers,
                   "Present", "Absent", "Leave", "Tour", "OT (h)", "Late", "EarlyOut"]

        def _fmt_ot(minutes: int) -> str:
            m = int(minutes or 0)
            if m <= 0:
                return ""
            h, mm = divmod(m, 60)
            return f"{h}h {mm}m" if h else f"{mm}m"

        table = [
            [str(i + 1),
             r.get("member_name") or "", r.get("rank") or "",
             (r.get("category") or "").title(),
             *r["cells"],
             str(r["totals"]["present"]), str(r["totals"]["absent"]),
             str(r["totals"]["leave"]), str(r["totals"]["tour"]),
             _fmt_ot(r["totals"].get("ot_minutes")),
             str(r["totals"].get("late") or ""),
             str(r["totals"].get("early_out") or "")]
            for i, r in enumerate(rows)
        ]
        filename_stem = f"calendar_grid_{month}"
        if fmt == "csv":
            return _csv_response(headers, table, f"{filename_stem}.csv")

        office = await db.config.find_one({"id": "office"})
        academy = (office or {}).get("office_name") or "iShowedUp"
        def _fmt(iso: str) -> str:
            try:
                y, m, d = iso.split("-")
                return f"{d}/{m}/{y[-2:]}"
            except Exception:
                return iso
        meta = {
            "Academy": academy,
            "Report": "Calendar Grid",
            "Month": month,
            "Range": f"{_fmt(data['start'])} → {_fmt(data['end'])}",
            "Members": str(len(rows)),
            "Filters": ", ".join(filter(None, [
                f"Category: {category}" if category else None,
                f"Fleet: {fleet}" if fleet else None,
                f"Institution: {institution}" if institution else None,
            ])) or "None",
            "Legend": "P=Present · HD=Half day · LT=Late · LV=Leave · "
                      "TR=Tour · PS=Posting · CO=Comp-off · WO=Weekly off · "
                      "HO=Holiday · AB=Absent",
            "Generated by": admin.get("full_name") or admin.get("email") or "Admin",
        }
        # A3 landscape ~397mm usable. #-col + Name+Rank+Cat + 31 days + 6 totals (P/AB/LV/TR/OT/LT).
        col_widths_mm = [8, 24, 14, 12] + [9] * len(days) + [12, 12, 12, 12, 14, 12]
        from reportlab.lib.pagesizes import A3
        pdf = _pdf_from_table(
            "Calendar Grid",
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
             # Canonical field is `late`, not `is_late`. Same bug as
             # calendar_grid — attendance-ledger's "Late" status was
             # unreachable before this fix.
             "late": 1, "overtime_total_min": 1,
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

        # `_hhmm` used to naively slice `iso[11:16]` — which returns
        # the UTC HH:MM stored in the DB, NOT the IST time the admin
        # expects. Prod bug 20 Feb 2026: attendance-ledger check-in
        # timings looked "strange" because they were UTC. Route through
        # `local_hm(office, iso)` (Asia/Kolkata via office_tz) instead.
        def _hhmm(iso):
            return local_hm(office, iso)

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
                if att.get("late"):
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
        member_id: str,
        year: Optional[int] = None,
        month: Optional[str] = None,
        admin: dict = Depends(require_admin),
    ):
        """Date-wise overtime sessions for a single member across a
        calendar month (default) or year. Powers the double-click OT
        drill-down modal.

        Pass `month=YYYY-MM` for month-scoped drill-down (default from
        15 Feb 2026 per user request). `year` is kept for year-wide
        PDF exports.
        """
        start, end, label = _ledger_window(year, month)
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
            "month": month,
            "window_label": label,
            "start": start,
            "end": end,
            "total_minutes": total_min,
            "rows": rows,
        }

    @router.get("/reports/ot-ledger/export")
    async def export_ot_ledger(
        member_id: str,
        year: Optional[int] = None,
        month: Optional[str] = None,
        fmt: str = "pdf",
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
        start, end, label = _ledger_window(year, month)
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
        # For IST-correct HH:MM rendering below.
        office = await db.config.find_one({"id": "office"})

        def _ddmmyyyy(iso: str) -> str:
            try:
                y, m, d = iso.split("-")
                return f"{d}/{m}/{y[-2:]}"
            except Exception:
                return iso

        def _hhmm(iso: str) -> str:
            if not iso:
                return "—"
            # IST conversion via office_tz — was slicing UTC bytes 11:16
            # before, which showed check-in times 5:30 hours behind IST
            # on any historical export path (attendance-ledger CSV/PDF).
            return local_hm(office, iso) or "—"

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
            "Early reason", "Late reason",
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
            "", "",
        ])

        if fmt == "csv":
            return _csv_response(headers, table, f"ot_ledger_{member_id}_{label}.csv")

        # PDF path — landscape A4, meta block matches the modal header.
        office = await db.config.find_one({"id": "office"})
        academy = (office or {}).get("office_name") or "iShowedUp"
        meta = {
            "Academy": academy,
            "Member": member_name,
            "Category": ((u or {}).get("category") or "").title() or "—",
            "Window": label,
            "Sessions": str(len(rows)),
            "Total OT": _fmt_min(tot_total),
            "Generated by": admin.get("full_name") or admin.get("email") or "Admin",
        }
        # Column widths (mm) tuned for A4 landscape (~277 mm usable).
        # Sum here = ~271 mm; reason columns eat what's left of the space.
        col_widths_mm = [22, 18, 20, 24, 26, 22, 65, 65]
        pdf = _pdf_from_table(
            f"Overtime Ledger — {member_name}",
            headers, table,
            subtitle=f"Window: {label}",
            orientation="landscape",
            col_widths=[w * mm for w in col_widths_mm],
            meta=meta,
            font_size=8,
        )
        return Response(
            content=pdf, media_type="application/pdf",
            headers={"Content-Disposition":
                     f"attachment; filename=ot_ledger_{member_name.replace(' ', '_')}_{label}.pdf"},
        )

    @router.get("/reports/comp-off-ledger")
    async def comp_off_ledger(
        member_id: str,
        year: Optional[int] = None,
        month: Optional[str] = None,
        admin: dict = Depends(require_admin),
    ):
        """Date-wise comp-off ledger for a single member across a
        calendar month (default) or year. Powers the double-click
        drill-down modal on the Comp-off columns in the Attendance
        report / The Grid.

        Returns three streams merged & sorted by date:
          • `earned`   — attendance date that fell on the member's
                         weekly_off (excl. dates that land inside an
                         approved posting window).
          • `applied`  — pending comp-off leaves.
          • `approved` — approved comp-off leaves (aka "used").

        Each row carries `date`, `dow` (Mon/Tue/…), `kind`, `qty`,
        and optionally `note` (leave reason / status detail).
        """
        yr_start, yr_end, label = _ledger_window(year, month)
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
            "month": month,
            "window_label": label,
            "start": yr_start,
            "end": yr_end,
            "totals": totals,
            "rows": rows,
        }

    @router.get("/reports/leave-ledger")
    async def leave_ledger(
        member_id: str,
        year: Optional[int] = None,
        month: Optional[str] = None,
        admin: dict = Depends(require_admin),
    ):
        """Date-wise leave ledger for a single member across a calendar
        month (default) or year. Powers the double-click drill-down
        modal on the Leave section (Open · COff · Total · Avld · Close)
        of the Attendance report / The Grid.

        Returns one row per leave application, sorted chronologically,
        with kind = applied (pending) / availed (approved) / rejected.
        Totals surface the split for the window at a glance.
        """
        yr_start, yr_end, label = _ledger_window(year, month)
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
            {"_id": 0, "id": 1, "status": 1, "start_date": 1, "end_date": 1,
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
                "id": L.get("id"),
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
            "month": month,
            "window_label": label,
            "start": yr_start,
            "end": yr_end,
            "totals": totals,
            "rows": rows,
        }

    def _ddmmyyyy(iso: str) -> str:
        try:
            y, m, d = iso.split("-")
            return f"{d}/{m}/{y[-2:]}"
        except Exception:
            return iso

    @router.get("/reports/comp-off-ledger/export")
    async def export_comp_off_ledger(
        member_id: str,
        year: Optional[int] = None,
        month: Optional[str] = None,
        fmt: str = "pdf",
        admin: dict = Depends(require_admin),
    ):
        """PDF/CSV of the comp-off ledger — mirrors the on-screen modal.
        Added 04 Feb 2026 alongside OT-ledger download so admins can hand
        a printable balance to any member applying for leave."""
        data = await comp_off_ledger(member_id, year, month, admin)
        rows = data["rows"]
        totals = data["totals"]
        member_name = data.get("member_name") or "Member"
        label = data.get("window_label") or (str(year) if year else month or "")
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
            return _csv_response(headers, table, f"comp_off_ledger_{member_id}_{label}.csv")
        office = await db.config.find_one({"id": "office"})
        academy = (office or {}).get("office_name") or "iShowedUp"
        meta = {
            "Academy": academy,
            "Member": member_name,
            "Category": ((data or {}).get("category") or "").title() or "—",
            "Window": label,
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
            subtitle=f"Window: {label}",
            orientation="landscape",
            col_widths=[w * mm for w in col_widths_mm],
            meta=meta,
            font_size=8,
        )
        return Response(
            content=pdf, media_type="application/pdf",
            headers={"Content-Disposition":
                     f"attachment; filename=comp_off_ledger_{member_name.replace(' ', '_')}_{label}.pdf"},
        )

    @router.get("/reports/leave-ledger/export")
    async def export_leave_ledger(
        member_id: str,
        year: Optional[int] = None,
        month: Optional[str] = None,
        fmt: str = "pdf",
        admin: dict = Depends(require_admin),
    ):
        """PDF/CSV of the leave ledger — mirrors the on-screen modal."""
        data = await leave_ledger(member_id, year, month, admin)
        rows = data["rows"]
        totals = data["totals"]
        member_name = data.get("member_name") or "Member"
        label = data.get("window_label") or (str(year) if year else month or "")
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
            return _csv_response(headers, table, f"leave_ledger_{member_id}_{label}.csv")
        office = await db.config.find_one({"id": "office"})
        academy = (office or {}).get("office_name") or "iShowedUp"
        meta = {
            "Academy": academy,
            "Member": member_name,
            "Category": ((data or {}).get("category") or "").title() or "—",
            "Window": label,
            "Opening balance": str(totals.get("opening", 0)),
            "Taken YTD": str(totals.get("taken_ytd", 0)),
            "Remaining": str(totals.get("remaining", 0)),
            "Generated by": admin.get("full_name") or admin.get("email") or "Admin",
        }
        col_widths_mm = [22, 22, 15, 22, 22, 15, 15, 20, 15, 55, 45]
        pdf = _pdf_from_table(
            f"Leave Ledger — {member_name}",
            headers, table,
            subtitle=f"Window: {label}",
            orientation="landscape",
            col_widths=[w * mm for w in col_widths_mm],
            meta=meta,
            font_size=7,
        )
        return Response(
            content=pdf, media_type="application/pdf",
            headers={"Content-Disposition":
                     f"attachment; filename=leave_ledger_{member_name.replace(' ', '_')}_{label}.pdf"},
        )

    return router
