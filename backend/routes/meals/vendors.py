"""Meals routes — vendors. Split out of routes/meals/__init__.py (Oct 2026); behaviour unchanged."""
from __future__ import annotations

from routes.meals.common import (
    DEFAULT_PURCHASE_CATEGORIES,
    Depends,
    HTTPException,
    Optional,
    PURCHASE_CFG_ID,
    PurchaseCategoriesIn,
    Query,
    VendorIn,
    VendorPatch,
    _slug_key,
    date,
    local_date_str,
    now_utc,
    timedelta,
    uuid,
)


def register(router, *, _signal_meals, _valid_date, db, require_admin, require_chef_or_admin):
    # ==================================================================
    # Meal purchases + expense report (Jun 2026)
    # ------------------------------------------------------------------
    # Daily purchase amounts per configurable category (fruits, grocery,
    # vegetables, …) stored one doc per date in `meal_purchases`.
    # Combined with `meal_records` counts to build the accountant-style
    # expense report (meals per group + spend per category + avg cost).
    # ==================================================================
    async def _purchase_categories() -> list[dict]:
        doc = await db.config.find_one({"id": PURCHASE_CFG_ID}, {"_id": 0})
        cats = (doc or {}).get("categories") or []
        if not cats:
            return [dict(c) for c in DEFAULT_PURCHASE_CATEGORIES]
        return cats

    # ------------------------------------------------------------------
    # Stock on hand — opening + Σ purchases − Σ issues − Σ wastage,
    # per item.
    # ------------------------------------------------------------------
    async def _stock_snapshot(as_of_iso: str, include_inactive: bool = False):
        """Shared stock math for /meals/stock and reorder suggestions.

        `include_inactive=True` also returns rows for deactivated items so
        their weighted-avg rate is available for VALUATION reports (issue
        cost / ₹-per-meal). Stock-on-hand and reorder keep the default
        (active-only) so discontinued items don't clutter those lists.
        """
        item_filter = {} if include_inactive else {"active": True}
        items = await db.meal_items.find(
            item_filter, {"_id": 0},
        ).sort([("category_key", 1), ("sort_order", 1), ("name", 1)]).to_list(500)
        cats = await _purchase_categories()
        cat_label = {c["key"]: c["label"] for c in cats}

        # These are one-doc-per-date collections; fetch ALL matching days
        # (length=None) so a busy pantry can never silently truncate the
        # ledger once a collection passes the old 5000-doc cap (code review).
        purch_docs = await db.meal_purchases.find(
            {"date": {"$lte": as_of_iso}}, {"_id": 0, "date": 1, "lines": 1},
        ).to_list(length=None)
        iss_docs = await db.meal_issues.find(
            {"date": {"$lte": as_of_iso}}, {"_id": 0, "date": 1, "lines": 1},
        ).to_list(length=None)
        wast_docs = await db.meal_wastage.find(
            {"date": {"$lte": as_of_iso}}, {"_id": 0, "date": 1, "lines": 1},
        ).to_list(length=None)
        adj_docs = await db.meal_adjustments.find(
            {"date": {"$lte": as_of_iso}}, {"_id": 0, "date": 1, "lines": 1},
        ).to_list(length=None)

        item_opening_as_of = {i["id"]: i.get("opening_stock_as_of") or "1970-01-01"
                              for i in items}

        def _sum_from(docs) -> dict[str, float]:
            out: dict[str, float] = {}
            for doc in docs:
                d = doc.get("date")
                for line in doc.get("lines") or []:
                    iid = line.get("item_id")
                    if iid and d and d >= item_opening_as_of.get(iid, "1970-01-01"):
                        out[iid] = out.get(iid, 0.0) + float(line.get("qty") or 0)
            return out

        def _sum_amount_from(docs) -> dict[str, float]:
            """Same as _sum_from but sums the `amount` field. Only purchase
            lines carry an amount (qty×rate) — issues/wastage don't. Used to
            compute weighted-avg cost per item for stock valuation."""
            out: dict[str, float] = {}
            for doc in docs:
                d = doc.get("date")
                for line in doc.get("lines") or []:
                    iid = line.get("item_id")
                    if iid and d and d >= item_opening_as_of.get(iid, "1970-01-01"):
                        out[iid] = out.get(iid, 0.0) + float(line.get("amount") or 0)
            return out

        purch_from = _sum_from(purch_docs)
        iss_from = _sum_from(iss_docs)
        wast_from = _sum_from(wast_docs)
        adj_from = _sum_from(adj_docs)   # signed: +extra / −loss
        purch_amount = _sum_amount_from(purch_docs)

        # Latest purchase rate per item on/before as_of (for conservative
        # issue valuation: issues are costed at max(WAC, current rate) so a
        # low historical average can't undervalue today's consumption).
        latest_rate: dict[str, float] = {}
        latest_date: dict[str, str] = {}
        for doc in purch_docs:
            dt = doc.get("date")
            for line in doc.get("lines") or []:
                iid = line.get("item_id")
                q = float(line.get("qty") or 0)
                if not iid or not dt or q <= 0:
                    continue
                r = line.get("rate")
                r = float(r) if r not in (None, "") else (float(line.get("amount") or 0) / q)
                if r > 0 and dt >= latest_date.get(iid, ""):
                    latest_date[iid] = dt
                    latest_rate[iid] = round(r, 4)

        rows = []
        for it in items:
            iid = it["id"]
            # Opening balance only exists from its as-of date — a back-dated
            # snapshot must not show stock that hadn't been counted yet.
            opening = float(it.get("opening_stock") or 0) \
                if as_of_iso >= item_opening_as_of.get(iid, "1970-01-01") else 0.0
            p = round(purch_from.get(iid, 0.0), 4)
            iq = round(iss_from.get(iid, 0.0), 4)
            w = round(wast_from.get(iid, 0.0), 4)
            adj = round(adj_from.get(iid, 0.0), 4)
            on_hand = round(opening + p - iq - w + adj, 4)
            min_s = round(float(it.get("min_stock") or 0), 4)
            low = on_hand <= (min_s if min_s > 0 else 0.001)
            # Weighted-avg cost for stock valuation. Standard WAC approach:
            # avg_rate = Σ amounts ÷ Σ qtys. If the item has an explicit
            # opening_rate, opening stock joins the blend (so items with
            # opening stock but no purchases still carry a real value);
            # otherwise opening is valued at the purchase-only WAC as before.
            purch_amt = round(purch_amount.get(iid, 0.0), 2)
            opening_rate = round(float(it.get("opening_rate") or 0), 4)
            if opening_rate > 0:
                denom = opening + p
                avg_rate = round((opening * opening_rate + purch_amt) / denom, 4) \
                    if denom > 0 else 0.0
                opening_value = round(opening * opening_rate, 2)
            else:
                avg_rate = round(purch_amt / p, 4) if p > 0 else 0.0
                opening_value = round(opening * avg_rate, 2)
            # Conservative issue rate = max(WAC, latest purchase rate).
            issue_rate = round(max(avg_rate, latest_rate.get(iid, 0.0)), 4)
            issued_cost_wac = round(iq * avg_rate, 2)   # WAC cost, keeps stock value accurate
            issued_value = round(iq * issue_rate, 2)    # conservative issue valuation
            wasted_value = round(w * avg_rate, 2)
            adj_value = round(adj * avg_rate, 2)   # signed
            # On-hand value stays at WAC (actual money tied up in stock).
            on_hand_value = round(opening_value + purch_amt - issued_cost_wac - wasted_value + adj_value, 2)
            rows.append({
                "item_id": iid,
                "name": it.get("name"),
                "category_key": it.get("category_key"),
                "category_label": cat_label.get(it.get("category_key"), it.get("category_key")),
                "unit": it.get("unit"),
                "opening_stock": round(opening, 4),
                "opening_stock_as_of": it.get("opening_stock_as_of"),
                "opening_rate": opening_rate,
                "purchased": p,
                "issued": iq,
                "wasted": w,
                "adjusted": adj,
                "on_hand": on_hand,
                "min_stock": min_s,
                "low": low,
                # Amounts (in ₹). avg_rate is weighted-avg purchase price;
                # issue_rate = max(WAC, latest rate) used to value issues.
                "avg_rate": avg_rate,
                "issue_rate": issue_rate,
                "opening_value": opening_value,
                "purchased_amount": purch_amt,
                "issued_value": issued_value,
                "wasted_value": wasted_value,
                "on_hand_value": on_hand_value,
            })
        return rows, cats

    @router.get("/meals/purchase-categories")
    async def get_purchase_categories(user: dict = Depends(require_chef_or_admin)):
        return {"categories": await _purchase_categories()}

    @router.put("/meals/purchase-categories")
    async def put_purchase_categories(
        body: PurchaseCategoriesIn, user: dict = Depends(require_chef_or_admin)
    ):
        if not body.categories:
            raise HTTPException(status_code=400, detail="At least one category is required")
        if len(body.categories) > 25:
            raise HTTPException(status_code=400, detail="Max 25 purchase categories")
        out, seen = [], set()
        for c in body.categories:
            label = c.label.strip()
            key = (c.key or "").strip().lower() or _slug_key(label)
            if key in seen:
                raise HTTPException(status_code=400, detail=f"Duplicate category key '{key}'")
            seen.add(key)
            out.append({"key": key, "label": label,
                        "active": c.active is not False})
        # 20 Feb 2026 rule: masters with data cannot be deleted. If any
        # existing category is being removed AND has items pointing at
        # it, refuse — chefs must move/deactivate those items first.
        existing = await _purchase_categories()
        dropped = [c["key"] for c in existing if c["key"] not in seen]
        if dropped:
            blockers: list = []
            for key in dropped:
                n = await db.meal_items.count_documents({"category_key": key})
                if n > 0:
                    lbl = next((e["label"] for e in existing if e["key"] == key), key)
                    blockers.append(f"{lbl} ({n} item{'s' if n != 1 else ''})")
            if blockers:
                raise HTTPException(
                    status_code=409,
                    detail=("Can't remove categories that still have items: "
                            + ", ".join(blockers)
                            + ". Move the items to another category or "
                              "delete them first."),
                )
        await db.config.update_one(
            {"id": PURCHASE_CFG_ID},
            {"$set": {"categories": out,
                      "updated_at": now_utc().isoformat(),
                      "updated_by": user.get("id")}},
            upsert=True,
        )
        await _signal_meals("categories")
        return {"categories": out}

    @router.put("/meals/purchase-categories/reorder")
    async def reorder_purchase_categories(
        body: dict,
        user: dict = Depends(require_chef_or_admin),
    ):
        """Reorder purchase categories by supplying the new key sequence.

        Body: `{"keys": ["dairy_products", "fruits", "cleaning_items", …]}`

        Missing keys keep their old position at the tail; unknown keys are
        rejected so a stale client can't wipe a category out of existence.
        """
        keys_in = list(body.get("keys") or [])
        if not keys_in:
            raise HTTPException(status_code=400, detail="keys list required")
        existing = await _purchase_categories()
        by_key = {c["key"]: c for c in existing}
        # Reject any key that isn't a current category — prevents accidental
        # data loss from a stale UI.
        for k in keys_in:
            if k not in by_key:
                raise HTTPException(
                    status_code=400,
                    detail=f"Unknown category key '{k}'")
        # Preserve the passed-in ordering, then append any categories the
        # client forgot about at the bottom so nothing disappears.
        ordered = [by_key[k] for k in keys_in if k in by_key]
        seen = set(keys_in)
        ordered.extend(c for c in existing if c["key"] not in seen)
        await db.config.update_one(
            {"id": PURCHASE_CFG_ID},
            {"$set": {"categories": ordered,
                      "updated_at": now_utc().isoformat(),
                      "updated_by": user.get("id")}},
            upsert=True,
        )
        await _signal_meals("categories")
        return {"categories": ordered}

    @router.post("/meals/items/sort-within-categories")
    async def sort_items_within_categories(
        by: str = Query("consumption", pattern="^(consumption|alpha)$"),
        days: int = Query(90, ge=1, le=3650),
        category_key: Optional[str] = Query(
            None, description="Only sort items inside this ONE category — leave blank for every category"),
        user: dict = Depends(require_chef_or_admin),
    ):
        """One-tap reorder of items INSIDE each category. Categories
        themselves keep whatever manual order the admin set — that's a
        deliberate call from the 20 Feb 2026 clarification: chefs want
        their walk-through order (Fruits, Grocery, …) preserved.

        Modes:
          • `by=consumption` (default) — sum of PURCHASE qty per item
            over the window, descending. Ties keep their CURRENT
            `sort_order` (not alpha) so the toggle doesn't secretly
            rebrand itself as an A→Z sort when a category has no
            recent purchases.
          • `by=alpha` — A → Z within each category.

        Pass `category_key=<key>` to sort just ONE category — powers the
        per-row toggle on the Daily Entry category header.

        When `by=consumption` and NOT A SINGLE item in the target
        category has any purchase in the window, we skip writes and
        return `no_data=True` so the client can toast a helpful reason
        instead of leaving the chef staring at an unchanged list.
        """
        item_q: dict = {}
        if category_key:
            item_q["category_key"] = category_key
        items = await db.meal_items.find(
            item_q, {"_id": 0, "id": 1, "category_key": 1, "name": 1, "sort_order": 1}
        ).to_list(2000)
        if not items:
            return {"by": by, "days": days if by == "consumption" else None,
                    "items_renumbered": 0, "categories_touched": 0,
                    "category_key": category_key, "no_data": False}

        per_item: dict = {}
        if by == "consumption":
            today = local_date_str(None)
            start = (date.fromisoformat(today) - timedelta(days=days - 1)).isoformat()
            # "How busy" = PURCHASE qty per item over the window (default
            # 90 days). Chefs asked for purchase-based ranking (not
            # issued) so newly-added stock items surface at the top the
            # same day they're bought.
            async for doc in db.meal_purchases.find(
                {"date": {"$gte": start, "$lte": today}},
                {"_id": 0, "lines": 1},
            ):
                for ln in (doc.get("lines") or []):
                    iid = ln.get("item_id")
                    q = float(ln.get("qty") or 0)
                    if iid and q > 0:
                        per_item[iid] = per_item.get(iid, 0.0) + q

        by_cat: dict = {}
        for it in items:
            by_cat.setdefault(it.get("category_key"), []).append(it)

        # If a SPECIFIC single category was requested AND consumption
        # mode AND no items in that category have purchases in the
        # window → don't touch anything, tell the client.
        if (by == "consumption" and category_key
                and not any(per_item.get(it["id"]) for it in items)):
            return {
                "by": by, "days": days, "items_renumbered": 0,
                "categories_touched": 0, "category_key": category_key,
                "no_data": True,
            }

        item_updates = 0
        for _ck, arr in by_cat.items():
            if by == "alpha":
                arr.sort(key=lambda i: (i.get("name") or "").lower())
            else:   # consumption — tie-break with CURRENT sort_order
                arr.sort(key=lambda i: (
                    -(per_item.get(i["id"]) or 0.0),
                    int(i.get("sort_order") or 0),
                    (i.get("name") or "").lower(),
                ))
            for idx, it in enumerate(arr):
                await db.meal_items.update_one(
                    {"id": it["id"]}, {"$set": {"sort_order": idx * 10}}
                )
                item_updates += 1
        await _signal_meals("items")
        return {
            "by": by,
            "days": days if by == "consumption" else None,
            "items_renumbered": item_updates,
            "categories_touched": len(by_cat),
            "category_key": category_key,
            "no_data": False,
        }

    @router.get("/meals/purchases")
    async def list_purchases(
        start: str, end: str, user: dict = Depends(require_chef_or_admin)
    ):
        s, e = _valid_date(start), _valid_date(end)
        if s > e:
            raise HTTPException(status_code=400, detail="start must be before end")
        rows = await db.meal_purchases.find(
            {"date": {"$gte": s, "$lte": e}},
            {"_id": 0},
        ).sort("date", 1).to_list(400)
        return {"start": s, "end": e, "purchases": rows}

    @router.get("/meals/daily-totals")
    async def daily_totals(
        start: str, end: str,
        user: dict = Depends(require_chef_or_admin),
    ):
        """Per-day purchase + issue totals across ALL items for a date
        range. Powers the double-click drill-down on the Daily entry
        totals cards and the printable Purchases/Issues PDF report
        (19 Aug 2026 user request).

        Issue amount uses the SAME weighted-average purchase rate the
        Daily-entry UI shows (Σ purch amount / Σ purch qty per item)
        so the numbers on this drill-down agree with the entry grid.
        """
        s, e = _valid_date(start), _valid_date(end)
        if s > e:
            raise HTTPException(status_code=400, detail="start must be before end")

        # Weighted-avg cost per item — reuse the SAME stock-snapshot math
        # the entry grid's Issues card uses (/meals/stock: opening_rate
        # blend + as-of date cap) so this drill-down agrees with the grid.
        snap_rows, _snap_cats = await _stock_snapshot(e, include_inactive=True)
        avg_rate: dict = {
            r["item_id"]: float(r.get("avg_rate") or 0) for r in snap_rows
        }

        # Per-day rollup.
        by_date: dict = {}
        async for p in db.meal_purchases.find(
            {"date": {"$gte": s, "$lte": e}},
            {"_id": 0, "date": 1, "lines": 1},
        ):
            d = p["date"]
            slot = by_date.setdefault(d, {"purchase_amt": 0.0, "issue_amt": 0.0,
                                          "purchase_lines": 0, "issue_lines": 0})
            for ln in (p.get("lines") or []):
                q = float(ln.get("qty") or 0)
                r = float(ln.get("rate") or 0)
                if q > 0:
                    slot["purchase_amt"] += q * r
                    slot["purchase_lines"] += 1

        async for i in db.meal_issues.find(
            {"date": {"$gte": s, "$lte": e}},
            {"_id": 0, "date": 1, "lines": 1},
        ):
            d = i["date"]
            slot = by_date.setdefault(d, {"purchase_amt": 0.0, "issue_amt": 0.0,
                                          "purchase_lines": 0, "issue_lines": 0})
            for ln in (i.get("lines") or []):
                iid = ln.get("item_id")
                q = float(ln.get("qty") or 0)
                if q <= 0 or not iid:
                    continue
                slot["issue_amt"] += q * avg_rate.get(iid, 0.0)
                slot["issue_lines"] += 1

        days = [
            {
                "date": d,
                "purchase_amt": round(v["purchase_amt"], 2),
                "issue_amt": round(v["issue_amt"], 2),
                "purchase_lines": v["purchase_lines"],
                "issue_lines": v["issue_lines"],
            }
            for d, v in sorted(by_date.items())
        ]
        return {
            "start": s, "end": e,
            "days": days,
            "grand_purchase_amt": round(sum(x["purchase_amt"] for x in days), 2),
            "grand_issue_amt": round(sum(x["issue_amt"] for x in days), 2),
        }

    # ------------------------------------------------------------------
    # Vendors master (Aug 2026). Light-weight supplier registry with
    # just name + phone. Purchase lines optionally carry `vendor_id` so
    # the accountant can trace who each ₹ came from. Any chef/admin can
    # read (fills the dropdown on the Daily entry grid); only admins
    # can create / edit / soft-delete.
    # ------------------------------------------------------------------
    def _norm_vendor_name(n: str) -> str:
        import re
        return re.sub(r"\s+", " ", (n or "").strip().lower())

    def _norm_phone(p: Optional[str]) -> Optional[str]:
        if not p:
            return None
        import re
        digits = re.sub(r"\D+", "", str(p))
        return digits or None

    @router.get("/meals/vendors")
    async def list_vendors(user: dict = Depends(require_chef_or_admin)):
        """All active vendors sorted by name — feeds the vendor
        dropdown on the Daily-entry grid and the Vendors master screen.
        Inactive vendors are hidden here; use ?include_inactive=1 for
        the admin screen if we ever need it.
        """
        rows = await db.meal_vendors.find(
            {"active": {"$ne": False}}, {"_id": 0},
        ).sort("name", 1).to_list(500)
        return {"vendors": rows}

    @router.get("/meals/vendor-trends")
    async def vendor_trends(
        months: int = 6, user: dict = Depends(require_chef_or_admin),
    ):
        """Per-vendor rolling monthly spend for a sparkline on the
        Vendors master screen (Aug 2026 user request — "spot who is
        quietly getting expensive"). Returns each vendor + a series of
        `{ym, amount}` from `months` ago (default 6) up to the current
        office-local month.
        """
        try:
            m = int(months)
        except Exception:
            m = 6
        m = max(1, min(m, 24))

        office = await db.config.find_one({"id": "office"}) or {}
        today_iso = local_date_str(office)
        y, mth = int(today_iso[:4]), int(today_iso[5:7])
        # Build the list of YYYY-MM buckets from oldest → newest.
        buckets: list = []
        yy, mm = y, mth
        for _ in range(m):
            buckets.append(f"{yy:04d}-{mm:02d}")
            mm -= 1
            if mm == 0:
                mm = 12
                yy -= 1
        buckets.reverse()
        start_ym = buckets[0]
        # Wide-range date filter that safely captures the earliest bucket.
        start_iso = f"{start_ym}-01"

        # Load every purchase line since the start of the window and
        # sum by (vendor_id, YYYY-MM). Missing vendor_id → skipped.
        totals: dict = {}   # vendor_id → {ym: amount}
        async for p in db.meal_purchases.find(
            {"date": {"$gte": start_iso}},
            {"_id": 0, "date": 1, "lines": 1},
        ):
            ym = p["date"][:7]
            if ym < start_ym:
                continue
            for ln in (p.get("lines") or []):
                vid = ln.get("vendor_id")
                q = float(ln.get("qty") or 0)
                r = float(ln.get("rate") or 0)
                if not vid or q <= 0:
                    continue
                slot = totals.setdefault(vid, {})
                slot[ym] = slot.get(ym, 0.0) + q * r

        vendors = await db.meal_vendors.find({}, {"_id": 0}).sort("name", 1).to_list(1000)
        out = []
        for v in vendors:
            series_map = totals.get(v["id"], {})
            series = [{"ym": ym, "amount": round(series_map.get(ym, 0.0), 2)} for ym in buckets]
            out.append({
                "id": v["id"],
                "name": v["name"],
                "series": series,
                "total": round(sum(x["amount"] for x in series), 2),
            })
        return {"months": buckets, "vendors": out}

    @router.get("/meals/vendors/{vendor_id}/scorecard")
    async def vendor_scorecard(
        vendor_id: str,
        days: int = Query(30, ge=1, le=365),
        user: dict = Depends(require_chef_or_admin),
    ):
        """Per-vendor 30-day scorecard (Feb 2026 user request).

        Returns headline stats + a per-item breakdown so the chef can
        spot suppliers who are quietly getting expensive:

          • total spend, purchase-line count, item variety in the window
          • per item: qty, spend, vendor's own avg rate, min/max rate,
            vendor's LATEST rate, market avg (across ALL vendors in the
            window), and a price-variance % vs the market avg.
        """
        vendor = await db.meal_vendors.find_one({"id": vendor_id}, {"_id": 0})
        if not vendor:
            raise HTTPException(status_code=404, detail="Vendor not found")

        today = local_date_str(None)
        start = (date.fromisoformat(today) - timedelta(days=days - 1)).isoformat()

        # All purchase docs in the window — we need EVERYONE's rates to
        # compute the market average per item (vendor comparison), not
        # just this vendor's.
        docs = await db.meal_purchases.find(
            {"date": {"$gte": start, "$lte": today}},
            {"_id": 0, "date": 1, "lines": 1},
        ).sort("date", 1).to_list(1000)

        # Per-item aggregates keyed by item_id.
        # this_vendor: {qty, spend, rates:[(date,rate)]}
        # market:      {qty, spend}    ← used for market-avg comparison
        this_vendor: dict = {}
        market: dict = {}
        for doc in docs:
            d = doc["date"]
            for ln in (doc.get("lines") or []):
                iid = ln.get("item_id")
                q = float(ln.get("qty") or 0)
                r = float(ln.get("rate") or 0)
                if not iid or q <= 0:
                    continue
                # market rollup (every vendor, including this one)
                m = market.setdefault(iid, {"qty": 0.0, "spend": 0.0})
                m["qty"] += q
                m["spend"] += q * r
                # vendor-specific rollup
                if ln.get("vendor_id") == vendor_id:
                    v = this_vendor.setdefault(iid, {
                        "qty": 0.0, "spend": 0.0, "rates": [], "last_date": None,
                    })
                    v["qty"] += q
                    v["spend"] += q * r
                    v["rates"].append((d, r))
                    if v["last_date"] is None or d >= v["last_date"]:
                        v["last_date"] = d

        if not this_vendor:
            return {
                "vendor": vendor, "days": days, "start": start, "end": today,
                "total_spend": 0.0, "total_lines": 0, "item_count": 0,
                "items": [],
            }

        # Hydrate item master for names/units.
        item_ids = list(this_vendor.keys())
        items = await db.meal_items.find(
            {"id": {"$in": item_ids}},
            {"_id": 0, "id": 1, "name": 1, "unit": 1, "category_key": 1},
        ).to_list(len(item_ids))
        by_id = {i["id"]: i for i in items}

        rows = []
        total_spend = 0.0
        total_lines = 0
        for iid, v in this_vendor.items():
            info = by_id.get(iid)
            if not info:
                continue
            qty = v["qty"]
            spend = v["spend"]
            rates = sorted(v["rates"])   # (date, rate)
            latest_rate = rates[-1][1] if rates else 0.0
            all_rates = [r for _, r in rates]
            min_rate = min(all_rates) if all_rates else 0.0
            max_rate = max(all_rates) if all_rates else 0.0
            avg_rate = spend / qty if qty else 0.0
            m = market.get(iid) or {"qty": 0.0, "spend": 0.0}
            market_avg = (m["spend"] / m["qty"]) if m["qty"] else 0.0
            # % above/below the market avg. + = more expensive than market.
            variance_pct = None
            if market_avg > 0:
                variance_pct = round((avg_rate - market_avg) / market_avg * 100.0, 1)
            rows.append({
                "item_id": iid,
                "name": info.get("name"),
                "unit": info.get("unit"),
                "category_key": info.get("category_key"),
                "qty": round(qty, 4),
                "spend": round(spend, 2),
                "avg_rate": round(avg_rate, 2),
                "latest_rate": round(latest_rate, 2),
                "min_rate": round(min_rate, 2),
                "max_rate": round(max_rate, 2),
                "market_avg": round(market_avg, 2),
                "variance_pct": variance_pct,
                "line_count": len(rates),
                "last_purchase_date": v["last_date"],
            })
            total_spend += spend
            total_lines += len(rates)

        rows.sort(key=lambda r: r["spend"], reverse=True)
        return {
            "vendor": vendor,
            "days": days, "start": start, "end": today,
            "total_spend": round(total_spend, 2),
            "total_lines": total_lines,
            "item_count": len(rows),
            "items": rows,
        }

    @router.get("/meals/items/{item_id}/price-trend")
    async def item_price_trend(
        item_id: str,
        days: Optional[int] = Query(None, ge=1, le=3650),
        user: dict = Depends(require_chef_or_admin),
    ):
        """Full purchase-price history for one item (Feb 2026 request).

        Returns every purchase line chronologically with date, qty, rate,
        amount and vendor name — so the client can render a price+qty
        graph "from the beginning". Pass `?days=90` to cap the window;
        omitted → since the item's first purchase.
        """
        item = await db.meal_items.find_one({"id": item_id}, {"_id": 0})
        if not item:
            raise HTTPException(status_code=404, detail="Item not found")

        today = local_date_str(None)
        q: dict = {"lines.item_id": item_id}
        if days:
            start = (date.fromisoformat(today) - timedelta(days=days - 1)).isoformat()
            q["date"] = {"$gte": start, "$lte": today}

        docs = await db.meal_purchases.find(
            q, {"_id": 0, "date": 1, "lines": 1},
        ).sort("date", 1).to_list(2000)

        # Hydrate vendor names (batch).
        vendors = await db.meal_vendors.find({}, {"_id": 0, "id": 1, "name": 1}).to_list(1000)
        vname = {v["id"]: v["name"] for v in vendors}

        points: list = []
        for doc in docs:
            d = doc["date"]
            for ln in (doc.get("lines") or []):
                if ln.get("item_id") != item_id:
                    continue
                qty = float(ln.get("qty") or 0)
                rate = float(ln.get("rate") or 0)
                if qty <= 0:
                    continue
                vid = ln.get("vendor_id")
                points.append({
                    "date": d,
                    "qty": round(qty, 4),
                    "rate": round(rate, 2),
                    "amount": round(qty * rate, 2),
                    "vendor_id": vid,
                    "vendor_name": vname.get(vid) if vid else None,
                })

        # Summary stats.
        if points:
            rates = [p["rate"] for p in points]
            qtys = [p["qty"] for p in points]
            total_qty = sum(qtys)
            total_spend = sum(p["amount"] for p in points)
            summary = {
                "first_date": points[0]["date"],
                "last_date": points[-1]["date"],
                "point_count": len(points),
                "min_rate": min(rates),
                "max_rate": max(rates),
                "latest_rate": rates[-1],
                "avg_rate": round(total_spend / total_qty, 2) if total_qty else 0.0,
                "total_qty": round(total_qty, 4),
                "total_spend": round(total_spend, 2),
            }
        else:
            summary = {
                "first_date": None, "last_date": None, "point_count": 0,
                "min_rate": 0.0, "max_rate": 0.0, "latest_rate": 0.0,
                "avg_rate": 0.0, "total_qty": 0.0, "total_spend": 0.0,
            }

        return {
            "item": {"id": item["id"], "name": item.get("name"),
                     "unit": item.get("unit"),
                     "category_key": item.get("category_key")},
            "days": days, "points": points, "summary": summary,
        }

    @router.get("/meals/items/last-rates")
    async def item_last_rates(
        before: Optional[str] = None,
        user: dict = Depends(require_chef_or_admin),
    ):
        """Most-recent purchase rate per item STRICTLY BEFORE `before`
        (defaults to today). Powers the price-outlier warning on the
        purchase-entry screen. Returns {item_id: {rate, date}}.

        A line's rate is taken from its stored `rate`; if missing but an
        `amount` is present, it's back-computed as amount ÷ qty.
        """
        b = _valid_date(before) if before else local_date_str(None)
        docs = await db.meal_purchases.find(
            {"date": {"$lt": b}},
            {"_id": 0, "date": 1, "lines": 1},
        ).sort("date", 1).to_list(5000)
        out: dict = {}
        for doc in docs:  # ascending → a later date overwrites an earlier one
            d = doc["date"]
            for ln in doc.get("lines") or []:
                iid = ln.get("item_id")
                q = float(ln.get("qty") or 0)
                if not iid or q <= 0:
                    continue
                r = float(ln.get("rate") or 0)
                if r <= 0:
                    amt = float(ln.get("amount") or 0)
                    r = (amt / q) if amt > 0 else 0.0
                if r <= 0:
                    continue
                out[iid] = {"rate": round(r, 2), "date": d}
        return {"before": b, "rates": out}

    @router.get("/meals/price-movers")
    async def price_movers(
        end: Optional[str] = None,
        days: int = Query(30, ge=3, le=365),
        user: dict = Depends(require_chef_or_admin),
    ):
        """Which commodities are getting dearer / cheaper (Jun 2026 request).

        Compares each item's weighted-average purchase rate in the CURRENT
        window [end-days+1, end] against the PREVIOUS equal-length window,
        returning the % change plus a rate sparkline across both windows so
        the client can draw an at-a-glance 'price movers' view.
        """
        e = _valid_date(end) if end else local_date_str(None)
        e_d = date.fromisoformat(e)
        cur_start = (e_d - timedelta(days=days - 1)).isoformat()
        base_start = (e_d - timedelta(days=2 * days - 1)).isoformat()
        base_end = (e_d - timedelta(days=days)).isoformat()

        items = await db.meal_items.find(
            {}, {"_id": 0, "id": 1, "name": 1, "unit": 1, "category_key": 1}).to_list(1000)
        imeta = {i["id"]: i for i in items}
        cats = await _purchase_categories()
        clabel = {c["key"]: c["label"] for c in cats}

        docs = await db.meal_purchases.find(
            {"date": {"$gte": base_start, "$lte": e}},
            {"_id": 0, "date": 1, "lines": 1}).to_list(5000)

        cur_q: dict = {}; cur_a: dict = {}
        base_q: dict = {}; base_a: dict = {}
        series_q: dict = {}; series_a: dict = {}
        for doc in docs:
            d = doc["date"]
            in_cur = d >= cur_start
            in_base = base_start <= d <= base_end
            for ln in doc.get("lines") or []:
                iid = ln.get("item_id"); q = float(ln.get("qty") or 0)
                if not iid or q <= 0:
                    continue
                amt = float(ln.get("amount") or (q * float(ln.get("rate") or 0)))
                if in_cur:
                    cur_q[iid] = cur_q.get(iid, 0) + q; cur_a[iid] = cur_a.get(iid, 0) + amt
                elif in_base:
                    base_q[iid] = base_q.get(iid, 0) + q; base_a[iid] = base_a.get(iid, 0) + amt
                series_q.setdefault(iid, {}); series_a.setdefault(iid, {})
                series_q[iid][d] = series_q[iid].get(d, 0) + q
                series_a[iid][d] = series_a[iid].get(d, 0) + amt

        movers: list = []
        for iid in set(list(cur_q) + list(base_q)):
            cq = cur_q.get(iid, 0); ca = cur_a.get(iid, 0)
            bq = base_q.get(iid, 0); ba = base_a.get(iid, 0)
            cur_rate = round(ca / cq, 2) if cq > 0 else None
            base_rate = round(ba / bq, 2) if bq > 0 else None
            if cur_rate is None:
                continue  # only items bought in the current window are "movers"
            pct = round((cur_rate - base_rate) / base_rate * 100, 1) if (base_rate and base_rate > 0) else None
            sq = series_q.get(iid, {}); sa = series_a.get(iid, {})
            spark = [{"date": dd, "rate": round(sa[dd] / sq[dd], 2)}
                     for dd in sorted(sq) if sq.get(dd, 0) > 0]
            m = imeta.get(iid, {})
            movers.append({
                "item_id": iid,
                "name": m.get("name") or "—",
                "unit": m.get("unit"),
                "category_key": m.get("category_key"),
                "category_label": clabel.get(m.get("category_key"), m.get("category_key")),
                "base_rate": base_rate,
                "cur_rate": cur_rate,
                "change_pct": pct,
                "is_new": base_rate is None,
                "cur_qty": round(cq, 3),
                "cur_spend": round(ca, 2),
                "spark": spark,
            })
        movers.sort(key=lambda x: (x["change_pct"] is None, -(x["change_pct"] or 0)))
        rising = [m for m in movers if m["change_pct"] is not None and m["change_pct"] > 0]
        falling = [m for m in movers if m["change_pct"] is not None and m["change_pct"] < 0]
        avg_change = round(sum(m["change_pct"] for m in movers if m["change_pct"] is not None)
                           / max(1, len(rising) + len(falling)), 1) if (rising or falling) else None
        return {
            "end": e, "days": days,
            "current": {"start": cur_start, "end": e},
            "baseline": {"start": base_start, "end": base_end},
            "movers": movers,
            "rising_count": len(rising),
            "falling_count": len(falling),
            "new_count": sum(1 for m in movers if m["is_new"]),
            "avg_change_pct": avg_change,
        }


    @router.post("/meals/vendors")
    async def create_vendor(body: VendorIn, user: dict = Depends(require_chef_or_admin)):
        name = body.name.strip()
        norm = _norm_vendor_name(name)
        if not norm:
            raise HTTPException(status_code=400, detail="Name required")
        # Case-insensitive dedupe against active AND inactive to avoid
        # accidentally creating a second row for a supplier whose old
        # entry was soft-deleted.
        clash = await db.meal_vendors.find_one({"name_norm": norm})
        if clash:
            raise HTTPException(status_code=409, detail=f'Vendor "{clash["name"]}" already exists')
        doc = {
            "id": str(uuid.uuid4()),
            "name": name,
            "name_norm": norm,
            "phone": _norm_phone(body.phone),
            "active": True,
            "created_at": now_utc().isoformat(),
            "created_by": user["id"],
        }
        await db.meal_vendors.insert_one(doc)
        doc.pop("_id", None)
        await _signal_meals("vendors")
        return doc

    @router.patch("/meals/vendors/{vendor_id}")
    async def update_vendor(
        vendor_id: str, body: VendorPatch,
        user: dict = Depends(require_chef_or_admin),
    ):
        vendor = await db.meal_vendors.find_one({"id": vendor_id}, {"_id": 0})
        if not vendor:
            raise HTTPException(status_code=404, detail="Vendor not found")
        update: dict = {}
        if body.name is not None:
            new_name = body.name.strip()
            new_norm = _norm_vendor_name(new_name)
            if not new_norm:
                raise HTTPException(status_code=400, detail="Name required")
            clash = await db.meal_vendors.find_one({"name_norm": new_norm, "id": {"$ne": vendor_id}})
            if clash:
                raise HTTPException(status_code=409, detail=f'Vendor "{clash["name"]}" already exists')
            update["name"] = new_name
            update["name_norm"] = new_norm
        if body.phone is not None:
            update["phone"] = _norm_phone(body.phone)
        if body.active is not None:
            update["active"] = bool(body.active)
        if update:
            await db.meal_vendors.update_one({"id": vendor_id}, {"$set": update})
        merged = {**vendor, **update}
        merged.pop("_id", None)
        await _signal_meals("vendors")
        return merged

    @router.delete("/meals/vendors/{vendor_id}")
    async def delete_vendor(vendor_id: str, admin: dict = Depends(require_admin)):
        vendor = await db.meal_vendors.find_one({"id": vendor_id}, {"_id": 0})
        if not vendor:
            raise HTTPException(status_code=404, detail="Vendor not found")
        # If the vendor was ever attached to a purchase line we soft-delete
        # (active=False) so historical audits keep their supplier context;
        # otherwise a hard delete keeps the master screen tidy.
        used = await db.meal_purchases.find_one({"lines.vendor_id": vendor_id})
        if used:
            await db.meal_vendors.update_one({"id": vendor_id}, {"$set": {"active": False}})
            await _signal_meals("vendors")
            return {"soft_deleted": True}
        await db.meal_vendors.delete_one({"id": vendor_id})
        await _signal_meals("vendors")
        return {"deleted": True}

    return {"_purchase_categories": _purchase_categories, "_stock_snapshot": _stock_snapshot}
