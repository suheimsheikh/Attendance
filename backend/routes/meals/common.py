"""Module-level models, constants and pure helpers shared by the meals routes."""
from __future__ import annotations

import asyncio
import json
import logging
import math
import uuid
from datetime import date, datetime, timedelta
from typing import List, Optional

import jwt
from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse

from services.auth_utils import JWT_ALGO, JWT_SECRET
from services.client_ctx import current_client_id
from pydantic import BaseModel, Field
from pymongo.errors import DuplicateKeyError

from services.time_utils import local_date_str, local_now, now_utc, office_tz
from services.photo import member_photo_url
from services.permissions import is_ex_member, is_super_admin
from services.scope import scoped_user_query as _scoped_user_query_shared
from services.nutrition_seed import lookup as _nutri_lookup, qty_to_grams as _qty_to_grams
from config import MAX_USERS

logger = logging.getLogger("routes.meals")


DEFAULT_MEAL_CUTOFF = "07:00"
DEFAULT_LUNCH_CUTOFF = "10:00"
DEFAULT_DINNER_CUTOFF = "18:00"
SEEDED_CATEGORY_KEYS = {"athlete", "elite", "coach", "staff", "executive"}
VALID_COLORS = {"sky", "rose", "emerald", "amber", "violet", "slate"}

# ---------------------------------------------------------------------------
# Meal muster (23 Feb 2026)
# ---------------------------------------------------------------------------
# The Chef's View above INFERS meal counts from attendance-timing overlaps.
# The endpoints below are the opposite: an EXPLICIT paper-trail of who
# actually ate, ticked off by admins/chefs/coaches from a Muster-style
# roster. Stored one row per (member, date, meal) in `meal_records` with a
# compound unique index so a double-tap can't create duplicates.
MEAL_KEYS: tuple[str, ...] = ("breakfast", "midmorning", "lunch", "snacks", "dinner")
MEAL_LABELS: dict[str, str] = {
    "breakfast":  "Breakfast",
    "midmorning": "Midmorning Snack",
    "lunch":      "Lunch",
    "snacks":     "Afternoon Snack",
    "dinner":     "Dinner",
}
MEAL_SHORT: dict[str, str] = {
    "breakfast":  "BF",
    "midmorning": "MM",
    "lunch":      "L",
    "snacks":     "AS",
    "dinner":     "D",
}


# ---------------------------------------------------------------------------
# Meal purchases & expense report (Jun 2026)
# ---------------------------------------------------------------------------
PURCHASE_CFG_ID = "meal_purchase_categories"
DEFAULT_PURCHASE_CATEGORIES = [
    {"key": "fruits",         "label": "Fruits"},
    {"key": "grocery",        "label": "Grocery"},
    {"key": "vegetables",     "label": "Vegetables"},
    {"key": "chicken_mutton", "label": "Chicken/Mutton"},
    {"key": "paneer",         "label": "Paneer"},
]

# Fixed list of stocking units offered when creating an item. Fixed list
# (rather than free-text) keeps stock math consistent across the app —
# users choose the unit once when defining the item, then every purchase
# and issue for that item inherits it.
VALID_UNITS = ("kg", "g", "L", "mL", "pcs", "dozen", "packet")


def _slug_key(label: str) -> str:
    import re
    s = re.sub(r"[^a-z0-9]+", "_", (label or "").strip().lower()).strip("_")
    return s or "item"


