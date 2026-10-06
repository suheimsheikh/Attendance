"""Meals routes — stock_take. Split out of routes/meals/__init__.py (Oct 2026); behaviour unchanged."""
from __future__ import annotations

from routes.meals.common import (  # noqa: F401
    Depends,
    HTTPException,
    Optional,
    Query,
    StockTakeIn,
    date,
    local_date_str,
    math,
    now_utc,
    timedelta,
)


def register(router, *, _audit, _not_future, _purchase_categories, _range_or_default, _safe_date_upsert, _signal_meals, _stock_snapshot, _upsert_line_scoped, _valid_date, db, require_chef_or_admin):
    # ==================================================================
    # Weekly stock-take (Jun 2026)
    # ------------------------------------------------------------------
    # Chefs count physical stock every week. The count is taken at the
    # START of the chosen day. We compare it to the system on-hand at
    # that moment and post the difference as a signed adjustment line in
    # `meal_adjustments` (+extra found / −loss). The ledger stays
    # continuous — the adjustment simply reconciles the running balance
    # to the counted number. Partial counts are fine: only items with a
    # physical value entered are touched.
    # ==================================================================
    @router.get("/meals/stock-take")
    async def stock_take_sheet(
        date: str,  # noqa: A002 — API contract; local name via _valid_date
        user: dict = Depends(require_chef_or_admin),
    ):
        """Physical-count worksheet: every active item with its SYSTEM
        on-hand at the START of `date`, plus any count already recorded
        for that date (so a partial take can be resumed)."""
        from datetime import date as _date_cls
        d = _valid_date(date)
        _not_future(d)
        prev = (_date_cls.fromisoformat(d) - timedelta(days=1)).isoformat()
        snap_rows, cats = await _stock_snapshot(prev)
        adj_doc = await db.meal_adjustments.find_one({"date": d}, {"_id": 0, "lines": 1})
        recorded = {ln["item_id"]: ln for ln in (adj_doc or {}).get("lines") or []}
        rows = []
        for r in snap_rows:
            rec = recorded.get(r["item_id"])
            rows.append({
                "item_id": r["item_id"],
                "name": r["name"],
                "category_key": r["category_key"],
                "category_label": r["category_label"],
                "unit": r["unit"],
                "system_qty": r["on_hand"],
                "avg_rate": r.get("avg_rate", 0),
                "needs_rate": not (r.get("avg_rate") or 0) > 0,
                "physical_qty": (rec or {}).get("physical"),
                "variance": (rec or {}).get("qty"),
                "recorded": rec is not None,
                "recorded_by": (rec or {}).get("by_name"),
                "recorded_at": (rec or {}).get("at"),
            })
        return {"date": d, "categories": cats, "rows": rows}

    @router.post("/meals/stock-take")
    async def stock_take_save(body: StockTakeIn, user: dict = Depends(require_chef_or_admin)):
        """Save a (partial) physical count for a day. For each counted
        item: variance = physical − system-on-hand-at-start-of-day; a
        signed adjustment line is upserted so the ledger reconciles."""
        from datetime import date as _date_cls
        d = _valid_date(body.date)
        _not_future(d)
        prev = (_date_cls.fromisoformat(d) - timedelta(days=1)).isoformat()
        snap_rows, _ = await _stock_snapshot(prev)
        sysmap = {r["item_id"]: r["on_hand"] for r in snap_rows}
        namemap = {r["item_id"]: r for r in snap_rows}
        now_iso = now_utc().isoformat()
        by_id = user.get("id")
        by_name = user.get("full_name") or user.get("email") or "Chef"
        counted = losses = extras = unchanged = opening_set = 0
        result_lines = []
        # Ensure the day's doc exists so per-item atomic writes can target it.
        # The unique index on `date` + _safe_date_upsert make the concurrent
        # first-write of a fresh day race-safe.
        await _safe_date_upsert(
            db.meal_adjustments, {"date": d}, {"$setOnInsert": {"date": d, "lines": []}})

        for ln in body.lines:
            iid = str(ln.get("item_id") or "")
            if iid not in sysmap:
                continue
            phys_raw = ln.get("physical_qty")
            if phys_raw is None or phys_raw == "":
                continue
            try:
                physical = float(phys_raw)
            except (TypeError, ValueError):
                continue
            if physical < 0 or not math.isfinite(physical):
                continue
            counted += 1
            system = sysmap[iid]
            # First-count path: an item with no cost history yet can take a
            # ₹/unit rate — the count then becomes its opening balance as of
            # this date (valued), rather than an un-valued adjustment.
            rate_raw = ln.get("rate")
            try:
                rate = float(rate_raw) if rate_raw not in (None, "") else 0.0
            except (TypeError, ValueError):
                rate = 0.0
            if not math.isfinite(rate):
                rate = 0.0
            if rate > 0 and not (namemap.get(iid, {}).get("avg_rate") or 0) > 0:
                await db.meal_items.update_one({"id": iid}, {"$set": {
                    "opening_stock": round(physical, 4),
                    "opening_stock_as_of": d,
                    "opening_rate": round(rate, 4),
                    "updated_at": now_iso,
                }})
                opening_set += 1
                # Also record the count in meal_adjustments (qty 0 = no ledger
                # impact, since the opening_stock above already carries the
                # quantity) so the sheet marks the item counted and the entered
                # value persists on reload. Without this line the count vanished.
                oline = {
                    "item_id": iid,
                    "qty": 0.0,
                    "physical": round(physical, 4),
                    "system": round(system, 4),
                    "avg_rate": round(rate, 4),
                    "kind": "opening",
                    "rate": round(rate, 4),
                    "notes": (str(ln.get("notes") or "").strip() or None),
                    "at": now_iso,
                    "by": by_id,
                    "by_name": by_name,
                }
                await _upsert_line_scoped(db.meal_adjustments, d, oline)
                result_lines.append({**oline, "name": namemap.get(iid, {}).get("name"),
                                     "unit": namemap.get(iid, {}).get("unit")})
                continue
            variance = round(physical - system, 4)
            if abs(variance) < 1e-9:
                unchanged += 1
                variance = 0.0           # verified, no change — still recorded
            elif variance > 0:
                extras += 1
            else:
                losses += 1
            line = {
                "item_id": iid,
                "qty": variance,               # signed: +extra / −loss / 0 = verified
                "physical": round(physical, 4),
                "system": round(system, 4),
                "avg_rate": round(float(namemap.get(iid, {}).get("avg_rate") or 0), 4),
                "kind": "stock_take",
                "notes": (str(ln.get("notes") or "").strip() or None),
                "at": now_iso,
                "by": by_id,
                "by_name": by_name,
            }
            await _upsert_line_scoped(db.meal_adjustments, d, line)
            result_lines.append({**line, "name": namemap.get(iid, {}).get("name"),
                                 "unit": namemap.get(iid, {}).get("unit")})
        await _safe_date_upsert(
            db.meal_adjustments, {"date": d},
            {"$set": {"updated_at": now_iso, "updated_by": by_id,
                      "updated_by_name": by_name}})
        # Don't leave an empty adjustments doc behind (all-unchanged counts).
        after = await db.meal_adjustments.find_one({"date": d}, {"_id": 0, "lines": 1})
        if not (after or {}).get("lines"):
            await db.meal_adjustments.delete_one({"date": d})
        await _signal_meals("adjustments", d)
        _stk_changes = [
            {"item": rl.get("name") or rl.get("item_id"), "unit": rl.get("unit") or "",
             "type": "opening" if rl.get("kind") == "opening" else ("changed" if (rl.get("qty") or 0) else "verified"),
             "kind": rl.get("kind"),
             "fields": ({"opening_stock": {"before": None, "after": rl.get("physical")},
                         "opening_rate": {"before": None, "after": rl.get("rate")}}
                        if rl.get("kind") == "opening" else
                        {"on_hand": {"before": rl.get("system"), "after": rl.get("physical")},
                         "variance": {"before": None, "after": rl.get("qty")}})}
            for rl in result_lines
        ]
        await _audit(user, "meals.stocktake.save", "meal_stocktake", d, f"Stock-take {d}",
                     meta={"date": d, "counted": counted, "losses": losses,
                           "counts": {"changed": len(_stk_changes)}, "changes": _stk_changes})
        return {"date": d, "counted": counted, "losses": losses,
                "extras": extras, "unchanged": unchanged, "opening_set": opening_set, "lines": result_lines}

    @router.get("/meals/stock-take/report")
    async def stock_take_report(
        start: Optional[str] = Query(None),
        end: Optional[str] = Query(None),
        user: dict = Depends(require_chef_or_admin),
    ):
        """Variance summary + audit history of stock-take adjustments in a
        range. `rows` ranks items by total variance value (loss+extra) so
        the biggest problem stock floats to the top; `history` is the
        chronological who/when audit trail of every count line."""
        s, e = _range_or_default(start, end)
        docs = await db.meal_adjustments.find(
            {"date": {"$gte": s, "$lte": e}},
            {"_id": 0, "date": 1, "lines": 1}).to_list(5000)
        snap_rows, _ = await _stock_snapshot(e)
        info = {r["item_id"]: r for r in snap_rows}
        all_items = await db.meal_items.find(
            {}, {"_id": 0, "id": 1, "name": 1, "unit": 1, "category_key": 1}).to_list(2000)
        item_map = {i["id"]: i for i in all_items}
        cats = await _purchase_categories()
        cat_label = {c["key"]: c["label"] for c in cats}

        agg: dict[str, dict] = {}
        history: list[dict] = []
        for d in docs:
            for ln in d.get("lines") or []:
                iid = ln.get("item_id")
                if not iid:
                    continue
                qty = float(ln.get("qty") or 0)
                # Value each line at the rate captured when it was counted;
                # fall back to the item's current avg rate for older lines.
                rate = ln.get("avg_rate")
                if rate is None:
                    rate = float((info.get(iid) or {}).get("avg_rate") or 0)
                rate = float(rate or 0)
                a = agg.setdefault(iid, {"loss_qty": 0.0, "extra_qty": 0.0,
                                         "loss_value": 0.0, "extra_value": 0.0, "count": 0}) if qty != 0 else None
                if qty < 0:
                    a["loss_qty"] += -qty
                    a["loss_value"] += -qty * rate
                    a["count"] += 1
                elif qty > 0:
                    a["extra_qty"] += qty
                    a["extra_value"] += qty * rate
                    a["count"] += 1
                # qty == 0 → verified no-change: shown in history, not ranked.
                history.append({
                    "date": d["date"], "item_id": iid, "qty": round(qty, 4),
                    "physical": ln.get("physical"), "system": ln.get("system"),
                    "by_name": ln.get("by_name"), "at": ln.get("at"),
                    "notes": ln.get("notes"),
                })

        def _meta(iid: str) -> dict:
            m = info.get(iid) or {}
            im = item_map.get(iid) or {}
            ckey = m.get("category_key") or im.get("category_key")
            return {
                "name": m.get("name") or im.get("name") or "(deleted item)",
                "unit": m.get("unit") or im.get("unit"),
                "category_key": ckey,
                "category_label": cat_label.get(ckey, (ckey or "").replace("_", " ").title()),
            }

        rows = []
        for iid, a in agg.items():
            m = _meta(iid)
            net_qty = round(a["extra_qty"] - a["loss_qty"], 4)
            rows.append({
                "item_id": iid, "name": m["name"], "unit": m["unit"],
                "category_key": m["category_key"], "category_label": m["category_label"],
                "loss_qty": round(a["loss_qty"], 4), "extra_qty": round(a["extra_qty"], 4),
                "net_qty": net_qty, "count": a["count"],
                "loss_value": round(a["loss_value"], 2),
                "extra_value": round(a["extra_value"], 2),
                "net_value": round(a["extra_value"] - a["loss_value"], 2),
            })
        rows.sort(key=lambda r: (-(r["loss_value"] + r["extra_value"]),
                                 -(r["loss_qty"] + r["extra_qty"])))

        for h in history:
            m = _meta(h["item_id"])
            h["name"] = m["name"]
            h["unit"] = m["unit"]
        history.sort(key=lambda h: (h["date"], h.get("at") or ""), reverse=True)

        totals = {
            "loss_qty": round(sum(r["loss_qty"] for r in rows), 4),
            "extra_qty": round(sum(r["extra_qty"] for r in rows), 4),
            "loss_value": round(sum(r["loss_value"] for r in rows), 2),
            "extra_value": round(sum(r["extra_value"] for r in rows), 2),
            "net_value": round(sum(r["net_value"] for r in rows), 2),
            "count": sum(r["count"] for r in rows),
            "items": len(rows),
        }
        return {"start": s, "end": e, "rows": rows, "history": history, "totals": totals}

    @router.get("/meals/stock-take/list")
    async def stock_take_list(user: dict = Depends(require_chef_or_admin)):
        """List every date that has a saved stock-take, newest first, with a
        one-line summary (items counted, losses/extras, net ₹ value, who
        recorded, when). Powers the 'flip between stock takes' picker."""
        docs = await db.meal_adjustments.find(
            {}, {"_id": 0, "date": 1, "lines": 1, "updated_at": 1,
                 "updated_by_name": 1}).to_list(length=None)
        out = []
        for d in docs:
            lines = d.get("lines") or []
            if not lines:
                continue
            counted = len(lines)
            losses = extras = 0
            loss_value = extra_value = 0.0
            counters: dict[str, int] = {}
            for ln in lines:
                qty = float(ln.get("qty") or 0)
                rate = float(ln.get("avg_rate") or ln.get("rate") or 0)
                if qty < 0:
                    losses += 1
                    loss_value += -qty * rate
                elif qty > 0:
                    extras += 1
                    extra_value += qty * rate
                who = ln.get("by_name")
                if who:
                    counters[who] = counters.get(who, 0) + 1
            recorded_by = (d.get("updated_by_name")
                           or (max(counters, key=counters.get) if counters else None))
            out.append({
                "date": d["date"],
                "counted": counted,
                "losses": losses,
                "extras": extras,
                "loss_value": round(loss_value, 2),
                "extra_value": round(extra_value, 2),
                "net_value": round(extra_value - loss_value, 2),
                "recorded_by": recorded_by,
                "recorded_by_all": sorted(counters.keys()),
                "updated_at": d.get("updated_at"),
            })
        out.sort(key=lambda r: r["date"], reverse=True)
        return {"takes": out}




    @router.get("/meals/categories/{category_key}/summary")
    async def category_summary(
        category_key: str,
        start: Optional[str] = Query(None),
        end: Optional[str] = Query(None),
        user: dict = Depends(require_chef_or_admin),
    ):
        """Per-item purchase/issue/wastage totals for a category in a range."""
        cats = await _purchase_categories()
        cat = next((c for c in cats if c["key"] == category_key), None)
        if not cat:
            raise HTTPException(status_code=404, detail="Category not found")
        s, e = _range_or_default(start, end)
        items = await db.meal_items.find(
            {"category_key": category_key}, {"_id": 0},
        ).sort([("sort_order", 1), ("name", 1)]).to_list(500)
        ids = {i["id"] for i in items}
        per = {i["id"]: {"purchased_qty": 0.0, "purchased_amount": 0.0,
                         "issued_qty": 0.0, "wasted_qty": 0.0} for i in items}
        rng = {"date": {"$gte": s, "$lte": e}}
        spend = 0.0
        for doc in await db.meal_purchases.find(
                rng, {"_id": 0, "lines": 1, "amounts": 1}).to_list(1000):
            spend += float((doc.get("amounts") or {}).get(category_key) or 0)
            for line in doc.get("lines") or []:
                iid = line.get("item_id")
                if iid in ids:
                    per[iid]["purchased_qty"] += float(line.get("qty") or 0)
                    per[iid]["purchased_amount"] += float(line.get("amount") or 0)
        for coll, key in ((db.meal_issues, "issued_qty"),
                          (db.meal_wastage, "wasted_qty")):
            for doc in await coll.find(rng, {"_id": 0, "lines": 1}).to_list(1000):
                for line in doc.get("lines") or []:
                    iid = line.get("item_id")
                    if iid in ids:
                        per[iid][key] += float(line.get("qty") or 0)
        return {
            "category": cat, "start": s, "end": e, "spend": round(spend, 2),
            "items": [{
                "item_id": i["id"], "name": i["name"], "unit": i["unit"],
                "active": i.get("active", True),
                **{k: round(v, 4) for k, v in per[i["id"]].items()},
            } for i in items],
        }

    @router.get("/meals/consumption-check")
    async def consumption_check(
        start: Optional[str] = Query(None),
        end: Optional[str] = Query(None),
        tolerance: float = Query(0.2, ge=0.01, le=1.0),
        user: dict = Depends(require_chef_or_admin),
    ):
        """Compare issued qty vs meal counts × per-item norms, day by day.
        Only items with norm_per_serving > 0 participate."""
        s, e = _range_or_default(start, end)
        items = await db.meal_items.find(
            {"active": True, "norm_per_serving": {"$gt": 0}}, {"_id": 0},
        ).sort([("category_key", 1), ("sort_order", 1), ("name", 1)]).to_list(500)
        if not items:
            return {"start": s, "end": e, "tolerance": tolerance,
                    "items_with_norm": 0, "rows": [], "flagged": 0}

        servings: dict[str, int] = {}
        async for g in db.meal_records.aggregate([
            {"$match": {"date": {"$gte": s, "$lte": e}}},
            {"$group": {"_id": "$date", "n": {"$sum": 1}}},
        ]):
            servings[g["_id"]] = int(g["n"])

        issued: dict[tuple, float] = {}
        for doc in await db.meal_issues.find(
                {"date": {"$gte": s, "$lte": e}},
                {"_id": 0, "date": 1, "lines": 1}).to_list(2000):
            for line in doc.get("lines") or []:
                iid = line.get("item_id")
                if iid:
                    k = (doc["date"], iid)
                    issued[k] = issued.get(k, 0.0) + float(line.get("qty") or 0)

        dates = sorted({d for d in servings} | {d for d, _ in issued}, reverse=True)
        rows, flagged = [], 0
        for d in dates:
            n_serv = servings.get(d, 0)
            for it in items:
                norm = float(it.get("norm_per_serving") or 0)
                expected = round(norm * n_serv, 3)
                iq = round(issued.get((d, it["id"]), 0.0), 3)
                if expected == 0 and iq == 0:
                    continue
                diff = round(iq - expected, 3)
                if expected > 0:
                    pct = round(diff / expected * 100, 1)
                    flag = "over" if iq > expected * (1 + tolerance) else \
                           "under" if iq < expected * (1 - tolerance) else "ok"
                else:
                    pct = None
                    flag = "over"  # issued with zero servings recorded
                if flag != "ok":
                    flagged += 1
                rows.append({"date": d, "servings": n_serv, "item_id": it["id"],
                             "name": it["name"], "unit": it["unit"], "norm": norm,
                             "expected": expected, "issued": iq, "diff": diff,
                             "pct": pct, "flag": flag})
        return {"start": s, "end": e, "tolerance": tolerance,
                "items_with_norm": len(items), "rows": rows, "flagged": flagged}

    @router.get("/meals/reorder-suggestions")
    async def reorder_suggestions(user: dict = Depends(require_chef_or_admin)):
        """Shopping list: low items + items running out at their recent pace.
        Pace = (issues + wastage over last 30 days) / 30; suggestion covers
        the next 14 days plus the min level."""
        today = local_date_str(None)
        rows, _cats = await _stock_snapshot(today)
        s30 = (date.fromisoformat(today) - timedelta(days=29)).isoformat()
        cons: dict[str, float] = {}
        for coll in (db.meal_issues, db.meal_wastage):
            for doc in await coll.find(
                    {"date": {"$gte": s30, "$lte": today}},
                    {"_id": 0, "lines": 1}).to_list(2000):
                for line in doc.get("lines") or []:
                    iid = line.get("item_id")
                    if iid:
                        cons[iid] = cons.get(iid, 0.0) + float(line.get("qty") or 0)

        out = []
        for r in rows:
            rate = round(cons.get(r["item_id"], 0.0) / 30.0, 4)
            days_left = round(r["on_hand"] / rate, 1) if rate > 0 and r["on_hand"] > 0 \
                else (0.0 if rate > 0 else None)
            running_out = days_left is not None and days_left <= 7
            if not (r["low"] or running_out):
                continue
            if rate > 0:
                need = rate * 14 + r["min_stock"] - r["on_hand"]
            else:
                need = max(r["min_stock"] * 2 - r["on_hand"], r["min_stock"], 1.0)
            suggested = math.ceil(max(need, 0) * 10) / 10
            if suggested <= 0:
                continue
            reasons = []
            if r["low"]:
                reasons.append("Below min level" if r["min_stock"] > 0 else "Out of stock")
            if running_out:
                reasons.append(f"~{days_left:g} days left at current pace")
            out.append({
                "item_id": r["item_id"], "name": r["name"], "unit": r["unit"],
                "category_label": r["category_label"], "on_hand": r["on_hand"],
                "min_stock": r["min_stock"], "daily_rate": rate,
                "days_left": days_left, "suggested_qty": suggested,
                "reasons": reasons, "low": r["low"],
            })
        out.sort(key=lambda x: (not x["low"], x["days_left"] if x["days_left"] is not None else 999))
        return {"window_days": 30, "horizon_days": 14, "items": out}

    return {}
