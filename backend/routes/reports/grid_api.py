"""Reports routes — grid_api. Split out of routes/reports/__init__.py (Oct 2026); behaviour unchanged."""
from __future__ import annotations

from routes.reports.common import (  # noqa: F401
    Depends,
    HTTPException,
    Header,
    Optional,
    Response,
    _csv_response,
    _pdf_from_table,
    date,
    landscape,
    mm,
    now_utc,
    uuid,
)


def register(router, *, _grid_impl, _ledger_window, db, enrich_leaves, require_admin):
    @router.get("/embed/auth")
    async def embed_auth(x_embed_key: str = Header(default="")):
        """Exchange the embed secret for a short-lived portal session so the
        chrome-less /embed/grid page can render the FULL admin Grid UI
        inside an iframe. Hardened Jul 2026 after code review: the key is
        accepted ONLY from the `X-Embed-Key` header (never the query string,
        so it stays out of access logs / Referer), ONLY `EMBED_KEY` is
        honoured (the server-to-server GRID_API_KEY can no longer mint an
        admin session), and the token expires after EMBED_SESSION_MINUTES.
        """
        import hmac
        import os
        expected = os.environ.get("EMBED_KEY", "").strip()
        if not expected:
            raise HTTPException(status_code=503, detail="Embed disabled: EMBED_KEY not configured")
        supplied = (x_embed_key or "").strip()
        if not supplied or not hmac.compare_digest(supplied, expected):
            raise HTTPException(status_code=401, detail="Invalid key")
        admin = await db.users.find_one(
            {"email": os.environ.get("ADMIN_SEED_EMAIL")}, {"_id": 0, "hashed_password": 0})
        if not admin:
            admin = await db.users.find_one({"role": "admin"}, {"_id": 0, "hashed_password": 0})
        if not admin:
            raise HTTPException(status_code=500, detail="No admin account available for embed session")
        from services.auth_utils import create_token
        ttl = int(os.environ.get("EMBED_SESSION_MINUTES", "180"))
        token = create_token(admin["id"], admin.get("role", "admin"), expires_minutes=ttl)
        return {"access_token": token, "token_type": "bearer", "user": admin, "expires_in_minutes": ttl}

    # ── PayCraft server-to-server API (GROUP B read + GROUP C write) ─────
    # Same gate as /api/grid: shared secret `key` query param matched
    # constant-time against GRID_API_KEY. No user login. Writes refuse
    # (409) when the month grid is locked and audit every change.
    def _require_grid_key(key: str) -> None:
        import hmac
        import os
        expected = os.environ.get("GRID_API_KEY", "").strip()
        if not expected:
            raise HTTPException(status_code=503, detail="Grid API disabled: GRID_API_KEY not configured on server")
        if not key or not hmac.compare_digest((key or "").strip(), expected):
            raise HTTPException(status_code=401, detail="Invalid key")

    _API_ACTOR = {"id": "paycraft-api", "full_name": "PayCraft (API)", "role": "service"}
    _CELL_CODES = {"P", "LT", "AB", "LV", "LP", "TR", "CO", "WO", "HO", "NJ", "LF"}

    def _bucket(rows: list, category: Optional[str], athlete_like: set) -> list:
        if category == "athlete":
            return [r for r in rows if r.get("category") in athlete_like]
        if category == "rest":
            return [r for r in rows if r.get("category") not in athlete_like]
        if category == "payroll":
            return [r for r in rows if r.get("category") in {"staff", "coach"}]
        return rows

    from services.grid_lock import get_month_lock, assert_month_unlocked

    async def _month_lock(month: str) -> dict:
        return await get_month_lock(db, month)

    async def _assert_unlocked(month: str) -> None:
        await assert_month_unlocked(db, month)

    # ---- GROUP B: read-only ------------------------------------------------
    @router.get("/leave-requests")
    async def api_leave_requests(month: str, key: str = "", status: str = "all"):
        """Leave/tour/comp-off/posting requests overlapping the month."""
        _require_grid_key(key)
        from holidays import _days_inclusive
        start_iso, end_iso, _ = _ledger_window(None, month)
        q: dict = {"start_date": {"$lte": end_iso}, "end_date": {"$gte": start_iso}}
        if status and status != "all":
            if status not in ("pending", "approved", "rejected", "cancelled"):
                raise HTTPException(status_code=400, detail="status must be pending | approved | all")
            q["status"] = status
        docs = await db.leaves.find(q, {"_id": 0}).to_list(20000)
        docs = await enrich_leaves(docs)
        rows = []
        for L in docs:
            if L.get("half_day"):
                days = 0.5
            else:
                try:
                    days = _days_inclusive(L.get("start_date"), L.get("end_date"))
                except Exception:
                    days = None
            rows.append({
                "id": L.get("id"),
                "member_id": L.get("user_id"),
                "member_name": L.get("member_name"),
                "from": L.get("start_date"),
                "to": L.get("end_date"),
                "days": days,
                "type": L.get("type"),
                "status": L.get("status"),
                "reason": L.get("reason"),
            })
        rows.sort(key=lambda r: (r.get("from") or ""))
        return {"rows": rows}

    @router.get("/corrections")
    async def api_corrections(month: str, key: str = "", status: str = "pending"):
        """Attendance/leave correction requests with a target_date in the month."""
        _require_grid_key(key)
        start_iso, end_iso, _ = _ledger_window(None, month)
        q: dict = {"target_date": {"$gte": start_iso, "$lte": end_iso}}
        if status and status != "all":
            q["status"] = status
        docs = await db.corrections.find(q, {"_id": 0}).sort("requested_at", -1).to_list(5000)
        rows = []
        for c in docs:
            p = c.get("payload") or {}
            rows.append({
                "id": c.get("id"),
                "member_id": c.get("requester_id"),
                "member_name": c.get("requester_name"),
                "date": c.get("target_date"),
                "from_code": p.get("from_code"),
                "to_code": p.get("to_code") or p.get("code"),
                "reason": c.get("reason"),
                "status": c.get("status"),
                "requested_by": c.get("filed_by_admin_name") or c.get("requester_name"),
            })
        return {"rows": rows}

    @router.get("/grid/status")
    @router.get("/grid-status")
    async def api_grid_status(month: str, key: str = ""):
        """Lock status of a month's grid."""
        _require_grid_key(key)
        lk = await _month_lock(month)
        return {
            "month": month,
            "locked": bool(lk.get("locked")),
            "locked_by": lk.get("locked_by_name") or lk.get("locked_by"),
            "locked_on": lk.get("locked_on"),
        }

    # ---- GROUP C: writes (refuse 409 when month locked; audited) -----------
    @router.post("/grid/cell")
    @router.post("/grid-cell")
    async def api_grid_cell(body: dict, key: str = ""):
        """Set/override a single member-day cell code."""
        _require_grid_key(key)
        member_id = (body or {}).get("member_id")
        d = (body or {}).get("date")
        code = (body or {}).get("code")
        if not member_id or not d or not code:
            raise HTTPException(status_code=400, detail="member_id, date and code are required")
        if code not in _CELL_CODES:
            raise HTTPException(status_code=400, detail=f"code must be one of {sorted(_CELL_CODES)}")
        try:
            date.fromisoformat(d)
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
        member = await db.users.find_one({"id": member_id}, {"_id": 0, "id": 1, "full_name": 1})
        if not member:
            raise HTTPException(status_code=400, detail="Unknown member_id")
        month = d[:7]
        await _assert_unlocked(month)
        prev = await db.grid_overrides.find_one({"user_id": member_id, "date": d}, {"_id": 0, "code": 1})
        now = now_utc().isoformat()
        await db.grid_overrides.update_one(
            {"user_id": member_id, "date": d},
            {"$set": {"code": code, "set_by": _API_ACTOR["id"], "set_by_name": _API_ACTOR["full_name"], "set_at": now},
             "$setOnInsert": {"id": str(uuid.uuid4())}},
            upsert=True,
        )
        from routes.admin_audit import write_audit
        await write_audit(
            db, actor=_API_ACTOR, action="grid_cell_override",
            entity_type="attendance", entity_id=f"{member_id}:{d}",
            entity_name=f"{member.get('full_name')} · {d}",
            before={"code": (prev or {}).get("code")}, after={"code": code},
            reason="PayCraft grid cell edit",
        )
        return {"ok": True}

    @router.post("/corrections/decision")
    async def api_corrections_decision(body: dict, key: str = ""):
        """Approve/reject a pending correction (applies the change on approve)."""
        _require_grid_key(key)
        cid = (body or {}).get("id")
        action = (body or {}).get("action")
        note = ((body or {}).get("note") or "").strip() or None
        if not cid or action not in ("approve", "reject"):
            raise HTTPException(status_code=400, detail="id and action ('approve'|'reject') are required")
        c = await db.corrections.find_one({"id": cid}, {"_id": 0})
        if not c:
            raise HTTPException(status_code=404, detail="Correction not found")
        if c.get("status") != "pending":
            raise HTTPException(status_code=409, detail=f"Correction already {c.get('status')}")
        target = c.get("target_date") or (c.get("payload") or {}).get("start_date")
        if not target:
            raise HTTPException(status_code=409, detail="Correction has no target date; cannot verify month lock")
        await _assert_unlocked(target[:7])
        decision = "approved" if action == "approve" else "rejected"
        from routes.admin_audit import write_audit
        from routes.corrections import APPLIERS
        applied = None
        if decision == "approved":
            applier = APPLIERS.get((c.get("entity_type"), c.get("kind")))
            if not applier:
                raise HTTPException(status_code=500, detail=f"No applier for {c.get('entity_type')}/{c.get('kind')}")
            applied = await applier(db, c, _API_ACTOR)
        now = now_utc().isoformat()
        await db.corrections.update_one({"id": cid}, {"$set": {
            "status": decision,
            "decided_by_id": _API_ACTOR["id"],
            "decided_by_name": _API_ACTOR["full_name"],
            "decided_at": now,
            "admin_note": note,
            "applied": applied,
        }})
        await write_audit(
            db, actor=_API_ACTOR, action=f"correction_{decision}",
            entity_type="correction", entity_id=cid,
            entity_name=f"{c.get('entity_type')}/{c.get('kind')} · {c.get('requester_name')} · {c.get('target_date')}",
            before={"status": "pending"}, after={"status": decision, "applied": applied, "admin_note": note},
            reason=note or f"{decision} via PayCraft",
        )
        return {"ok": True, "id": cid, "decision": decision, "applied": applied}

    @router.post("/grid/lock")
    @router.post("/grid-lock")
    async def api_grid_lock(body: dict, key: str = ""):
        """Lock/unlock a month's grid. Locked months refuse all other writes."""
        _require_grid_key(key)
        month = (body or {}).get("month")
        locked = (body or {}).get("locked")
        if not month or not isinstance(locked, bool):
            raise HTTPException(status_code=400, detail="month (YYYY-MM) and locked (bool) are required")
        try:
            _ledger_window(None, month)  # validates YYYY-MM
        except HTTPException:
            raise HTTPException(status_code=400, detail="month must be YYYY-MM")
        prev = await _month_lock(month)
        now = now_utc().isoformat()
        await db.grid_locks.update_one(
            {"month": month},
            {"$set": {
                "locked": locked,
                "locked_by": _API_ACTOR["id"] if locked else None,
                "locked_by_name": _API_ACTOR["full_name"] if locked else None,
                "locked_on": now if locked else None,
            }, "$setOnInsert": {"id": str(uuid.uuid4()), "month": month}},
            upsert=True,
        )
        from routes.admin_audit import write_audit
        await write_audit(
            db, actor=_API_ACTOR, action="grid_lock" if locked else "grid_unlock",
            entity_type="grid_lock", entity_id=month, entity_name=f"Grid {month}",
            before={"locked": bool(prev.get("locked"))}, after={"locked": locked},
            reason="PayCraft grid lock toggle",
        )
        return {"ok": True, "month": month, "locked": locked, "locked_on": now if locked else None}

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
                   "Present", "Absent", "Leave", "LOP", "Tour", "OT (h)", "Late", "EarlyOut", "DAR X"]

        def _fmt_ot(minutes: int) -> str:
            m = int(minutes or 0)
            if m <= 0:
                return ""
            h, mm = divmod(m, 60)
            return f"{h}h {mm}m" if h else f"{mm}m"

        def _dar(n) -> str:
            n = int(n or 0)
            return f"X{n}" if n else ""

        table = [
            [str(i + 1),
             r.get("member_name") or "", r.get("rank") or "",
             (r.get("category") or "").title(),
             *r["cells"],
             str(r["totals"]["present"]), str(r["totals"]["absent"]),
             str(r["totals"]["leave"]), str(r["totals"].get("lop") or ""),
             str(r["totals"]["tour"]),
             _fmt_ot(r["totals"].get("ot_minutes")),
             str(r["totals"].get("late") or ""),
             str(r["totals"].get("early_out") or ""),
             _dar(r["totals"].get("dar_missed"))]
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
                      "LP=Loss of pay · TR=Tour · PS=Posting · CO=Comp-off · "
                      "WO=Weekly off · HO=Holiday · AB=Absent · DAR X=missed DAR",
            "Generated by": admin.get("full_name") or admin.get("email") or "Admin",
        }
        # A3 landscape ~397mm usable. #-col + Name+Rank+Cat + days + 9 totals
        # (P/AB/LV/LOP/TR/OT/LT/EO/DAR). Day columns trimmed to 7mm so the two
        # extra totals columns still fit a 31-day month without clipping.
        col_widths_mm = [8, 22, 13, 11] + [7] * len(days) + [10, 10, 10, 10, 10, 13, 10, 12, 11]
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

    return {}
