"""Recipes / weekly-menu tree — Day > Meal > Dish > Ingredient.

Seeded from the combined menu workbook. Macros (energy/carbs/protein/fat/
fibre) are per-dish-serving. Micronutrients are stored per-100g on each
ingredient and filled by Claude (cheapest model) via the Emergent LLM key;
the dish/meal/day micro totals are computed by scaling per-100g by each
ingredient's gram weight. A name-keyed cache means each distinct ingredient
is only sent to the LLM once.
"""
import os, json, uuid, re, logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from typing import Optional, List

log = logging.getLogger("recipes")

MICROS = ["iron", "calcium", "sodium", "potassium", "magnesium", "zinc", "vitamin_d", "vitamin_b12"]
MICRO_UNITS = {"iron": "mg", "calcium": "mg", "sodium": "mg", "potassium": "mg",
               "magnesium": "mg", "zinc": "mg", "vitamin_d": "µg", "vitamin_b12": "µg"}
SEED_PATH = os.path.join(os.path.dirname(__file__), "..", "seed_recipes.json")


def _now():
    return datetime.now(timezone.utc).isoformat()


def _norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())


async def _fill_one_from_llm(name: str) -> dict:
    """Ask Claude (cheapest model) for per-100g micronutrients of `name`."""
    from emergentintegrations.llm.chat import LlmChat, UserMessage
    key = os.environ.get("EMERGENT_LLM_KEY")
    if not key:
        raise HTTPException(500, "EMERGENT_LLM_KEY not configured")
    sys = ("You are a nutrition database. For the given food ingredient, return ONLY a compact "
           "JSON object of typical micronutrient content PER 100 GRAMS (raw/edible portion), with "
           "these exact numeric keys (no units, no text): iron_mg, calcium_mg, sodium_mg, "
           "potassium_mg, magnesium_mg, zinc_mg, vitamin_d_ug, vitamin_b12_ug. Use 0 when "
           "negligible. No markdown, no explanation.")
    chat = LlmChat(api_key=key, session_id=f"micro-{_norm(name)[:24]}", system_message=sys)\
        .with_model("anthropic", "claude-haiku-4-5-20251001")
    resp = await chat.send_message(UserMessage(text=f"Ingredient: {name}"))
    txt = resp if isinstance(resp, str) else getattr(resp, "content", str(resp))
    m = re.search(r"\{.*\}", txt, re.DOTALL)
    if not m:
        raise HTTPException(502, f"AI returned no JSON for '{name}'")
    raw = json.loads(m.group(0))
    key_map = {"iron": "iron_mg", "calcium": "calcium_mg", "sodium": "sodium_mg",
               "potassium": "potassium_mg", "magnesium": "magnesium_mg", "zinc": "zinc_mg",
               "vitamin_d": "vitamin_d_ug", "vitamin_b12": "vitamin_b12_ug"}
    out = {}
    for k in MICROS:
        v = raw.get(key_map[k])
        try:
            out[k] = round(float(v), 3) if v is not None else 0.0
        except (TypeError, ValueError):
            out[k] = 0.0
    return out


