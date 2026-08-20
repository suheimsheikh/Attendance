"""Pantry nutrition lookup (Feb 2026).

Per-100g macro values for common Indian pantry / mess items. The
Kitchen Analytics panel computes total kcal + macro split for a date
window by multiplying qty (converted to grams) by these values.

* Values are approximate reference numbers (USDA / IFCT / package
  labels rounded to whole numbers). Good enough for portion-planning
  charts, NOT for medical diet advice.
* `grams_per_unit` gives the assumed weight of ONE piece / packet /
  bunch etc. for items sold by count. Items whose unit is already a
  weight (`kg`, `g`) or a volume (`L`, `ml`) auto-convert (L≈1 kg for
  most cooking liquids).
* Match is case-insensitive substring / equality on the item name.
  Longer, more specific keys win over generic ones.

Admins can override any item's nutrition via the Item master (the
`nutrition` map stored on `meal_items` beats this lookup).
"""
from __future__ import annotations

# key: canonical lower-case name-fragment
# value: dict of per-100g macros + optional grams_per_unit for count units
_NUTRITION: dict[str, dict[str, float]] = {
    # ── Cereals & grains ─────────────────────────────
    "rice":         {"kcal": 355, "protein_g": 7,  "carbs_g": 78, "fat_g": 1,   "fibre_g": 1},
    "basmati":      {"kcal": 349, "protein_g": 8,  "carbs_g": 77, "fat_g": 0.5, "fibre_g": 1},
    "atta":         {"kcal": 340, "protein_g": 12, "carbs_g": 72, "fat_g": 2,   "fibre_g": 11},
    "wheat":        {"kcal": 340, "protein_g": 12, "carbs_g": 72, "fat_g": 2,   "fibre_g": 11},
    "maida":        {"kcal": 362, "protein_g": 10, "carbs_g": 76, "fat_g": 1,   "fibre_g": 2},
    "suji":         {"kcal": 360, "protein_g": 12, "carbs_g": 73, "fat_g": 1,   "fibre_g": 3},
    "rava":         {"kcal": 360, "protein_g": 12, "carbs_g": 73, "fat_g": 1,   "fibre_g": 3},
    "poha":         {"kcal": 346, "protein_g": 7,  "carbs_g": 77, "fat_g": 1,   "fibre_g": 2},
    "oats":         {"kcal": 389, "protein_g": 17, "carbs_g": 66, "fat_g": 7,   "fibre_g": 10},
    "corn flakes":  {"kcal": 357, "protein_g": 7,  "carbs_g": 84, "fat_g": 0.4, "fibre_g": 3},
    "bread":        {"kcal": 265, "protein_g": 9,  "carbs_g": 49, "fat_g": 3,   "fibre_g": 3, "grams_per_unit": 400},
    "vermicelli":   {"kcal": 355, "protein_g": 12, "carbs_g": 71, "fat_g": 1,   "fibre_g": 3},

    # ── Pulses / dals ────────────────────────────────
    "toor dal":     {"kcal": 343, "protein_g": 22, "carbs_g": 62, "fat_g": 1.5, "fibre_g": 15},
    "arhar":        {"kcal": 343, "protein_g": 22, "carbs_g": 62, "fat_g": 1.5, "fibre_g": 15},
    "moong":        {"kcal": 347, "protein_g": 24, "carbs_g": 63, "fat_g": 1.2, "fibre_g": 16},
    "chana dal":    {"kcal": 364, "protein_g": 20, "carbs_g": 60, "fat_g": 6,   "fibre_g": 12},
    "urad":         {"kcal": 341, "protein_g": 25, "carbs_g": 58, "fat_g": 1.6, "fibre_g": 18},
    "masoor":       {"kcal": 352, "protein_g": 25, "carbs_g": 63, "fat_g": 1.1, "fibre_g": 11},
    "rajma":        {"kcal": 333, "protein_g": 24, "carbs_g": 60, "fat_g": 0.8, "fibre_g": 25},
    "chickpea":     {"kcal": 364, "protein_g": 19, "carbs_g": 61, "fat_g": 6,   "fibre_g": 17},
    "chana":        {"kcal": 364, "protein_g": 19, "carbs_g": 61, "fat_g": 6,   "fibre_g": 17},
    "peanut":       {"kcal": 567, "protein_g": 26, "carbs_g": 16, "fat_g": 49,  "fibre_g": 9},

    # ── Vegetables ────────────────────────────────────
    "potato":       {"kcal": 77,  "protein_g": 2,   "carbs_g": 17, "fat_g": 0.1, "fibre_g": 2, "grams_per_unit": 150},
    "onion":        {"kcal": 40,  "protein_g": 1.1, "carbs_g": 9,  "fat_g": 0.1, "fibre_g": 1.7, "grams_per_unit": 110},
    "tomato":       {"kcal": 18,  "protein_g": 0.9, "carbs_g": 3.9,"fat_g": 0.2, "fibre_g": 1.2, "grams_per_unit": 100},
    "cucumber":     {"kcal": 16,  "protein_g": 0.7, "carbs_g": 3.6,"fat_g": 0.1, "fibre_g": 0.5, "grams_per_unit": 250},
    "carrot":       {"kcal": 41,  "protein_g": 0.9, "carbs_g": 10, "fat_g": 0.2, "fibre_g": 2.8, "grams_per_unit": 60},
    "cabbage":      {"kcal": 25,  "protein_g": 1.3, "carbs_g": 5.8,"fat_g": 0.1, "fibre_g": 2.5, "grams_per_unit": 700},
    "cauliflower":  {"kcal": 25,  "protein_g": 1.9, "carbs_g": 5,  "fat_g": 0.3, "fibre_g": 2,   "grams_per_unit": 600},
    "brinjal":      {"kcal": 25,  "protein_g": 1,   "carbs_g": 6,  "fat_g": 0.2, "fibre_g": 3,   "grams_per_unit": 250},
    "capsicum":     {"kcal": 20,  "protein_g": 1,   "carbs_g": 4.6,"fat_g": 0.2, "fibre_g": 1.7, "grams_per_unit": 120},
    "beans":        {"kcal": 31,  "protein_g": 1.8, "carbs_g": 7,  "fat_g": 0.1, "fibre_g": 3.4},
    "peas":         {"kcal": 81,  "protein_g": 5,   "carbs_g": 14, "fat_g": 0.4, "fibre_g": 5},
    "spinach":      {"kcal": 23,  "protein_g": 2.9, "carbs_g": 3.6,"fat_g": 0.4, "fibre_g": 2.2, "grams_per_unit": 100},
    "palak":        {"kcal": 23,  "protein_g": 2.9, "carbs_g": 3.6,"fat_g": 0.4, "fibre_g": 2.2, "grams_per_unit": 100},
    "methi":        {"kcal": 49,  "protein_g": 4.4, "carbs_g": 6,  "fat_g": 0.9, "fibre_g": 1,   "grams_per_unit": 100},
    "coriander":    {"kcal": 23,  "protein_g": 2.1, "carbs_g": 3.7,"fat_g": 0.5, "fibre_g": 2.8, "grams_per_unit": 100},
    "curry leaves": {"kcal": 108, "protein_g": 6,   "carbs_g": 19, "fat_g": 1,   "fibre_g": 6,   "grams_per_unit": 20},
    "green chilli": {"kcal": 40,  "protein_g": 2,   "carbs_g": 9,  "fat_g": 0.2, "fibre_g": 1.5, "grams_per_unit": 5},
    "ginger":       {"kcal": 80,  "protein_g": 1.8, "carbs_g": 18, "fat_g": 0.8, "fibre_g": 2},
    "garlic":       {"kcal": 149, "protein_g": 6,   "carbs_g": 33, "fat_g": 0.5, "fibre_g": 2.1},
    "lemon":        {"kcal": 29,  "protein_g": 1.1, "carbs_g": 9,  "fat_g": 0.3, "fibre_g": 2.8, "grams_per_unit": 60},
    "lime":         {"kcal": 30,  "protein_g": 0.7, "carbs_g": 11, "fat_g": 0.2, "fibre_g": 2.8, "grams_per_unit": 60},

    # ── Fruits ────────────────────────────────────────
    "banana":       {"kcal": 89,  "protein_g": 1.1, "carbs_g": 23, "fat_g": 0.3, "fibre_g": 2.6, "grams_per_unit": 120},
    "apple":        {"kcal": 52,  "protein_g": 0.3, "carbs_g": 14, "fat_g": 0.2, "fibre_g": 2.4, "grams_per_unit": 180},
    "orange":       {"kcal": 47,  "protein_g": 0.9, "carbs_g": 12, "fat_g": 0.1, "fibre_g": 2.4, "grams_per_unit": 130},
    "mango":        {"kcal": 60,  "protein_g": 0.8, "carbs_g": 15, "fat_g": 0.4, "fibre_g": 1.6, "grams_per_unit": 200},
    "grapes":       {"kcal": 69,  "protein_g": 0.7, "carbs_g": 18, "fat_g": 0.2, "fibre_g": 0.9},
    "watermelon":   {"kcal": 30,  "protein_g": 0.6, "carbs_g": 8,  "fat_g": 0.2, "fibre_g": 0.4},
    "papaya":       {"kcal": 43,  "protein_g": 0.5, "carbs_g": 11, "fat_g": 0.3, "fibre_g": 1.7},

    # ── Dairy & eggs ─────────────────────────────────
    "milk":         {"kcal": 65,  "protein_g": 3.3, "carbs_g": 5,   "fat_g": 3.5, "fibre_g": 0},   # per 100 ml
    "curd":         {"kcal": 60,  "protein_g": 3.5, "carbs_g": 4.7, "fat_g": 3.3, "fibre_g": 0},
    "dahi":         {"kcal": 60,  "protein_g": 3.5, "carbs_g": 4.7, "fat_g": 3.3, "fibre_g": 0},
    "yoghurt":      {"kcal": 60,  "protein_g": 3.5, "carbs_g": 4.7, "fat_g": 3.3, "fibre_g": 0},
    "paneer":       {"kcal": 296, "protein_g": 18,  "carbs_g": 6,   "fat_g": 22,  "fibre_g": 0},
    "cheese":       {"kcal": 402, "protein_g": 25,  "carbs_g": 1.3, "fat_g": 33,  "fibre_g": 0},
    "butter":       {"kcal": 717, "protein_g": 0.9, "carbs_g": 0.1, "fat_g": 81,  "fibre_g": 0},
    "ghee":         {"kcal": 900, "protein_g": 0,   "carbs_g": 0,   "fat_g": 100, "fibre_g": 0},
    "egg":          {"kcal": 155, "protein_g": 13,  "carbs_g": 1.1, "fat_g": 11,  "fibre_g": 0, "grams_per_unit": 50},

    # ── Meat / protein ────────────────────────────────
    "chicken":      {"kcal": 165, "protein_g": 31, "carbs_g": 0,  "fat_g": 3.6, "fibre_g": 0},
    "mutton":       {"kcal": 294, "protein_g": 25, "carbs_g": 0,  "fat_g": 21,  "fibre_g": 0},
    "fish":         {"kcal": 206, "protein_g": 22, "carbs_g": 0,  "fat_g": 12,  "fibre_g": 0},
    "prawn":        {"kcal": 99,  "protein_g": 24, "carbs_g": 0.2,"fat_g": 0.3, "fibre_g": 0},

    # ── Oils, sugar, spices, misc ─────────────────────
    "oil":          {"kcal": 884, "protein_g": 0, "carbs_g": 0,  "fat_g": 100, "fibre_g": 0},   # per 100 ml (density ~0.92)
    "sugar":        {"kcal": 387, "protein_g": 0, "carbs_g": 100,"fat_g": 0,   "fibre_g": 0},
    "jaggery":      {"kcal": 383, "protein_g": 0.4, "carbs_g": 98,"fat_g": 0.1,"fibre_g": 0},
    "salt":         {"kcal": 0,   "protein_g": 0, "carbs_g": 0,  "fat_g": 0,   "fibre_g": 0},
    "tea":          {"kcal": 1,   "protein_g": 0.1, "carbs_g": 0.3,"fat_g": 0, "fibre_g": 0},
    "coffee":       {"kcal": 2,   "protein_g": 0.1, "carbs_g": 0, "fat_g": 0,  "fibre_g": 0},
    "biscuit":      {"kcal": 480, "protein_g": 6, "carbs_g": 65, "fat_g": 21,  "fibre_g": 2},
    "cashew":       {"kcal": 553, "protein_g": 18, "carbs_g": 30,"fat_g": 44,  "fibre_g": 3},
    "almond":       {"kcal": 579, "protein_g": 21, "carbs_g": 22,"fat_g": 50,  "fibre_g": 12},
    "raisin":       {"kcal": 299, "protein_g": 3, "carbs_g": 79, "fat_g": 0.5, "fibre_g": 4},
    "kishmish":     {"kcal": 299, "protein_g": 3, "carbs_g": 79, "fat_g": 0.5, "fibre_g": 4},
    "dates":        {"kcal": 277, "protein_g": 2, "carbs_g": 75, "fat_g": 0.2, "fibre_g": 7,   "grams_per_unit": 8},

    # ── Non-food (skipped for macros) ────────────────
    "detergent":    None,
    "soap":         None,
    "phenyl":       None,
    "napkin":       None,
    "tissue":       None,
    "bleach":       None,
}


