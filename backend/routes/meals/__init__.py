"""Chef's View — meal-planning endpoint + Categories master read.

Two related things live here because they ship together:

  • GET /api/masters/categories  — returns the 5 seeded categories
    (athlete, elite, coach, staff, executive) with their colors and
    labels. Powers the Members-form dropdown so admins can start
    tagging Elites.

  • GET /api/admin/meals-today   — the Chef's View aggregator. Lists
    every member who checked in BEFORE the meal cut-off today, grouped
    by category, with photo + name for a printable drill-down. The chef
    plans the day's meal count from this.

Cut-off defaults to 07:00 office-local time — the sailing academy's
morning meal window — but is overridable via `?cutoff=HH:MM` for
lunch/dinner variations.
"""
from __future__ import annotations

from routes.meals.common import (  # noqa: F401
    asyncio,
    json,
    logging,
    math,
    uuid,
    date,
    datetime,
    timedelta,
    List,
    Optional,
    jwt,
    APIRouter,
    Depends,
    File,
    HTTPException,
    Query,
    UploadFile,
    StreamingResponse,
    JWT_ALGO,
    JWT_SECRET,
    current_client_id,
    BaseModel,
    Field,
    DuplicateKeyError,
    local_date_str,
    local_now,
    now_utc,
    office_tz,
    member_photo_url,
    is_ex_member,
    is_super_admin,
    _scoped_user_query_shared,
    _nutri_lookup,
    _qty_to_grams,
    MAX_USERS,
    logger,
    DEFAULT_MEAL_CUTOFF,
    DEFAULT_LUNCH_CUTOFF,
    DEFAULT_DINNER_CUTOFF,
    SEEDED_CATEGORY_KEYS,
    VALID_COLORS,
    MEAL_KEYS,
    MEAL_LABELS,
    MEAL_SHORT,
    PURCHASE_CFG_ID,
    DEFAULT_PURCHASE_CATEGORIES,
    VALID_UNITS,
    _slug_key,
    _norm_header,
    _parse_any_date,
    _parse_amount,
    PurchaseCategoryItem,
    PurchaseCategoriesIn,
    PurchaseUpsertIn,
    ItemIn,
    ItemPatch,
    ItemsReorderIn,
    SubcatIn,
    SubcatPatch,
    IssuesUpsertIn,
    LinesPatchIn,
    VendorIn,
    VendorPatch,
    VALID_WASTAGE_REASONS,
    WastageUpsertIn,
    StockTakeIn,
    MealMarkIn,
    CategoryIn,
    CategoryPatch,
    _valid_hm,
    _parse_hm,
    _earliest_check_in_before,
    _covering_session_check_in,
    _weighted_rate_lookup,
    _kitchen_daily_series,
    _kitchen_item_rows,
    _kitchen_cat_pct,
    OverheadIn,
    OverheadBackfillIn,
)
from routes.meals.muster import register as _reg_muster
from routes.meals.vendors import register as _reg_vendors
from routes.meals.items import register as _reg_items
from routes.meals.stock import register as _reg_stock
from routes.meals.stock_take import register as _reg_stock_take
from routes.meals.purchases import register as _reg_purchases
from routes.meals.analytics import register as _reg_analytics
from routes.meals.calendar import register as _reg_calendar
from routes.meals.auto_issue import register as _reg_auto_issue


