"""Meals routes — auto-issue suggestion (Recipes × Meals Muster).

Draft only: builds suggested pantry issue lines for a date from the weekday's
recipe menu × that day's meal-muster headcounts. Nothing is saved here — the
chef reviews the lines in the Issues tab and saves as usual.
"""
from __future__ import annotations

import difflib
import math
from datetime import date, timedelta
from typing import Dict, Optional

from fastapi import Depends
from pydantic import BaseModel

from routes.meals.common import MEAL_KEYS, MEAL_LABELS, _nutri_lookup
from routes.recipes import UNIT_BASE, _norm

# Recipe meal name (normalised) -> meals-muster slot whose headcount it uses.
RECIPE_MEAL_SLOT = {
    "prebreakfast": "breakfast", "pretraining": "breakfast", "breakfast": "breakfast",
    "midmorning": "midmorning", "lunch": "lunch",
    "evening": "snacks", "evenings": "snacks", "snacks": "snacks", "eveningsnacks": "snacks",
    "dinner": "dinner",
}


class SuggestIn(BaseModel):
    date: str
    counts: Optional[Dict[str, int]] = None


def _num(x) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


def _round_up(qty: float, unit_factor: Optional[float]) -> float:
    """kg/L → next 0.05 · g/ml → next 10 · counts/other → next whole number."""
    if qty <= 0:
        return 0.0
    if unit_factor and unit_factor >= 1000:
        return round(math.ceil(qty / 0.05 - 1e-9) * 0.05, 2)
    if unit_factor == 1:
        return float(math.ceil(qty / 10 - 1e-9) * 10)
    return float(math.ceil(qty - 1e-9))


COUNT_DOZEN = {"dozen", "dz", "doz"}


def _grams_per_pantry_unit(item: dict):
    """(grams in ONE pantry unit, source) for cross-unit conversion, or (None, None).
    Order: item override → weight/volume unit (1 g ≈ 1 ml) → nutrition seed piece weight."""
    ov = item.get("grams_per_unit")
    if ov and ov > 0:
        return float(ov), "item"
    unit = str(item.get("unit") or "").strip().lower()
    ic = UNIT_BASE.get(unit)
    if ic:
        return float(ic[1]), "density"
    seed = _nutri_lookup(item.get("name") or "") or {}
    gpu = seed.get("grams_per_unit")
    if gpu:
        return float(gpu) * (12 if unit in COUNT_DOZEN else 1), "seed"
    return None, None


async def _muster_counts(db, d: str) -> dict:
    counts = {k: 0 for k in MEAL_KEYS}
    async for r in db.meal_records.find({"date": d}, {"_id": 0, "meal": 1}):
        if r.get("meal") in counts:
            counts[r["meal"]] += 1
    return counts