# Precomputed ordered list — longer keys first so "chana dal" wins over "chana".
_KEYS = sorted(
    (k for k, v in _NUTRITION.items() if v is not None),
    key=lambda s: (-len(s), s),
)


def lookup(name: str) -> dict | None:
    """Return per-100g nutrition dict for the given item name, or None
    if no match is found. Case-insensitive substring match; the longest
    matching key wins."""
    if not name:
        return None
    n = name.lower()
    if n in _NUTRITION:
        return _NUTRITION[n] if _NUTRITION[n] else None
    for key in _KEYS:
        if key in n:
            return _NUTRITION[key]
    return None


# Volume → weight conversion assumption (cooking liquids ≈ 1 g/ml)
_UNIT_TO_GRAMS: dict[str, float] = {
    "kg": 1000.0,
    "g":  1.0,
    "gm": 1.0,
    "gms": 1.0,
    "grams": 1.0,
    "l":  1000.0,
    "lt": 1000.0,
    "ltr": 1000.0,
    "liter": 1000.0,
    "litre": 1000.0,
    "ml":  1.0,
    "mls": 1.0,
}


def qty_to_grams(qty: float, unit: str | None, override_grams_per_unit: float | None = None) -> float | None:
    """Convert a purchase-line qty to grams. Returns None if the unit
    is non-weight/volume AND no `grams_per_unit` override is provided
    (chef must set it on the item, else nutrition for that line is
    skipped)."""
    if not qty:
        return 0.0
    u = (unit or "").strip().lower()
    if u in _UNIT_TO_GRAMS:
        return float(qty) * _UNIT_TO_GRAMS[u]
    if override_grams_per_unit and override_grams_per_unit > 0:
        return float(qty) * float(override_grams_per_unit)
    return None
