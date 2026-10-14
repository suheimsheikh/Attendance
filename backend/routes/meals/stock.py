"""Meals routes — stock. Split out of routes/meals/__init__.py (Oct 2026); behaviour unchanged."""
from __future__ import annotations

from routes.meals.common import (
    Depends,
    HTTPException,
    IssuesUpsertIn,
    LinesPatchIn,
    Optional,
    Query,
    VALID_UNITS,
    VALID_WASTAGE_REASONS,
    WastageUpsertIn,
    _assert_qty_rate_sane,
    _parse_amount,
    date,
    local_date_str,
    now_utc,
    timedelta,
    uuid,
)


def register(router, *, _audit, _diff_meta, _line_diff, _not_future, _safe_date_upsert, _signal_meals, _stock_snapshot, _upsert_line_scoped, _valid_date, db, require_chef_or_admin):
    # ------------------------------------------------------------------
    # Daily issues (consumption)
    # ------------------------------------------------------------------
    @router.get("/meals/issues")
    async def list_issues(
        start: str, end: str, user: dict = Depends(require_chef_or_admin),
    ):
        s, e = _valid_date(start), _valid_date(end)
        if s > e:
            raise HTTPException(status_code=400, detail="start must be before end")
        rows = await db.meal_issues.find(
            {"date": {"$gte": s, "$lte": e}}, {"_id": 0},
        ).sort("date", 1).to_list(400)
        return {"start": s, "end": e, "issues": rows}

    async def _assert_issue_stock(d: str, lines: list) -> None:
        """Hard stock guard (Jun 2026, user request): reject issuing more
        of any item than is on hand as of date `d`. Available =
        opening + Σpurchases − Σ(other issues) − Σwastage + Σadjustments
        up to `d`; the day's already-saved issue for the item is added
        back since this save replaces it. Items with no recorded stock
        resolve to 0 and are blocked too — the error says where to fix it.
        """
        wanted: dict = {}
        for ln in lines:
            iid = str(ln.get("item_id") or "").strip()
            q = _parse_amount(ln.get("qty"))
            if iid and q and q > 0:
                wanted[iid] = wanted.get(iid, 0.0) + float(q)
        if not wanted:
            return
        snap_rows, _ = await _stock_snapshot(d, include_inactive=True)
        on_hand = {r["item_id"]: r["on_hand"] for r in snap_rows}
        unit_by = {r["item_id"]: (r.get("unit") or "") for r in snap_rows}
        name_by = {r["item_id"]: r.get("name") for r in snap_rows}
        existing = await db.meal_issues.find_one({"date": d}, {"_id": 0, "lines": 1})
        prior: dict = {}
        for ln in (existing or {}).get("lines") or []:
            iid = ln.get("item_id")
            if iid:
                prior[iid] = prior.get(iid, 0.0) + float(ln.get("qty") or 0)
        EPS = 1e-4
        shortages = []
        for iid, want in wanted.items():
            avail = round(on_hand.get(iid, 0.0) + prior.get(iid, 0.0), 4)
            if want - avail > EPS:
                nm = name_by.get(iid) or "item"
                u = unit_by.get(iid) or ""
                shortages.append(
                    f"{nm} (need {round(want, 3)}{u}, only {round(max(avail, 0.0), 3)}{u} in stock)"
                )
        if shortages:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Not enough stock to issue: " + "; ".join(shortages)
                    + ". Enter opening stock in Purchases & Issues → Stock Master "
                    "(edit the item → Opening stock), or record a purchase in "
                    "Purchases & Issues → Daily entry, before issuing."
                ),
            )

    async def _issue_qty_warnings(d: str, lines: list) -> list:
        """Non-blocking sanity check (Jun 2026, user request): flag issue
        quantities far above an item's normal daily amount so obvious
        typos (e.g. 50kg for 5kg) get a warning without blocking the save.
        Normal = average issued qty per issuing-day over the prior 30 days;
        a line is flagged when it exceeds 3× that average (and the average
        is meaningful). Items with no issue history are never flagged."""
        wanted: dict = {}
        for ln in lines:
            iid = str(ln.get("item_id") or "").strip()
            q = _parse_amount(ln.get("qty"))
            if iid and q and q > 0:
                wanted[iid] = max(wanted.get(iid, 0.0), float(q))
        if not wanted:
            return []
        start = (date.fromisoformat(d) - timedelta(days=30)).isoformat()
        docs = await db.meal_issues.find(
            {"date": {"$gte": start, "$lt": d}}, {"_id": 0, "date": 1, "lines": 1},
        ).to_list(400)
        totals: dict = {}
        days_seen: dict = {}
        for doc in docs:
            for ln in doc.get("lines") or []:
                iid = ln.get("item_id")
                q = float(ln.get("qty") or 0)
                if iid and q > 0:
                    totals[iid] = totals.get(iid, 0.0) + q
                    days_seen.setdefault(iid, set()).add(doc["date"])
        warns = []
        item_names = {ln.get("item_id"): (ln.get("item_name") or ln.get("name"))
                      for ln in lines if isinstance(ln, dict)}
        for iid, want in wanted.items():
            nd = len(days_seen.get(iid, ()))
            if nd < 3:
                continue  # too little history to judge "normal"
            avg = totals[iid] / nd
            if avg > 0 and want > 3 * avg:
                nm = item_names.get(iid) or "item"
                warns.append(f"{nm}: {round(want, 2)} is well above the usual ~{round(avg, 2)}/day — please double-check.")
        return warns

    @router.put("/meals/issues/{date_str}")
    async def upsert_issues(
        date_str: str, body: IssuesUpsertIn,
        user: dict = Depends(require_chef_or_admin),
    ):
        d = _not_future(_valid_date(date_str))
        item_ids = [str(l.get("item_id") or "") for l in body.lines if l.get("item_id")]
        items = await db.meal_items.find(
            {"id": {"$in": item_ids}}, {"_id": 0},
        ).to_list(len(item_ids) or 1)
        by_id = {i["id"]: i for i in items}

        clean: list[dict] = []
        for raw in body.lines:
            iid = str(raw.get("item_id") or "").strip()
            item = by_id.get(iid)
            if not item:
                raise HTTPException(status_code=400,
                                    detail=f"Unknown item_id: {iid or '(blank)'}")
            qty = _parse_amount(raw.get("qty"))
            if qty is None or qty <= 0:
                continue  # blank/zero silently dropped
            _assert_qty_rate_sane(item["name"], qty)
            clean.append({
                "id": str(raw.get("id") or uuid.uuid4()),
                "item_id": iid,
                "item_name": item.get("name"),
                "category_key": item.get("category_key"),
                "qty": round(qty, 4),
                "unit": item.get("unit"),
            })

        stamp = {
            "updated_at": now_utc().isoformat(),
            "updated_by": user.get("id"),
            "updated_by_name": user.get("full_name") or user.get("email"),
        }
        await _assert_issue_stock(d, clean)
        warns = await _issue_qty_warnings(d, clean)
        prev = await db.meal_issues.find_one({"date": d}, {"_id": 0, "lines": 1})
        await _safe_date_upsert(
            db.meal_issues,
            {"date": d},
            {"$set": {"date": d, "lines": clean, **stamp},
             "$setOnInsert": {"id": str(uuid.uuid4())}},
        )
        await _signal_meals("issues", d)
        _diff = _line_diff((prev or {}).get("lines"), clean, "issue")
        await _audit(user, "meals.issue.save", "meal_issue", d, f"Issues {d}", meta=_diff_meta(d, _diff))
        return {"date": d, "lines": clean, "warnings": warns}

    @router.patch("/meals/issues/{date_str}")
    async def patch_issue_lines(
        date_str: str, body: LinesPatchIn,
        user: dict = Depends(require_chef_or_admin),
    ):
        """Merge ONLY the edited lines into the day's issues doc — each
        item updated atomically (positional $set / $push / $pull) so
        concurrent machines editing different items never clash."""
        d = _not_future(_valid_date(date_str))
        _prev = await db.meal_issues.find_one({"date": d}, {"_id": 0, "lines": 1})
        item_ids = [str(l.get("item_id") or "") for l in body.upserts if l.get("item_id")]
        items = await db.meal_items.find(
            {"id": {"$in": item_ids}}, {"_id": 0},
        ).to_list(len(item_ids) or 1)
        by_id = {i["id"]: i for i in items}
        # Validate item ids up-front so an unknown id yields a clear error
        # rather than a confusing "not enough stock" from the guard below.
        for _u in body.upserts:
            _iid = str(_u.get("item_id") or "").strip()
            if not _iid or _iid not in by_id:
                raise HTTPException(status_code=400,
                                    detail=f"Unknown item_id: {_iid or '(blank)'}")
        await _assert_issue_stock(d, list(body.upserts))
        _named = [{"item_id": u.get("item_id"), "qty": u.get("qty"),
                   "item_name": (by_id.get(str(u.get("item_id") or "")) or {}).get("name")}
                  for u in body.upserts]
        warns = await _issue_qty_warnings(d, _named)
        await _safe_date_upsert(
            db.meal_issues,
            {"date": d},
            {"$setOnInsert": {"id": str(uuid.uuid4()), "date": d, "lines": []}},
        )
        removes = [str(r) for r in body.removes]
        for raw in body.upserts:
            iid = str(raw.get("item_id") or "").strip()
            item = by_id.get(iid)
            if not item:
                raise HTTPException(status_code=400,
                                    detail=f"Unknown item_id: {iid or '(blank)'}")
            qty = _parse_amount(raw.get("qty"))
            if qty is None or qty <= 0:
                removes.append(iid)
                continue
            _assert_qty_rate_sane(item["name"], qty)
            line = {
                "id": str(uuid.uuid4()),
                "item_id": iid,
                "item_name": item.get("name"),
                "category_key": item.get("category_key"),
                "qty": round(qty, 4),
                "unit": item.get("unit"),
            }
            await _upsert_line_scoped(db.meal_issues, d, line)
        for iid in removes:
            await db.meal_issues.update_one(
                {"date": d}, {"$pull": {"lines": {"item_id": iid}}})
        await db.meal_issues.update_one({"date": d}, {"$set": {
            "updated_at": now_utc().isoformat(),
            "updated_by": user.get("id"),
            "updated_by_name": user.get("full_name") or user.get("email"),
        }})
        await _signal_meals("issues", d)
        doc = await db.meal_issues.find_one({"date": d}, {"_id": 0})
        _diff = _line_diff((_prev or {}).get("lines"), (doc or {}).get("lines"), "issue")
        await _audit(user, "meals.issue.edit", "meal_issue", d, f"Issues {d}", meta=_diff_meta(d, _diff))
        return {"date": d, "lines": (doc or {}).get("lines") or [], "warnings": warns}

    # ------------------------------------------------------------------
    # Wastage & losses — event log with reason + optional notes.
    # ------------------------------------------------------------------
    def _valid_reason(r: str) -> str:
        r = (r or "").strip().lower()
        if r not in VALID_WASTAGE_REASONS:
            raise HTTPException(status_code=400,
                                detail=f"reason must be one of {list(VALID_WASTAGE_REASONS)}")
        return r

    @router.get("/meals/wastage")
    async def list_wastage(
        start: str, end: str, user: dict = Depends(require_chef_or_admin),
    ):
        s, e = _valid_date(start), _valid_date(end)
        if s > e:
            raise HTTPException(status_code=400, detail="start must be before end")
        rows = await db.meal_wastage.find(
            {"date": {"$gte": s, "$lte": e}}, {"_id": 0},
        ).sort("date", 1).to_list(400)
        return {"start": s, "end": e, "wastage": rows,
                "reasons": list(VALID_WASTAGE_REASONS)}

    @router.put("/meals/wastage/{date_str}")
    async def upsert_wastage(
        date_str: str, body: WastageUpsertIn,
        user: dict = Depends(require_chef_or_admin),
    ):
        """Replace all wastage lines for a date. Same shape as issues but
        each line carries {reason, notes}. Zero/blank qty rows silently
        dropped so a partial save doesn't null everything."""
        d = _not_future(_valid_date(date_str))
        item_ids = [str(l.get("item_id") or "") for l in body.lines if l.get("item_id")]
        items = await db.meal_items.find(
            {"id": {"$in": item_ids}}, {"_id": 0},
        ).to_list(len(item_ids) or 1)
        by_id = {i["id"]: i for i in items}

        clean: list[dict] = []
        for raw in body.lines:
            iid = str(raw.get("item_id") or "").strip()
            item = by_id.get(iid)
            if not item:
                raise HTTPException(status_code=400,
                                    detail=f"Unknown item_id: {iid or '(blank)'}")
            qty = _parse_amount(raw.get("qty"))
            if qty is None or qty <= 0:
                continue
            _assert_qty_rate_sane(item["name"], qty)
            reason = _valid_reason(raw.get("reason") or "wasted")
            notes = str(raw.get("notes") or "").strip()[:400]
            clean.append({
                "id": str(raw.get("id") or uuid.uuid4()),
                "item_id": iid,
                "item_name": item.get("name"),
                "category_key": item.get("category_key"),
                "qty": round(qty, 4),
                "unit": item.get("unit"),
                "reason": reason,
                "notes": notes,
            })

        stamp = {
            "updated_at": now_utc().isoformat(),
            "updated_by": user.get("id"),
            "updated_by_name": user.get("full_name") or user.get("email"),
        }
        _prev_w = await db.meal_wastage.find_one({"date": d}, {"_id": 0, "lines": 1})
        await _safe_date_upsert(
            db.meal_wastage,
            {"date": d},
            {"$set": {"date": d, "lines": clean, **stamp},
             "$setOnInsert": {"id": str(uuid.uuid4())}},
        )
        _diff = _line_diff((_prev_w or {}).get("lines"), clean, "wastage")
        await _audit(user, "meals.wastage.save", "meal_wastage", d, f"Wastage {d}", meta=_diff_meta(d, _diff))
        await _signal_meals("wastage", d)
        return {"date": d, "lines": clean}

    @router.patch("/meals/wastage/{date_str}")
    async def patch_wastage_lines(
        date_str: str, body: LinesPatchIn,
        user: dict = Depends(require_chef_or_admin),
    ):
        """Merge ONLY the edited wastage lines into the day's doc — each
        item updated atomically (positional $set / $push / $pull) so
        concurrent machines editing different items never clash.  Mirrors
        the issues PATCH, but each line carries reason + notes."""
        d = _not_future(_valid_date(date_str))
        _prev_w = await db.meal_wastage.find_one({"date": d}, {"_id": 0, "lines": 1})
        item_ids = [str(l.get("item_id") or "") for l in body.upserts if l.get("item_id")]
        items = await db.meal_items.find(
            {"id": {"$in": item_ids}}, {"_id": 0},
        ).to_list(len(item_ids) or 1)
        by_id = {i["id"]: i for i in items}
        await _safe_date_upsert(
            db.meal_wastage,
            {"date": d},
            {"$setOnInsert": {"id": str(uuid.uuid4()), "date": d, "lines": []}},
        )
        removes = [str(r) for r in body.removes]
        for raw in body.upserts:
            iid = str(raw.get("item_id") or "").strip()
            item = by_id.get(iid)
            if not item:
                raise HTTPException(status_code=400,
                                    detail=f"Unknown item_id: {iid or '(blank)'}")
            qty = _parse_amount(raw.get("qty")) or 0.0
            notes = str(raw.get("notes") or "").strip()[:400]
            # Persist any line with a positive qty OR a non-empty note
            # (notes-only rows are legitimate — "check tomorrow" scribble
            # before the chef weighs the loss). Rows with neither are
            # treated as "remove this line".
            if qty <= 0 and not notes:
                removes.append(iid)
                continue
            reason = _valid_reason(raw.get("reason") or "wasted")
            line = {
                "id": str(uuid.uuid4()),
                "item_id": iid,
                "item_name": item.get("name"),
                "category_key": item.get("category_key"),
                "qty": round(qty, 4),
                "unit": item.get("unit"),
                "reason": reason,
                "notes": notes,
            }
            await _upsert_line_scoped(db.meal_wastage, d, line)
        for iid in removes:
            await db.meal_wastage.update_one(
                {"date": d}, {"$pull": {"lines": {"item_id": iid}}})
        await db.meal_wastage.update_one({"date": d}, {"$set": {
            "updated_at": now_utc().isoformat(),
            "updated_by": user.get("id"),
            "updated_by_name": user.get("full_name") or user.get("email"),
        }})
        await _signal_meals("wastage", d)
        doc = await db.meal_wastage.find_one({"date": d}, {"_id": 0})
        _diff = _line_diff((_prev_w or {}).get("lines"), (doc or {}).get("lines"), "wastage")
        await _audit(user, "meals.wastage.edit", "meal_wastage", d, f"Wastage {d}", meta=_diff_meta(d, _diff))
        return {"date": d, "lines": (doc or {}).get("lines") or []}

    @router.get("/meals/stock")
    async def stock_on_hand(
        as_of: Optional[str] = Query(None),
        user: dict = Depends(require_chef_or_admin),
    ):
        as_of_iso = _valid_date(as_of) if as_of else local_date_str(None)
        rows, cats = await _stock_snapshot(as_of_iso)
        return {"as_of": as_of_iso, "rows": rows,
                "low_count": sum(1 for r in rows if r["low"]),
                "categories": cats, "units": list(VALID_UNITS)}

    @router.get("/meals/procurement-plan")
    async def procurement_plan(
        horizon_days: int = Query(30, ge=1, le=180),
        history_days: int = Query(90, ge=7, le=365),
        buffer_pct: float = Query(20.0, ge=0.0, le=100.0),
        averaging: str = Query("median", pattern="^(mean|median)$"),
        as_of: Optional[str] = Query(None),
        user: dict = Depends(require_chef_or_admin),
    ):
        """Suggested monthly-purchase plan per item.

        Formula
        -------
            avg_per_day  = <method>(daily issue qty across last `history_days`)
            est_use      = avg_per_day × horizon_days
            buffer       = est_use × (buffer_pct / 100)
            to_buy       = max(0, est_use + buffer − on_hand)
            est_amount   = to_buy × weighted_avg_rate (from stock report)

        `to_buy` never goes negative — if you already hold more than
        (est_use + buffer) we just report to_buy = 0 for that item. The
        UI paints the row anyway so you can see it's over-stocked.

        We also surface each item's "last used vendor" (heaviest supplier
        across the last `history_days` of purchases) so the frontend can
        group the plan by vendor and generate one order per supplier.
        """
        from datetime import timedelta, date as _date_cls

        as_of_iso = _valid_date(as_of) if as_of else local_date_str(None)
        as_of_date = _date_cls.fromisoformat(as_of_iso)
        window_start = (as_of_date - timedelta(days=history_days - 1)).isoformat()

        # 1) Reuse the stock snapshot for on-hand, avg_rate, unit, name.
        stock_rows, _cats = await _stock_snapshot(as_of_iso)
        stock_by_id = {r["item_id"]: r for r in stock_rows}

        # 2) Pull daily issue quantities per item across the window so we
        #    can compute mean / median day-of-consumption. Wastage is
        #    explicitly EXCLUDED — a spoilage event shouldn't inflate
        #    procurement. Purchases are also excluded — we only care
        #    about actual usage.
        iss_docs = await db.meal_issues.find(
            {"date": {"$gte": window_start, "$lte": as_of_iso}},
            {"_id": 0, "date": 1, "lines": 1},
        ).to_list(5000)
        # daily[item_id][date_iso] = qty issued that day
        daily: dict[str, dict[str, float]] = {}
        for doc in iss_docs:
            d = doc.get("date")
            for line in (doc.get("lines") or []):
                iid = line.get("item_id")
                q = float(line.get("qty") or 0)
                if not iid or q <= 0 or not d:
                    continue
                by_day = daily.setdefault(iid, {})
                by_day[d] = by_day.get(d, 0.0) + q

        # Zero-fill missing days so median doesn't get skewed by
        # only-picking-up-consumption-days. This is the difference
        # between "avg per usage day" and "avg per calendar day".
        # Consumers naturally want per-calendar-day so procurement
        # covers the FULL horizon, not just usage-days.
        window_dates: list[str] = []
        cur = as_of_date - timedelta(days=history_days - 1)
        while cur <= as_of_date:
            window_dates.append(cur.isoformat())
            cur += timedelta(days=1)

        def _avg(series: list[float]) -> float:
            if not series:
                return 0.0
            if averaging == "mean":
                return sum(series) / len(series)
            s = sorted(series)
            mid = len(s) // 2
            return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2

        # 3) Top vendor per item over the same window (heaviest spend).
        purch_docs = await db.meal_purchases.find(
            {"date": {"$gte": window_start, "$lte": as_of_iso}},
            {"_id": 0, "lines": 1, "vendor_id": 1},
        ).to_list(5000)
        vendor_spend: dict[str, dict[str, float]] = {}  # item_id -> {vendor_id: amount}
        for doc in purch_docs:
            doc_vendor = doc.get("vendor_id")
            for line in (doc.get("lines") or []):
                iid = line.get("item_id")
                if not iid:
                    continue
                amt = float(line.get("qty") or 0) * float(line.get("rate") or 0)
                vid = line.get("vendor_id") or doc_vendor
                if not vid:
                    continue
                vendor_spend.setdefault(iid, {})[vid] = vendor_spend.get(iid, {}).get(vid, 0.0) + amt
        # Resolve vendor names in one query
        vendor_ids_all = {vid for vmap in vendor_spend.values() for vid in vmap.keys()}
        vendor_name = {}
        if vendor_ids_all:
            v_rows = await db.meal_vendors.find(
                {"id": {"$in": list(vendor_ids_all)}},
                {"_id": 0, "id": 1, "name": 1},
            ).to_list(len(vendor_ids_all))
            vendor_name = {v["id"]: v.get("name") for v in v_rows}

        # 4) Compose the plan.
        plan_rows = []
        for iid, s in stock_by_id.items():
            series = [daily.get(iid, {}).get(d, 0.0) for d in window_dates]
            avg = _avg(series)
            est_use = avg * horizon_days
            buf = est_use * (buffer_pct / 100.0)
            on_hand = float(s.get("on_hand") or 0)
            to_buy = max(0.0, est_use + buf - on_hand)
            rate = float(s.get("avg_rate") or 0)
            est_amount = to_buy * rate

            # Top vendor by spend for this item in the window
            top_vendor_id = None
            top_vendor_name = None
            vmap = vendor_spend.get(iid) or {}
            if vmap:
                top_vendor_id = max(vmap.items(), key=lambda kv: kv[1])[0]
                top_vendor_name = vendor_name.get(top_vendor_id) or "—"

            # Days-of-cover — helps the UI colour-code urgency without
            # doing this math on the client.
            days_cover = (on_hand / avg) if avg > 1e-9 else (float("inf") if on_hand > 0 else 0.0)

            plan_rows.append({
                "item_id": iid,
                "name": s.get("name"),
                "unit": s.get("unit"),
                "category_key": s.get("category_key"),
                "category_label": s.get("category_label"),
                "on_hand": round(on_hand, 3),
                "avg_per_day": round(avg, 3),
                "est_use": round(est_use, 3),
                "buffer": round(buf, 3),
                "to_buy": round(to_buy, 3),
                "avg_rate": round(rate, 2),
                "est_amount": round(est_amount, 2),
                "days_cover": None if days_cover == float("inf") else round(days_cover, 1),
                "top_vendor_id": top_vendor_id,
                "top_vendor_name": top_vendor_name,
            })

        # Sort with most-urgent first so admins see negative / zero
        # stock at the top. Break ties by est_amount descending so
        # biggest-spend items sit above the smaller ones.
        def _urgency(r):
            oh = r["on_hand"]
            if oh < 0: return (0, -r["est_amount"])
            if oh == 0 and r["est_use"] > 0: return (1, -r["est_amount"])
            if r["days_cover"] is not None and r["days_cover"] < 10 and r["est_use"] > 0: return (2, -r["est_amount"])
            return (3, -r["est_amount"])
        plan_rows.sort(key=_urgency)

        total_estimate = round(sum(r["est_amount"] for r in plan_rows), 2)
        return {
            "as_of": as_of_iso,
            "horizon_days": horizon_days,
            "history_days": history_days,
            "buffer_pct": buffer_pct,
            "averaging": averaging,
            "total_estimate": total_estimate,
            "rows": plan_rows,
        }

    def _range_or_default(start: Optional[str], end: Optional[str]) -> tuple[str, str]:
        e = _valid_date(end) if end else local_date_str(None)
        s = _valid_date(start) if start else \
            (date.fromisoformat(e) - timedelta(days=29)).isoformat()
        if s > e:
            raise HTTPException(status_code=400, detail="start must be before end")
        return s, e

    @router.get("/meals/items/{item_id}/ledger")
    async def item_ledger(
        item_id: str,
        start: Optional[str] = Query(None),
        end: Optional[str] = Query(None),
        granularity: str = Query("day", pattern="^(day|week|month)$"),
        user: dict = Depends(require_chef_or_admin),
    ):
        """Merged purchase/issue/wastage/stock-take history for one item.
        `granularity` rolls the per-date rows up into week/month periods
        (running balance = balance at the end of each period)."""
        item = await db.meal_items.find_one({"id": item_id}, {"_id": 0})
        if not item:
            raise HTTPException(status_code=404, detail="Item not found")
        s, e = _range_or_default(start, end)
        q = {"date": {"$gte": s, "$lte": e}, "lines.item_id": item_id}
        proj = {"_id": 0, "date": 1, "lines": 1, "updated_by_name": 1}
        purch = await db.meal_purchases.find(q, proj).to_list(400)
        iss = await db.meal_issues.find(q, proj).to_list(400)
        wast = await db.meal_wastage.find(q, proj).to_list(400)

        events: list[dict] = []
        tot = {"purchased_qty": 0.0, "purchased_amount": 0.0,
               "issued_qty": 0.0, "wasted_qty": 0.0, "adjusted_qty": 0.0}

        def _collect(docs, typ):
            for doc in docs:
                for line in doc.get("lines") or []:
                    if line.get("item_id") != item_id:
                        continue
                    qty = float(line.get("qty") or 0)
                    ev = {"date": doc["date"], "type": typ, "qty": qty,
                          "by": doc.get("updated_by_name")}
                    if typ == "purchase":
                        ev["rate"] = line.get("rate")
                        ev["amount"] = line.get("amount")
                        tot["purchased_qty"] += qty
                        tot["purchased_amount"] += float(line.get("amount") or 0)
                    elif typ == "issue":
                        tot["issued_qty"] += qty
                    elif typ == "adjustment":
                        ev["physical"] = line.get("physical")
                        ev["system"] = line.get("system")
                        ev["notes"] = line.get("notes")
                        tot["adjusted_qty"] += qty
                    else:
                        ev["reason"] = line.get("reason")
                        ev["notes"] = line.get("notes")
                        tot["wasted_qty"] += qty
                    events.append(ev)

        adj = await db.meal_adjustments.find(q, proj).to_list(400)
        _collect(purch, "purchase")
        _collect(iss, "issue")
        _collect(wast, "wastage")
        _collect(adj, "adjustment")
        events.sort(key=lambda x: (x["date"], x["type"]), reverse=True)

        # Current on-hand (same math as /meals/stock, single item, as of today).
        today = local_date_str(None)
        as_of = item.get("opening_stock_as_of") or "1970-01-01"
        oq = {"date": {"$gte": as_of, "$lte": today}, "lines.item_id": item_id}

        async def _qty_sum(coll) -> float:
            total = 0.0
            for doc in await coll.find(oq, {"_id": 0, "lines": 1}).to_list(2000):
                for line in doc.get("lines") or []:
                    if line.get("item_id") == item_id:
                        total += float(line.get("qty") or 0)
            return total

        on_hand = round(float(item.get("opening_stock") or 0)
                        + await _qty_sum(db.meal_purchases)
                        - await _qty_sum(db.meal_issues)
                        - await _qty_sum(db.meal_wastage)
                        + await _qty_sum(db.meal_adjustments), 4)

        # ── Passbook-style per-date rows with a running stock-in-hand
        #    balance (Jun 2026 — double-click ledger on Daily Entry).
        #    Purchases / Issues / Wastage / Stock-take adjustments sit in
        #    their own columns per date; `balance` carries forward the
        #    on-hand after each day.
        opening_stock = float(item.get("opening_stock") or 0)
        low = min(as_of, s)   # show every in-range transaction (incl.
        rng_q = {"date": {"$gte": low, "$lte": e}, "lines.item_id": item_id}   # pre-baseline)
        mv_proj = {"_id": 0, "date": 1, "lines": 1}
        p_all = await db.meal_purchases.find(rng_q, mv_proj).to_list(3000)
        i_all = await db.meal_issues.find(rng_q, mv_proj).to_list(3000)
        w_all = await db.meal_wastage.find(rng_q, mv_proj).to_list(3000)
        a_all = await db.meal_adjustments.find(rng_q, mv_proj).to_list(3000)

        move: dict[str, dict] = {}

        def _bucket(dd: str) -> dict:
            return move.setdefault(dd, {"purch_qty": 0.0, "purch_amt": 0.0,
                                        "issue_qty": 0.0, "waste_qty": 0.0,
                                        "adj_qty": 0.0, "adj_by": None,
                                        "adj_at": None, "adj_physical": None,
                                        "adj_system": None})

        for doc in p_all:
            for ln in doc.get("lines") or []:
                if ln.get("item_id") != item_id:
                    continue
                qv = float(ln.get("qty") or 0)
                b = _bucket(doc["date"])
                b["purch_qty"] += qv
                b["purch_amt"] += float(ln.get("amount") or (qv * float(ln.get("rate") or 0)))
        for doc in i_all:
            for ln in doc.get("lines") or []:
                if ln.get("item_id") == item_id:
                    _bucket(doc["date"])["issue_qty"] += float(ln.get("qty") or 0)
        for doc in w_all:
            for ln in doc.get("lines") or []:
                if ln.get("item_id") == item_id:
                    _bucket(doc["date"])["waste_qty"] += float(ln.get("qty") or 0)
        for doc in a_all:
            for ln in doc.get("lines") or []:
                if ln.get("item_id") == item_id:
                    b = _bucket(doc["date"])
                    b["adj_qty"] += float(ln.get("qty") or 0)
                    b["adj_by"] = ln.get("by_name")
                    b["adj_at"] = ln.get("at")
                    b["adj_physical"] = ln.get("physical")
                    b["adj_system"] = ln.get("system")

        # Opening balance = opening stock + net movement between the
        # opening as-of date and the day BEFORE the range start.
        opening_balance = opening_stock
        for dd, mv in move.items():
            if as_of <= dd < s:
                opening_balance += mv["purch_qty"] - mv["issue_qty"] - mv["waste_qty"] + mv["adj_qty"]

        rows: list[dict] = []
        bal = opening_balance
        for dd in sorted(d for d in move if s <= d <= e):
            mv = move[dd]
            # Transactions dated before the opening baseline are shown for
            # visibility but don't move the on-hand balance (the opening
            # stock already reflects the position as of `as_of`), so the
            # running balance still reconciles to `on_hand`.
            pre_opening = dd < as_of
            if not pre_opening:
                bal += mv["purch_qty"] - mv["issue_qty"] - mv["waste_qty"] + mv["adj_qty"]
            rows.append({
                "date": dd,
                "purch_qty": round(mv["purch_qty"], 4),
                "purch_amt": round(mv["purch_amt"], 2),
                "issue_qty": round(mv["issue_qty"], 4),
                "waste_qty": round(mv["waste_qty"], 4),
                "adj_qty": round(mv["adj_qty"], 4),
                "adj_by": mv["adj_by"],
                "adj_at": mv["adj_at"],
                "adj_physical": mv["adj_physical"],
                "adj_system": mv["adj_system"],
                "pre_opening": pre_opening,
                "balance": None if pre_opening else round(bal, 4),
            })

        return {"item": item, "start": s, "end": e, "events": events,
                "totals": {k: round(v, 4) for k, v in tot.items()},
                "on_hand": on_hand,
                "opening_balance": round(opening_balance, 4),
                "granularity": granularity,
                "rows": _group_ledger_rows(rows, granularity)}

    @router.get("/meals/stock-ledgers/print")
    async def stock_ledgers_print(
        start: Optional[str] = Query(None),
        end: Optional[str] = Query(None),
        category: Optional[str] = Query(None),
        user: dict = Depends(require_chef_or_admin),
    ):
        """Every ACTIVE item's passbook ledger for a date range, in one
        payload, for the 'Print all ledgers' page. Same running-balance math
        as the single-item ledger, computed in one pass over the movement
        docs. `category` (a category_key) limits to one category; omit/`all`
        for everything."""
        s, e = _range_or_default(start, end)
        snap_rows, _ = await _stock_snapshot(e, include_inactive=False)
        snap = {r["item_id"]: r for r in snap_rows}
        item_q = {"active": {"$ne": False}}
        if category and category != "all":
            item_q["category_key"] = category
        items = await db.meal_items.find(item_q, {"_id": 0}).to_list(length=None)

        q = {"date": {"$lte": e}}
        proj = {"_id": 0, "date": 1, "lines": 1}
        p_all = await db.meal_purchases.find(q, proj).to_list(length=None)
        i_all = await db.meal_issues.find(q, proj).to_list(length=None)
        w_all = await db.meal_wastage.find(q, proj).to_list(length=None)
        a_all = await db.meal_adjustments.find(q, proj).to_list(length=None)

        # buckets[item_id][date] = movement totals for that day
        buckets: dict = {}

        def _b(iid, dd):
            return buckets.setdefault(iid, {}).setdefault(
                dd, {"purch_qty": 0.0, "purch_amt": 0.0, "issue_qty": 0.0,
                     "waste_qty": 0.0, "adj_qty": 0.0,
                     "st_kind": None, "st_physical": None})

        for doc in p_all:
            for ln in doc.get("lines") or []:
                iid = ln.get("item_id")
                if not iid:
                    continue
                qv = float(ln.get("qty") or 0)
                b = _b(iid, doc["date"])
                b["purch_qty"] += qv
                b["purch_amt"] += float(ln.get("amount") or (qv * float(ln.get("rate") or 0)))
        for doc in i_all:
            for ln in doc.get("lines") or []:
                if ln.get("item_id"):
                    _b(ln["item_id"], doc["date"])["issue_qty"] += float(ln.get("qty") or 0)
        for doc in w_all:
            for ln in doc.get("lines") or []:
                if ln.get("item_id"):
                    _b(ln["item_id"], doc["date"])["waste_qty"] += float(ln.get("qty") or 0)
        for doc in a_all:
            for ln in doc.get("lines") or []:
                iid = ln.get("item_id")
                if not iid:
                    continue
                b = _b(iid, doc["date"])
                b["adj_qty"] += float(ln.get("qty") or 0)
                # Tag the day as a physical stock-take / opening count so the
                # ledger can flag it clearly with its date.
                b["st_kind"] = ln.get("kind") or "stock_take"
                if ln.get("physical") is not None:
                    b["st_physical"] = round(float(ln.get("physical")), 4)

        ledgers = []
        grand_value = 0.0
        for it in items:
            iid = it["id"]
            sr = snap.get(iid)
            if sr is None:
                continue
            opening_stock = float(it.get("opening_stock") or 0)
            as_of = it.get("opening_stock_as_of") or "1970-01-01"
            days = buckets.get(iid, {})
            opening_balance = opening_stock
            for dd, mv in days.items():
                if as_of <= dd < s:
                    opening_balance += mv["purch_qty"] - mv["issue_qty"] - mv["waste_qty"] + mv["adj_qty"]
            rows = []
            tot = {"purch_qty": 0.0, "purch_amt": 0.0, "issue_qty": 0.0,
                   "waste_qty": 0.0, "adj_qty": 0.0}
            avg_rate = float(sr.get("avg_rate") or 0)
            bal = opening_balance
            for dd in sorted(d for d in days if s <= d <= e):
                mv = days[dd]
                pre = dd < as_of
                if not pre:
                    bal += mv["purch_qty"] - mv["issue_qty"] - mv["waste_qty"] + mv["adj_qty"]
                for k in tot:
                    tot[k] += mv[k]
                rows.append({
                    "date": dd,
                    "purch_qty": round(mv["purch_qty"], 4),
                    "purch_amt": round(mv["purch_amt"], 2),
                    "issue_qty": round(mv["issue_qty"], 4),
                    "issue_val": round(mv["issue_qty"] * avg_rate, 2),
                    "waste_qty": round(mv["waste_qty"], 4),
                    "waste_val": round(mv["waste_qty"] * avg_rate, 2),
                    "adj_qty": round(mv["adj_qty"], 4),
                    "adj_val": round(mv["adj_qty"] * avg_rate, 2),
                    "is_stock_take": bool(mv.get("st_kind")),
                    "st_kind": mv.get("st_kind"),
                    "st_physical": mv.get("st_physical"),
                    "pre_opening": pre,
                    "balance": None if pre else round(bal, 4),
                    "balance_val": None if pre else round(bal * avg_rate, 2),
                })
            closing = round(bal, 4)
            value = round(closing * avg_rate, 2)
            grand_value += value
            ledgers.append({
                "item_id": iid,
                "name": it.get("name"),
                "unit": it.get("unit"),
                "category": sr.get("category_label") or sr.get("category_key") or "Uncategorised",
                "category_key": sr.get("category_key"),
                "opening_balance": round(opening_balance, 4),
                "opening_value": round(opening_balance * avg_rate, 2),
                "opening_date": s,
                "closing_balance": closing,
                "closing_date": e,
                "avg_rate": round(avg_rate, 2),
                "value": value,
                "totals": {
                    **{k: round(v, 4) for k, v in tot.items()},
                    "issue_val": round(tot["issue_qty"] * avg_rate, 2),
                    "waste_val": round(tot["waste_qty"] * avg_rate, 2),
                    "adj_val": round(tot["adj_qty"] * avg_rate, 2),
                },
                "rows": rows,
            })

        ledgers.sort(key=lambda x: ((x["category"] or "").lower(), (x["name"] or "").lower()))
        return {
            "start": s, "end": e, "as_of": e,
            "generated_at": now_utc().isoformat(),
            "total_items": len(ledgers),
            "total_value": round(grand_value, 2),
            "ledgers": ledgers,
        }


    def _group_ledger_rows(rows: list, granularity: str) -> list:
        """Roll daily ledger rows up into week/month periods. Running
        balance for a period = the balance of its last active day (no
        movement after it within the period, so it's the period-end
        on-hand). Only periods with activity appear — same as daily."""
        if granularity == "day" or not rows:
            return rows

        def _key(dd: str) -> str:
            dt = date.fromisoformat(dd)
            if granularity == "week":
                return (dt - timedelta(days=dt.weekday())).isoformat()  # Monday
            return dt.replace(day=1).isoformat()

        grouped: dict[str, dict] = {}
        order: list[str] = []
        for r in rows:  # oldest → newest
            k = _key(r["date"])
            if k not in grouped:
                grouped[k] = {"purch_qty": 0.0, "purch_amt": 0.0, "issue_qty": 0.0,
                              "waste_qty": 0.0, "adj_qty": 0.0, "balance": r["balance"],
                              "end": r["date"], "adj_ct": 0}
                order.append(k)
            g = grouped[k]
            g["purch_qty"] += r["purch_qty"]
            g["purch_amt"] += r["purch_amt"]
            g["issue_qty"] += r["issue_qty"]
            g["waste_qty"] += r["waste_qty"]
            g["adj_qty"] += r["adj_qty"]
            if r["adj_qty"]:
                g["adj_ct"] += 1
            g["balance"] = r["balance"]
            g["end"] = r["date"]
        out = []
        for k in order:
            g = grouped[k]
            out.append({
                "date": k, "period_start": k, "period_end": g["end"],
                "purch_qty": round(g["purch_qty"], 4), "purch_amt": round(g["purch_amt"], 2),
                "issue_qty": round(g["issue_qty"], 4), "waste_qty": round(g["waste_qty"], 4),
                "adj_qty": round(g["adj_qty"], 4), "adj_count": g["adj_ct"],
                "balance": None if g["balance"] is None else round(g["balance"], 4),
                "pre_opening": g["balance"] is None,
                "adj_by": None, "adj_at": None, "adj_physical": None, "adj_system": None,
            })
        return out

    return {"_range_or_default": _range_or_default}