def register(router, *, db, require_chef_or_admin, _stock_snapshot, _valid_date):

    @router.post("/meals/issues/suggest")
    async def suggest_issues(body: SuggestIn, user: dict = Depends(require_chef_or_admin)):
        d = _valid_date(body.date)
        weekday = date.fromisoformat(d).strftime("%A")
        days = await db.menu_days.find({}, {"_id": 0}).to_list(50)
        menu_day = next((x for x in days if _norm(x.get("name")) == _norm(weekday)), None)

        prev_date = (date.fromisoformat(d) - timedelta(days=1)).isoformat()
        muster = await _muster_counts(db, d)
        prev = await _muster_counts(db, prev_date)
        override = {k: max(0, int(v)) for k, v in (body.counts or {}).items() if k in muster and v is not None}
        used, source = {}, {}
        for k in MEAL_KEYS:
            if k in override:
                used[k], source[k] = override[k], "manual"
            elif muster[k] > 0:
                used[k], source[k] = muster[k], "muster"
            else:
                used[k], source[k] = prev[k], "prev_day"
        headcounts = {k: {"label": MEAL_LABELS[k], "muster": muster[k], "prev_day": prev[k],
                          "used": used[k], "source": source[k]} for k in MEAL_KEYS}

        base = {"date": d, "weekday": weekday, "headcounts": headcounts, "meal_slots": [],
                "lines": [], "unmatched": [], "unit_mismatches": [], "skipped_meals": []}
        if not menu_day:
            return {**base, "menu_day": None}

        meals = await db.menu_meals.find({"day_id": menu_day["id"]}, {"_id": 0}).sort("order", 1).to_list(100)
        meal_ids = [m["id"] for m in meals]
        dishes = await db.menu_dishes.find({"meal_id": {"$in": meal_ids}}, {"_id": 0}).sort("order", 1).to_list(2000)
        dishes_by_meal: dict = {}
        for di in dishes:
            dishes_by_meal.setdefault(di["meal_id"], []).append(di)

        items = await db.meal_items.find({"active": True}, {"_id": 0}).to_list(1000)
        item_by_norm = {}
        for it in items:
            item_by_norm.setdefault(_norm(it.get("name")), it)
        item_names = [it["name"] for it in items]

        acc: dict = {}        # item_id -> accumulated qty in the item's unit
        unmatched: dict = {}
        mismatched: dict = {}
        for m in meals:
            slot = RECIPE_MEAL_SLOT.get(_norm(m.get("name")))
            if not slot:
                base["skipped_meals"].append({"name": m.get("name"), "reason": "no matching muster meal"})
                continue
            hc = used[slot]
            base["meal_slots"].append({"recipe_meal": m.get("name"), "slot": slot,
                                       "slot_label": MEAL_LABELS[slot], "headcount": hc,
                                       "dishes": len(dishes_by_meal.get(m["id"], []))})
            if hc <= 0:
                continue
            for di in dishes_by_meal.get(m["id"], []):
                for g in di.get("ingredients", []):
                    nm = (g.get("name") or "").strip()
                    nn = _norm(nm)
                    amt = _num(g.get("amount"))
                    if not nn or amt <= 0:
                        continue
                    src = f"{m.get('name')} · {di.get('name')}"
                    it = item_by_norm.get(nn)
                    if not it:
                        rec = unmatched.setdefault(nn, {"name": nm, "count": 0, "sources": []})
                        rec["count"] += 1
                        if src not in rec["sources"]:
                            rec["sources"].append(src)
                        continue
                    r_unit = str(g.get("unit") or "g").strip().lower()
                    i_unit = str(it.get("unit") or "").strip().lower()
                    rc, ic = UNIT_BASE.get(r_unit), UNIT_BASE.get(i_unit)
                    conv = None
                    if rc and ic and rc[0] == ic[0]:
                        qty = amt * rc[1] * hc / ic[1]
                    elif not rc and not ic and _norm(r_unit) == _norm(i_unit):
                        qty = amt * hc
                    else:
                        gpu, src_kind = _grams_per_pantry_unit(it) if rc else (None, None)
                        if not gpu:
                            mm = mismatched.setdefault(it["id"], {"item_id": it["id"], "name": nm, "pantry_name": it["name"],
                                                                  "recipe_unit": r_unit, "pantry_unit": it.get("unit") or "?",
                                                                  "count": 0})
                            mm["count"] += 1
                            continue
                        qty = amt * rc[1] * hc / gpu
                        conv = {"grams_per_unit": round(gpu, 3), "source": src_kind}
                    a = acc.setdefault(it["id"], {"item": it, "qty": 0.0, "sources": [], "conversion": None})
                    if conv:
                        a["conversion"] = conv
                    a["qty"] += qty
                    if src not in a["sources"]:
                        a["sources"].append(src)

        stock_rows, _ = await _stock_snapshot(prev_date)
        on_hand = {r["item_id"]: r.get("on_hand") for r in stock_rows}

        lines = []
        for iid, a in acc.items():
            it = a["item"]
            conv = UNIT_BASE.get(str(it.get("unit") or "").strip().lower())
            qty = _round_up(a["qty"], conv[1] if conv else None)
            oh = on_hand.get(iid)
            lines.append({"item_id": iid, "item_name": it["name"], "category_key": it.get("category_key"),
                          "unit": it.get("unit"), "qty": qty, "raw_qty": round(a["qty"], 4),
                          "on_hand": oh, "short": oh is not None and qty > oh + 1e-6,
                          "sources": a["sources"], "conversion": a["conversion"]})
        lines.sort(key=lambda x: (x["category_key"] or "", x["item_name"].lower()))
        base["lines"] = lines
        base["unmatched"] = sorted(
            ({**v, "suggestions": difflib.get_close_matches(v["name"], item_names, n=3, cutoff=0.4)}
             for v in unmatched.values()), key=lambda x: x["name"].lower())
        base["unit_mismatches"] = sorted(mismatched.values(), key=lambda x: x["name"].lower())
        return {**base, "menu_day": {"id": menu_day["id"], "name": menu_day.get("name")}}

    return {}
