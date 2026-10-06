"""Meals routes — calendar. Split out of routes/meals/__init__.py (Oct 2026); behaviour unchanged."""
from __future__ import annotations

from routes.meals.common import (  # noqa: F401
    Depends,
    File,
    HTTPException,
    MEAL_KEYS,
    Optional,
    UploadFile,
    date,
    local_date_str,
    now_utc,
    timedelta,
    uuid,
)


def register(router, *, DailyCountsIn, _MAIN_LABELS, _MAIN_MEALS, _days_in_month, _stock_snapshot, _valid_date, db, require_admin, require_chef_or_admin):
    def _valid_int(v) -> int:
        try:
            n = int(v)
            if n < 0:
                raise ValueError
            return n
        except Exception:
            raise HTTPException(status_code=400, detail=f"expected non-negative integer, got {v!r}")

    @router.get("/meals/meal-calendar")
    async def meal_calendar_list(
        start: Optional[str] = None,
        end: Optional[str] = None,
        user: dict = Depends(require_chef_or_admin),
    ):
        """Return daily meal counts in [start, end]. If either is
        omitted, defaults to the last 90 days.

        Sources, per date (highest priority wins):
          1. Manual/spreadsheet row in `meal_daily_counts`.
          2. Auto-derived count from per-person Meal Muster marks
             (`meal_records`, distinct users per meal). Includes the
             count of members who actually marked so the KPI strip
             reflects live Muster data even before anyone types it
             into the Calendar.
        """
        e = _valid_date(end) if end else local_date_str(None)
        e_d = date.fromisoformat(e)
        s = _valid_date(start) if start else (e_d - timedelta(days=90)).isoformat()
        s_d = date.fromisoformat(s)
        if s_d > e_d:
            raise HTTPException(status_code=400, detail="start must be before end")

        # ── Manual / spreadsheet rows ────────────────────────────────
        rows = await db.meal_daily_counts.find(
            {"date": {"$gte": s, "$lte": e}},
            {"_id": 0},
        ).sort("date", 1).to_list(500)
        by_date = {r["date"]: r for r in rows}

        # ── Muster derived counts: distinct users per (date, meal) ──
        # `meal_records` has one row per (user, date, meal). Same user
        # marking twice for the same meal is deduped via `$addToSet`.
        muster_pipeline = [
            {"$match": {"date": {"$gte": s, "$lte": e}}},
            {"$group": {
                "_id": {"date": "$date", "meal": "$meal"},
                "users": {"$addToSet": "$user_id"},
            }},
        ]
        muster_by_date: dict[str, dict[str, int]] = {}
        async for g in db.meal_records.aggregate(muster_pipeline):
            d = g["_id"]["date"]
            m = (g["_id"]["meal"] or "").lower()
            n = len([u for u in g["users"] if u])
            muster_by_date.setdefault(d, {})[m] = n

        def _muster_row(iso: str) -> dict | None:
            m = muster_by_date.get(iso)
            if not m:
                return None
            bf = int(m.get("breakfast") or 0)
            mm = int(m.get("midmorning") or 0)
            l  = int(m.get("lunch") or 0)
            sn = int(m.get("snacks") or 0)
            dn = int(m.get("dinner") or 0)
            if bf == 0 and mm == 0 and l == 0 and sn == 0 and dn == 0:
                return None
            return {
                "date": iso,
                "breakfast":  bf,
                "midmorning": mm,
                "lunch":      l,
                "snacks":     sn,
                "dinner":     dn,
                "total":      bf + mm + l + sn + dn,
                "source":     "muster",
                "has_data":   True,
            }

        out = []
        cur = s_d
        while cur <= e_d:
            iso = cur.isoformat()
            r = by_date.get(iso)
            # `has_muster` is independent of `source`: even when a
            # spreadsheet row wins the priority contest, we still want
            # to flag days that have per-person meal_records so the
            # UI can highlight them as "click to see roster".
            has_muster = iso in muster_by_date and any(
                (muster_by_date[iso].get(k) or 0) > 0
                for k in MEAL_KEYS
            )
            if r:
                bf = int(r.get("breakfast") or 0)
                mm = int(r.get("midmorning") or 0)
                l  = int(r.get("lunch") or 0)
                sn = int(r.get("snacks") or 0)
                dn = int(r.get("dinner") or 0)
                out.append({
                    "date": iso,
                    "breakfast":  bf,
                    "midmorning": mm,
                    "lunch":      l,
                    "snacks":     sn,
                    "dinner":     dn,
                    "total":      bf + mm + l + sn + dn,
                    "source":     r.get("source") or "manual",
                    "updated_at": r.get("updated_at"),
                    "has_data":   True,
                    "has_muster": has_muster,
                })
            else:
                mr = _muster_row(iso)
                if mr:
                    mr["has_muster"] = True
                    out.append(mr)
                else:
                    out.append({"date": iso, "breakfast": 0, "midmorning": 0, "lunch": 0,
                                "snacks": 0, "dinner": 0,
                                "total": 0, "source": None, "has_data": False,
                                "has_muster": False})
            cur += timedelta(days=1)
        # Totals for the KPI strip — now 5 meals. Read defensively via
        # .get() so legacy rows without midmorning/snacks still tally
        # into the 3 slots they DO have.
        totals = {"breakfast": 0, "midmorning": 0, "lunch": 0, "snacks": 0, "dinner": 0, "total": 0}
        populated = 0
        for r in out:
            if r["has_data"]:
                populated += 1
                for k in ("breakfast", "midmorning", "lunch", "snacks", "dinner"):
                    totals[k] += r.get(k, 0) or 0
                totals["total"] += r["total"]

        # ── Per-day purchase & issue COST (Sep 2026 Consumption view) ──
        # Purchases valued at their entered amount; issues valued at each
        # item's weighted-avg purchase rate over the window (fallback:
        # current stock snapshot rate). "Issue cost ÷ total meals" gives a
        # true per-meal consumption cost.
        purch_docs_c = await db.meal_purchases.find(
            {"date": {"$gte": s, "$lte": e}}, {"_id": 0, "date": 1, "lines": 1, "amounts": 1}).to_list(3000)
        iss_docs_c = await db.meal_issues.find(
            {"date": {"$gte": s, "$lte": e}}, {"_id": 0, "date": 1, "lines": 1}).to_list(3000)
        pq_c: dict[str, float] = {}
        pa_c: dict[str, float] = {}
        for doc in purch_docs_c:
            for ln in doc.get("lines") or []:
                iid = ln.get("item_id"); q = float(ln.get("qty") or 0); rt = float(ln.get("rate") or 0)
                if iid and q > 0:
                    pq_c[iid] = pq_c.get(iid, 0.0) + q
                    pa_c[iid] = pa_c.get(iid, 0.0) + q * rt
        snap_rows_c, _ = await _stock_snapshot(e, include_inactive=True)
        snap_rate_c = {r["item_id"]: float(r.get("avg_rate") or 0) for r in snap_rows_c}

        def _rate_c(iid: str) -> float:
            return pa_c[iid] / pq_c[iid] if pq_c.get(iid, 0) > 0 else snap_rate_c.get(iid, 0.0)

        pcost_by_date: dict[str, float] = {}
        icost_by_date: dict[str, float] = {}
        for doc in purch_docs_c:
            amts = doc.get("amounts") or {}
            if amts:
                c = sum(float(v or 0) for v in amts.values())
            else:
                c = sum(float(ln.get("amount") or (float(ln.get("qty") or 0) * float(ln.get("rate") or 0)))
                        for ln in doc.get("lines") or [])
            pcost_by_date[doc["date"]] = pcost_by_date.get(doc["date"], 0.0) + c
        for doc in iss_docs_c:
            c = sum(float(ln.get("qty") or 0) * _rate_c(ln.get("item_id"))
                    for ln in doc.get("lines") or [] if ln.get("item_id"))
            icost_by_date[doc["date"]] = icost_by_date.get(doc["date"], 0.0) + c
        # Kitchen wage bill is a FIXED monthly cost. A COMPLETED month's
        # full bill is spread equally across that month's meal-data days in
        # range (so it sums back to the full bill, e.g. 75k). The CURRENT
        # in-progress month is prorated to elapsed days (see _effective_bill
        # below) so ₹/meal doesn't spike early in the month.
        oh_docs_c = await db.meal_overheads.find(
            {"month": {"$gte": s[:7], "$lte": e[:7]}}, {"_id": 0}).to_list(400)
        bill_by_month = {
            d["month"]: float(d.get("staff_wages") or 0) + float(d.get("incidentals") or 0)
            for d in oh_docs_c
        }
        # Hybrid apportionment: a COMPLETED month carries its FULL monthly
        # bill (spread across its meal-data days in range → sums to the
        # bill), but the CURRENT in-progress month is prorated to elapsed
        # days so ₹/meal stays stable through the month instead of spiking
        # early. Future months contribute ₹0.
        _today_iso = local_date_str(None)
        _cur_mk = _today_iso[:7]
        _cur_day = int(_today_iso[8:10])

        def _effective_bill(mk: str) -> float:
            bill = bill_by_month.get(mk, 0.0)
            if not bill:
                return 0.0
            if mk < _cur_mk:
                return bill
            if mk == _cur_mk:
                return bill * _cur_day / _days_in_month(mk)
            return 0.0
        mealdays_by_month: dict[str, int] = {}
        for r in out:
            if r["has_data"]:
                mk = r["date"][:7]
                mealdays_by_month[mk] = mealdays_by_month.get(mk, 0) + 1
        overhead_total_c = 0.0
        for r in out:
            r["purchase_cost"] = round(pcost_by_date.get(r["date"], 0.0), 2)
            mk = r["date"][:7]
            bill = _effective_bill(mk)
            nd = mealdays_by_month.get(mk, 0)
            oh = round(bill / nd, 2) if (r["has_data"] and bill and nd) else 0.0
            r["wage_cost"] = oh
            overhead_total_c += oh
            r["issue_cost"] = round(icost_by_date.get(r["date"], 0.0), 2)
        totals["purchase_cost"] = round(sum(pcost_by_date.values()), 2)
        # Kitchen staff wage bill (apportioned per day) — sits BETWEEN
        # purchases and issues in the consumption view, and is folded into
        # the "…incl wages" cost-per-meal figures.
        totals["wage_cost"] = round(overhead_total_c, 2)
        totals["issue_cost"] = round(sum(icost_by_date.values()), 2)
        # Cost-per-meal denominator is MAIN meals only — Breakfast +
        # Lunch + Dinner (Jun 2026 user request). Mid-morning & afternoon
        # snacks cost far less, so counting them would dilute ₹/meal.
        _mm = totals["breakfast"] + totals["lunch"] + totals["dinner"]
        totals["main_meals"] = _mm
        totals["issue_cost_per_meal"] = round(totals["issue_cost"] / _mm, 2) if _mm else None
        totals["purchase_cost_per_meal"] = round(totals["purchase_cost"] / _mm, 2) if _mm else None
        totals["wage_cost_per_meal"] = round(totals["wage_cost"] / _mm, 2) if _mm else None
        # Fully-loaded cost per meal (food + wages), both lenses.
        totals["purchase_cost_incl_wages"] = round(totals["purchase_cost"] + totals["wage_cost"], 2)
        totals["issue_cost_incl_wages"] = round(totals["issue_cost"] + totals["wage_cost"], 2)
        totals["purchase_cost_per_meal_incl_wages"] = round(totals["purchase_cost_incl_wages"] / _mm, 2) if _mm else None
        totals["issue_cost_per_meal_incl_wages"] = round(totals["issue_cost_incl_wages"] / _mm, 2) if _mm else None
        # Cost per athlete-day — assumes 3 main meals (BF+L+D) per athlete
        # per day, so athlete-days = main_meals ÷ 3.
        _adays = (_mm / 3) if _mm else 0
        totals["athlete_days"] = round(_adays, 1)
        totals["cost_per_athlete_day"] = round(totals["issue_cost_incl_wages"] / _adays, 2) if _adays else None

        # ── Per-day data red flags (cheap subset: completeness only) ────
        # Outlier detection is intentionally NOT run here — day-to-day
        # headcounts vary enough that it would flag almost every row. It
        # lives only on the single-day Daily-entry banner instead.
        for r in out:
            fl = []
            main_now = (r.get("breakfast", 0) or 0) + (r.get("lunch", 0) or 0) + (r.get("dinner", 0) or 0)
            missing_main = [k for k in _MAIN_MEALS if (r.get(k, 0) or 0) <= 0]
            has_iss = (r.get("issue_cost", 0) or 0) > 0
            has_pur = (r.get("purchase_cost", 0) or 0) > 0
            if r["has_data"] or has_iss:
                if len(missing_main) == 3 and has_iss:
                    fl.append({"severity": "high", "code": "no_headcount",
                               "message": "Stock consumed but no meal headcount entered"})
                elif 0 < len(missing_main) < 3:
                    names = " / ".join(_MAIN_LABELS[k] for k in missing_main)
                    fl.append({"severity": "high", "code": "missing_main_meal",
                               "message": f"No {names} headcount recorded"})
            if r["has_data"] and main_now > 0 and not has_iss and not has_pur:
                fl.append({"severity": "medium", "code": "counts_no_consumption",
                           "message": "Meals recorded but no kitchen consumption entered"})
            r["flags"] = fl

        return {
            "start": s, "end": e,
            "days": out,
            "totals": totals,
            "populated_days": populated,
            "day_count": (e_d - s_d).days + 1,
        }

    @router.put("/meals/meal-calendar")
    async def meal_calendar_upsert(
        body: DailyCountsIn, user: dict = Depends(require_admin),
    ):
        d = _valid_date(body.date)
        bf = _valid_int(body.breakfast)
        mm = _valid_int(body.midmorning)
        l  = _valid_int(body.lunch)
        sn = _valid_int(body.snacks)
        dn = _valid_int(body.dinner)
        doc = {
            "date": d,
            "breakfast": bf,
            "midmorning": mm,
            "lunch": l,
            "snacks": sn,
            "dinner": dn,
            "total": bf + mm + l + sn + dn,
            "source": "manual",
            "updated_at": now_utc().isoformat(),
            "updated_by": user.get("id"),
            "updated_by_name": user.get("name"),
        }
        await db.meal_daily_counts.update_one(
            {"date": d}, {"$set": doc, "$setOnInsert": {"id": str(uuid.uuid4())}},
            upsert=True,
        )
        return {"ok": True, "date": d, "total": doc["total"]}

    @router.delete("/meals/meal-calendar/{iso_date}")
    async def meal_calendar_delete(iso_date: str, user: dict = Depends(require_admin)):
        d = _valid_date(iso_date)
        r = await db.meal_daily_counts.delete_one({"date": d})
        return {"ok": True, "deleted": r.deleted_count}

    @router.get("/meals/menu-master-download")
    async def menu_master_download(user: dict = Depends(require_chef_or_admin)):
        """Download the pre-built menu master workbook (combined
        `Calculations of menu` + `Recipes` files). Rebuilt at
        /app/backend/data/menu_master_combined.xlsx during the Feb 2026
        recipe ingest — regenerate offline via
        `scripts/build_menu_master.py` if the source spreadsheets change."""
        from fastapi.responses import FileResponse
        from pathlib import Path
        p = Path(__file__).resolve().parents[2] / "data" / "menu_master_combined.xlsx"
        if not p.exists():
            raise HTTPException(status_code=404, detail="menu_master_combined.xlsx not built yet")
        return FileResponse(
            path=str(p),
            filename="menu_master_combined.xlsx",
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )

    @router.get("/meals/meal-calendar/bounds")
    async def meal_calendar_bounds(user: dict = Depends(require_chef_or_admin)):
        """Return the earliest and latest dates for which any meal data
        exists — either an imported/manual row in `meal_daily_counts`
        or a live-muster mark in `meal_records`. The Meals Calendar UI
        uses `min_date` to default the "from" filter so admins see the
        entire history in one shot instead of just the current month."""
        dates: list[str] = []
        # Earliest & latest across both source collections.
        for coll in ("meal_daily_counts", "meal_records"):
            lo = await db[coll].find({}, {"_id": 0, "date": 1}).sort("date", 1).limit(1).to_list(1)
            hi = await db[coll].find({}, {"_id": 0, "date": 1}).sort("date", -1).limit(1).to_list(1)
            if lo: dates.append(lo[0]["date"])
            if hi: dates.append(hi[0]["date"])
        if not dates:
            today = local_date_str(None)
            return {"min_date": today, "max_date": today, "has_data": False}
        return {"min_date": min(dates), "max_date": max(dates), "has_data": True}

    @router.get("/meals/meal-calendar/events")
    async def meal_calendar_events(
        start: str, end: str,
        user: dict = Depends(require_chef_or_admin),
    ):
        """Return regattas / camps / breaks overlapping [start, end] so
        the Meals Calendar analytics can render them as coloured bands
        on the daily-trend chart. Only date-range fields are returned
        — no member lists — to keep payloads tiny."""
        s = _valid_date(start); e = _valid_date(end)
        # Overlap test: event.start_date <= end  AND  event.end_date >= start
        overlap = {"start_date": {"$lte": e}, "end_date": {"$gte": s}}
        def _pack(rows: list, kind: str) -> list:
            return [{"kind": kind, "name": r.get("name"),
                     "start_date": r.get("start_date"), "end_date": r.get("end_date"),
                     "level": r.get("level"), "location": r.get("location"),
                     "institution": r.get("institution"),
                     "days_of_week": r.get("days_of_week") or []}
                    for r in rows]
        reg   = await db.regattas.find(overlap, {"_id": 0}).to_list(200)
        cmp_  = await db.camps.find(overlap,    {"_id": 0}).to_list(200)
        brk   = await db.breaks.find(overlap,   {"_id": 0}).to_list(200)
        return {"regattas": _pack(reg, "regatta"),
                "camps":    _pack(cmp_, "camp"),
                "breaks":   _pack(brk, "break")}

    @router.post("/meals/meal-calendar/import")
    async def meal_calendar_import(
        file: UploadFile = File(...),
        overwrite: bool = False,
        user: dict = Depends(require_admin),
    ):
        """Bulk-import daily meal counts from a monthly spreadsheet.

        Accepts the standard chef layout (one sheet per month, columns:
        DATE · Sailors B/L/D/T · Staff B/L/D/T · Grand total). Reads
        every sheet, sums Sailors + Staff per meal-slot, and upserts
        one `meal_daily_counts` row per date.

        Duplicate handling:
          • `overwrite=false` (default) — dates already present are
            **skipped** and reported back in the response so the admin
            can review; this makes the import safe to run repeatedly.
          • `overwrite=true` — spreadsheet wins and existing rows are
            replaced. Use when the chef has a corrected file to reload.

        Response is a dry-run-style summary: inserted / updated /
        skipped / errors, so the caller can preview before deciding to
        rerun with `overwrite=true`.
        """
        import pandas as pd
        from io import BytesIO

        raw = await file.read()
        if not raw:
            raise HTTPException(status_code=400, detail="Uploaded file is empty.")
        try:
            xl = pd.ExcelFile(BytesIO(raw))
        except Exception as ex:
            raise HTTPException(status_code=400, detail=f"Not a valid .xlsx file: {ex}")

        parsed: list[dict] = []
        errors: list[dict] = []
        for sheet in xl.sheet_names:
            try:
                df = pd.read_excel(xl, sheet_name=sheet, header=None, skiprows=2)
            except Exception as ex:
                errors.append({"sheet": sheet, "error": f"read failed: {ex}"})
                continue
            for idx, r in df.iterrows():
                d = r.iloc[0] if len(r) > 0 else None
                if pd.isna(d):
                    continue
                try:
                    iso = pd.to_datetime(d).date().isoformat()
                except Exception:
                    continue
                def _n(i: int) -> int:
                    if i >= len(r):
                        return 0
                    v = r.iloc[i]
                    return int(v) if pd.notna(v) and str(v).strip() != "" else 0
                # cols 1..3 = Sailors B/L/D ; cols 5..7 = Staff B/L/D
                bf = _n(1) + _n(5)
                l = _n(2) + _n(6)
                dn = _n(3) + _n(7)
                tot = bf + l + dn
                if tot == 0:
                    continue
                # Legacy 3-meal sheet: midmorning/snacks are reset so the
                # stored total stays a true 5-slot sum on overwrite.
                parsed.append({
                    "date": iso, "breakfast": bf, "midmorning": 0, "lunch": l,
                    "snacks": 0, "dinner": dn, "total": tot,
                })

        # Group into three buckets against the existing DB rows.
        existing = {
            d["date"] async for d in db.meal_daily_counts.find({}, {"_id": 0, "date": 1})
        }
        to_insert = [r for r in parsed if r["date"] not in existing]
        overlap   = [r for r in parsed if r["date"] in existing]

        inserted = 0
        updated = 0
        skipped = 0
        for r in to_insert:
            r_doc = {**r, "source": f"upload:{file.filename}",
                     "updated_at": now_utc().isoformat(),
                     "updated_by": user.get("id"),
                     "updated_by_name": user.get("name")}
            await db.meal_daily_counts.update_one(
                {"date": r["date"]},
                {"$set": r_doc, "$setOnInsert": {"id": str(uuid.uuid4())}},
                upsert=True,
            )
            inserted += 1
        for r in overlap:
            if overwrite:
                await db.meal_daily_counts.update_one(
                    {"date": r["date"]},
                    {"$set": {**r, "source": f"upload:{file.filename}",
                              "updated_at": now_utc().isoformat(),
                              "updated_by": user.get("id"),
                              "updated_by_name": user.get("name")}},
                )
                updated += 1
            else:
                skipped += 1

        return {
            "filename": file.filename,
            "sheets": xl.sheet_names,
            "parsed": len(parsed),
            "inserted": inserted,
            "updated": updated,
            "skipped": skipped,
            "skipped_dates": [r["date"] for r in overlap][:60] if not overwrite else [],
            "errors": errors,
        }

    @router.get("/meals/audit-log")
    async def kitchen_audit_log(
        since: Optional[str] = None,
        until: Optional[str] = None,
        action: Optional[str] = None,
        actor_id: Optional[str] = None,
        limit: int = 300,
        user: dict = Depends(require_chef_or_admin),
    ):
        """Kitchen Audit Log — every change to kitchen/pantry data, newest
        first. Reads the shared `audit_log` collection filtered to the
        `meals.*` action namespace."""
        limit = max(1, min(int(limit or 300), 1000))
        q: dict = {"action": {"$regex": "^meals\\."}}
        if action:
            q["action"] = action
        if actor_id:
            q["actor_id"] = actor_id
        if since:
            q.setdefault("at", {})["$gte"] = since
        if until:
            q.setdefault("at", {})["$lte"] = f"{until}T23:59:59.999999+00:00"
        rows = await db.audit_log.find(q, {"_id": 0}).sort("at", -1).limit(limit).to_list(limit)
        return {"rows": rows, "count": len(rows)}

    @router.get("/meals/data-health")
    async def meals_data_health(user: dict = Depends(require_chef_or_admin)):
        """Kitchen data-health snapshot: items that will block issuing or
        look mis-configured, so someone can fix them proactively. Uses the
        as-of-today stock snapshot + purchase history."""
        today = local_date_str(None)
        rows, _ = await _stock_snapshot(today, include_inactive=False)
        purch = await db.meal_purchases.find({}, {"_id": 0, "lines": 1}).to_list(length=None)
        purchased_ids: set = set()
        last_rate: dict = {}
        for p in purch:
            for ln in p.get("lines") or []:
                iid = ln.get("item_id")
                q = float(ln.get("qty") or 0)
                if iid and q > 0:
                    purchased_ids.add(iid)
                    r = float(ln.get("rate") or 0) or (float(ln.get("amount") or 0) / q if q else 0)
                    if r > 0:
                        last_rate[iid] = round(r, 2)

        def _slim(r):
            return {"item_id": r["item_id"], "name": r.get("name"),
                    "category": r.get("category_label") or r.get("category_key"),
                    "unit": r.get("unit"), "on_hand": r.get("on_hand"),
                    "avg_rate": r.get("avg_rate") or 0,
                    "opening_stock": r.get("opening_stock") or 0,
                    "opening_rate": r.get("opening_rate") or 0,
                    "suggested_rate": last_rate.get(r["item_id"], 0)}

        negative = [_slim(r) for r in rows if (r.get("on_hand") or 0) < 0]
        # Untracked & un-purchased → issuing is blocked until stock is entered.
        no_stock = [_slim(r) for r in rows
                    if (r.get("on_hand") or 0) <= 0
                    and r["item_id"] not in purchased_ids
                    and not (r.get("opening_stock") or 0)]
        low = [_slim(r) for r in rows if r.get("low")]
        # Has stock on hand but no cost basis (avg_rate 0) → can't be valued.
        needs_rate = [_slim(r) for r in rows
                      if (r.get("on_hand") or 0) > 0 and (r.get("avg_rate") or 0) <= 0]
        return {
            "as_of": today,
            "counts": {
                "negative_stock": len(negative),
                "no_stock_untracked": len(no_stock),
                "low_stock": len(low),
                "needs_rate": len(needs_rate),
            },
            "negative_stock": negative,
            "no_stock_untracked": no_stock,
            "low_stock": low,
            "needs_rate": needs_rate,
        }

    return {}
