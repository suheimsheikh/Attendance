"""Reports routes — grid. Split out of routes/reports/__init__.py (Oct 2026); behaviour unchanged."""
from __future__ import annotations

from services.attendance_calc import effective_hours
from routes.reports.common import (
    Depends,
    GridReadResponse,
    HTTPException,
    Optional,
    _breaks_module,
    date,
    grid_punch_meta,
    local_date_str,
    local_hm,
    session_ot_minutes,
    timedelta,
)

# Grid cell codes that count as a payable day (Pay total).
PAYABLE_CODES = frozenset({"P", "HD", "LT", "LV", "CO", "TR", "PS", "WO", "HO", "BK"})


def register(router, *, _athlete_like_keys, db, require_admin):
    async def _grid_impl(
        month: str,
        category: Optional[str] = None,
        fleet: Optional[str] = None,
        institution: Optional[str] = None,
        with_meta: bool = True,
        member_id: Optional[str] = None,
        with_punch_times: bool = False,
    ):
        """Month-view calendar grid — one row per member, one cell per
        calendar day of the requested month.

        ``with_meta=False`` skips the per-cell tooltip metadata. The
        default is True to preserve the current UI contract; the CSV/PDF
        export path and any callers that don't need hover context can
        opt out to save ~30% payload size.

        ``with_punch_times=True`` selects the integration-only code/in/out
        metadata, using the same attendance records without changing cells
        or totals. It does not expose private leave/break tooltip details.

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
        default_wo = ((office or {}).get("default_weekly_off") or "sunday").lower()
        default_work_start = (office or {}).get("default_work_start") or "09:00"
        from holidays import WEEKDAY_KEY

        # --- Roster (same filter pills as Attendance report). ---
        users = await db.users.find(
            {"id": member_id} if member_id else {"status": {"$ne": "left"}, "archived": {"$ne": True}},
            {"_id": 0, "id": 1, "full_name": 1, "rank": 1, "category": 1,
             "fleet": 1, "institution": 1, "weekly_off": 1,
             "work_start": 1, "work_end": 1, "dow_hours": 1,
             # dar_exempt / dar_required MUST be projected — the DAR-miss
             # column runs dar_required_for() on these dicts, and without
             # these fields every staff/coach is wrongly treated as
             # DAR-required (exempt cooks/drivers/security showed misses).
             # Fixed Jun 2026 (user report).
             "dar_exempt": 1, "dar_required": 1, "status": 1,
             # Hourly-wager pay: OT column reflects rounded hours worked.
             "hourly_wager": 1,
             # Joining/leaving dates drive the "NJ" (Not Joined) and
             # "LF" (Left) cell codes so the Grid doesn't show
             # pre-joining or post-leaving days as absent. Added
             # 14 Feb 2026 (user request).
             "joining_date": 1, "leaving_date": 1},
        ).to_list(2000)
        # Members who left BEFORE this month starts are dropped entirely —
        # they only appear up to (and including) their leaving month, where
        # post-leaving days paint LF (user request, Jun 2026).
        if not member_id:
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
        elif with_punch_times and category and category != "all":
            # Integration callers also need exact staff/coach/executive
            # and custom category keys; retain all existing bucket meanings.
            users = [u for u in users if u.get("category") == category]
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
        import asyncio
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
                 "late": 1, "overtime_total_min": 1, "hours": 1,
                 # Early-out flag stamped at checkout (13 Feb 2026);
                 # historical rows are computed on-the-fly from
                 # check_out_at + user.work_end so the Grid tally is
                 # correct for pre-feature data too.
                 "early_out_minutes": 1, "missing_checkout": 1, "auto_checkout": 1,
                 "corrected_via": 1},
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
        # Who filed / approved each corrected day (Oct 2026) — surfaced in the cell tooltip.
        _corr_ids = list({a["corrected_via"] for a in att_docs if a.get("corrected_via")})
        corr_by_id: dict = {}
        if _corr_ids:
            async for c in db.corrections.find(
                    {"id": {"$in": _corr_ids}},
                    {"_id": 0, "id": 1, "kind": 1, "requester_name": 1, "filed_by_admin_name": 1,
                     "decided_by_name": 1, "decided_at": 1, "admin_note": 1}):
                corr_by_id[c["id"]] = {
                    "kind": c.get("kind"),
                    "filed_by": c.get("filed_by_admin_name") or c.get("requester_name"),
                    "approved_by": c.get("decided_by_name"),
                    "approved_at": c.get("decided_at"),
                    "auto": (c.get("admin_note") or "").startswith("Auto-approved"),
                }
        leaves_by_user: dict = {}
        for L in leave_docs:
            leaves_by_user.setdefault(L["user_id"], []).append(L)
        # Manual grid overrides (PayCraft / admin cell edits via
        # POST /api/grid/cell). A single explicit code per (user, date)
        # that trumps the computed classification below.
        override_docs = await db.grid_overrides.find(
            {"user_id": {"$in": user_ids},
             "date": {"$gte": start_iso, "$lte": end_iso}}, {"_id": 0},
        ).to_list(50000)
        overrides_by_user: dict = {}
        for o in override_docs:
            if o.get("user_id") and o.get("date") and o.get("code"):
                overrides_by_user.setdefault(o["user_id"], {})[o["date"]] = o["code"]
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

        def _leave_code(uid: str, iso: str) -> Optional[str]:
            """Approved-leave cell code for a member on a date: LV / TR /
            PS / CO, or the LP overlay for the loss-of-pay tail (and
            cancelled→LOP ranges). Returns None when no approved leave
            covers the date. Shared by the normal (past) branch and the
            future-date branch so planned leave shows ahead of time."""
            for L in leaves_by_user.get(uid, []):
                if L.get("start_date") <= iso <= L.get("end_date"):
                    # Grid-initiated cancellations flip the whole date
                    # range to LP so admins see the day counts as
                    # loss-of-pay without diving into the leave record
                    # (24 Feb 2026).
                    if L.get("status") == "cancelled" and L.get("converted_to_lop"):
                        return "LP"
                    code = LEAVE_CODE.get((L.get("type") or "").lower(), "LV")
                    # LOP overlay (20 Feb 2026): an APPROVED `leave` with a
                    # non-zero `lop_days` stamp paints its trailing days LP
                    # (balance drains from the front, so LOP falls at the END).
                    if code == "LV":
                        lop_d = float(L.get("lop_days") or 0)
                        if lop_d > 0:
                            _end = date.fromisoformat(L["end_date"])
                            if (_end - date.fromisoformat(iso)).days < lop_d:
                                return "LP"
                    return code
            return None

        def _classify(uid: str, iso: str, dow_idx: int, weekly_off: str,
                      work_start: str, joining_date: Optional[str] = None,
                      leaving_date: Optional[str] = None) -> str:
            # Manual grid override (PayCraft / admin cell edit) wins over
            # every computed rule — an explicit code set via /api/grid/cell.
            _ov = overrides_by_user.get(uid)
            if _ov and iso in _ov:
                return _ov[iso]
            # Athletes are tracked for attendance ONLY during designated
            # camps (user rule). On every other day their cell stays BLANK
            # and is excluded from totals — EXCEPT if they actually checked
            # in or were mustered that day, in which case the real attendance
            # is shown (user, Jun 2026). A manual override (above) still wins.
            # Employees (staff/coach/exec) are unaffected by this rule.
            _att_nc = att_by_user.get(uid, {}).get(iso)
            if (_cat_by_uid.get(uid, "") in _athlete_like_absent
                    and iso not in _expected_dates.get(uid, set())
                    and not (_att_nc and _att_nc.get("check_in_at"))):
                return ""
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
                # Future dates are normally blank, BUT an already-approved
                # leave / tour / posting / comp-off is surfaced ahead of
                # time so the roster shows planned absences (user request,
                # Jun 2026). Only leave-type codes appear early; future
                # weekly-off / holiday / absent stay blank until the day
                # elapses. NOTE: totals below still count ELAPSED days only,
                # so these future cells never inflate payroll figures.
                return _leave_code(uid, iso) or ""
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
            lc = _leave_code(uid, iso)
            if lc:
                return lc
            # Break for this member (admin-applied via /admin/breaks).
            # Painted with a dedicated BK code so admins can tell it
            # apart from a global HO (15 Feb 2026).
            if iso in breaks_by_user.get(uid, {}):
                return "BK"
            # Weekly-off / holiday are employee concepts and do NOT apply to
            # athletes — they're camp-driven, so an enrolled camp day always
            # overrides a weekly-off/holiday (a no-show resolves to AB on a
            # past day, or blank today while still in progress).
            _is_ath = _cat_by_uid.get(uid, "") in _athlete_like_absent
            if not _is_ath and WEEKDAY_KEY[dow_idx] == weekly_off:
                return "WO"
            if not _is_ath and iso in holiday_dates:
                return "HO"
            # The current day never shows "AB": the day is still in
            # progress, so a member with no check-in yet is rendered
            # blank (and excluded from every total) — they may still
            # check in, or it resolves to AB tomorrow once the day is
            # past. Option B, user-confirmed 30 Jun 2026.
            if iso == today_iso:
                return ""
            return _absent_or_blank(uid, iso)

        # Precompute day-of-week per iso for the month.
        dow_by_iso = {iso: date.fromisoformat(iso).weekday() for iso in days}

        # Camp-expected dates per athlete (user rule, Oct 2026 — camps only).
        # Athletes carry attendance ONLY on days an enrolled camp covers;
        # every other day is blanked by `_classify` and a camp no-show paints
        # "AB". Regattas and personal work_start do NOT make an athlete
        # expected. Employees (staff/coach/exec) are unaffected.
        from camps import camp_active_on as _camp_active_on, camp_applies_to as _camp_applies_to
        _WK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
        _athlete_like_absent = athlete_like
        _cat_by_uid = {u["id"]: (u.get("category") or "") for u in users}
        _camps_range = await db.camps.find(
            {"start_date": {"$lte": end_iso}, "end_date": {"$gte": start_iso}}, {"_id": 0},
        ).to_list(500)
        _expected_dates: dict = {}
        if _camps_range:
            _athletes = [u for u in users if (u.get("category") or "") in _athlete_like_absent]
            for iso in days:
                wk = _WK[dow_by_iso[iso]]
                active = [c for c in _camps_range if _camp_active_on(c, iso, wk)]
                if not active:
                    continue
                for u in _athletes:
                    if any(_camp_applies_to(c, u) for c in active):
                        _expected_dates.setdefault(u["id"], set()).add(iso)

        _hourly_uids = {u["id"] for u in users if u.get("hourly_wager")}

        # Camp/regatta bands for the header overview row (Oct 2026). Each
        # band is clamped to the visible window; the frontend merges them
        # into a sticky row under the DOW header.
        _regattas_range = await db.regattas.find(
            {"start_date": {"$lte": end_iso}, "end_date": {"$gte": start_iso}}, {"_id": 0},
        ).to_list(500)
        grid_events = (
            [{"type": "camp", "name": c.get("name") or "Camp",
              "start": max(c.get("start_date") or start_iso, start_iso),
              "end": min(c.get("end_date") or end_iso, end_iso)} for c in _camps_range]
            + [{"type": "regatta", "name": r.get("name") or "Regatta",
                "start": max(r.get("start_date") or start_iso, start_iso),
                "end": min(r.get("end_date") or end_iso, end_iso)} for r in _regattas_range]
        )

        def _absent_or_blank(uid: str, iso: str) -> str:
            """Athletes are AB only when expected at a camp that day;
            otherwise blank. Hourly wagers are never absent (blank).
            Other employees are always AB on a missed day."""
            if uid in _hourly_uids:
                return ""
            if _cat_by_uid.get(uid, "") in _athlete_like_absent:
                return "AB" if iso in _expected_dates.get(uid, set()) else ""
            return "AB"

        # Athlete-like categories are tracked via Breaks, not payroll
        # absence — the weekly-off "sandwich" rule below is an EMPLOYEE
        # rule, so we skip it for them.
        sandwich_athlete_like = athlete_like
        # DAR misses per employee (Sep 2026) — payroll deducts a day per miss.
        from services.dar import compute_missed_by_user
        dar_missed_by_user = await compute_missed_by_user(db, users, start_iso, end_iso, today_iso)
        rows = []
        for u in users:
            uid = u["id"]
            weekly_off = (u.get("weekly_off") or default_wo).lower()
            work_start = u.get("work_start") or default_work_start
            cells = [_classify(uid, iso, dow_by_iso[iso], weekly_off, work_start,
                               u.get("joining_date"), u.get("leaving_date"))
                     for iso in days]
            # Weekly-off "carry" rule (user-updated 30 Jun 2026): a
            # weekly-off day (or a run of consecutive WO days) is treated
            # as ABSENT when the member is absent (AB) on the working day
            # immediately BEFORE it OR immediately AFTER it. Only in-window
            # neighbours are considered, so a WO on the very first/last day
            # of the month is left untouched (its neighbour lives in an
            # unloaded adjacent month). Converted "AB" flows into totals.
            if u.get("category") not in sandwich_athlete_like:
                n = len(cells)
                i = 0
                while i < n:
                    if cells[i] == "WO":
                        j = i
                        while j + 1 < n and cells[j + 1] == "WO":
                            j += 1
                        before_abs = i - 1 >= 0 and cells[i - 1] == "AB"
                        after_abs = j + 1 < n and cells[j + 1] == "AB"
                        if before_abs or after_abs:
                            for k in range(i, j + 1):
                                cells[k] = "AB"
                        i = j + 1
                    else:
                        i += 1
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
                        _ot = session_ot_minutes(u, att)
                        if _ot:
                            m["ot_minutes"] = _ot
                        if att.get("corrected_via") in corr_by_id:
                            m["correction"] = corr_by_id[att["corrected_via"]]
                    if m:
                        cell_meta[iso] = m
            if with_punch_times:
                cell_meta = grid_punch_meta(days, cells, att_by_user.get(uid, {}), office)
            # Per-row totals — surfaces at the end of each row in the UI.
            # Half-day + Late still count as attendance (present-like);
            # Comp-off is bucketed with Leave (both are time-off types).
            # OT minutes are summed across all attendance rows in the
            # window — surfaces as an "OT h" column at the right so
            # admins can spot high-OT staff at a glance (15 Feb 2026
            # user request).
            ot_minutes = sum(
                session_ot_minutes(u, att_by_user.get(uid, {}).get(iso))
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
            user_work_end = u.get("work_end") or ((office or {}).get("default_work_end") or "17:00")  # noqa: F841 (kept for row schedule display)

            def _we_min_for(iso: str):
                """Member's effective work_end (minutes-of-day) for a given
                date, honoring any per-DOW override. None on parse failure."""
                we_hm = effective_hours(u, office, iso)[1]
                _p = (we_hm or "").split(":")[:2]
                try:
                    return int(_p[0]) * 60 + int(_p[1])
                except (ValueError, IndexError):
                    return None

            def _is_early_out(att: dict, iso: str) -> bool:
                if not att or not att.get("check_out_at"):
                    return False
                stored = att.get("early_out_minutes")
                if stored is not None:
                    return int(stored) >= 15
                we_min = _we_min_for(iso)
                if we_min is None:
                    return False
                hm = local_hm(office, att.get("check_out_at"))
                if not hm or ":" not in hm:
                    return False
                try:
                    h, m = hm.split(":")[:2]
                    out_min = int(h) * 60 + int(m)
                except (ValueError, IndexError):
                    return False
                return (we_min - out_min) >= 15

            early_out_days = sum(
                1 for iso in days if _is_early_out(att_by_user.get(uid, {}).get(iso), iso)
            )
            # Totals count ELAPSED days only (iso <= today) so future
            # planned-leave cells surfaced above never inflate the
            # month's LV / TR / LP figures (the LP total feeds PayCraft
            # leave-balances — future LOP must not be docked early).
            elapsed_cells = [c for c, iso in zip(cells, days) if iso <= today_iso]
            # Half-day leaves consume 0.5 of a leave day — reflect that on the
            # register so the Grid's `leave` + `payable` totals match the 0.5
            # the balance deducts (half-day leaves are single-day by
            # definition). 12 Oct 2026, user-approved. No half-days → no change.
            _hd_dates = {L["start_date"] for L in leaves_by_user.get(uid, [])
                         if L.get("half_day") and (L.get("type") or "").lower() == "leave"}
            _hd_count = sum(1 for c, iso in zip(cells, days)
                            if iso <= today_iso and c == "LV" and iso in _hd_dates)

            def _half(total: int) -> float:
                v = total - 0.5 * _hd_count
                return int(v) if float(v).is_integer() else round(v, 1)

            totals = {
                # Payable days (Oct 2026): every elapsed day that is paid —
                # worked (P/HD/LT), paid time-off (LV/CO), duty (TR/PS) and
                # off-days (WO/HO/BK). Excludes AB, LP, NJ, LF and future days.
                # Half-day leaves count 0.5 (only the paid half is payable).
                "payable":     _half(sum(1 for c in elapsed_cells if c in PAYABLE_CODES)),
                "present":     sum(1 for c in elapsed_cells if c in ("P", "HD", "LT")),
                "absent":      sum(1 for c in elapsed_cells if c == "AB"),
                # LP days count toward the "leave" total (backward
                # compat with pre-20-Feb behaviour where every approved
                # leave day rolled up into LV). The dedicated `lop`
                # sub-total below breaks it out for admins who want to
                # see the split.
                "leave":       _half(sum(1 for c in elapsed_cells if c in ("LV", "CO", "LP"))),
                "tour":        sum(1 for c in elapsed_cells if c == "TR"),
                # Late-count is a subset of Present — surfaced as its
                # own column at the right of the totals strip so admins
                # can spot habitual late-comers at a glance (15 Feb 2026).
                "late":        sum(1 for c in elapsed_cells if c == "LT"),
                # LOP-day count (20 Feb 2026) — tail portion of any
                # approved leave whose requested days exceeded the
                # comp-off + paid-leave balance. Surfaces alongside
                # payroll's `lop_days` totals so admins get the same
                # number from either angle.
                "lop":         sum(1 for c in elapsed_cells if c == "LP"),
                "ot_minutes":  ot_minutes,
                # Days with an ≥15-min early departure (subset of
                # Present; unrelated to Leaves). Sits next to LT in
                # the totals strip.
                "early_out":   early_out_days,
                # Worked days with no Daily Activity Report (employees
                # only, from the DAR policy effective date, excludes today).
                "dar_missed":  len(dar_missed_by_user.get(uid, [])),
            }
            if uid in _hourly_uids:
                # Hourly wagers are paid on hours only (ot_minutes, ≤8 h/day):
                # no payable days, absences, LOP, late, early-out or DAR cuts.
                totals.update(payable=0, absent=0, lop=0, late=0, early_out=0, dar_missed=0)
            if _cat_by_uid.get(uid, "") in athlete_like:
                # Athletes/elite are sailors, not paid staff — no pay (user
                # rule, Oct 2026). Attendance counts stay; only pay is zeroed.
                totals["payable"] = 0
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
                "today": today_iso, "days": days, "rows": rows, "events": grid_events}

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

    @router.get("/grid", response_model=GridReadResponse, response_model_exclude_unset=True)
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
        Keeps legacy cells/totals/schedules unchanged. Each date in cell_meta
        carries its code; worked days also carry office-local HH:MM in/out
        (null for a missing punch). No private UI tooltip details are exposed.

        If neither key is configured the endpoint 503s — a mis-configured
        server must never behave like an open, PII-leaking endpoint.
        `category=all` (or omitted) returns all grid members. Existing buckets
        (athlete / elite / rest / payroll) retain their meanings; staff,
        coach, executive and other category keys select exact categories.
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
        return await _grid_impl(month, category, fleet, institution,
                                with_meta=False, with_punch_times=True)

    return {"_grid_impl": _grid_impl}
