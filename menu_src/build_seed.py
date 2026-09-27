import json, re
from collections import OrderedDict

# Reuse the parsing (parts 1-3) of combine_menu.py to get `combined`,
# `diet_no_recipe`, `orphan` without running the xlsx-writing part 4.
src = open('/app/menu_src/combine_menu.py').read().split('# ---------- 4)')[0]
ns = {}
exec(src, ns)
combined = ns['combined']

def split_qty(name):
    n = str(name or "").strip()
    if "-" in n:
        left, right = n.rsplit("-", 1)
        if any(ch.isdigit() for ch in right):
            return left.strip(), right.strip()
    return n, ""

def split_raw(raw):
    if not raw:
        return None, ""
    m = re.match(r'\s*([0-9]*\.?[0-9]+)\s*(.*)$', str(raw))
    if not m:
        return None, str(raw).strip()
    amt = float(m.group(1)); unit = m.group(2).strip()
    return amt, unit

# Group into Day -> Meal -> Dish -> ingredients
tree = OrderedDict()
for d in combined:
    day, meal, dish = d["day"], d["meal"], d["dish"]
    tree.setdefault(day, OrderedDict()).setdefault(meal, OrderedDict()).setdefault(dish, {
        "energy": d["energy"], "carbs": d["carbs"], "protein": d["protein"],
        "fat": d["fat"], "fiber": d["fiber"], "ingredients": []
    })
    node = tree[day][meal][dish]
    ing_name = d["ingredient"]
    if ing_name and not ing_name.startswith("— no recipe"):
        amt, unit = split_raw(d["raw"])
        node["ingredients"].append({"name": ing_name, "amount": amt, "unit": unit})

MICRO_KEYS = ["iron", "calcium", "sodium", "potassium", "magnesium", "zinc", "vitamin_d", "vitamin_b12"]

out_days = []
for do, (day, meals) in enumerate(tree.items()):
    meal_list = []
    for mo, (meal, dishes) in enumerate(meals.items()):
        dish_list = []
        for so, (dish, info) in enumerate(dishes.items()):
            name, cooked = split_qty(dish)
            ings = []
            for io, ing in enumerate(info["ingredients"]):
                ings.append({
                    "name": ing["name"],
                    "amount": ing["amount"],
                    "unit": ing["unit"] or "g",
                    "order": io,
                    "per100": {k: None for k in MICRO_KEYS},  # filled by Claude
                })
            dish_list.append({
                "name": name, "cooked_qty": cooked, "order": so,
                "energy": info["energy"], "carbs": info["carbs"],
                "protein": info["protein"], "fat": info["fat"], "fiber": info["fiber"],
                "ingredients": ings,
            })
        meal_list.append({"name": meal or "General", "order": mo, "dishes": dish_list})
    out_days.append({"name": day, "order": do, "meals": meal_list})

json.dump({"days": out_days, "micro_keys": MICRO_KEYS}, open('/app/backend/seed_recipes.json', 'w'), indent=1, default=str)
print("days:", len(out_days))
print("meals:", sum(len(d["meals"]) for d in out_days))
print("dishes:", sum(len(m["dishes"]) for d in out_days for m in d["meals"]))
print("ingredients:", sum(len(di["ingredients"]) for d in out_days for m in d["meals"] for di in m["dishes"]))