def _norm_header(s: str) -> str:
    import re
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _parse_any_date(v) -> Optional[str]:
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    s = str(v or "").strip()
    if not s:
        return None
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def _parse_amount(v) -> Optional[float]:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(",", "").replace("₹", "").replace("Rs.", "").replace("Rs", "")
    if not s or s in ("-", "—"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


class PurchaseCategoryItem(BaseModel):
    key: Optional[str] = None
    label: str = Field(..., min_length=1, max_length=60)
    active: Optional[bool] = None


class PurchaseCategoriesIn(BaseModel):
    categories: List[PurchaseCategoryItem]


class PurchaseUpsertIn(BaseModel):
    # Legacy path — kept for the bulk-CSV importer and older clients that
    # still POST a `{category_key: amount}` map. New clients POST `lines`.
    amounts: Optional[dict] = None
    lines: Optional[List[dict]] = None


class ItemIn(BaseModel):
    """Body for creating a new stock item under a purchase category."""
    category_key: str = Field(..., min_length=1, max_length=60)
    name: str = Field(..., min_length=1, max_length=80)
    unit: str
    opening_stock: float = 0.0
    opening_stock_as_of: Optional[str] = None   # ISO date; defaults to today
    opening_rate: float = 0.0                   # ₹/unit cost of opening stock; 0 = unknown
    min_stock: float = 0.0                      # low-stock alert level; 0 = off
    norm_per_serving: float = 0.0               # expected qty per meal serving; 0 = untracked
    sort_order: int = 100
    subcategory_key: Optional[str] = None       # optional grouping within a category
    # Optional per-item nutrition override (per 100 g):
    #   {kcal, protein_g, carbs_g, fat_g, fibre_g, grams_per_unit}
    # Any/all keys may be omitted. Falls back to the built-in
    # nutrition_seed lookup when None.
    nutrition: Optional[dict] = None


class ItemPatch(BaseModel):
    category_key: Optional[str] = None
    name: Optional[str] = None
    unit: Optional[str] = None
    opening_stock: Optional[float] = None
    opening_stock_as_of: Optional[str] = None
    opening_rate: Optional[float] = None
    min_stock: Optional[float] = None
    norm_per_serving: Optional[float] = None
    sort_order: Optional[int] = None
    subcategory_key: Optional[str] = None       # "" or null clears the grouping
    active: Optional[bool] = None
    nutrition: Optional[dict] = None
    grams_per_unit: Optional[float] = None      # grams in ONE pantry unit (e.g. 1 dozen = 1440); 0 clears


class ItemsReorderIn(BaseModel):
    """Body for PUT /api/meals/items/reorder — drag-and-drop ordering
    of items within one category from the Masters tree."""
    category_key: str
    item_ids: List[str]


class SubcatIn(BaseModel):
    category_key: str = Field(..., min_length=1, max_length=60)
    name: str = Field(..., min_length=1, max_length=60)


class SubcatPatch(BaseModel):
    name: Optional[str] = None
    order: Optional[int] = None
    active: Optional[bool] = None



class IssuesUpsertIn(BaseModel):
    """Body for PUT /api/meals/issues/{date}. `lines` is a list of
    `{item_id, qty}` entries — unit is inherited from the item master."""
    lines: List[dict]


class LinesPatchIn(BaseModel):
    """Body for PATCH /api/meals/purchases/{date} and /meals/issues/{date}.
    Granular per-line merge (Jun 2026 multi-machine fix): the client sends
    ONLY the lines it actually edited, so two machines entering different
    items on the same day never overwrite each other (the old PUT replaced
    the whole day's lines wholesale — last writer wiped the other's rows)."""
    upserts: List[dict] = Field(default_factory=list)
    removes: List[str] = Field(default_factory=list)


# Vendors master (Aug 2026). Very light — just name + phone — used to
# annotate each purchase line so the accountant can trace which supplier
# a given day's veg / grocery / milk bill came from. Storing the
# `vendor_id` on the purchase line keeps history stable if a vendor is
# later renamed.
class VendorIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    phone: Optional[str] = Field(default=None, max_length=20)


class VendorPatch(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    phone: Optional[str] = Field(default=None, max_length=20)
    active: Optional[bool] = None


# Wastage & losses — separate event log so consumption vs loss is easy
# to split in reports. Each line: {item_id, qty, reason, notes?}. Reason
# picked from a fixed list so category totals stay clean; free-text
# `notes` gives the chef space to explain (e.g. "left in sun, spoiled").
VALID_WASTAGE_REASONS = ("wasted", "spoilt", "rotten", "lost", "damaged", "other")


class WastageUpsertIn(BaseModel):
    lines: List[dict]


class StockTakeIn(BaseModel):
    """Body for POST /api/meals/stock-take — a weekly physical count.
    `lines` is a list of `{item_id, physical_qty, notes?}`. The server
    computes the variance vs system on-hand and posts a signed
    adjustment line (loss/extra) so the continuous ledger reconciles to
    the counted number."""
    date: str
    lines: List[dict]


class MealMarkIn(BaseModel):
    """Body for /api/meals/mark-bulk and /api/meals/unmark-bulk.
    Defined at module scope (not inside make_router) so `from __future__
    import annotations` + FastAPI's `get_type_hints()` can resolve the
    forward reference at route-decoration time."""
    meal: str
    date: str            # ISO YYYY-MM-DD, office-local
    user_ids: List[str]


class CategoryIn(BaseModel):
    """Body for creating a new category.

    `key` is normalised to lowercase and used as the persisted category
    value on user records — cannot be changed after creation. `label` is
    the human-facing string shown on tiles and dropdowns. `color` picks
    the tile tint (matches TICKET_STYLE on the frontend). New categories
    default to `meal_eligible=False` and `is_athlete_like=False` — the
    admin can flip these explicitly.
    """
    key: str = Field(..., min_length=2, max_length=40)
    label: str = Field(..., min_length=2, max_length=60)
    color: str = "slate"
    is_athlete_like: bool = False
    meal_eligible: bool = False
    sort_order: int = 100


class CategoryPatch(BaseModel):
    key: Optional[str] = None  # rename support — cascades to db.users.category
    label: Optional[str] = None
    color: Optional[str] = None
    is_athlete_like: Optional[bool] = None
    meal_eligible: Optional[bool] = None
    sort_order: Optional[int] = None
    active: Optional[bool] = None


def _valid_hm(s: str) -> bool:
    try:
        h, m = s.split(":")[:2]
        h, m = int(h), int(m)
        return 0 <= h <= 23 and 0 <= m <= 59
    except (ValueError, AttributeError, TypeError):
        return False


def _parse_hm(cutoff: str) -> tuple[int, int]:
    if not _valid_hm(cutoff):
        raise HTTPException(status_code=400, detail="cutoff must be HH:MM (00:00–23:59)")
    h, m = cutoff.split(":")[:2]
    return int(h), int(m)


def _earliest_check_in_before(sessions: list[dict], cutoff_utc: str) -> Optional[str]:
    """Breakfast eligibility: return the member's earliest check_in_at
    on the day IF it lands at-or-before the breakfast cut-off. `None`
    means they arrived too late (skip). Extracted from meals_today so
    the rule is unit-testable in isolation."""
    cis = sorted([s["check_in_at"] for s in sessions if s.get("check_in_at")])
    if cis and cis[0] <= cutoff_utc:
        return cis[0]
    return None


def _covering_session_check_in(sessions: list[dict], anchor_utc: str) -> Optional[str]:
    """Lunch / Dinner eligibility: return the check_in_at of the FIRST
    session that "covers" the anchor time — i.e. checked in ≤ anchor
    and either has no checkout yet or checked out AFTER the anchor.
    `None` means the member was off-campus at the anchor moment.

    Ordering: iterates in list order. Callers pass `by_user[uid]` which
    Mongo returns in insertion order (chronological on this collection).
    """
    for s in sessions:
        ci = s.get("check_in_at")
        co = s.get("check_out_at")
        if not ci or ci > anchor_utc:
            continue
        if co is None or co > anchor_utc:
            return ci
    return None


# ── Kitchen analytics helpers (extracted from `kitchen_analytics` in
#    the Feb 2026 complexity pass — pure functions, testable in
#    isolation, no DB access). ─────────────────────────────────────────
def _weighted_rate_lookup(purch_qty: dict, purch_amt: dict, snap_rate: dict):
    """Return a `rate_for(item_id) -> float` closure that yields the
    weighted-average purchase rate for `item_id` in the current window,
    falling back to the stock snapshot avg_rate when the item wasn't
    purchased. Used to value issues at comparable rupees vs purchases."""
    def rate_for(iid: str) -> float:
        if purch_qty.get(iid, 0) > 0:
            return purch_amt[iid] / purch_qty[iid]
        return snap_rate.get(iid, 0.0)
    return rate_for


def _kitchen_daily_series(daily: dict) -> list:
    """Format a `{date: {amount, qty, lines, …}}` roll-up as a
    sorted-by-date list of chart-ready rows."""
    return [
        {"date": d,
         "amount": round(v["amount"], 2),
         "qty":    round(v["qty"], 3),
         "lines":  v["lines"],
         "cat":    {k: round(a, 2) for k, a in (v.get("cat") or {}).items()}}
        for d, v in sorted(daily.items())
    ]


def _kitchen_item_rows(items_agg: dict, by_id: dict, cat_label: dict) -> list:
    """Format a `{item_id: {qty, amount, lines}}` roll-up as a list
    of table rows, hydrated with the item's name / unit / category
    labels from the master maps, and sorted by amount desc."""
    rows = []
    for iid, v in items_agg.items():
        info = by_id.get(iid) or {}
        ckey = info.get("category_key")
        rows.append({
            "item_id": iid,
            "name":    info.get("name") or "(deleted item)",
            "unit":    info.get("unit"),
            "category_key":   ckey,
            "category_label": cat_label.get(ckey, (ckey or "").replace("_", " ").title()),
            "qty":    round(v["qty"], 3),
            "amount": round(v["amount"], 2),
            "lines":  v["lines"],
        })
    rows.sort(key=lambda r: r["amount"], reverse=True)
    return rows


def _kitchen_cat_pct(cat_agg: dict, cat_label: dict) -> list:
    """Format a `{category_key: rupee_amount}` roll-up as the % pie
    the frontend expects. Uses 1.0 as the total-denominator floor so
    an empty window returns 0% rows instead of dividing by zero."""
    total = sum(cat_agg.values()) or 1.0
    rows = [
        {"key":    k,
         "label":  cat_label.get(k, k.replace("_", " ").title()),
         "amount": round(v, 2),
         "pct":    round(v * 100.0 / total, 1)}
        for k, v in cat_agg.items()
    ]
    rows.sort(key=lambda r: r["amount"], reverse=True)
    return rows


class OverheadIn(BaseModel):
    """Monthly kitchen overhead entry — staff wage bill (+ optional
    incidentals). Folded into cost-per-meal, apportioned equally per day."""
    staff_wages: float = Field(ge=0)
    incidentals: float = Field(default=0, ge=0)
    note: Optional[str] = None


class OverheadBackfillIn(BaseModel):
    default_wages: float = Field(default=75000, ge=0)
    overwrite: bool = False


class DailyCountsIn(BaseModel):
    """Body for PUT /api/meals/meal-calendar (daily meal-count aggregate).
    Module scope: with `from __future__ import annotations`, FastAPI can only
    resolve body models that are module globals."""
    date: str
    breakfast: int = 0
    midmorning: int = 0
    lunch: int = 0
    snacks: int = 0
    dinner: int = 0
