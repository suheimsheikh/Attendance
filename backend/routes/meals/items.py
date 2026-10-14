"""Meals routes — items. Split out of routes/meals/__init__.py (Oct 2026); behaviour unchanged."""
from __future__ import annotations

from routes.meals.common import (
    Depends,
    HTTPException,
    ItemIn,
    ItemPatch,
    ItemsReorderIn,
    Optional,
    Query,
    SubcatIn,
    SubcatPatch,
    VALID_UNITS,
    local_date_str,
    now_utc,
    uuid,
)


def register(router, *, _audit, _purchase_categories, _signal_meals, _valid_date, db, require_admin, require_chef_or_admin):
    # ------------------------------------------------------------------
    # Items master (Feb 2026) — sub-categories under each purchase
    # category. Admin manages CRUD; anyone chef/admin can read so the
    # purchase entry dropdown works.
    # ------------------------------------------------------------------
    def _valid_unit(u: str) -> str:
        if u not in VALID_UNITS:
            raise HTTPException(status_code=400,
                                detail=f"unit must be one of {list(VALID_UNITS)}")
        return u

    def _norm_name(n: str) -> str:
        import re
        return re.sub(r"\s+", " ", (n or "").strip().lower())

    # Fat-finger ceilings for item master numbers (Jun 2026).
    _ITEM_CAPS = {
        "opening_stock": 1000000, "min_stock": 1000000,
        "opening_rate": 100000, "norm_per_serving": 100000,
        "grams_per_unit": 1000000,
    }

    def _check_item_num(field: str, value, label: str) -> None:
        if value is None:
            return
        try:
            v = float(value)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail=f"{label} must be a number")
        if v < 0:
            raise HTTPException(status_code=400, detail=f"{label} cannot be negative")
        cap = _ITEM_CAPS.get(field, 1000000)
        if v > cap:
            raise HTTPException(status_code=400, detail=f"{label} looks too large — max {cap:,.0f}. Please re-check.")

    # Per-100g nutrition bounds. Macros can't exceed 100 g per 100 g; energy
    # tops out near pure fat (~900 kcal/100g). grams_per_unit is a pack size.
    _NUTRI_CAPS = {"kcal": 900, "protein_g": 100, "carbs_g": 100,
                   "fat_g": 100, "fibre_g": 100, "grams_per_unit": 1000000}
    _NUTRI_LABEL = {"kcal": "Calories", "protein_g": "Protein", "carbs_g": "Carbs",
                    "fat_g": "Fat", "fibre_g": "Fibre", "grams_per_unit": "Grams per unit"}

    def _clean_nutrition(nut):
        """Validate + normalise a per-100g nutrition override. Returns a dict
        of the supplied keys, or None to clear the override. Rejects
        negatives, non-numbers, unknown keys and out-of-range values."""
        if nut is None:
            return None
        if not isinstance(nut, dict):
            raise HTTPException(status_code=400, detail="Nutrition must be an object")
        out: dict = {}
        for k, raw in nut.items():
            if k not in _NUTRI_CAPS:
                continue  # ignore unknown keys
            if raw in (None, ""):
                continue
            try:
                v = float(raw)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail=f"{_NUTRI_LABEL[k]} must be a number")
            if v < 0:
                raise HTTPException(status_code=400, detail=f"{_NUTRI_LABEL[k]} cannot be negative")
            if v > _NUTRI_CAPS[k]:
                unit = "g/100g" if k != "kcal" and k != "grams_per_unit" else ("kcal/100g" if k == "kcal" else "g")
                raise HTTPException(status_code=400, detail=f"{_NUTRI_LABEL[k]} looks too high — max {_NUTRI_CAPS[k]:,.0f} {unit}. Please re-check.")
            out[k] = round(v, 3)
        return out or None

    @router.get("/meals/items")
    async def list_items(
        category_key: Optional[str] = Query(None),
        include_inactive: bool = Query(False),
        user: dict = Depends(require_chef_or_admin),
    ):
        q: dict = {}
        if not include_inactive:
            q["active"] = True
        if category_key:
            q["category_key"] = category_key
        rows = await db.meal_items.find(q, {"_id": 0}) \
            .sort([("category_key", 1), ("sort_order", 1), ("name", 1)]) \
            .to_list(500)
        return {"items": rows, "units": list(VALID_UNITS)}

    # ── Sub-categories (optional grouping of items within a category) ──
    def _subcat_slug(s: str) -> str:
        import re
        return re.sub(r"[^a-z0-9]+", "-", (s or "").strip().lower()).strip("-") or "grp"

    @router.get("/meals/subcategories")
    async def list_subcategories(category_key: Optional[str] = Query(None),
                                 user: dict = Depends(require_chef_or_admin)):
        q: dict = {"active": {"$ne": False}}
        if category_key:
            q["category_key"] = category_key
        rows = await db.meal_subcategories.find(q, {"_id": 0}) \
            .sort([("category_key", 1), ("order", 1), ("name", 1)]).to_list(1000)
        return {"subcategories": rows}

    @router.post("/meals/subcategories")
    async def create_subcategory(body: SubcatIn, user: dict = Depends(require_chef_or_admin)):
        cats = await _purchase_categories()
        if body.category_key not in {c["key"] for c in cats}:
            raise HTTPException(status_code=400, detail=f"Unknown category '{body.category_key}'")
        name = body.name.strip()
        key = _subcat_slug(name)
        existing = await db.meal_subcategories.find_one(
            {"category_key": body.category_key, "key": key}, {"_id": 0})
        if existing:
            if existing.get("active") is False:
                await db.meal_subcategories.update_one(
                    {"id": existing["id"]}, {"$set": {"active": True, "name": name}})
                existing.update({"active": True, "name": name})
                await _signal_meals("items")
                return existing
            raise HTTPException(status_code=409, detail=f"Sub-category '{name}' already exists here")
        n = await db.meal_subcategories.count_documents({"category_key": body.category_key})
        doc = {"id": str(uuid.uuid4()), "category_key": body.category_key, "key": key,
               "name": name, "order": n, "active": True, "created_at": now_utc().isoformat()}
        await db.meal_subcategories.insert_one(dict(doc))
        await _signal_meals("items")
        return doc

    @router.patch("/meals/subcategories/{sid}")
    async def patch_subcategory(sid: str, body: SubcatPatch, user: dict = Depends(require_chef_or_admin)):
        row = await db.meal_subcategories.find_one({"id": sid}, {"_id": 0})
        if not row:
            raise HTTPException(status_code=404, detail="Sub-category not found")
        upd: dict = {}
        if body.name is not None:
            upd["name"] = body.name.strip()
        if body.order is not None:
            upd["order"] = int(body.order)
        if body.active is not None:
            upd["active"] = bool(body.active)
        if upd:
            await db.meal_subcategories.update_one({"id": sid}, {"$set": upd})
            row.update(upd)
            await _signal_meals("items")
        return row

    @router.delete("/meals/subcategories/{sid}")
    async def delete_subcategory(sid: str, user: dict = Depends(require_chef_or_admin)):
        row = await db.meal_subcategories.find_one({"id": sid}, {"_id": 0})
        if not row:
            return {"ok": True, "already_deleted": True}
        await db.meal_subcategories.update_one({"id": sid}, {"$set": {"active": False}})
        # Detach items so they fall back to "Ungrouped" rather than dangling.
        await db.meal_items.update_many(
            {"category_key": row["category_key"], "subcategory_key": row["key"]},
            {"$set": {"subcategory_key": None}})
        await _signal_meals("items")
        return {"ok": True}

    @router.post("/meals/items")
    async def create_item(body: ItemIn, user: dict = Depends(require_chef_or_admin)):
        _valid_unit(body.unit)
        cats = await _purchase_categories()
        if body.category_key not in {c["key"] for c in cats}:
            raise HTTPException(status_code=400,
                                detail=f"Unknown category '{body.category_key}'")
        name = body.name.strip()
        name_norm = _norm_name(name)
        # Uniqueness within (category_key, name) among ACTIVE items only —
        # a soft-deleted item with the same name can be reactivated later
        # without a collision.
        clash = await db.meal_items.find_one(
            {"category_key": body.category_key,
             "name_norm": name_norm, "active": True},
        )
        if clash:
            raise HTTPException(status_code=409,
                                detail=f"Item '{name}' already exists under this category")
        opening = float(body.opening_stock or 0)
        _check_item_num("opening_stock", opening, "Opening stock")
        _check_item_num("opening_rate", body.opening_rate, "Opening rate")
        _check_item_num("min_stock", body.min_stock, "Min level")
        _check_item_num("norm_per_serving", body.norm_per_serving, "Norm per serving")
        nutrition = _clean_nutrition(body.nutrition)
        as_of = _valid_date(body.opening_stock_as_of) if body.opening_stock_as_of \
            else local_date_str(None)
        doc = {
            "id": str(uuid.uuid4()),
            "category_key": body.category_key,
            "name": name,
            "name_norm": name_norm,
            "unit": body.unit,
            "opening_stock": round(opening, 4),
            "opening_stock_as_of": as_of,
            "opening_rate": round(float(body.opening_rate or 0), 4),
            "min_stock": round(float(body.min_stock or 0), 4),
            "norm_per_serving": round(float(body.norm_per_serving or 0), 4),
            "nutrition": nutrition,
            "sort_order": int(body.sort_order),
            "subcategory_key": (body.subcategory_key or None),
            "active": True,
            "created_at": now_utc().isoformat(),
            "created_by": user.get("id"),
            "created_by_name": user.get("full_name") or user.get("email"),
        }
        await db.meal_items.insert_one(doc)
        doc.pop("_id", None)
        await _signal_meals("items")
        return doc

    @router.patch("/meals/items/{item_id}")
    async def update_item(
        item_id: str, body: ItemPatch, user: dict = Depends(require_chef_or_admin),
    ):
        row = await db.meal_items.find_one({"id": item_id}, {"_id": 0})
        if not row:
            raise HTTPException(status_code=404, detail="Item not found")
        update: dict = {}
        if body.category_key is not None:
            cats = await _purchase_categories()
            if body.category_key not in {c["key"] for c in cats}:
                raise HTTPException(status_code=400, detail="Unknown category")
            update["category_key"] = body.category_key
        if body.name is not None:
            new_name = body.name.strip()
            new_norm = _norm_name(new_name)
            if new_norm != row.get("name_norm"):
                clash = await db.meal_items.find_one({
                    "category_key": update.get("category_key", row["category_key"]),
                    "name_norm": new_norm, "active": True,
                    "id": {"$ne": item_id},
                })
                if clash:
                    raise HTTPException(status_code=409, detail="Another item has that name")
            update["name"] = new_name
            update["name_norm"] = new_norm
        if body.unit is not None:
            _valid_unit(body.unit)
            update["unit"] = body.unit
        if body.opening_stock is not None:
            _check_item_num("opening_stock", body.opening_stock, "Opening stock")
            update["opening_stock"] = round(float(body.opening_stock), 4)
        if body.opening_stock_as_of is not None:
            update["opening_stock_as_of"] = _valid_date(body.opening_stock_as_of)
        if body.opening_rate is not None:
            _check_item_num("opening_rate", body.opening_rate, "Opening rate")
            update["opening_rate"] = round(float(body.opening_rate), 4)
        if body.min_stock is not None:
            _check_item_num("min_stock", body.min_stock, "Min level")
            update["min_stock"] = round(float(body.min_stock), 4)
        if body.norm_per_serving is not None:
            _check_item_num("norm_per_serving", body.norm_per_serving, "Norm per serving")
            update["norm_per_serving"] = round(float(body.norm_per_serving), 4)
        if body.nutrition is not None:
            update["nutrition"] = _clean_nutrition(body.nutrition)
        if body.sort_order is not None:
            update["sort_order"] = int(body.sort_order)
        if body.subcategory_key is not None:
            update["subcategory_key"] = body.subcategory_key or None
        if body.active is not None:
            update["active"] = bool(body.active)
        if body.grams_per_unit is not None:
            _check_item_num("grams_per_unit", body.grams_per_unit, "Grams per unit")
            update["grams_per_unit"] = round(float(body.grams_per_unit), 3) or None
        if update:
            update["updated_at"] = now_utc().isoformat()
            update["updated_by"] = user.get("id")
            update["updated_by_name"] = user.get("full_name") or user.get("email")
            # Capture before→after per changed field BEFORE mutating `row`.
            _audit_fields = {
                k: {"before": row.get(k), "after": v}
                for k, v in update.items()
                if k not in ("updated_at", "updated_by", "updated_by_name", "name_norm")
            }
            await db.meal_items.update_one({"id": item_id}, {"$set": update})
            row.update(update)
            await _signal_meals("items")
            if _audit_fields:
                await _audit(user, "meals.item.edit", "meal_item", item_id, row.get("name"),
                             meta={"date": (row.get("updated_at") or "")[:10],
                                   "changes": [{"item": row.get("name"), "unit": row.get("unit") or "",
                                                "type": "changed", "fields": _audit_fields}],
                                   "counts": {"changed": 1}})
        return row

    @router.delete("/meals/items/{item_id}")
    async def delete_item(item_id: str, admin: dict = Depends(require_admin)):
        row = await db.meal_items.find_one({"id": item_id}, {"_id": 0})
        if not row:
            # Idempotent DELETE: if the row is already gone (another admin
            # deleted it, or the client is retrying), return success rather
            # than 404. Removes the recurring "Item not found" toast when
            # two admins act on the Masters tree at the same time.
            return {"ok": True, "soft_deleted": False, "already_deleted": True}
        # 20 Feb 2026 user rule: "Nobody can delete a master or a Daily
        # entry item if there is data in it." Previously we soft-deleted
        # (active=False) silently — this refuses instead so the audit
        # trail can't be swept under the rug. Deactivation is still
        # available as a distinct action (PATCH active=false).
        purch_ct = await db.meal_purchases.count_documents({"lines.item_id": item_id})
        issue_ct = await db.meal_issues.count_documents({"lines.item_id": item_id})
        waste_ct = await db.meal_wastage.count_documents({"lines.item_id": item_id})
        total = purch_ct + issue_ct + waste_ct
        if total > 0:
            parts = []
            if purch_ct: parts.append(f"{purch_ct} purchase{'s' if purch_ct != 1 else ''}")
            if issue_ct: parts.append(f"{issue_ct} issue{'s' if issue_ct != 1 else ''}")
            if waste_ct: parts.append(f"{waste_ct} wastage row{'s' if waste_ct != 1 else ''}")
            raise HTTPException(
                status_code=409,
                detail=(f"Can't delete “{row.get('name')}” — it has "
                        f"{', '.join(parts)} on record. Deactivate it "
                        f"instead to hide from Daily Entry while keeping "
                        f"history intact."),
            )
        await db.meal_items.delete_one({"id": item_id})
        await _signal_meals("items")
        await _audit(admin, "meals.item.delete", "meal_item", item_id, row.get("name"),
                     meta={"date": now_utc().isoformat()[:10],
                           "changes": [{"item": row.get("name"), "unit": row.get("unit") or "",
                                        "type": "removed", "fields": {}}],
                           "counts": {"removed": 1}})
        return {"ok": True, "soft_deleted": False}

    @router.put("/meals/items/reorder")
    async def reorder_items(body: ItemsReorderIn, user: dict = Depends(require_chef_or_admin)):
        rows = await db.meal_items.find(
            {"category_key": body.category_key}, {"_id": 0, "id": 1},
        ).to_list(500)
        valid = {r["id"] for r in rows}
        ids = [i for i in body.item_ids if i in valid]
        if not ids:
            raise HTTPException(status_code=400,
                                detail="No valid item ids for this category")
        for idx, iid in enumerate(ids):
            await db.meal_items.update_one(
                {"id": iid}, {"$set": {"sort_order": (idx + 1) * 10}})
        await _signal_meals("items")
        return {"ok": True, "ordered": len(ids)}

    return {}