def make_router(db, require_admin, get_current_user, require_chef_or_admin):
    router = APIRouter(prefix="/api/recipes", tags=["recipes"])

    async def _ensure_seed():
        if await db.menu_days.count_documents({}) > 0:
            return
        try:
            data = json.load(open(SEED_PATH))
        except Exception as e:
            log.warning("recipe seed missing: %s", e)
            return
        for d in data.get("days", []):
            day_id = str(uuid.uuid4())
            await db.menu_days.insert_one({"id": day_id, "name": d["name"], "order": d["order"]})
            for m in d.get("meals", []):
                meal_id = str(uuid.uuid4())
                await db.menu_meals.insert_one({"id": meal_id, "day_id": day_id,
                                                "name": m["name"], "order": m["order"]})
                for di in m.get("dishes", []):
                    ings = [{"id": str(uuid.uuid4()), "name": g["name"], "amount": g.get("amount"),
                             "unit": g.get("unit") or "g", "order": g.get("order", i),
                             "per100": {k: None for k in MICROS}}
                            for i, g in enumerate(di.get("ingredients", []))]
                    await db.menu_dishes.insert_one({
                        "id": str(uuid.uuid4()), "meal_id": meal_id, "name": di["name"],
                        "cooked_qty": di.get("cooked_qty", ""), "order": di.get("order", 0),
                        "energy": di.get("energy"), "carbs": di.get("carbs"),
                        "protein": di.get("protein"), "fat": di.get("fat"), "fiber": di.get("fiber"),
                        "ingredients": ings})

    def _dish_micros(ings):
        tot = {k: 0.0 for k in MICROS}
        have = False
        for g in ings:
            per = g.get("per100") or {}
            amt = g.get("amount")
            try:
                amt = float(amt)
            except (TypeError, ValueError):
                continue
            for k in MICROS:
                v = per.get(k)
                if v is not None:
                    tot[k] += float(v) * amt / 100.0
                    have = True
        return ({k: round(tot[k], 2) for k in MICROS} if have else {k: None for k in MICROS})

    def _num(x):
        try:
            return float(x)
        except (TypeError, ValueError):
            return 0.0

    def _dish_weight(ings):
        """Total quantity of a dish split by unit (grams vs millilitres)."""
        g = ml = 0.0
        for x in ings:
            amt = _num(x.get("amount"))
            if (str(x.get("unit") or "g").lower()) == "ml":
                ml += amt
            else:
                g += amt
        return round(g, 1), round(ml, 1)

    @router.get("/meta")
    async def meta(user=Depends(get_current_user)):
        return {"micros": MICROS, "micro_units": MICRO_UNITS}

    @router.get("/tree")
    async def tree(user=Depends(require_chef_or_admin)):
        await _ensure_seed()
        days = await db.menu_days.find({}, {"_id": 0}).sort("order", 1).to_list(100)
        meals = await db.menu_meals.find({}, {"_id": 0}).sort("order", 1).to_list(1000)
        dishes = await db.menu_dishes.find({}, {"_id": 0}).sort("order", 1).to_list(5000)
        meals_by_day, dishes_by_meal = {}, {}
        for m in meals:
            meals_by_day.setdefault(m["day_id"], []).append(m)
        for d in dishes:
            dishes_by_meal.setdefault(m["meal_id"] if False else d["meal_id"], []).append(d)
        MAC = ["energy", "carbs", "protein", "fat", "fiber"]
        WT = ["weight_g", "weight_ml"]
        out_days = []
        for day in days:
            day_meals = []
            d_tot = {k: 0.0 for k in MAC + MICROS + WT}
            for m in sorted(meals_by_day.get(day["id"], []), key=lambda x: x.get("order", 0)):
                m_dishes = []
                m_tot = {k: 0.0 for k in MAC + MICROS + WT}
                for di in sorted(dishes_by_meal.get(m["id"], []), key=lambda x: x.get("order", 0)):
                    micros = _dish_micros(di.get("ingredients", []))
                    wg, wml = _dish_weight(di.get("ingredients", []))
                    di_out = {**di, "micros": micros, "weight_g": wg, "weight_ml": wml}
                    m_dishes.append(di_out)
                    for k in MAC:
                        m_tot[k] += _num(di.get(k))
                    for k in MICROS:
                        if micros.get(k) is not None:
                            m_tot[k] += micros[k]
                    m_tot["weight_g"] += wg
                    m_tot["weight_ml"] += wml
                day_meals.append({**m, "dishes": m_dishes, "totals": {k: round(m_tot[k], 2) for k in MAC + MICROS + WT}})
                for k in MAC + MICROS + WT:
                    d_tot[k] += m_tot[k]
            out_days.append({**day, "meals": day_meals, "totals": {k: round(d_tot[k], 2) for k in MAC + MICROS + WT}})
        return {"days": out_days, "micros": MICROS, "micro_units": MICRO_UNITS}

    # ---------------- CRUD: Days ----------------
    class DayIn(BaseModel):
        name: str
        order: Optional[int] = None

    @router.post("/days")
    async def add_day(body: DayIn, user=Depends(require_admin)):
        order = body.order if body.order is not None else (await db.menu_days.count_documents({}))
        doc = {"id": str(uuid.uuid4()), "name": body.name.strip(), "order": order}
        await db.menu_days.insert_one(doc)
        return {k: v for k, v in doc.items() if k != "_id"}

    @router.put("/days/{day_id}")
    async def edit_day(day_id: str, body: DayIn, user=Depends(require_admin)):
        upd = {"name": body.name.strip()}
        if body.order is not None:
            upd["order"] = body.order
        r = await db.menu_days.update_one({"id": day_id}, {"$set": upd})
        if not r.matched_count:
            raise HTTPException(404, "Day not found")
        return {"ok": True}

    @router.delete("/days/{day_id}")
    async def del_day(day_id: str, user=Depends(require_admin)):
        meal_ids = [m["id"] async for m in db.menu_meals.find({"day_id": day_id}, {"id": 1})]
        await db.menu_dishes.delete_many({"meal_id": {"$in": meal_ids}})
        await db.menu_meals.delete_many({"day_id": day_id})
        await db.menu_days.delete_one({"id": day_id})
        return {"ok": True}

    # ---------------- CRUD: Meals ----------------
    class MealIn(BaseModel):
        day_id: Optional[str] = None
        name: str
        order: Optional[int] = None

    @router.post("/meals")
    async def add_meal(body: MealIn, user=Depends(require_admin)):
        if not body.day_id:
            raise HTTPException(400, "day_id required")
        order = body.order if body.order is not None else (await db.menu_meals.count_documents({"day_id": body.day_id}))
        doc = {"id": str(uuid.uuid4()), "day_id": body.day_id, "name": body.name.strip(), "order": order}
        await db.menu_meals.insert_one(doc)
        return {k: v for k, v in doc.items() if k != "_id"}

    @router.put("/meals/{meal_id}")
    async def edit_meal(meal_id: str, body: MealIn, user=Depends(require_admin)):
        upd = {"name": body.name.strip()}
        if body.order is not None:
            upd["order"] = body.order
        r = await db.menu_meals.update_one({"id": meal_id}, {"$set": upd})
        if not r.matched_count:
            raise HTTPException(404, "Meal not found")
        return {"ok": True}

    @router.delete("/meals/{meal_id}")
    async def del_meal(meal_id: str, user=Depends(require_admin)):
        await db.menu_dishes.delete_many({"meal_id": meal_id})
        await db.menu_meals.delete_one({"id": meal_id})
        return {"ok": True}

    # ---------------- CRUD: Dishes ----------------
    class DishIn(BaseModel):
        meal_id: Optional[str] = None
        name: str
        cooked_qty: Optional[str] = ""
        energy: Optional[float] = None
        carbs: Optional[float] = None
        protein: Optional[float] = None
        fat: Optional[float] = None
        fiber: Optional[float] = None
        order: Optional[int] = None

    @router.post("/dishes")
    async def add_dish(body: DishIn, user=Depends(require_admin)):
        if not body.meal_id:
            raise HTTPException(400, "meal_id required")
        order = body.order if body.order is not None else (await db.menu_dishes.count_documents({"meal_id": body.meal_id}))
        doc = {"id": str(uuid.uuid4()), "meal_id": body.meal_id, "name": body.name.strip(),
               "cooked_qty": body.cooked_qty or "", "order": order,
               "energy": body.energy, "carbs": body.carbs, "protein": body.protein,
               "fat": body.fat, "fiber": body.fiber, "ingredients": []}
        await db.menu_dishes.insert_one(doc)
        return {k: v for k, v in doc.items() if k != "_id"}

    @router.put("/dishes/{dish_id}")
    async def edit_dish(dish_id: str, body: DishIn, user=Depends(require_admin)):
        upd = {"name": body.name.strip(), "cooked_qty": body.cooked_qty or ""}
        for k in ("energy", "carbs", "protein", "fat", "fiber", "order"):
            v = getattr(body, k)
            if v is not None:
                upd[k] = v
        r = await db.menu_dishes.update_one({"id": dish_id}, {"$set": upd})
        if not r.matched_count:
            raise HTTPException(404, "Dish not found")
        return {"ok": True}

    @router.delete("/dishes/{dish_id}")
    async def del_dish(dish_id: str, user=Depends(require_admin)):
        await db.menu_dishes.delete_one({"id": dish_id})
        return {"ok": True}

    # ---------------- CRUD: Ingredients (embedded) ----------------
    class IngIn(BaseModel):
        name: str
        amount: Optional[float] = None
        unit: Optional[str] = "g"

    async def _micros_for(name: str, force: bool = False) -> dict:
        """Cache-first per-100g micros. LLM call only when not cached / forced."""
        nn = _norm(name)
        if not force:
            c = await db.menu_micro_cache.find_one({"name_norm": nn}, {"_id": 0})
            if c and c.get("per100"):
                return c["per100"]
        per = await _fill_one_from_llm(name)
        await db.menu_micro_cache.update_one({"name_norm": nn},
            {"$set": {"name_norm": nn, "name": name, "per100": per, "at": _now()}}, upsert=True)
        return per

    @router.post("/dishes/{dish_id}/ingredients")
    async def add_ingredient(dish_id: str, body: IngIn, user=Depends(require_admin)):
        dish = await db.menu_dishes.find_one({"id": dish_id}, {"_id": 0})
        if not dish:
            raise HTTPException(404, "Dish not found")
        try:
            per = await _micros_for(body.name)
        except Exception as e:
            log.warning("micro fill failed for %s: %s", body.name, e)
            per = {k: None for k in MICROS}
        ing = {"id": str(uuid.uuid4()), "name": body.name.strip(), "amount": body.amount,
               "unit": body.unit or "g", "order": len(dish.get("ingredients", [])), "per100": per}
        await db.menu_dishes.update_one({"id": dish_id}, {"$push": {"ingredients": ing}})
        return ing

    @router.put("/dishes/{dish_id}/ingredients/{ing_id}")
    async def edit_ingredient(dish_id: str, ing_id: str, body: IngIn, user=Depends(require_admin)):
        dish = await db.menu_dishes.find_one({"id": dish_id}, {"_id": 0})
        if not dish:
            raise HTTPException(404, "Dish not found")
        ings = dish.get("ingredients", [])
        target = next((g for g in ings if g["id"] == ing_id), None)
        if not target:
            raise HTTPException(404, "Ingredient not found")
        name_changed = _norm(target.get("name")) != _norm(body.name)
        target["name"] = body.name.strip()
        target["amount"] = body.amount
        target["unit"] = body.unit or "g"
        if name_changed or not target.get("per100") or all(v is None for v in (target.get("per100") or {}).values()):
            try:
                target["per100"] = await _micros_for(body.name)
            except Exception as e:
                log.warning("micro refill failed: %s", e)
        await db.menu_dishes.update_one({"id": dish_id}, {"$set": {"ingredients": ings}})
        return target

    @router.delete("/dishes/{dish_id}/ingredients/{ing_id}")
    async def del_ingredient(dish_id: str, ing_id: str, user=Depends(require_admin)):
        await db.menu_dishes.update_one({"id": dish_id}, {"$pull": {"ingredients": {"id": ing_id}}})
        return {"ok": True}

    # ---------------- Bulk AI fill ----------------
    @router.post("/fill-micros")
    async def fill_micros(limit: int = 25, user=Depends(require_admin)):
        """Fill per-100g micros for ingredients still missing them. Processes up
        to `limit` DISTINCT ingredient names per call (cheap, cached, repeatable)."""
        dishes = await db.menu_dishes.find({}, {"_id": 0}).to_list(5000)
        need = {}  # name_norm -> (name, [(dish_id, ing_id)])
        for di in dishes:
            for g in di.get("ingredients", []):
                per = g.get("per100") or {}
                if all(per.get(k) is None for k in MICROS):
                    nn = _norm(g["name"])
                    need.setdefault(nn, (g["name"], []))[1].append((di["id"], g["id"]))
        total_remaining = len(need)
        processed = 0
        for nn, (name, refs) in list(need.items())[:max(1, limit)]:
            try:
                per = await _micros_for(name, force=False)
            except Exception as e:
                log.warning("bulk fill failed for %s: %s", name, e)
                continue
            for dish_id, ing_id in refs:
                await db.menu_dishes.update_one(
                    {"id": dish_id, "ingredients.id": ing_id},
                    {"$set": {"ingredients.$.per100": per}})
            processed += 1
        return {"processed": processed, "remaining": max(0, total_remaining - processed)}

    return router
