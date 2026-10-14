"""Meals routes — purchases. Split out of routes/meals/__init__.py (Oct 2026); behaviour unchanged."""
from __future__ import annotations

from services.scope import athlete_like_keys
from routes.meals.common import (
    Depends,
    File,
    HTTPException,
    LinesPatchIn,
    MEAL_KEYS,
    MEAL_LABELS,
    MEAL_SHORT,
    PurchaseUpsertIn,
    UploadFile,
    _assert_qty_rate_sane,
    _norm_header,
    _parse_amount,
    _parse_any_date,
    date,
    now_utc,
    timedelta,
    uuid,
)


def register(router, *, _audit, _diff_meta, _line_diff, _not_future, _overhead_daily_map, _purchase_categories, _safe_date_upsert, _signal_meals, _stock_snapshot, _upsert_line_scoped, _valid_date, db, require_chef_or_admin):
    @router.put("/meals/purchases/{date_str}")
    async def upsert_purchase(
        date_str: str, body: PurchaseUpsertIn,
        user: dict = Depends(require_chef_or_admin),
    ):
        """Upsert one day's purchases.

        Two payload shapes:
          • **lines** — new items-based model. Each line:
              `{item_id, qty, rate}` (unit + name + category derived from
              item master). `amount = qty * rate` server-side. Existing
              lines for the date are REPLACED wholesale so the client can
              be a plain re-save.
          • **amounts** — legacy category-total map (bulk CSV path).
            Preserved for backward compat; overwrites the summary field
            only, does not touch `lines`.

        Either way, `amounts` (the derived category totals) is kept in
        sync so the expense report keeps working with zero changes.
        """
        d = _not_future(_valid_date(date_str))
        stamp = {
            "updated_at": now_utc().isoformat(),
            "updated_by": user.get("id"),
            "updated_by_name": user.get("full_name") or user.get("email"),
        }

        if body.lines is not None:
            # Resolve item master once for validation + hydration.
            _prev_p = await db.meal_purchases.find_one({"date": d}, {"_id": 0, "lines": 1})
            item_ids = [str(l.get("item_id") or "") for l in body.lines if l.get("item_id")]
            items = await db.meal_items.find(
                {"id": {"$in": item_ids}}, {"_id": 0},
            ).to_list(len(item_ids) or 1)
            by_id = {i["id"]: i for i in items}

            clean_lines: list[dict] = []
            amounts: dict[str, float] = {}
            for raw in body.lines:
                iid = str(raw.get("item_id") or "").strip()
                item = by_id.get(iid)
                if not item:
                    raise HTTPException(status_code=400,
                                        detail=f"Unknown item_id: {iid or '(blank)'}")
                qty = _parse_amount(raw.get("qty"))
                rate = _parse_amount(raw.get("rate"))
                if qty is None or qty <= 0:
                    continue  # blank/zero lines silently dropped
                if rate is None or rate <= 0:
                    raise HTTPException(status_code=400,
                                        detail=f"Rate for '{item['name']}' must be greater than ₹0 — a quantity was entered without a price")
                _assert_qty_rate_sane(item["name"], qty, rate)
                amount = round(qty * rate, 2)
                clean_lines.append({
                    "id": str(raw.get("id") or uuid.uuid4()),
                    "item_id": iid,
                    "item_name": item.get("name"),
                    "category_key": item.get("category_key"),
                    "qty": round(qty, 4),
                    "unit": item.get("unit"),
                    "rate": round(rate, 2),
                    "amount": amount,
                    # Optional supplier attribution (Aug 2026). Blank string
                    # / missing / null → stored as None so filters and the
                    # audit UI can distinguish "no vendor" from "vendor X".
                    "vendor_id": (str(raw.get("vendor_id")).strip() or None)
                                 if raw.get("vendor_id") is not None else None,
                })
                cat = item.get("category_key") or "other"
                amounts[cat] = round(amounts.get(cat, 0.0) + amount, 2)

            await _safe_date_upsert(
                db.meal_purchases,
                {"date": d},
                {"$set": {"date": d, "lines": clean_lines,
                          "amounts": amounts, **stamp},
                 "$setOnInsert": {"id": str(uuid.uuid4())}},
            )
            await _signal_meals("purchases", d)
            _diff = _line_diff((_prev_p or {}).get("lines"), clean_lines, "purchase")
            await _audit(user, "meals.purchase.save", "meal_purchase", d, f"Purchases {d}", meta=_diff_meta(d, _diff))
            return {"date": d, "lines": clean_lines, "amounts": amounts,
                    "total": round(sum(amounts.values()), 2)}

        # ── Legacy amounts-map path ────────────────────────────────────
        amounts: dict[str, float] = {}
        for k, v in (body.amounts or {}).items():
            amt = _parse_amount(v)
            if amt is None:
                continue
            if amt < 0:
                raise HTTPException(status_code=400, detail=f"Amount for '{k}' cannot be negative")
            if amt > 0:
                amounts[str(k)] = round(amt, 2)
        await _safe_date_upsert(
            db.meal_purchases,
            {"date": d},
            {"$set": {"date": d, "amounts": amounts, **stamp},
             "$setOnInsert": {"id": str(uuid.uuid4())}},
        )
        await _signal_meals("purchases", d)
        await _audit(user, "meals.purchase.save", "meal_purchase", d, f"Purchases {d}")
        return {"date": d, "amounts": amounts,
                "total": round(sum(amounts.values()), 2)}

    @router.patch("/meals/purchases/{date_str}")
    async def patch_purchase_lines(
        date_str: str, body: LinesPatchIn,
        user: dict = Depends(require_chef_or_admin),
    ):
        """Merge ONLY the edited lines into the day's purchases doc — each
        item updated atomically (positional $set / $push / $pull) so
        concurrent machines editing different items never clash. The
        derived `amounts` category totals are recomputed from the merged
        doc afterwards so the expense report stays consistent."""
        d = _not_future(_valid_date(date_str))
        _prev_p = await db.meal_purchases.find_one({"date": d}, {"_id": 0, "lines": 1})
        item_ids = [str(l.get("item_id") or "") for l in body.upserts if l.get("item_id")]
        items = await db.meal_items.find(
            {"id": {"$in": item_ids}}, {"_id": 0},
        ).to_list(len(item_ids) or 1)
        by_id = {i["id"]: i for i in items}
        await _safe_date_upsert(
            db.meal_purchases,
            {"date": d},
            {"$setOnInsert": {"id": str(uuid.uuid4()), "date": d,
                              "lines": [], "amounts": {}}},
        )
        removes = [str(r) for r in body.removes]
        for raw in body.upserts:
            iid = str(raw.get("item_id") or "").strip()
            item = by_id.get(iid)
            if not item:
                raise HTTPException(status_code=400,
                                    detail=f"Unknown item_id: {iid or '(blank)'}")
            qty = _parse_amount(raw.get("qty"))
            rate = _parse_amount(raw.get("rate"))
            if qty is None or qty <= 0:
                removes.append(iid)
                continue
            if rate is None or rate <= 0:
                raise HTTPException(status_code=400,
                                    detail=f"Rate for '{item['name']}' must be greater than ₹0 — a quantity was entered without a price")
            _assert_qty_rate_sane(item["name"], qty, rate)
            line = {
                "id": str(uuid.uuid4()),
                "item_id": iid,
                "item_name": item.get("name"),
                "category_key": item.get("category_key"),
                "qty": round(qty, 4),
                "unit": item.get("unit"),
                "rate": round(rate, 2),
                "amount": round(qty * rate, 2),
                "vendor_id": (str(raw.get("vendor_id")).strip() or None)
                             if raw.get("vendor_id") is not None else None,
            }
            await _upsert_line_scoped(db.meal_purchases, d, line)
        for iid in removes:
            await db.meal_purchases.update_one(
                {"date": d}, {"$pull": {"lines": {"item_id": iid}}})

        doc = await db.meal_purchases.find_one({"date": d}, {"_id": 0}) or {}
        amounts: dict[str, float] = {}
        for ln in (doc.get("lines") or []):
            cat = ln.get("category_key") or "other"
            amounts[cat] = round(amounts.get(cat, 0.0) + float(ln.get("amount") or 0), 2)
        await db.meal_purchases.update_one({"date": d}, {"$set": {
            "amounts": amounts,
            "updated_at": now_utc().isoformat(),
            "updated_by": user.get("id"),
            "updated_by_name": user.get("full_name") or user.get("email"),
        }})
        await _signal_meals("purchases", d)
        _diff = _line_diff((_prev_p or {}).get("lines"), doc.get("lines"), "purchase")
        await _audit(user, "meals.purchase.edit", "meal_purchase", d, f"Purchases {d}", meta=_diff_meta(d, _diff))
        return {"date": d, "lines": doc.get("lines") or [], "amounts": amounts,
                "total": round(sum(amounts.values()), 2)}

    @router.post("/meals/purchases/bulk-upload")
    async def bulk_upload_purchases(
        file: UploadFile = File(...),
        user: dict = Depends(require_chef_or_admin),
    ):
        """Import daily purchase amounts from a spreadsheet (CSV or XLSX).

        Expected layout: first column = date, remaining columns matched
        against the configured purchase categories by fuzzy header
        (case/punctuation-insensitive — "CHICKEN/ MUTTON" matches
        "Chicken/Mutton"). Dates accept ISO or day-first formats
        (1/7/2026 = 1 July). Amounts may contain commas. Existing dates
        are merged (only uploaded columns overwritten)."""
        name = (file.filename or "").lower()
        content = await file.read()
        if len(content) > 5 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="File too large (max 5 MB)")

        rows: list[list] = []
        if name.endswith(".csv"):
            import csv as _csv
            import io as _io
            try:
                text = content.decode("utf-8-sig")
            except UnicodeDecodeError:
                text = content.decode("latin-1")
            rows = [r for r in _csv.reader(_io.StringIO(text))]
        elif name.endswith(".xlsx"):
            import io as _io
            from openpyxl import load_workbook
            try:
                wb = load_workbook(_io.BytesIO(content), read_only=True, data_only=True)
            except Exception:
                raise HTTPException(status_code=400, detail="Could not read the Excel file — is it a valid .xlsx?")
            ws = wb.active
            rows = [list(r) for r in ws.iter_rows(values_only=True)]
            wb.close()
        else:
            raise HTTPException(status_code=400, detail="Upload a .csv or .xlsx file")

        # Locate the header row: first row containing a cell that maps
        # to a known category OR literally "date".
        cats = await _purchase_categories()
        norm_to_key = {}
        for c in cats:
            norm_to_key[_norm_header(c["key"])] = c["key"]
            norm_to_key[_norm_header(c["label"])] = c["key"]

        header_idx, col_map, date_col = None, {}, 0
        for i, r in enumerate(rows[:10]):
            hits = {}
            dcol = None
            for j, cell in enumerate(r or []):
                n = _norm_header(str(cell)) if cell is not None else ""
                if not n:
                    continue
                if n == "date":
                    dcol = j
                elif n in norm_to_key:
                    hits[j] = norm_to_key[n]
            if hits:
                header_idx, col_map = i, hits
                date_col = dcol if dcol is not None else 0
                break
        if header_idx is None:
            raise HTTPException(
                status_code=400,
                detail="No recognisable header row — need a 'Date' column plus at least one "
                       "column matching a purchase category "
                       f"({', '.join(c['label'] for c in cats)}).",
            )
        unmatched = []
        header_row = rows[header_idx] or []
        for j, cell in enumerate(header_row):
            if j == date_col or j in col_map or cell is None:
                continue
            n = _norm_header(str(cell))
            if n and n != "date":
                unmatched.append(str(cell).strip())

        imported_dates, skipped, errors = [], 0, []
        now_iso = now_utc().isoformat()
        for r in rows[header_idx + 1:]:
            if not r:
                continue
            d = _parse_any_date(r[date_col] if date_col < len(r) else None)
            if not d:
                raw = str(r[date_col] if date_col < len(r) else "").strip().lower()
                has_amounts = any(
                    _parse_amount(r[j]) not in (None, 0.0)
                    for j in col_map if j < len(r)
                )
                # Footer rows ("TOTAL", "Grand total", …) are expected in
                # accountant sheets — skip silently even with amounts.
                if has_amounts and "total" not in raw:
                    errors.append(f"Row skipped — unreadable date: {r[date_col] if date_col < len(r) else ''!r}")
                skipped += 1
                continue
            sets = {}
            for j, key in col_map.items():
                amt = _parse_amount(r[j] if j < len(r) else None)
                if amt is None or amt == 0:
                    continue
                if amt < 0:
                    errors.append(f"{d}: negative amount ignored for {key}")
                    continue
                sets[f"amounts.{key}"] = round(amt, 2)
            if not sets:
                skipped += 1
                continue
            await _safe_date_upsert(
                db.meal_purchases,
                {"date": d},
                {"$set": {**sets, "date": d,
                          "updated_at": now_iso,
                          "updated_by": user.get("id"),
                          "updated_by_name": user.get("full_name") or user.get("email"),
                          "source": "bulk_upload"},
                 "$setOnInsert": {"id": str(uuid.uuid4())}},
            )
            imported_dates.append(d)

        cats_by_key = {c["key"]: c["label"] for c in cats}
        if imported_dates:
            await _signal_meals("purchases")
        return {
            "imported_days": len(imported_dates),
            "dates": sorted(imported_dates),
            "skipped_rows": skipped,
            "matched_columns": [cats_by_key.get(k, k)
                                for k in sorted({v for v in col_map.values()})],
            "unmatched_columns": unmatched,
            "errors": errors[:20],
        }

    @router.get("/meals/expense-report")
    async def meal_expense_report(
        start: str, end: str, user: dict = Depends(require_chef_or_admin)
    ):
        """Accountant-style report: per-day meal counts split into
        Athletes vs Staff (B/F, Lunch, Snacks, Dinner), daily meal
        total, purchase spend per category, and grand totals with
        average cost per meal."""
        s, e = _valid_date(start), _valid_date(end)
        if s > e:
            raise HTTPException(status_code=400, detail="start must be before end")
        s_d, e_d = date.fromisoformat(s), date.fromisoformat(e)
        if (e_d - s_d).days > 370:
            raise HTTPException(status_code=400, detail="Range too large (max 1 year)")

        athlete_like = set(await athlete_like_keys(db))

        recs = await db.meal_records.find(
            {"date": {"$gte": s, "$lte": e}},
            {"_id": 0, "date": 1, "meal": 1, "category": 1},
        ).to_list(200000)
        purchases = await db.meal_purchases.find(
            {"date": {"$gte": s, "$lte": e}}, {"_id": 0},
        ).to_list(400)
        cats = await _purchase_categories()
        cat_keys = [c["key"] for c in cats]
        # Surface orphan keys (category deleted after data existed) so
        # historic money never silently disappears from totals.
        for p in purchases:
            for k in (p.get("amounts") or {}):
                if k not in cat_keys:
                    cat_keys.append(k)
                    cats.append({"key": k, "label": k.replace("_", " ").title(),
                                 "orphan": True})

        counts: dict[str, dict[str, dict[str, int]]] = {}
        for r in recs:
            m = (r.get("meal") or "").lower()
            if m not in MEAL_KEYS:
                continue
            grp = "athletes" if (r.get("category") in athlete_like) else "staff"
            counts.setdefault(r["date"], {}) \
                  .setdefault(grp, {k: 0 for k in MEAL_KEYS})[m] += 1
        purch_by_date = {p["date"]: (p.get("amounts") or {}) for p in purchases}

        def _grp(day_iso: str, grp: str) -> dict:
            g = counts.get(day_iso, {}).get(grp) or {k: 0 for k in MEAL_KEYS}
            return {**g, "total": sum(g.values())}

        days_out = []
        overhead_map = await _overhead_daily_map(s, e)
        overhead_total = 0.0
        tot_grp = {"athletes": {k: 0 for k in MEAL_KEYS},
                   "staff":    {k: 0 for k in MEAL_KEYS}}
        tot_purch = {k: 0.0 for k in cat_keys}
        cur = s_d
        while cur <= e_d:
            iso = cur.isoformat()
            a, st = _grp(iso, "athletes"), _grp(iso, "staff")
            amounts = purch_by_date.get(iso, {})
            day_expense = round(sum(float(v or 0) for v in amounts.values()), 2)
            day_overhead = round(overhead_map.get(iso, 0.0), 2)
            overhead_total += day_overhead
            days_out.append({
                "date": iso,
                "athletes": a,
                "staff": st,
                "meal_count": a["total"] + st["total"],
                "purchases": {k: amounts.get(k) for k in cat_keys if amounts.get(k)},
                "expense_total": day_expense,
                # Apportioned kitchen wage bill for the day + fully-loaded total.
                "overhead": day_overhead,
                "total_expense": round(day_expense + day_overhead, 2),
            })
            for k in MEAL_KEYS:
                tot_grp["athletes"][k] += a[k]
                tot_grp["staff"][k] += st[k]
            for k, v in amounts.items():
                if k in tot_purch:
                    tot_purch[k] += float(v or 0)
            cur += timedelta(days=1)

        tot_a = sum(tot_grp["athletes"].values())
        tot_s = sum(tot_grp["staff"].values())
        total_meals = tot_a + tot_s
        total_expenses = round(sum(tot_purch.values()), 2)
        overhead_total = round(overhead_total, 2)
        expenses_with_overhead = round(total_expenses + overhead_total, 2)

        # Item-wise breakdown (Feb 2026 user request) — piggy-backs on
        # the same date-range so the accountant can drill from category
        # totals down to individual item qty × ₹ for purchases AND
        # issues. Issues are valued at each item's weighted-avg purchase
        # rate over the same window (fall-back: current stock snapshot).
        items_master = await db.meal_items.find(
            {}, {"_id": 0, "id": 1, "name": 1, "unit": 1, "category_key": 1},
        ).to_list(2000)
        item_by_id = {i["id"]: i for i in items_master}
        purch_docs_ext = await db.meal_purchases.find(
            {"date": {"$gte": s, "$lte": e}},
            {"_id": 0, "lines": 1},
        ).to_list(5000)
        iss_docs_ext = await db.meal_issues.find(
            {"date": {"$gte": s, "$lte": e}},
            {"_id": 0, "lines": 1},
        ).to_list(5000)
        p_qty: dict[str, float] = {}
        p_amt: dict[str, float] = {}
        p_lines: dict[str, int] = {}
        for doc in purch_docs_ext:
            for ln in (doc.get("lines") or []):
                iid = ln.get("item_id")
                q = float(ln.get("qty") or 0)
                r = float(ln.get("rate") or 0)
                if not iid or q <= 0:
                    continue
                p_qty[iid] = p_qty.get(iid, 0.0) + q
                p_amt[iid] = p_amt.get(iid, 0.0) + q * r
                p_lines[iid] = p_lines.get(iid, 0) + 1
        snap_rows2, _ = await _stock_snapshot(e, include_inactive=True)
        snap_rate2 = {r["item_id"]: float(r.get("avg_rate") or 0) for r in snap_rows2}

        def _rate_for2(iid: str) -> float:
            if p_qty.get(iid, 0) > 0:
                return p_amt[iid] / p_qty[iid]
            return snap_rate2.get(iid, 0.0)

        i_qty: dict[str, float] = {}
        i_amt: dict[str, float] = {}
        i_lines: dict[str, int] = {}
        for doc in iss_docs_ext:
            for ln in (doc.get("lines") or []):
                iid = ln.get("item_id")
                q = float(ln.get("qty") or 0)
                if not iid or q <= 0:
                    continue
                i_qty[iid] = i_qty.get(iid, 0.0) + q
                i_amt[iid] = i_amt.get(iid, 0.0) + q * _rate_for2(iid)
                i_lines[iid] = i_lines.get(iid, 0) + 1

        def _mk_item_rows(qty_map: dict, amt_map: dict, lines_map: dict) -> list:
            rows = []
            for iid in qty_map:
                info = item_by_id.get(iid) or {}
                rows.append({
                    "item_id": iid,
                    "name": info.get("name") or "(deleted item)",
                    "unit": info.get("unit"),
                    "category_key": info.get("category_key"),
                    "qty": round(qty_map.get(iid, 0.0), 3),
                    "amount": round(amt_map.get(iid, 0.0), 2),
                    "lines": lines_map.get(iid, 0),
                })
            rows.sort(key=lambda r: r["amount"], reverse=True)
            return rows

        item_purchases = _mk_item_rows(p_qty, p_amt, p_lines)
        item_issues = _mk_item_rows(i_qty, i_amt, i_lines)
        item_purchases_total = round(sum(r["amount"] for r in item_purchases), 2)
        item_issues_total = round(sum(r["amount"] for r in item_issues), 2)
        # Bulk-uploaded / legacy purchases carry only category `amounts`,
        # not per-item `lines`. Surface the gap so the itemised total and
        # the report's grand total can be reconciled by the accountant.
        unitemised_purchases_amount = round(max(0.0, total_expenses - item_purchases_total), 2)

        return {
            "start": s, "end": e,
            "categories": cats,
            "meals": [{"key": k, "label": MEAL_LABELS[k], "short": MEAL_SHORT[k]}
                      for k in MEAL_KEYS],
            "days": days_out,
            "item_purchases": item_purchases,
            "item_issues": item_issues,
            "item_purchases_total": item_purchases_total,
            "item_issues_total": item_issues_total,
            "unitemised_purchases_amount": unitemised_purchases_amount,
            "totals": {
                "athletes": {**tot_grp["athletes"], "total": tot_a},
                "staff":    {**tot_grp["staff"],    "total": tot_s},
                "meal_count": total_meals,
                "purchases": {k: round(v, 2) for k, v in tot_purch.items()},
                "expenses": total_expenses,
                "avg_cost_per_meal": round(total_expenses / total_meals, 2) if total_meals else None,
                # Kitchen wage-bill overhead apportioned into this range, and
                # the fully-loaded cost per meal (food + overhead). The
                # existing `avg_cost_per_meal` stays FOOD-ONLY for backward
                # compatibility; new fields carry the loaded figures.
                "overhead_total": overhead_total,
                "expenses_with_overhead": expenses_with_overhead,
                "food_cost_per_meal": round(total_expenses / total_meals, 2) if total_meals else None,
                "overhead_cost_per_meal": round(overhead_total / total_meals, 2) if total_meals else None,
                "total_cost_per_meal": round(expenses_with_overhead / total_meals, 2) if total_meals else None,
            },
        }

    return {}
