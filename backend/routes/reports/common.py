"""Module-level models, constants and pure helpers shared by the meals routes."""
from __future__ import annotations

import csv
import io
import uuid
from datetime import date, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Response

from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_RIGHT

from services.time_utils import local_date_str, local_hm, local_now, now_utc
from services.permissions import is_super_admin
from grid_models import GridReadResponse
from services.grid_punches import grid_punch_meta
from services.attendance_calc import session_ot_minutes
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


async def _hourly_wager_ot_rows(db, member_id: str, start: str, end: str) -> List[dict]:
    """OT-ledger rows for an hourly-wager member. Each worked day (a
    closed session with `hours`) becomes one row whose OT total is the
    hours worked rounded to the nearest half hour — mirroring how their
    pay is fed to payroll. The early/late split doesn't apply, so the
    whole value sits in the Total column with a self-describing reason."""
    docs = await db.attendance.find(
        {"user_id": member_id,
         "date": {"$gte": start, "$lte": end},
         "hours": {"$gt": 0}},
        {"_id": 0, "date": 1, "check_in_at": 1, "check_out_at": 1, "hours": 1},
    ).sort("date", 1).to_list(2000)
    member = {"hourly_wager": True}
    rows: List[dict] = []
    for d in docs:
        ot = session_ot_minutes(member, d)
        if ot <= 0:
            continue
        hrs = float(d.get("hours") or 0)
        rows.append({
            "date": d.get("date"),
            "check_in_at": d.get("check_in_at"),
            "check_out_at": d.get("check_out_at"),
            "overtime_early_min": 0,
            "overtime_late_min": 0,
            "overtime_total_min": ot,
            "overtime_reason": f"Hourly wage — {hrs:g}h worked",
            "overtime_early_reason": None,
            "overtime_late_reason": None,
            "overtime_status": None,
            "hourly_wager": True,
        })
    return rows
