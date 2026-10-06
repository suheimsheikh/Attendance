"""Reports routes — ledgers. Split out of routes/reports/__init__.py (Oct 2026); behaviour unchanged."""
from __future__ import annotations

from routes.reports.common import (  # noqa: F401
    Depends,
    HTTPException,
    Optional,
    Response,
    _csv_response,
    _hourly_wager_ot_rows,
    _pdf_from_table,
    date,
    local_date_str,
    local_hm,
    mm,
    timedelta,
)


def register(router, *, _ledger_window, db, require_admin):
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
        u = await db.users.find_one(
            {"id": member_id},
            {"_id": 0, "full_name": 1, "rank": 1, "category": 1, "hourly_wager": 1},
        )
        if (u or {}).get("hourly_wager"):
            rows = await _hourly_wager_ot_rows(db, member_id, start, end)
        else:
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
        u = await db.users.find_one(
            {"id": member_id},
            {"_id": 0, "full_name": 1, "category": 1, "rank": 1, "hourly_wager": 1},
        )
        if (u or {}).get("hourly_wager"):
            rows = await _hourly_wager_ot_rows(db, member_id, start, end)
        else:
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

    return {}
