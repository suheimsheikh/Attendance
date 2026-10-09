"""Meals routes — analytics. Split out of routes/meals/__init__.py (Oct 2026); behaviour unchanged."""
from __future__ import annotations

from routes.meals.common import (  # noqa: F401
    Depends,
    HTTPException,
    Query,
    _kitchen_cat_pct,
    _kitchen_daily_series,
    _kitchen_item_rows,
    _nutri_lookup,
    _qty_to_grams,
    _weighted_rate_lookup,
    date,
    local_date_str,
    timedelta,
)


def register(router, *, _purchase_categories, _stock_snapshot, _valid_date, db, require_chef_or_admin):
    @router.get("/meals/kitchen-analytics/item-daily")
    async def kitchen_analytics_item_daily(
        start: str, end: str,
        item_ids: str = Query(..., description="Comma-separated item IDs"),
        kind: str = Query("purchases", pattern="^(purchases|issues)$"),
        user: dict = Depends(require_chef_or_admin),
    ):
        """Per-item, per-day amount + qty across the [start, end] window
        for the given item IDs. Powers the "toggle a bar in Top items
        → focus the daily-trend chart on that item" flow on Kitchen
        Analytics. Sparse output: only dates with activity for that
        item are returned; the frontend fills the zero-days on render."""
        s = _valid_date(start)
        e = _valid_date(end)
        ids = [x.strip() for x in (item_ids or "").split(",") if x.strip()]
        if not ids:
            return {"items": []}

        # Item master lookup (one shot).
        item_rows = await db.meal_items.find(
            {"id": {"$in": ids}}, {"_id": 0, "id": 1, "name": 1, "unit": 1},
        ).to_list(len(ids))
        info_by_id = {i["id"]: i for i in item_rows}

        coll = "meal_purchases" if kind == "purchases" else "meal_issues"
        docs = await db[coll].find(
            {"date": {"$gte": s, "$lte": e},
             "lines.item_id": {"$in": ids}},
            {"_id": 0, "date": 1, "lines": 1},
        ).to_list(5000)

        # Bucket: {item_id: {date: {"amount": .., "qty": ..}}}
        bucket: dict[str, dict[str, dict[str, float]]] = {i: {} for i in ids}
        for d in docs:
            date_iso = d.get("date")
            for ln in (d.get("lines") or []):
                iid = ln.get("item_id")
                if iid not in bucket:
                    continue
                q = float(ln.get("qty") or 0)
                r = float(ln.get("rate") or 0)
                amt = q * r
                cell = bucket[iid].setdefault(date_iso, {"amount": 0.0, "qty": 0.0})
                cell["amount"] += amt
                cell["qty"] += q

        items = []
        for iid in ids:
            info = info_by_id.get(iid) or {}
            daily = [
                {"date": dd,
                 "amount": round(v["amount"], 2),
                 "qty":    round(v["qty"], 3)}
                for dd, v in sorted(bucket[iid].items())
            ]
            items.append({
                "item_id": iid,
                "name":    info.get("name") or "(deleted item)",
                "unit":    info.get("unit"),
                "daily":   daily,
            })
        return {"items": items, "kind": kind, "start": s, "end": e}


    @router.get("/meals/kitchen-analytics/item-compare")
    async def kitchen_analytics_item_compare(
        start: str, end: str,
        item_ids: str = Query(..., description="Comma-separated item IDs"),
        user: dict = Depends(require_chef_or_admin),
    ):
        """Combined purchases-vs-consumption series for a basket of items
        over [start, end]. Aggregates the selected items into one Purchases
        and one Consumption line per day (qty + ₹). Powers the Compare tab."""
        s = _valid_date(start)
        e = _valid_date(end)
        if s > e:
            raise HTTPException(status_code=400, detail="start must be before end")
        if (date.fromisoformat(e) - date.fromisoformat(s)).days > 400:
            raise HTTPException(status_code=400, detail="Range too large (max ~13 months)")
        ids = [x.strip() for x in (item_ids or "").split(",") if x.strip()]
        if not ids:
            return {"days": [], "totals": {"purch_qty": 0, "purch_amt": 0, "issue_qty": 0, "issue_amt": 0}, "items": []}

        item_rows = await db.meal_items.find(
            {"id": {"$in": ids}}, {"_id": 0, "id": 1, "name": 1, "unit": 1}).to_list(len(ids))
        idset = set(ids)

        # Per-item, per-date buckets so consumption can be valued at each
        # item's window weighted-average PURCHASE rate (issue lines carry
        # no rate — they're costed at avg like the rest of the app).
        purch: dict[str, dict[str, float]] = {}   # item -> {date: qty}
        purch_amt: dict[str, dict[str, float]] = {}
        issue: dict[str, dict[str, float]] = {}
        p_tot_qty: dict[str, float] = {i: 0.0 for i in ids}
        p_tot_amt: dict[str, float] = {i: 0.0 for i in ids}

        pdocs = await db.meal_purchases.find(
            {"date": {"$gte": s, "$lte": e}, "lines.item_id": {"$in": ids}},
            {"_id": 0, "date": 1, "lines": 1}).to_list(5000)
        for d in pdocs:
            for ln in (d.get("lines") or []):
                iid = ln.get("item_id")
                if iid not in idset:
                    continue
                qv = float(ln.get("qty") or 0)
                av = qv * float(ln.get("rate") or 0)
                purch.setdefault(iid, {})[d["date"]] = purch.get(iid, {}).get(d["date"], 0.0) + qv
                purch_amt.setdefault(iid, {})[d["date"]] = purch_amt.get(iid, {}).get(d["date"], 0.0) + av
                p_tot_qty[iid] += qv
                p_tot_amt[iid] += av

        idocs = await db.meal_issues.find(
            {"date": {"$gte": s, "$lte": e}, "lines.item_id": {"$in": ids}},
            {"_id": 0, "date": 1, "lines": 1}).to_list(5000)
        for d in idocs:
            for ln in (d.get("lines") or []):
                iid = ln.get("item_id")
                if iid not in idset:
                    continue
                issue.setdefault(iid, {})[d["date"]] = issue.get(iid, {}).get(d["date"], 0.0) + float(ln.get("qty") or 0)

        avg_rate = {i: (p_tot_amt[i] / p_tot_qty[i] if p_tot_qty[i] else 0.0) for i in ids}

        # Roll up to per-date totals across the selected basket.
        by_date: dict[str, dict[str, float]] = {}
        for iid in ids:
            for dd, qv in purch.get(iid, {}).items():
                c = by_date.setdefault(dd, {"purch_qty": 0.0, "purch_amt": 0.0, "issue_qty": 0.0, "issue_amt": 0.0})
                c["purch_qty"] += qv
                c["purch_amt"] += purch_amt.get(iid, {}).get(dd, 0.0)
            for dd, qv in issue.get(iid, {}).items():
                c = by_date.setdefault(dd, {"purch_qty": 0.0, "purch_amt": 0.0, "issue_qty": 0.0, "issue_amt": 0.0})
                c["issue_qty"] += qv
                c["issue_amt"] += qv * avg_rate[iid]

        days = [{"date": dd,
                 "purch_qty": round(v["purch_qty"], 1), "purch_amt": round(v["purch_amt"], 2),
                 "issue_qty": round(v["issue_qty"], 1), "issue_amt": round(v["issue_amt"], 2)}
                for dd, v in sorted(by_date.items())]
        totals = {
            "purch_qty": round(sum(v["purch_qty"] for v in by_date.values()), 1),
            "purch_amt": round(sum(v["purch_amt"] for v in by_date.values()), 2),
            "issue_qty": round(sum(v["issue_qty"] for v in by_date.values()), 1),
            "issue_amt": round(sum(v["issue_amt"] for v in by_date.values()), 2),
        }
        return {"days": days, "totals": totals, "start": s, "end": e,
                "items": [{"id": i["id"], "name": i["name"], "unit": i.get("unit")} for i in item_rows]}


    @router.get("/meals/kitchen-analytics/bounds")
    async def kitchen_analytics_bounds(user: dict = Depends(require_chef_or_admin)):
        """Earliest and latest dates for which any pantry activity exists
        (purchases OR issues). Used by the Kitchen Analytics tab to
        default the "All" preset window to full history — same UX as
        the Meals Calendar page."""
        dates: list[str] = []
        for coll in ("meal_purchases", "meal_issues"):
            lo = await db[coll].find({}, {"_id": 0, "date": 1}).sort("date", 1).limit(1).to_list(1)
            hi = await db[coll].find({}, {"_id": 0, "date": 1}).sort("date", -1).limit(1).to_list(1)
            if lo: dates.append(lo[0]["date"])
            if hi: dates.append(hi[0]["date"])
        if not dates:
            today = local_date_str(None)
            return {"min_date": today, "max_date": today, "has_data": False}
        return {"min_date": min(dates), "max_date": max(dates), "has_data": True}


    @router.get("/meals/pantry-day-detail")
    async def pantry_day_detail(
        date: str,  # noqa: A002
        kind: str = Query("purchases", pattern="^(purchases|issues)$"),
        user: dict = Depends(require_chef_or_admin),
    ):
        """Line-level detail for a single day — powers the "click a day
        on the chart" popup on the Kitchen Analytics tab. Returns one
        row per (vendor, item) purchase / per (item) issue with
        hydrated item name + unit + category label.

        For purchases, `unitemised` rows are also surfaced so admins
        can see when a bulk-uploaded day contributed rupees to the
        chart without per-item breakdown.
        """
        d = _valid_date(date)
        coll = "meal_purchases" if kind == "purchases" else "meal_issues"
        docs = await db[coll].find(
            {"date": d}, {"_id": 0},
        ).to_list(500)

        # Hydrate item + category master once.
        items = await db.meal_items.find(
            {}, {"_id": 0, "id": 1, "name": 1, "unit": 1, "category_key": 1},
        ).to_list(2000)
        by_id = {i["id"]: i for i in items}
        cats = await _purchase_categories()
        cat_label = {c["key"]: c.get("label") or c["key"] for c in cats}

        # Vendor lookup (purchases only).
        vendor_by_id: dict = {}
        if kind == "purchases":
            vendor_ids = list({d.get("vendor_id") for d in docs if d.get("vendor_id")})
            if vendor_ids:
                vendors = await db.meal_vendors.find(
                    {"id": {"$in": vendor_ids}}, {"_id": 0, "id": 1, "name": 1},
                ).to_list(200)
                vendor_by_id = {v["id"]: v.get("name") for v in vendors}

        lines: list[dict] = []
        unitemised_by_cat: dict[str, float] = {}
        totals = {"amount": 0.0, "qty": 0.0, "lines": 0}
        for doc in docs:
            vendor_name = vendor_by_id.get(doc.get("vendor_id")) if kind == "purchases" else None
            itemised_amount = 0.0
            for ln in (doc.get("lines") or []):
                iid = ln.get("item_id")
                q = float(ln.get("qty") or 0)
                r = float(ln.get("rate") or 0)
                amt = q * r
                info = by_id.get(iid) or {}
                lines.append({
                    "item_id": iid,
                    "name":    info.get("name") or "(deleted item)",
                    "unit":    info.get("unit"),
                    "category_key":   info.get("category_key"),
                    "category_label": cat_label.get(info.get("category_key"),
                                                   (info.get("category_key") or "").replace("_", " ").title()),
                    "qty":     round(q, 3),
                    "rate":    round(r, 2),
                    "amount":  round(amt, 2),
                    "vendor":  vendor_name,
                })
                itemised_amount += amt
                totals["qty"] += q
                totals["lines"] += 1
            # Reconcile category-level bulk totals against the itemised
            # part so admins can see how much of the day was uploaded
            # without per-item detail.
            if kind == "purchases":
                amounts_map = doc.get("amounts") or {}
                day_total = sum(float(v or 0) for v in amounts_map.values())
                totals["amount"] += day_total if amounts_map else itemised_amount
                if amounts_map:
                    gap = max(0.0, day_total - itemised_amount)
                    if gap > 0:
                        # Attribute to the largest category so the pie
                        # accounting stays honest.
                        top_cat = max(amounts_map.items(),
                                      key=lambda x: float(x[1] or 0), default=(None, 0))
                        if top_cat[0]:
                            unitemised_by_cat[top_cat[0]] = unitemised_by_cat.get(top_cat[0], 0.0) + gap
            else:
                totals["amount"] += itemised_amount

        lines.sort(key=lambda r: -r["amount"])
        unitemised_rows = [
            {"category_key": k,
             "category_label": cat_label.get(k, k.replace("_", " ").title()),
             "amount": round(v, 2)}
            for k, v in sorted(unitemised_by_cat.items(), key=lambda x: -x[1])
        ]
        return {
            "date": d,
            "kind": kind,
            "totals": {"amount": round(totals["amount"], 2),
                       "qty": round(totals["qty"], 3),
                       "lines": totals["lines"]},
            "lines": lines,
            "unitemised": unitemised_rows,
        }


    @router.get("/meals/kitchen-analytics")
    async def kitchen_analytics(
        start: str, end: str,
        user: dict = Depends(require_chef_or_admin),
    ):
        """Kitchen graphics panel (Feb 2026 user request).

        Aggregates purchases + issues in the given window and returns
        the numbers needed to plot:
          • Daily amount trend
          • Top items by amount + top items by qty
          • Category-wise % split
          • Item-wise breakdown (full list, sortable client-side)

        Issue amounts are valued at the weighted-avg purchase rate for
        each item over the same window (falls back to the current
        stock snapshot when the item has no purchase in the window)
        so purchases and issues use comparable rupee figures.
        """
        s, e = _valid_date(start), _valid_date(end)
        if s > e:
            raise HTTPException(status_code=400, detail="start must be before end")
        s_d, e_d = date.fromisoformat(s), date.fromisoformat(e)
        if (e_d - s_d).days > 400:
            raise HTTPException(status_code=400, detail="Range too large (max ~13 months)")

        # ---- Item + category master (for names / labels) ----
        items = await db.meal_items.find(
            {}, {"_id": 0, "id": 1, "name": 1, "unit": 1, "category_key": 1, "nutrition": 1},
        ).to_list(2000)
        by_id = {i["id"]: i for i in items}
        cats = await _purchase_categories()
        cat_label = {c["key"]: c.get("label") or c["key"] for c in cats}

        # ---- Pull purchase + issue docs for the window ----
        # `amounts` is included so we can reconcile bulk-uploaded /
        # legacy purchase docs (which carry category totals but no
        # per-item `lines`) into the daily trend + category share.
        purch_docs = await db.meal_purchases.find(
            {"date": {"$gte": s, "$lte": e}},
            {"_id": 0, "date": 1, "lines": 1, "amounts": 1},
        ).to_list(5000)
        iss_docs = await db.meal_issues.find(
            {"date": {"$gte": s, "$lte": e}},
            {"_id": 0, "date": 1, "lines": 1},
        ).to_list(5000)

        # ---- Weighted-avg rate per item from THIS window's purchases ----
        # Falls back to current stock avg_rate when an item was issued but
        # never purchased in the window (opening-stock consumption).
        purch_qty: dict[str, float] = {}
        purch_amt: dict[str, float] = {}
        for doc in purch_docs:
            for ln in (doc.get("lines") or []):
                iid = ln.get("item_id")
                q = float(ln.get("qty") or 0)
                r = float(ln.get("rate") or 0)
                if not iid or q <= 0:
                    continue
                purch_qty[iid] = purch_qty.get(iid, 0.0) + q
                purch_amt[iid] = purch_amt.get(iid, 0.0) + q * r

        snap_rows, _snap_cats = await _stock_snapshot(e)
        snap_rate = {r["item_id"]: float(r.get("avg_rate") or 0) for r in snap_rows}
        _rate_for = _weighted_rate_lookup(purch_qty, purch_amt, snap_rate)

        # ---- Roll-ups ----
        def _blank_day():
            return {"amount": 0.0, "qty": 0.0, "lines": 0,
                    "itemised_amount": 0.0, "unitemised_amount": 0.0,
                    "cat": {}}

        def _blank_item():
            # `vendors`: {vendor_id: rupee_amount} for purchases.
            # Populated only during purchase aggregation — issues
            # don't carry a vendor.
            return {"qty": 0.0, "amount": 0.0, "lines": 0, "vendors": {}}

        # Seed every day in the window with a zero row so charts show
        # gaps as flat points instead of skipping the label.
        purch_daily: dict[str, dict] = {}
        iss_daily: dict[str, dict] = {}
        cur = s_d
        while cur <= e_d:
            iso = cur.isoformat()
            purch_daily[iso] = _blank_day()
            iss_daily[iso] = _blank_day()
            cur += timedelta(days=1)

        purch_items: dict[str, dict] = {}
        iss_items: dict[str, dict] = {}
        purch_cat: dict[str, float] = {}
        iss_cat: dict[str, float] = {}
        # Vendor roll-up (Feb 2026 user request): per-vendor total spend
        # across all purchases in the window, so we can render a
        # "Top vendors by ₹" chart in Kitchen Analytics.
        # Shape: {vendor_id: {"amount": rupees, "purchases": int}}
        vendor_totals: dict[str, dict] = {}
        # Per-date list of (item_id, qty) tuples — used to plot the
        # daily kcal trend by re-scoring each line through the same
        # nutrition resolver.
        purch_daily_lines: dict[str, list] = {}
        iss_daily_lines: dict[str, list] = {}

        for doc in purch_docs:
            d = doc["date"]
            doc_vendor_id = doc.get("vendor_id")
            slot = purch_daily.setdefault(d, _blank_day())
            amounts_map = doc.get("amounts") or {}
            day_total = sum(float(v or 0) for v in amounts_map.values())
            itemised_from_lines = 0.0
            # Per-doc vendor totals — accumulated from line-level
            # vendor_id (the real source of truth, since the same
            # purchase doc can mix vendors — vegetables from Vendor A,
            # spices from Vendor B). Falls back to doc-level vendor_id
            # if the line doesn't carry one.
            doc_vendors: dict[str, float] = {}
            doc_line_cat: dict[str, float] = {}   # per-day category ₹ from lines
            for ln in (doc.get("lines") or []):
                iid = ln.get("item_id")
                q = float(ln.get("qty") or 0)
                r = float(ln.get("rate") or 0)
                if not iid or q <= 0:
                    continue
                amt = q * r
                itemised_from_lines += amt
                _ck = (by_id.get(iid) or {}).get("category_key") or "uncategorised"
                doc_line_cat[_ck] = doc_line_cat.get(_ck, 0.0) + amt
                slot["qty"] += q
                slot["lines"] += 1
                it = purch_items.setdefault(iid, _blank_item())
                it["qty"] += q
                it["amount"] += amt
                it["lines"] += 1
                ln_vendor = ln.get("vendor_id") or doc_vendor_id
                if ln_vendor:
                    it["vendors"][ln_vendor] = it["vendors"].get(ln_vendor, 0.0) + amt
                    doc_vendors[ln_vendor] = doc_vendors.get(ln_vendor, 0.0) + amt
                purch_daily_lines.setdefault(d, []).append((iid, q))
            # Category share is drawn from `amounts` so bulk-uploaded
            # days still contribute to the pie.
            for ckey, v in amounts_map.items():
                purch_cat[ckey] = purch_cat.get(ckey, 0.0) + float(v or 0)
            # Per-day category breakdown for the stacked weekly bars —
            # same source as the category share: `amounts` when present,
            # else the per-line item categories.
            if amounts_map:
                for ckey, v in amounts_map.items():
                    slot["cat"][ckey] = slot["cat"].get(ckey, 0.0) + float(v or 0)
            else:
                for _ck, _a in doc_line_cat.items():
                    slot["cat"][_ck] = slot["cat"].get(_ck, 0.0) + _a
            # If no `amounts` (very early docs), fall back to lines.
            eff_day_total = day_total if amounts_map else itemised_from_lines
            slot["amount"] += eff_day_total
            slot["itemised_amount"] += itemised_from_lines
            slot["unitemised_amount"] += max(0.0, eff_day_total - itemised_from_lines)
            # Vendor rollup: distribute this doc's spend across the
            # vendors that showed up on its lines. Line-level vendors
            # give per-vendor accuracy for docs that span multiple
            # suppliers. If no line-level vendors are found, credit the
            # whole doc-total to the doc-level vendor (or "__unknown__"
            # sentinel so bulk imports still show up in the chart).
            if doc_vendors:
                for vid, amt in doc_vendors.items():
                    v_agg = vendor_totals.setdefault(vid, {"amount": 0.0, "purchases": 0})
                    v_agg["amount"] += amt
                    v_agg["purchases"] += 1
            else:
                v_key = doc_vendor_id or "__unknown__"
                v_agg = vendor_totals.setdefault(v_key, {"amount": 0.0, "purchases": 0})
                v_agg["amount"] += eff_day_total
                v_agg["purchases"] += 1

        for doc in iss_docs:
            d = doc["date"]
            slot = iss_daily.setdefault(d, _blank_day())
            for ln in (doc.get("lines") or []):
                iid = ln.get("item_id")
                q = float(ln.get("qty") or 0)
                if not iid or q <= 0:
                    continue
                rate = _rate_for(iid)
                amt = q * rate
                slot["amount"] += amt
                slot["qty"] += q
                slot["lines"] += 1
                it = iss_items.setdefault(iid, _blank_item())
                it["qty"] += q
                it["amount"] += amt
                it["lines"] += 1
                info = by_id.get(iid) or {}
                ckey = info.get("category_key") or "uncategorised"
                iss_cat[ckey] = iss_cat.get(ckey, 0.0) + amt
                slot["cat"][ckey] = slot["cat"].get(ckey, 0.0) + amt
                iss_daily_lines.setdefault(d, []).append((iid, q))

        def _daily_series(daily: dict) -> list:
            return _kitchen_daily_series(daily)

        def _item_rows(items_agg: dict) -> list:
            return _kitchen_item_rows(items_agg, by_id, cat_label)

        def _cat_pct(cat_agg: dict) -> list:
            return _kitchen_cat_pct(cat_agg, cat_label)

        purch_item_rows = _item_rows(purch_items)
        # Hydrate top-3 vendor names into each purchase item row so the
        # bar-chart tooltip can show "top vendor: X (₹Y) · Z more" —
        # requested by user 21 Aug 2026 alongside the qty tooltip.
        # Combined lookup: item-level vendors PLUS doc-level vendor_totals
        # so we can build the top-vendors-by-spend chart with one query.
        vendor_ids_seen = {vid for r in purch_items.values() for vid in r["vendors"].keys()}
        vendor_ids_seen.update(vid for vid in vendor_totals.keys() if vid != "__unknown__")
        vendor_by_id: dict[str, str] = {}
        if vendor_ids_seen:
            v_rows = await db.meal_vendors.find(
                {"id": {"$in": list(vendor_ids_seen)}},
                {"_id": 0, "id": 1, "name": 1},
            ).to_list(len(vendor_ids_seen))
            vendor_by_id = {v["id"]: v.get("name") for v in v_rows}
            for row in purch_item_rows:
                vmap = purch_items.get(row["item_id"], {}).get("vendors") or {}
                top = sorted(vmap.items(), key=lambda x: -x[1])[:3]
                row["top_vendors"] = [
                    {"name": vendor_by_id.get(vid) or "—",
                     "amount": round(amt, 2)}
                    for vid, amt in top
                ]

        # Top-vendors-by-spend list (Feb 2026 user request). Every
        # vendor with at least one purchase in the window, sorted by
        # rupee spend descending. Purchases without a vendor_id land
        # under a "Unknown / not set" row so bulk-imports still get
        # counted somewhere.
        v_total_amount = sum(v["amount"] for v in vendor_totals.values()) or 1.0
        top_vendors_rows = []
        for vid, agg in vendor_totals.items():
            top_vendors_rows.append({
                "vendor_id": vid if vid != "__unknown__" else None,
                "name": (vendor_by_id.get(vid) if vid != "__unknown__" else None) or "Unknown / not set",
                "amount": round(agg["amount"], 2),
                "purchases": agg["purchases"],
                "pct": round(agg["amount"] * 100.0 / v_total_amount, 2),
            })
        top_vendors_rows.sort(key=lambda r: r["amount"], reverse=True)

        iss_item_rows = _item_rows(iss_items)

        # ---- Nutrition rollup (Feb 2026 request) --------------------
        # Per-item macro totals for the window. Uses the item's stored
        # `nutrition` override first, else falls back to the built-in
        # `nutrition_seed` lookup by name.
        MACRO_KEYS = ("kcal", "protein_g", "carbs_g", "fat_g", "fibre_g")

        def _resolve_nutrition(info: dict) -> dict | None:
            n = info.get("nutrition") or None
            if n and isinstance(n, dict) and (n.get("kcal") is not None
                                              or n.get("protein_g") is not None):
                return n
            return _nutri_lookup(info.get("name") or "")

        def _line_macros(info: dict, qty: float) -> dict | None:
            nut = _resolve_nutrition(info)
            if not nut:
                return None
            gpu = None
            if isinstance(info.get("nutrition"), dict):
                gpu = info["nutrition"].get("grams_per_unit")
            if gpu is None:
                gpu = nut.get("grams_per_unit")
            grams = _qty_to_grams(qty, info.get("unit"), gpu)
            if grams is None:
                return None   # unit not weight/volume and no override
            factor = grams / 100.0
            return {k: float(nut.get(k) or 0) * factor for k in MACRO_KEYS}

        def _nutrition_rollup(items_agg: dict, daily_lines: dict) -> dict:
            """items_agg: {iid: {qty, amount, lines}}. daily_lines: {date:
            [(iid, qty), ...]}. Returns per-item macros, macro totals,
            daily kcal series and coverage stats."""
            per_item: list = []
            totals = {k: 0.0 for k in MACRO_KEYS}
            covered_qty = 0.0
            total_qty = 0.0
            covered_amt = 0.0
            total_amt = 0.0
            for iid, v in items_agg.items():
                info = by_id.get(iid) or {}
                macros = _line_macros(info, v["qty"])
                total_qty += v["qty"]
                total_amt += v["amount"]
                if not macros:
                    continue
                covered_qty += v["qty"]
                covered_amt += v["amount"]
                for k in MACRO_KEYS:
                    totals[k] += macros[k]
                per_item.append({
                    "item_id": iid,
                    "name": info.get("name") or "(deleted item)",
                    "unit": info.get("unit"),
                    "category_key": info.get("category_key"),
                    "qty": round(v["qty"], 3),
                    **{k: round(macros[k], 1) for k in MACRO_KEYS},
                })
            per_item.sort(key=lambda r: r["kcal"], reverse=True)

            # Macro grams pie (protein + carbs + fat + fibre) with % of grams.
            macro_grams = [
                {"key": "protein", "label": "Protein", "grams": round(totals["protein_g"], 1)},
                {"key": "carbs",   "label": "Carbs",   "grams": round(totals["carbs_g"], 1)},
                {"key": "fat",     "label": "Fat",     "grams": round(totals["fat_g"], 1)},
                {"key": "fibre",   "label": "Fibre",   "grams": round(totals["fibre_g"], 1)},
            ]
            tg = sum(m["grams"] for m in macro_grams) or 1.0
            for m in macro_grams:
                m["pct"] = round(m["grams"] * 100.0 / tg, 1)

            # Kcal contribution pie (4/4/9/2 kcal per gram).
            kcal_from = {
                "protein": totals["protein_g"] * 4,
                "carbs":   totals["carbs_g"] * 4,
                "fat":     totals["fat_g"] * 9,
                "fibre":   totals["fibre_g"] * 2,
            }
            tk = sum(kcal_from.values()) or 1.0
            kcal_pie = [
                {"key": k, "label": lbl, "kcal": round(v, 0),
                 "pct": round(v * 100.0 / tk, 1)}
                for k, lbl, v in [
                    ("protein", "Protein", kcal_from["protein"]),
                    ("carbs",   "Carbs",   kcal_from["carbs"]),
                    ("fat",     "Fat",     kcal_from["fat"]),
                    ("fibre",   "Fibre",   kcal_from["fibre"]),
                ]
            ]

            # Daily kcal trend — cheap: iterate the collected per-day
            # (item_id, qty) tuples and reuse the same _line_macros.
            daily_kcal = []
            for d in sorted(daily_lines.keys()):
                kcal_sum = 0.0
                for iid, qty in daily_lines[d]:
                    m = _line_macros(by_id.get(iid) or {}, qty)
                    if m:
                        kcal_sum += m["kcal"]
                daily_kcal.append({"date": d, "kcal": round(kcal_sum, 0)})

            return {
                "totals": {k: round(v, 1) for k, v in totals.items()},
                "kcal_total": round(totals["kcal"], 0),
                "top_by_kcal": per_item[:12],
                "items": per_item,
                "macro_grams": macro_grams,
                "kcal_pie": kcal_pie,
                "daily_kcal": daily_kcal,
                "coverage": {
                    "items_covered": len(per_item),
                    "items_total": len(items_agg),
                    "qty_covered": round(covered_qty, 3),
                    "qty_total": round(total_qty, 3),
                    "amount_covered": round(covered_amt, 2),
                    "amount_total": round(total_amt, 2),
                    "qty_pct": round(covered_qty * 100.0 / total_qty, 1) if total_qty else 0,
                    "amount_pct": round(covered_amt * 100.0 / total_amt, 1) if total_amt else 0,
                },
            }

        purch_nut = _nutrition_rollup(purch_items, purch_daily_lines)
        iss_nut = _nutrition_rollup(iss_items, iss_daily_lines)

        def _pack(daily, items_rows, cat_rows, nutrition) -> dict:
            total_amount = round(sum(d["amount"] for d in daily), 2)
            total_qty_lines = sum(d["lines"] for d in daily)
            itemised_amount = round(sum(r["amount"] for r in items_rows), 2)
            # Top-by-qty only makes sense across a single unit — mixing
            # kg with pcs / packet / L is misleading. Chef requested
            # (26 Feb 2026) to restrict the qty chart to `kg` items.
            kg_rows = [r for r in items_rows if (r.get("unit") or "").strip().lower() == "kg"]
            return {
                "daily": daily,
                "top_by_amount": items_rows,
                "top_by_qty": sorted(kg_rows, key=lambda r: r["qty"], reverse=True),
                "category_totals": cat_rows,
                "items": items_rows,
                "total_amount": total_amount,
                "itemised_amount": itemised_amount,
                "unitemised_amount": round(max(0.0, total_amount - itemised_amount), 2),
                "total_lines": total_qty_lines,
                "item_count": len(items_rows),
                "nutrition": nutrition,
            }

        return {
            "start": s, "end": e,
            "purchases": {
                **_pack(_daily_series(purch_daily), purch_item_rows, _cat_pct(purch_cat), purch_nut),
                "top_vendors": top_vendors_rows,
            },
            "issues":    _pack(_daily_series(iss_daily),   iss_item_rows,   _cat_pct(iss_cat),    iss_nut),
        }

    # ── Meals Calendar (Feb 2026 chef request) ───────────────────────
    # Simple date → {breakfast, lunch, dinner, total} aggregate.
    # Backfilled from the Jul-2026 spreadsheet Sailors + Staff +
    # MJPTBC-WRES combined. Future entries can be typed in directly
    # or auto-derived once per-person meal_records catch up.
    # DailyCountsIn lives in routes/meals/common.py (module scope so FastAPI resolves the body model).
    return {}