def make_router(db, require_admin, get_current_user, require_chef_or_admin=None, write_audit=None) -> APIRouter:
    router = APIRouter(prefix="/api")
    # Fallback so tests that don't pass the chef dep still work — treat
    # chef-or-admin as admin-only. Production wires the real dep from
    # server.py. Added 4 Feb 2026 with the Roles master.
    if require_chef_or_admin is None:
        require_chef_or_admin = require_admin

    async def _audit(actor, action, entity_type, entity_id,
                     entity_name=None, before=None, after=None, meta=None):
        """Kitchen audit trail (Jun 2026). Best-effort passthrough to the
        shared write_audit → `audit_log` collection; no-op if not wired
        (e.g. in unit tests). All kitchen actions are namespaced `meals.*`
        so the Kitchen Audit Log can query them as one stream."""
        if not write_audit:
            return
        try:
            await write_audit(
                db, actor=actor or {}, action=action, entity_type=entity_type,
                entity_id=str(entity_id), entity_name=entity_name,
                before=before, after=after, meta=meta,
            )
        except Exception:
            pass

    def _round_cmp(v):
        try:
            return round(float(v), 4)
        except (TypeError, ValueError):
            return v

    def _line_diff(before_lines, after_lines, kind):
        """Per-item change list between a day's old and new `lines`, so the
        Kitchen Audit Log can show EXACTLY what changed. Returns
        [{item, unit, type: added|changed|removed, fields:{f:{before,after}}}].
        Added Jun 2026."""
        fields = {
            "purchase": ["qty", "rate", "amount", "vendor_id"],
            "issue":    ["qty"],
            "wastage":  ["qty", "reason", "notes"],
        }.get(kind, ["qty"])

        def _key(l):
            return str((l or {}).get("item_id") or (l or {}).get("item_name") or "")

        b = {_key(l): l for l in (before_lines or []) if _key(l)}
        a = {_key(l): l for l in (after_lines or []) if _key(l)}
        out = []
        for k in set(b) | set(a):
            bl, al = b.get(k), a.get(k)
            ref = al or bl
            name = ref.get("item_name") or ref.get("item_id")
            unit = ref.get("unit") or ""
            if bl and not al:
                fld = {f: {"before": bl.get(f), "after": None}
                       for f in fields if bl.get(f) not in (None, "", 0)}
                out.append({"item": name, "unit": unit, "type": "removed", "fields": fld})
            elif al and not bl:
                fld = {f: {"before": None, "after": al.get(f)}
                       for f in fields if al.get(f) not in (None, "", 0)}
                out.append({"item": name, "unit": unit, "type": "added", "fields": fld})
            else:
                fld = {}
                for f in fields:
                    if _round_cmp(bl.get(f)) != _round_cmp(al.get(f)):
                        fld[f] = {"before": bl.get(f), "after": al.get(f)}
                if fld:
                    out.append({"item": name, "unit": unit, "type": "changed", "fields": fld})
        out.sort(key=lambda x: (str(x.get("item") or "")).lower())
        return out

    def _diff_meta(d, diff):
        counts = {"added": 0, "changed": 0, "removed": 0}
        for c in diff:
            counts[c["type"]] = counts.get(c["type"], 0) + 1
        return {"date": d, "changes": diff, "counts": counts}

    async def _require_super_admin(user: dict = Depends(require_admin)):
        if not is_super_admin(user):
            raise HTTPException(status_code=403, detail="Super Admin privileges required")
        return user

    def _valid_month(m: str) -> str:
        import re as _re
        if not _re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", m or ""):
            raise HTTPException(status_code=400, detail="month must be YYYY-MM (e.g. 2026-09)")
        return m

    def _days_in_month(mk: str) -> int:
        import calendar as _cal
        return _cal.monthrange(int(mk[:4]), int(mk[5:7]))[1]

    async def _overhead_daily_map(s: str, e: str) -> dict:
        """{iso_date: apportioned_overhead_₹} for [s,e]. Each month's total
        (wages + incidentals) is spread EQUALLY across that month's days,
        so any date range — daily, weekly, custom — gets a fair share."""
        docs = await db.meal_overheads.find(
            {"month": {"$gte": s[:7], "$lte": e[:7]}}, {"_id": 0},
        ).to_list(400)
        tot_by_month = {
            d["month"]: float(d.get("staff_wages") or 0) + float(d.get("incidentals") or 0)
            for d in docs
        }
        out: dict = {}
        cur, e_d = date.fromisoformat(s), date.fromisoformat(e)
        while cur <= e_d:
            mk = cur.isoformat()[:7]
            total = tot_by_month.get(mk, 0.0)
            out[cur.isoformat()] = (total / _days_in_month(mk)) if total else 0.0
            cur += timedelta(days=1)
        return out

    def _overhead_total_row(d: dict) -> dict:
        d = {**d}
        d["total"] = round(float(d.get("staff_wages") or 0) + float(d.get("incidentals") or 0), 2)
        return d

    # ── Data red flags (Jun 2026) ────────────────────────────────────
    # Surfaced on the Daily-entry screen and the Consumption table so
    # gaps are caught AT ENTRY TIME. All flags WARN, never block.
    _MAIN_MEALS = ("breakfast", "lunch", "dinner")
    _MAIN_LABELS = {"breakfast": "breakfast", "lunch": "lunch", "dinner": "dinner"}

    async def _effective_meal_counts(d: str) -> tuple[dict, Optional[str]]:
        """Headcount per meal for one day. A manual/spreadsheet row in
        meal_daily_counts wins; otherwise distinct-user counts from the
        Meal Muster (meal_records)."""
        row = await db.meal_daily_counts.find_one({"date": d}, {"_id": 0})
        if row:
            return ({k: int(row.get(k) or 0) for k in MEAL_KEYS},
                    row.get("source") or "manual")
        out = {k: 0 for k in MEAL_KEYS}
        async for g in db.meal_records.aggregate([
            {"$match": {"date": d}},
            {"$group": {"_id": "$meal", "users": {"$addToSet": "$user_id"}}},
        ]):
            m = (g["_id"] or "").lower()
            if m in out:
                out[m] = len([u for u in g["users"] if u])
        return out, ("muster" if any(out.values()) else None)

    async def _compute_day_flags(d: str) -> list[dict]:
        """Full red-flag set for a single day (used by /meals/day-flags on
        the Daily-entry screen). Each flag: {severity, code, message}."""
        flags: list[dict] = []
        counts, _src = await _effective_meal_counts(d)
        any_meal = any(counts.values())
        missing_main = [k for k in _MAIN_MEALS if counts.get(k, 0) <= 0]

        iss = await db.meal_issues.find_one({"date": d}, {"_id": 0, "lines": 1})
        pur = await db.meal_purchases.find_one({"date": d}, {"_id": 0, "lines": 1})
        iss_lines = [l for l in ((iss or {}).get("lines") or []) if float(l.get("qty") or 0) > 0]
        pur_lines = (pur or {}).get("lines") or []
        has_issues = bool(iss_lines)
        has_purch = any(float(l.get("qty") or 0) > 0 for l in pur_lines)

        # 🔴 Missing main meal(s) / no headcount at all
        if len(missing_main) == 3 and has_issues:
            flags.append({"severity": "high", "code": "no_headcount",
                          "message": "Stock was consumed but no meal headcount was entered for the day"})
        elif 0 < len(missing_main) < 3 and (any_meal or has_issues):
            names = " / ".join(_MAIN_LABELS[k] for k in missing_main)
            flags.append({"severity": "high", "code": "missing_main_meal",
                          "message": f"No {names} headcount recorded"})

        # 🟠 Meals recorded but nothing consumed
        if any_meal and not has_issues and not has_purch:
            flags.append({"severity": "medium", "code": "counts_no_consumption",
                          "message": "Meals were recorded but no kitchen consumption was entered"})

        # Item-level checks need stock context (rate + on-hand)
        if iss_lines:
            prev = (date.fromisoformat(d) - timedelta(days=1)).isoformat()
            snap_prev, _ = await _stock_snapshot(prev, include_inactive=True)
            snap_day, _ = await _stock_snapshot(d, include_inactive=True)
            onhand_prev = {r["item_id"]: r["on_hand"] for r in snap_prev}
            rate_day = {r["item_id"]: r["avg_rate"] for r in snap_day}
            name_day = {r["item_id"]: r["name"] for r in snap_day}
            # Same-day purchases add to what's available to issue that day —
            # buying and consuming an item on the same date is normal (fresh
            # chicken, veg) and must NOT be flagged as negative stock.
            purchased_today: dict[str, float] = {}
            for l in pur_lines:
                pid = l.get("item_id")
                if pid:
                    purchased_today[pid] = purchased_today.get(pid, 0.0) + float(l.get("qty") or 0)
            for l in iss_lines:
                iid = l.get("item_id"); q = float(l.get("qty") or 0)
                if not iid:
                    continue
                nm = name_day.get(iid, "An item")
                if rate_day.get(iid, 0) <= 0:
                    flags.append({"severity": "medium", "code": "issue_no_price",
                                  "message": f"{nm}: consumed but never purchased — no price to value it"})
                avail = onhand_prev.get(iid, 0.0) + purchased_today.get(iid, 0.0)
                if q > avail + 1e-6:
                    flags.append({"severity": "medium", "code": "negative_stock",
                                  "message": f"{nm}: issued {q:g} {l.get('unit') or ''}".rstrip() + f" but only {avail:g} on hand"})

        # 🟠 Purchase row with qty but ₹0 rate/amount
        for l in pur_lines:
            q = float(l.get("qty") or 0)
            amt = float(l.get("amount") or (q * float(l.get("rate") or 0)))
            if q > 0 and amt <= 0:
                flags.append({"severity": "medium", "code": "purchase_zero_rate",
                              "message": "A purchase line has a quantity but ₹0 rate/amount"})
                break

        # 🟠 Headcount outlier vs the trailing 28-day average
        base_start = (date.fromisoformat(d) - timedelta(days=28)).isoformat()
        hist = await db.meal_daily_counts.find(
            {"date": {"$gte": base_start, "$lt": d}}, {"_id": 0}).to_list(60)
        if len(hist) >= 5:
            for k in _MAIN_MEALS:
                vals = [int(h.get(k) or 0) for h in hist if int(h.get(k) or 0) > 0]
                if len(vals) >= 5 and counts.get(k, 0) > 0:
                    mean = sum(vals) / len(vals)
                    if mean > 0 and abs(counts[k] - mean) / mean > 0.25:
                        arrow = "above" if counts[k] > mean else "below"
                        flags.append({"severity": "medium", "code": "headcount_outlier",
                                      "message": f"{_MAIN_LABELS[k].title()} count {counts[k]} is {arrow} the recent average (~{round(mean)})"})
        return flags

    @router.get("/meals/day-flags")
    async def meal_day_flags(date: str, user: dict = Depends(require_chef_or_admin)):  # noqa: A002
        """All data red flags for one day — powers the Daily-entry banner."""
        d = _valid_date(date)
        flags = await _compute_day_flags(d)
        return {"date": d, "flags": flags,
                "high": sum(1 for f in flags if f["severity"] == "high"),
                "medium": sum(1 for f in flags if f["severity"] == "medium")}


    @router.get("/meals/overheads")
    async def list_overheads(user: dict = Depends(require_chef_or_admin)):
        """All monthly kitchen-overhead entries (view: chef/admin).
        `can_edit` is True only for Super Admins."""
        docs = await db.meal_overheads.find({}, {"_id": 0}).sort("month", -1).to_list(400)
        return {"overheads": [_overhead_total_row(d) for d in docs],
                "can_edit": is_super_admin(user)}

    @router.get("/meals/overheads/{month}")
    async def get_overhead(month: str, user: dict = Depends(require_chef_or_admin)):
        _valid_month(month)
        d = await db.meal_overheads.find_one({"month": month}, {"_id": 0})
        if not d:
            return {"month": month, "staff_wages": 0, "incidentals": 0,
                    "note": None, "total": 0, "can_edit": is_super_admin(user)}
        d = _overhead_total_row(d)
        d["can_edit"] = is_super_admin(user)
        return d

    @router.put("/meals/overheads/{month}")
    async def upsert_overhead(month: str, body: OverheadIn,
                              user: dict = Depends(_require_super_admin)):
        _valid_month(month)
        doc = {
            "month": month,
            "staff_wages": round(body.staff_wages, 2),
            "incidentals": round(body.incidentals, 2),
            "note": (body.note or None),
            "updated_by": user.get("full_name") or user.get("id"),
            "updated_at": now_utc().isoformat(),
        }
        await db.meal_overheads.update_one({"month": month}, {"$set": doc}, upsert=True)
        return _overhead_total_row(doc)

    @router.post("/meals/overheads/backfill")
    async def backfill_overheads(body: OverheadBackfillIn,
                                 user: dict = Depends(_require_super_admin)):
        """Seed a default monthly wage bill for every month that already has
        meal data but no overhead entry. Idempotent — skips months that
        already have a value unless `overwrite` is set."""
        import re as _re
        _MONTH_RE = _re.compile(r"^20\d{2}-(0[1-9]|1[0-2])$")
        # Meal data lives across several collections: per-person Muster
        # marks (meal_records), manual/spreadsheet headcounts
        # (meal_daily_counts) and kitchen consumption (meal_issues). Scan
        # all of them so months that only have imported counts still count.
        month_set: set[str] = set()
        for coll in ("meal_records", "meal_daily_counts", "meal_issues"):
            for d in await db[coll].distinct("date"):
                if d:
                    mk = str(d)[:7]
                    if _MONTH_RE.match(mk):
                        month_set.add(mk)
        months = sorted(month_set)
        filled: list = []
        for mk in months:
            exists = await db.meal_overheads.find_one({"month": mk}, {"_id": 0, "month": 1})
            if exists and not body.overwrite:
                continue
            doc = {
                "month": mk,
                "staff_wages": round(body.default_wages, 2),
                "incidentals": 0.0,
                "note": "Backfilled default wage bill",
                "updated_by": user.get("full_name") or user.get("id"),
                "updated_at": now_utc().isoformat(),
            }
            await db.meal_overheads.update_one({"month": mk}, {"$set": doc}, upsert=True)
            filled.append(mk)
        return {"filled_months": filled, "default_wages": body.default_wages,
                "considered_months": months}

    # Exposed so the presence router (Feb 2026) can broadcast row-focus
    # events on the same SSE channel without depending on meals.py's
    # module-private closures.
    router._signal_meals_ref = [None]  # noqa: SLF001

    # ------------------------------------------------------------------
    # Live update signal (Jun 2026 — user asked for pushed updates instead
    # of client polling). Every pantry mutation bumps a monotonic `seq` on
    # a single db.config doc; connected clients hold an SSE stream open at
    # GET /meals/events and refetch when seq moves. Mongo-backed so it
    # works across multiple workers/pods in production. `client` carries
    # the originating browser tab's X-Client-Id so that tab can ignore
    # its own echo.
    # ------------------------------------------------------------------
    async def _signal_meals(scope: str, date_iso: Optional[str] = None):
        try:
            await db.config.update_one(
                {"id": "meals_signal"},
                {"$inc": {"seq": 1},
                 "$set": {"scope": scope, "date": date_iso,
                          "client": current_client_id.get(),
                          "at": now_utc().isoformat()}},
                upsert=True,
            )
        except Exception:
            logging.getLogger(__name__).warning("meals signal bump failed", exc_info=True)
    router._signal_meals_ref[0] = _signal_meals  # noqa: SLF001

    async def _safe_date_upsert(coll, flt, update):
        """upsert=True that tolerates a unique-`date` insert race: if a
        concurrent request already created the day's doc (DuplicateKeyError),
        reapply the same update as a plain non-upsert update on the now-
        existing doc. Used for the one-doc-per-date pantry collections."""
        try:
            return await coll.update_one(flt, update, upsert=True)
        except DuplicateKeyError:
            return await coll.update_one(flt, update, upsert=False)

    async def _upsert_line_scoped(coll, d, line):
        """Atomically upsert one array line keyed by item_id in a per-date
        doc: positional `$set` if the item's line exists, else a `$ne`-guarded
        `$push`. Prevents duplicate lines when two saves of the SAME item on
        the SAME date race. The day's doc must already exist."""
        res = await coll.update_one(
            {"date": d, "lines.item_id": line["item_id"]},
            {"$set": {"lines.$": line}})
        if res.matched_count == 0:
            await coll.update_one(
                {"date": d, "lines.item_id": {"$ne": line["item_id"]}},
                {"$push": {"lines": line}})

    @router.get("/meals/events")
    async def meals_events(token: str):
        """SSE stream of pantry-change signals. EventSource cannot set an
        Authorization header, so the JWT arrives as a `token` query param.
        Emits the current seq on connect (client baselines against it) and
        a new frame whenever any pantry data changes; `: ping` keepalives
        every ~20s stop proxies from dropping the idle connection."""
        try:
            payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
        except Exception:
            raise HTTPException(status_code=401, detail="Invalid or expired token")
        u = await db.users.find_one(
            {"id": payload.get("sub")}, {"_id": 0, "role": 1, "active": 1})
        if not u or u.get("active") is False or u.get("role") not in ("admin", "chef"):
            raise HTTPException(status_code=403, detail="Not allowed")

        async def stream():
            # 2KB comment padding defeats proxy buffer thresholds so the
            # first real frame is delivered immediately through the ingress.
            yield ":" + (" " * 2048) + "\n\n"
            last = None
            beat = 0
            while True:
                doc = await db.config.find_one(
                    {"id": "meals_signal"},
                    {"_id": 0, "seq": 1, "scope": 1, "date": 1, "client": 1})
                seq = int((doc or {}).get("seq") or 0)
                if seq != last:
                    last = seq
                    yield "data: " + json.dumps({
                        "seq": seq,
                        "scope": (doc or {}).get("scope"),
                        "date": (doc or {}).get("date"),
                        "client": (doc or {}).get("client") or "",
                    }) + "\n\n"
                beat += 1
                if beat % 20 == 0:
                    yield ": ping\n\n"
                await asyncio.sleep(1)

        return StreamingResponse(
            stream(), media_type="text/event-stream",
            headers={"Cache-Control": "no-cache, no-transform",
                     "X-Accel-Buffering": "no",
                     # Opt out of GZipMiddleware — gzip buffers tiny SSE
                     # frames and stalls delivery.
                     "Content-Encoding": "identity"},
        )

    _ns = _reg_muster(router, db=db, get_current_user=get_current_user, require_admin=require_admin, require_chef_or_admin=require_chef_or_admin)
    _not_future = _ns["_not_future"]
    _valid_date = _ns["_valid_date"]

    _ns = _reg_vendors(router, _signal_meals=_signal_meals, _valid_date=_valid_date, db=db, require_admin=require_admin, require_chef_or_admin=require_chef_or_admin)
    _purchase_categories = _ns["_purchase_categories"]
    _stock_snapshot = _ns["_stock_snapshot"]

    _ns = _reg_items(router, _audit=_audit, _purchase_categories=_purchase_categories, _signal_meals=_signal_meals, _valid_date=_valid_date, db=db, require_admin=require_admin, require_chef_or_admin=require_chef_or_admin)

    _ns = _reg_stock(router, _audit=_audit, _diff_meta=_diff_meta, _line_diff=_line_diff, _not_future=_not_future, _safe_date_upsert=_safe_date_upsert, _signal_meals=_signal_meals, _stock_snapshot=_stock_snapshot, _upsert_line_scoped=_upsert_line_scoped, _valid_date=_valid_date, db=db, require_chef_or_admin=require_chef_or_admin)
    _range_or_default = _ns["_range_or_default"]

    _ns = _reg_stock_take(router, _audit=_audit, _not_future=_not_future, _purchase_categories=_purchase_categories, _range_or_default=_range_or_default, _safe_date_upsert=_safe_date_upsert, _signal_meals=_signal_meals, _stock_snapshot=_stock_snapshot, _upsert_line_scoped=_upsert_line_scoped, _valid_date=_valid_date, db=db, require_chef_or_admin=require_chef_or_admin)


    _ns = _reg_purchases(router, _audit=_audit, _diff_meta=_diff_meta, _line_diff=_line_diff, _not_future=_not_future, _overhead_daily_map=_overhead_daily_map, _purchase_categories=_purchase_categories, _safe_date_upsert=_safe_date_upsert, _signal_meals=_signal_meals, _stock_snapshot=_stock_snapshot, _upsert_line_scoped=_upsert_line_scoped, _valid_date=_valid_date, db=db, require_chef_or_admin=require_chef_or_admin)

    _ns = _reg_analytics(router, _purchase_categories=_purchase_categories, _stock_snapshot=_stock_snapshot, _valid_date=_valid_date, db=db, require_chef_or_admin=require_chef_or_admin)
    DailyCountsIn = _ns["DailyCountsIn"]

    _ns = _reg_calendar(router, DailyCountsIn=DailyCountsIn, _MAIN_LABELS=_MAIN_LABELS, _MAIN_MEALS=_MAIN_MEALS, _days_in_month=_days_in_month, _stock_snapshot=_stock_snapshot, _valid_date=_valid_date, db=db, require_admin=require_admin, require_chef_or_admin=require_chef_or_admin)


    _reg_auto_issue(router, db=db, require_chef_or_admin=require_chef_or_admin,
                    _stock_snapshot=_stock_snapshot, _valid_date=_valid_date)

    return router
