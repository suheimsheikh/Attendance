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
from services.permissions import is_ex_member
from services.scope import scoped_user_query as _scoped_user_query_shared
from config import MAX_USERS

logger = logging.getLogger(__name__)


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
MEAL_KEYS: tuple[str, ...] = ("breakfast", "lunch", "snacks", "dinner")
MEAL_LABELS: dict[str, str] = {
    "breakfast": "Breakfast",
    "lunch":     "Lunch",
    "snacks":    "Snacks / Tea",
    "dinner":    "Dinner",
}
MEAL_SHORT: dict[str, str] = {
    "breakfast": "BF",
    "lunch":     "L",
    "snacks":    "S",
    "dinner":    "D",
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
    active: Optional[bool] = None


class ItemsReorderIn(BaseModel):
    """Body for PUT /api/meals/items/reorder — drag-and-drop ordering
    of items within one category from the Masters tree."""
    category_key: str
    item_ids: List[str]


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


def make_router(db, require_admin, get_current_user, require_chef_or_admin=None) -> APIRouter:
    router = APIRouter(prefix="/api")
    # Fallback so tests that don't pass the chef dep still work — treat
    # chef-or-admin as admin-only. Production wires the real dep from
    # server.py. Added 4 Feb 2026 with the Roles master.
    if require_chef_or_admin is None:
        require_chef_or_admin = require_admin

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

    # ------------------------------------------------------------------
    # Categories master — full CRUD (8 Jul 2026). The 5 seed categories
    # (athlete/elite/coach/staff/executive) can be renamed/recoloured
    # but their `key` is locked and they cannot be deleted (backend rules
    # branch on those keys for OT, leave, and expected-daily semantics).
    # Anyone signed in may read (so the Members-form dropdown works);
    # only admins may write.
    # ------------------------------------------------------------------
    @router.get("/masters/categories")
    async def list_categories(
        include_inactive: bool = Query(False),
        user: dict = Depends(get_current_user),
    ):
        q = {} if include_inactive else {"active": True}
        rows = await db.categories.find(q, {"_id": 0}) \
            .sort("sort_order", 1).to_list(50)
        # Hydrate member counts so the admin UI can show "42 members" per
        # row and disable delete on non-empty categories.
        pipeline = [{"$group": {"_id": "$category", "n": {"$sum": 1}}}]
        counts = {c["_id"]: c["n"] async for c in db.users.aggregate(pipeline) if c["_id"]}
        for r in rows:
            r["member_count"] = counts.get(r["key"], 0)
            r["is_seeded"] = r["key"] in SEEDED_CATEGORY_KEYS
        return rows

    @router.post("/masters/categories")
    async def create_category(body: CategoryIn, user: dict = Depends(require_chef_or_admin)):
        key = body.key.strip().lower()
        if not key.replace("_", "").isalnum():
            raise HTTPException(status_code=400,
                                detail="Key must be alphanumeric (underscores allowed).")
        if body.color not in VALID_COLORS:
            raise HTTPException(status_code=400,
                                detail=f"color must be one of {sorted(VALID_COLORS)}")
        if await db.categories.find_one({"key": key}):
            raise HTTPException(status_code=409, detail="A category with that key already exists.")
        doc = {
            "id": str(uuid.uuid4()),
            "key": key,
            "label": body.label.strip(),
            "color": body.color,
            "is_athlete_like": bool(body.is_athlete_like),
            "meal_eligible": bool(body.meal_eligible),
            "sort_order": int(body.sort_order),
            "active": True,
            "created_at": now_utc().isoformat(),
            "created_by": user.get("id"),
        }
        await db.categories.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @router.patch("/masters/categories/{cat_id}")
    async def update_category(
        cat_id: str, body: CategoryPatch, user: dict = Depends(require_chef_or_admin)
    ):
        row = await db.categories.find_one({"id": cat_id}, {"_id": 0})
        if not row:
            raise HTTPException(status_code=404, detail="Category not found")
        update = {}
        # ── Key rename (cascade to member records) ───────────────────────────
        # Seeded categories cannot be renamed because they're referenced by
        # hard-coded rule sets elsewhere (OVERTIME_CATEGORIES, ATHLETE_CATEGORIES).
        # Custom categories can be renamed; we cascade the new key into every
        # user record so no member ends up orphaned.
        if body.key is not None:
            new_key = body.key.strip().lower()
            if not new_key or not all(c.isalnum() or c == "_" for c in new_key):
                raise HTTPException(status_code=400,
                                    detail="key must be lowercase alphanumeric + underscore only")
            if new_key != row["key"]:
                if row["key"] in SEEDED_CATEGORY_KEYS:
                    raise HTTPException(status_code=409,
                                        detail="Seeded categories cannot be renamed — they're referenced by hard-coded rules.")
                # Reject if another category (seeded or otherwise) already owns the new key.
                clash = await db.categories.find_one({"key": new_key, "id": {"$ne": cat_id}})
                if clash or new_key in SEEDED_CATEGORY_KEYS:
                    raise HTTPException(status_code=409, detail=f"key '{new_key}' is already in use")
                # Cascade to member records — set BEFORE flipping the category
                # doc so a mid-flight member fetch never sees a dangling ref.
                cascade = await db.users.update_many(
                    {"category": row["key"]}, {"$set": {"category": new_key}}
                )
                update["key"] = new_key
                # Stash cascade info on the returned row for the UI toast.
                row["_cascaded_members"] = int(cascade.modified_count)
        if body.label is not None:
            update["label"] = body.label.strip()
        if body.color is not None:
            if body.color not in VALID_COLORS:
                raise HTTPException(status_code=400,
                                    detail=f"color must be one of {sorted(VALID_COLORS)}")
            update["color"] = body.color
        if body.is_athlete_like is not None:
            update["is_athlete_like"] = bool(body.is_athlete_like)
        if body.meal_eligible is not None:
            update["meal_eligible"] = bool(body.meal_eligible)
        if body.sort_order is not None:
            update["sort_order"] = int(body.sort_order)
        if body.active is not None:
            # Prevent deactivating a seeded category — it's referenced by
            # rules (OVERTIME_CATEGORIES, ATHLETE_CATEGORIES, etc.).
            if not body.active and row["key"] in SEEDED_CATEGORY_KEYS:
                raise HTTPException(
                    status_code=409,
                    detail="Seeded categories cannot be deactivated. Rename instead if needed.",
                )
            update["active"] = bool(body.active)
        if not update:
            return row
        await db.categories.update_one({"id": cat_id}, {"$set": update})
        row.update(update)
        return row

    @router.delete("/masters/categories/{cat_id}")
    async def delete_category(cat_id: str, admin: dict = Depends(require_admin)):
        row = await db.categories.find_one({"id": cat_id}, {"_id": 0})
        if not row:
            raise HTTPException(status_code=404, detail="Category not found")
        if row["key"] in SEEDED_CATEGORY_KEYS:
            raise HTTPException(status_code=409,
                                detail="Seeded categories are protected — rename instead.")
        in_use = await db.users.count_documents({"category": row["key"]})
        if in_use > 0:
            raise HTTPException(
                status_code=409,
                detail=f"{in_use} member(s) still use this category — reassign first.",
            )
        await db.categories.delete_one({"id": cat_id})
        return {"ok": True}

    # ------------------------------------------------------------------
    # Chef's View
    # ------------------------------------------------------------------
    @router.get("/admin/meals-today")
    async def meals_today(
        cutoff: Optional[str] = Query(None, description="HH:MM breakfast cut-off override (defaults to office setting)"),
        lunch_cutoff: Optional[str] = Query(None, description="HH:MM lunch anchor time — members still on campus at this time count"),
        dinner_cutoff: Optional[str] = Query(None, description="HH:MM dinner anchor time — members still on campus at this time count"),
        date_str: Optional[str] = Query(None, alias="date", description="YYYY-MM-DD (defaults to today, office-local)"),
        admin: dict = Depends(require_chef_or_admin),
    ):
        """Return meal-eligible members split across the three daily
        meal windows (breakfast / lunch / dinner).

        Rules:
          • **Breakfast** — members whose earliest check-in is ≤
            `breakfast_cutoff` (e.g. 07:00). Same rule as the original
            Chef's View.
          • **Lunch** — members "still on campus at `lunch_cutoff`"
            (default 10:00). I.e. any attendance session with
            `check_in_at ≤ lunch_cutoff` AND (no `check_out_at` yet OR
            `check_out_at > lunch_cutoff`).
          • **Dinner** — same rule as lunch but anchored to
            `dinner_cutoff` (default 18:00).

        Cut-off resolution: query param > office setting > module
        default. Config keys on `office`: `meal_breakfast_cutoff`,
        `meal_lunch_cutoff`, `meal_dinner_cutoff`.
        """
        office = await db.config.find_one({"id": "office"})

        def _resolve(param: Optional[str], office_key: str, default: str) -> tuple[str, int, int]:
            if param is not None:
                h, m = _parse_hm(param)
                return f"{h:02d}:{m:02d}", h, m
            cfg = (office or {}).get(office_key) or default
            if not _valid_hm(cfg):
                cfg = default
            h, m = _parse_hm(cfg)
            return cfg, h, m

        bf_str, bf_h, bf_m = _resolve(cutoff,        "meal_breakfast_cutoff", DEFAULT_MEAL_CUTOFF)
        lu_str, lu_h, lu_m = _resolve(lunch_cutoff,  "meal_lunch_cutoff",     DEFAULT_LUNCH_CUTOFF)
        di_str, di_h, di_m = _resolve(dinner_cutoff, "meal_dinner_cutoff",    DEFAULT_DINNER_CUTOFF)

        if date_str:
            try:
                today_d = date.fromisoformat(date_str)
                today_iso = today_d.isoformat()
            except ValueError:
                raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
        else:
            today_iso = local_date_str(office)
            today_d = date.fromisoformat(today_iso)
        tz = office_tz(office)
        # For today's date, compute "is this meal window locked in yet"
        # — i.e. has the clock crossed the anchor time? Before the
        # anchor passes, showing a provisional count is misleading
        # (members can still leave before the anchor), so we hide it.
        # Past dates are always locked.
        _local_today = local_date_str(office)
        _is_today = today_iso == _local_today
        _now_local = local_now(office) if _is_today else None
        def _locked(h: int, m: int) -> bool:
            if not _is_today:
                return True
            return (_now_local.hour, _now_local.minute) >= (h, m)

        # Build the three cut-off moments in office-local time then
        # convert to UTC ISO strings (attendance rows store UTC ISO).
        from datetime import timezone as _tz
        def _to_utc_iso(h: int, m: int) -> str:
            dt = datetime(today_d.year, today_d.month, today_d.day, h, m, 0, tzinfo=tz)
            return dt.astimezone(_tz.utc).isoformat()
        bf_utc = _to_utc_iso(bf_h, bf_m)
        lu_utc = _to_utc_iso(lu_h, lu_m)
        di_utc = _to_utc_iso(di_h, di_m)

        # One fetch covering every session in the day — we bucket
        # in-memory per meal window.
        attendances = await db.attendance.find(
            {"date": today_iso, "check_in_at": {"$ne": None}},
            {"_id": 0, "user_id": 1, "check_in_at": 1, "check_out_at": 1},
        ).to_list(10000)

        # Bucket sessions by user.
        by_user: dict[str, list[dict]] = {}
        for row in attendances:
            uid = row.get("user_id")
            if uid:
                by_user.setdefault(uid, []).append(row)

        # Meal-window membership functions.
        def _breakfast_eligible(sessions: list[dict]) -> Optional[str]:
            """Earliest check_in_at if it's ≤ breakfast cut-off."""
            cis = sorted([s["check_in_at"] for s in sessions if s.get("check_in_at")])
            if cis and cis[0] <= bf_utc:
                return cis[0]
            return None

        def _still_on_campus_at(sessions: list[dict], anchor_utc: str) -> Optional[str]:
            """Return the check_in_at of the covering session, or None."""
            for s in sessions:
                ci = s.get("check_in_at")
                co = s.get("check_out_at")
                if not ci or ci > anchor_utc:
                    continue
                if co is None or co > anchor_utc:
                    return ci
            return None

        # Fetch users + categories master (one shot, shared across
        # all three buckets).
        user_ids = list(by_user.keys())
        users_by_id: dict[str, dict] = {}
        if user_ids:
            users = await db.users.find(
                {"id": {"$in": user_ids}},
                {"_id": 0, "id": 1, "full_name": 1, "category": 1,
                 "photo_thumb": 1, "institution": 1, "fleet": 1},
            ).to_list(5000)
            users_by_id = {u["id"]: u for u in users}
        cats = await db.categories.find(
            {"active": True, "meal_eligible": True},
            {"_id": 0, "key": 1, "label": 1, "color": 1, "sort_order": 1},
        ).sort("sort_order", 1).to_list(50)
        cat_by_key = {c["key"]: c for c in cats}
        cat_order = {c["key"]: c.get("sort_order", 999) for c in cats}

        def _bucket(picker) -> dict:
            """Run `picker(sessions) -> Optional[check_in_at]` on every
            user and package into the shape the frontend expects."""
            members = []
            counts: dict[str, int] = {c["key"]: 0 for c in cats}
            for uid, sessions in by_user.items():
                ci = picker(sessions)
                if not ci:
                    continue
                u = users_by_id.get(uid)
                if not u:
                    continue
                key = u.get("category")
                if key not in cat_by_key:
                    continue
                counts[key] += 1
                members.append({
                    "id": uid,
                    "full_name": u.get("full_name"),
                    "category": key,
                    "photo_thumb": u.get("photo_thumb"),
                    "institution": u.get("institution"),
                    "fleet": u.get("fleet"),
                    "check_in_at": ci,
                })
            members.sort(key=lambda x: (cat_order.get(x["category"], 999),
                                         (x["full_name"] or "").lower()))
            return {"counts": counts, "total": sum(counts.values()), "members": members}

        breakfast = _bucket(_breakfast_eligible)
        lunch     = _bucket(lambda s: _still_on_campus_at(s, lu_utc))
        dinner    = _bucket(lambda s: _still_on_campus_at(s, di_utc))
        # Stamp lock state + zero-out unlocked buckets so the kitchen
        # never sees a premature estimate. Past dates always locked.
        for bucket_dict, (h, m) in (
            (breakfast, (bf_h, bf_m)),
            (lunch,     (lu_h, lu_m)),
            (dinner,    (di_h, di_m)),
        ):
            locked = _locked(h, m)
            bucket_dict["locked"] = locked
            if not locked:
                bucket_dict["counts"] = {c["key"]: 0 for c in cats}
                bucket_dict["total"] = 0
                bucket_dict["members"] = []

        return {
            "today": today_iso,
            "generated_at": now_utc().isoformat(),
            "categories": cats,
            "cutoffs": {
                "breakfast": bf_str,
                "lunch":     lu_str,
                "dinner":    di_str,
            },
            "breakfast": breakfast,
            "lunch":     lunch,
            "dinner":    dinner,
            # --- Legacy top-level fields — kept so any older client that
            # still reads `counts` / `members` / `total` / `cutoff` on
            # the root of the payload keeps working during rollout.
            "cutoff": bf_str,
            "configured_cutoff": (office or {}).get("meal_breakfast_cutoff") or DEFAULT_MEAL_CUTOFF,
            "counts": breakfast["counts"],
            "total":  breakfast["total"],
            "members": breakfast["members"],
        }

    # ==================================================================
    # Meal muster — explicit paper-trail (23 Feb 2026)
    # ------------------------------------------------------------------
    # A chef/admin/coach ticks a member and it's persisted in
    # `meal_records`. Different from Chef's View above, which INFERS
    # meal eligibility from attendance windows.
    # ==================================================================
    async def _scoped_meal_query(scope: str) -> dict:
        """Meal muster is admin/chef/coach only — no escort branch —
        so admins can always widen. Delegates to the shared helper in
        services.scope."""
        return await _scoped_user_query_shared(db, scope, admin_can_widen=True)

    def _valid_meal(meal: str) -> str:
        m = (meal or "").strip().lower()
        if m not in MEAL_KEYS:
            raise HTTPException(status_code=400,
                                detail=f"meal must be one of {list(MEAL_KEYS)}")
        return m

    def _valid_date(d: str) -> str:
        try:
            return date.fromisoformat(d).isoformat()
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")

    def _not_future(d: str) -> str:
        if d > local_date_str(None):
            raise HTTPException(status_code=400, detail="date cannot be in the future")
        return d

    # Note: the compound unique index `uniq_user_date_meal` is created
    # at app startup in `server.py::_lifespan`. Per-request builds were
    # dropped in the perf review (24 Feb 2026) — startup is the right
    # place for a one-shot idempotent operation.

    @router.get("/meals/config")
    async def meal_config(user: dict = Depends(get_current_user)):
        """Static list of meal keys/labels used by the frontend to render
        the meal switcher. Exposed as an endpoint (rather than hard-coded
        on the client) so a future admin-configurable meal list plugs in
        without a frontend release."""
        return {
            "meals": [
                {"key": k, "label": MEAL_LABELS[k], "short": MEAL_SHORT[k]}
                for k in MEAL_KEYS
            ],
        }

    @router.get("/meals/roster")
    async def meal_roster(
        meal: str,
        date: str,  # noqa: A002 — matches API contract; local name shadowed via `_valid_date`
        scope: str = "all",
        user: dict = Depends(require_chef_or_admin),
    ):
        """Return every member in the selected scope with an
        `already_marked` flag so the frontend can pre-tick rows already
        recorded for this (meal, date) tuple.

        Eligibility rules (aligned with Chef's View 24 Feb 2026):
          • Category must be `active=true AND meal_eligible=true` in
            the categories master. Executive/day-scholar categories
            can be flipped off there without touching this code.
          • Member must not be an ex-member as of the meal date —
            same `leaving_date < target` rule as Copy Yesterday and
            the other write-guarded endpoints. History stays intact;
            they just don't appear on the roster after their exit.
        """
        m = _valid_meal(meal)
        d = _valid_date(date)

        # Resolve meal-eligible category keys from the master. Cheap
        # (< 10 rows) — do it inline rather than plumbing a helper.
        eligible_cats = {
            c["key"] async for c in db.categories.find(
                {"active": True, "meal_eligible": True},
                {"_id": 0, "key": 1},
            )
        }

        q = await _scoped_meal_query(scope)
        # Exclude admin-only accounts — they don't eat mess meals.
        q["role"] = {"$ne": "admin"}
        # Push the category filter into the DB query so we don't drag
        # ineligible members over the wire only to drop them in Python.
        if eligible_cats:
            existing = q.get("category")
            if isinstance(existing, dict) and "$in" in existing:
                # Intersect with the scope filter's category set.
                q["category"] = {"$in": [k for k in existing["$in"] if k in eligible_cats]}
            elif isinstance(existing, dict) and "$nin" in existing:
                # `non_athletes` scope — keep it AS-IS and stack the
                # eligibility set on top via $and.
                q["$and"] = [
                    {"category": existing},
                    {"category": {"$in": list(eligible_cats)}},
                ]
                q.pop("category")
            elif isinstance(existing, str):
                # scope=staff / coach / executive → must be BOTH the
                # chosen category AND meal-eligible. If admin flipped
                # the category off, the roster is empty — correct.
                if existing not in eligible_cats:
                    q["category"] = {"$in": []}  # empty → no rows
            else:
                q["category"] = {"$in": list(eligible_cats)}
        # 20 Feb 2026: per-member `meal_eligible` override wins over the
        # category flag either way — bring users with an explicit True
        # back INTO the roster even if their category is off, and
        # exclude users with an explicit False from a category that is
        # on. Implemented as an $or across two branches so both cases
        # co-exist in a single query.
        base_q = dict(q)
        q = {"$or": [
            {**base_q, "meal_eligible": {"$ne": False}},   # category-eligible AND not explicitly excluded
            {"meal_eligible": True, "role": {"$ne": "admin"}},  # per-member opt-in even if category is off
        ]}
        users = await db.users.find(
            q,
            # Explicit fields — dropped full `photo` (25KB) in favor
            # of `photo_thumb` (3KB). Perf pass 24 Feb 2026.
            {"_id": 0, "id": 1, "full_name": 1, "rank": 1,
             "category": 1, "institution": 1, "photo_thumb": 1,
             "gender": 1, "leaving_date": 1,
             "father_mobile": 1, "mother_mobile": 1, "guardian_mobile": 1},
        ).to_list(MAX_USERS)

        marks = await db.meal_records.find(
            {"date": d, "meal": m},
            {"_id": 0, "user_id": 1},
        ).to_list(MAX_USERS)
        marked_ids = {r["user_id"] for r in marks}

        out = []
        for u in users:
            # Ex-member cutoff — checked against the meal date `d`,
            # not today (a chef marking yesterday's meal shouldn't be
            # blocked by today's leaving_date). Aligned with the
            # Copy-Yesterday rule: leaving_date < target ⇒ ex.
            if is_ex_member(u, today_iso=d):
                continue
            uid = u["id"]
            out.append({
                "id": uid,
                "full_name": u.get("full_name"),
                "rank": u.get("rank"),
                "category": u.get("category"),
                "institution": u.get("institution"),
                "gender": u.get("gender"),
                "photo": member_photo_url(u),
                "leaving_date": u.get("leaving_date"),
                "father_mobile": u.get("father_mobile"),
                "mother_mobile": u.get("mother_mobile"),
                "guardian_mobile": u.get("guardian_mobile"),
                "already_marked": uid in marked_ids,
            })
        out.sort(key=lambda x: (x["full_name"] or "").lower())
        return {"meal": m, "date": d, "scope": scope,
                "members": out, "count": len(out),
                "marked_count": len(marked_ids)}

    @router.post("/meals/mark-bulk")
    async def meal_mark_bulk(body: MealMarkIn, user: dict = Depends(require_chef_or_admin)):
        m = _valid_meal(body.meal)
        d = _valid_date(body.date)
        if not body.user_ids:
            return {"marked_count": 0, "skipped_count": 0}

        # Resolve meal-eligible category keys so the write path enforces
        # the same invariant the roster (read path) already does.
        # Closes the race between the chef opening the roster and an
        # admin flipping category.meal_eligible before Save is tapped
        # (code review 24 Feb 2026).
        eligible_cats = {
            c["key"] async for c in db.categories.find(
                {"active": True, "meal_eligible": True},
                {"_id": 0, "key": 1},
            )
        }

        # Hydrate names/categories/leaving_date so the meal_records doc
        # is self-describing (report views don't have to re-join to
        # `users`) AND so we can enforce the eligibility gate below.
        subjects = await db.users.find(
            {"id": {"$in": body.user_ids}},
            {"_id": 0, "id": 1, "full_name": 1, "category": 1,
             "institution": 1, "leaving_date": 1, "role": 1,
             "meal_eligible": 1},
        ).to_list(len(body.user_ids))
        by_id = {u["id"]: u for u in subjects}

        marked, skipped = 0, 0
        now_iso = now_utc().isoformat()
        marker_id = user.get("id")
        marker_name = user.get("full_name") or user.get("email") or "Chef"
        for uid in body.user_ids:
            u = by_id.get(uid)
            if not u:
                skipped += 1
                continue
            # Eligibility gates (mirror the roster's read-path filters):
            #   • not an admin-only account (they don't eat mess)
            #   • not an ex-member as of the meal date
            #   • per-member `meal_eligible` override wins: explicit
            #     False → skip regardless of category; explicit True →
            #     allow even if category is off. Only when the user
            #     hasn't set the field do we fall back to the category
            #     master (Feb 2026 fine-grained control).
            if u.get("role") == "admin":
                skipped += 1
                continue
            if is_ex_member(u, today_iso=d):
                skipped += 1
                continue
            override = u.get("meal_eligible")
            if override is False:
                skipped += 1
                continue
            if override is None and u.get("category") not in eligible_cats:
                skipped += 1
                continue
            doc = {
                "id": str(uuid.uuid4()),
                "user_id": uid,
                "user_name": u.get("full_name"),
                "category": u.get("category"),
                "institution": u.get("institution"),
                "date": d,
                "meal": m,
                "marked_at": now_iso,
                "marked_by": marker_id,
                "marked_by_name": marker_name,
            }
            try:
                await db.meal_records.insert_one(doc)
                marked += 1
            except DuplicateKeyError:
                # Already marked for this (member, date, meal) — the
                # unique index guards it, and the intent is idempotent
                # so we just count it as a skip. Any OTHER exception
                # is a real error and now propagates instead of being
                # silently masked as "skipped".
                skipped += 1
        return {"marked_count": marked, "skipped_count": skipped,
                "meal": m, "date": d}

    @router.post("/meals/unmark-bulk")
    async def meal_unmark_bulk(body: MealMarkIn, user: dict = Depends(require_chef_or_admin)):
        m = _valid_meal(body.meal)
        d = _valid_date(body.date)
        if not body.user_ids:
            return {"unmarked_count": 0}
        res = await db.meal_records.delete_many(
            {"date": d, "meal": m, "user_id": {"$in": body.user_ids}},
        )
        return {"unmarked_count": int(res.deleted_count or 0),
                "meal": m, "date": d}

    @router.post("/meals/copy-previous")
    async def meal_copy_previous(
        meal: str,
        date: str,  # target date — usually today
        from_date: Optional[str] = None,   # override source date (defaults to date - 1)
        user: dict = Depends(require_chef_or_admin),
    ):
        """Seed today's marks for `meal` from a previous day. If
        `from_date` is not provided we use `date - 1` (skipping weekends
        would surprise chefs — mess service is 7 days a week, so a
        strict calendar-day lookback is the right default).

        Duplicates are silently skipped via the compound unique index
        (`copied_count` reflects only NEW inserts). Members whose
        `leaving_date` is BEFORE the target date are excluded so
        ex-members don't sneak into a fresh day's roster; a member on
        their final active day (`leaving_date == target`) is still
        carried forward — matches the canonical `is_ex_member` rule."""
        # `date` is shadowed by the query-param name, so grab the class
        # via the datetime import path before we lose it.
        from datetime import date as _date_cls
        m = _valid_meal(meal)
        target = _valid_date(date)
        if from_date is not None:
            source = _valid_date(from_date)
        else:
            source = (_date_cls.fromisoformat(target) - timedelta(days=1)).isoformat()
        if source >= target:
            raise HTTPException(status_code=400,
                                detail="from_date must be before date")

        # Read yesterday's rows.
        prev_rows = await db.meal_records.find(
            {"meal": m, "date": source},
            {"_id": 0, "user_id": 1, "user_name": 1,
             "category": 1, "institution": 1},
        ).to_list(MAX_USERS)
        if not prev_rows:
            return {"copied_count": 0, "skipped_count": 0,
                    "meal": m, "date": target, "from_date": source,
                    "source_count": 0}

        # Cross-check leaving_date so ex-members from the source day
        # don't get carried forward into a day when they no longer eat.
        # A member whose leaving_date == target is on their FINAL
        # active day and still eats — mirrors `is_ex_member` which
        # treats `leaving_date < today` as ex (strict).
        user_ids = [r["user_id"] for r in prev_rows]
        actives = await db.users.find(
            {"id": {"$in": user_ids},
             "$or": [{"leaving_date": None}, {"leaving_date": ""},
                     {"leaving_date": {"$gte": target}}]},
            {"_id": 0, "id": 1},
        ).to_list(len(user_ids))
        active_ids = {u["id"] for u in actives}

        copied, skipped = 0, 0
        now_iso = now_utc().isoformat()
        marker_id = user.get("id")
        marker_name = user.get("full_name") or user.get("email") or "Chef"
        for r in prev_rows:
            uid = r["user_id"]
            if uid not in active_ids:
                skipped += 1
                continue
            doc = {
                "id": str(uuid.uuid4()),
                "user_id": uid,
                "user_name": r.get("user_name"),
                "category": r.get("category"),
                "institution": r.get("institution"),
                "date": target,
                "meal": m,
                "marked_at": now_iso,
                "marked_by": marker_id,
                "marked_by_name": marker_name,
                "copied_from": source,
            }
            try:
                await db.meal_records.insert_one(doc)
                copied += 1
            except DuplicateKeyError:
                # Already marked for today (via mark-bulk or a prior
                # copy-previous run) — dedupe silently. Non-duplicate
                # errors propagate.
                skipped += 1
        return {"copied_count": copied, "skipped_count": skipped,
                "meal": m, "date": target, "from_date": source,
                "source_count": len(prev_rows)}

    @router.get("/meals/daily-counts")
    async def meal_daily_counts(
        date: str,  # noqa: A002
        user: dict = Depends(require_chef_or_admin),
    ):
        """Kitchen-facing headcount for the day. Groups by meal and by
        category so the chef can plan portions per meal + per group."""
        d = _valid_date(date)
        rows = await db.meal_records.find(
            {"date": d},
            {"_id": 0, "meal": 1, "category": 1, "user_id": 1},
        ).to_list(5000)
        # meal → { category → count, total }
        per_meal: dict[str, dict] = {
            k: {"total": 0, "by_category": {}, "user_ids": []} for k in MEAL_KEYS
        }
        for r in rows:
            m = (r.get("meal") or "").lower()
            if m not in per_meal:
                continue
            per_meal[m]["total"] += 1
            cat = r.get("category") or "other"
            per_meal[m]["by_category"][cat] = per_meal[m]["by_category"].get(cat, 0) + 1
            per_meal[m]["user_ids"].append(r.get("user_id"))
        return {
            "date": d,
            "meals": [
                {"key": k, "label": MEAL_LABELS[k], "short": MEAL_SHORT[k],
                 "total": per_meal[k]["total"],
                 "by_category": per_meal[k]["by_category"]}
                for k in MEAL_KEYS
            ],
        }

    @router.get("/meals/daily-details")
    async def meal_daily_details(
        date: str,       # noqa: A002 — API contract; local name via _valid_date
        meal: str,
        user: dict = Depends(require_chef_or_admin),
    ):
        """Detailed roster of who took `meal` on `date` — one row per
        member with name, category, institution, marked_at time, and
        who marked them. Drives the click-through details view + PDF
        print on the Meals Report (user request 24 Feb 2026)."""
        d = _valid_date(date)
        m = _valid_meal(meal)
        rows = await db.meal_records.find(
            {"date": d, "meal": m},
            {"_id": 0, "user_id": 1, "user_name": 1, "category": 1,
             "institution": 1, "marked_at": 1, "marked_by_name": 1,
             "copied_from": 1},
        ).to_list(MAX_USERS)
        # Sort by category then name so the printed sheet groups
        # naturally (all athletes together, then staff, etc.).
        rows.sort(key=lambda r: (
            (r.get("category") or "zz").lower(),
            (r.get("institution") or "").lower(),
            (r.get("user_name") or "").lower(),
        ))
        return {
            "date": d, "meal": m,
            "meal_label": MEAL_LABELS[m],
            "meal_short": MEAL_SHORT[m],
            "count": len(rows),
            "members": rows,
        }

    @router.get("/meals/monthly-grid")
    async def meal_monthly_grid(
        month: str,          # YYYY-MM
        scope: str = "all",
        user: dict = Depends(require_chef_or_admin),
    ):
        """Admin-facing matrix. Rows = members in scope, cols = days of
        the month, cell = bit-flags of which meals they took (BF/L/S/D).
        Also returns per-member and per-day totals so the frontend can
        surface a "top eaters" summary without a second call."""
        try:
            y, mo = month.split("-")
            y, mo = int(y), int(mo)
            month_start = date(y, mo, 1)
            # Compute last day of month via first-of-next-month minus one day.
            if mo == 12:
                month_end = date(y, 12, 31)
            else:
                month_end = date(y, mo + 1, 1) - timedelta(days=1)
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail="month must be YYYY-MM")

        start_iso = month_start.isoformat()
        end_iso = month_end.isoformat()

        # Members in the requested scope.
        q = await _scoped_meal_query(scope)
        q["role"] = {"$ne": "admin"}
        members = await db.users.find(
            q,
            {"_id": 0, "id": 1, "full_name": 1, "category": 1, "institution": 1,
             "photo_thumb": 1, "leaving_date": 1},
        ).sort("full_name", 1).to_list(MAX_USERS)
        member_ids = {u["id"] for u in members}

        # All meal records for this month.
        recs = await db.meal_records.find(
            {"date": {"$gte": start_iso, "$lte": end_iso},
             "user_id": {"$in": list(member_ids)}},
            {"_id": 0, "user_id": 1, "date": 1, "meal": 1},
        ).to_list(50000)

        # Build the grid.
        # Encode which meals each (member, day) had as a set of meal keys.
        by_member_day: dict[str, dict[str, set]] = {}
        per_day_totals: dict[str, dict[str, int]] = {}
        per_member_totals: dict[str, dict[str, int]] = {}
        for r in recs:
            uid = r["user_id"]
            d_iso = r["date"]
            m = (r.get("meal") or "").lower()
            if m not in MEAL_KEYS:
                continue
            by_member_day.setdefault(uid, {}).setdefault(d_iso, set()).add(m)
            per_day_totals.setdefault(d_iso, {k: 0 for k in MEAL_KEYS})[m] += 1
            per_member_totals.setdefault(uid, {k: 0 for k in MEAL_KEYS})[m] += 1

        days = []
        cur = month_start
        while cur <= month_end:
            days.append(cur.isoformat())
            cur = cur + timedelta(days=1)

        rows = []
        for u in members:
            uid = u["id"]
            uday = by_member_day.get(uid, {})
            row = {
                "id": uid,
                "full_name": u.get("full_name"),
                "category": u.get("category"),
                "institution": u.get("institution"),
                "photo": member_photo_url(u),
                "leaving_date": u.get("leaving_date"),
                "days": {d: sorted(list(uday.get(d, set()))) for d in days if d in uday},
                "totals": per_member_totals.get(uid, {k: 0 for k in MEAL_KEYS}),
            }
            # Include only members with at least one meal in the month to
            # keep the grid focused (admins can widen scope; blank rows
            # don't add signal). Frontend still gets days array.
            if row["totals"] and sum(row["totals"].values()) > 0:
                rows.append(row)

        return {
            "month": month,
            "days": days,
            "scope": scope,
            "meals": [{"key": k, "label": MEAL_LABELS[k], "short": MEAL_SHORT[k]}
                      for k in MEAL_KEYS],
            "rows": rows,
            "per_day_totals": per_day_totals,
        }

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
        snap_rows, _snap_cats = await _stock_snapshot(e)
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
        if opening < 0:
            raise HTTPException(status_code=400, detail="Opening stock cannot be negative")
        if (body.opening_rate or 0) < 0:
            raise HTTPException(status_code=400, detail="Opening rate cannot be negative")
        if (body.min_stock or 0) < 0:
            raise HTTPException(status_code=400, detail="Min level cannot be negative")
        if (body.norm_per_serving or 0) < 0:
            raise HTTPException(status_code=400, detail="Norm per serving cannot be negative")
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
            "sort_order": int(body.sort_order),
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
            if body.opening_stock < 0:
                raise HTTPException(status_code=400, detail="Opening stock cannot be negative")
            update["opening_stock"] = round(float(body.opening_stock), 4)
        if body.opening_stock_as_of is not None:
            update["opening_stock_as_of"] = _valid_date(body.opening_stock_as_of)
        if body.opening_rate is not None:
            if body.opening_rate < 0:
                raise HTTPException(status_code=400, detail="Opening rate cannot be negative")
            update["opening_rate"] = round(float(body.opening_rate), 4)
        if body.min_stock is not None:
            if body.min_stock < 0:
                raise HTTPException(status_code=400, detail="Min level cannot be negative")
            update["min_stock"] = round(float(body.min_stock), 4)
        if body.norm_per_serving is not None:
            if body.norm_per_serving < 0:
                raise HTTPException(status_code=400, detail="Norm per serving cannot be negative")
            update["norm_per_serving"] = round(float(body.norm_per_serving), 4)
        if body.sort_order is not None:
            update["sort_order"] = int(body.sort_order)
        if body.active is not None:
            update["active"] = bool(body.active)
        if update:
            update["updated_at"] = now_utc().isoformat()
            update["updated_by"] = user.get("id")
            update["updated_by_name"] = user.get("full_name") or user.get("email")
            await db.meal_items.update_one({"id": item_id}, {"$set": update})
            row.update(update)
            await _signal_meals("items")
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

    # ------------------------------------------------------------------
    # Daily issues (consumption)
    # ------------------------------------------------------------------
    @router.get("/meals/issues")
    async def list_issues(
        start: str, end: str, user: dict = Depends(require_chef_or_admin),
    ):
        s, e = _valid_date(start), _valid_date(end)
        if s > e:
            raise HTTPException(status_code=400, detail="start must be before end")
        rows = await db.meal_issues.find(
            {"date": {"$gte": s, "$lte": e}}, {"_id": 0},
        ).sort("date", 1).to_list(400)
        return {"start": s, "end": e, "issues": rows}

    @router.put("/meals/issues/{date_str}")
    async def upsert_issues(
        date_str: str, body: IssuesUpsertIn,
        user: dict = Depends(require_chef_or_admin),
    ):
        d = _not_future(_valid_date(date_str))
        item_ids = [str(l.get("item_id") or "") for l in body.lines if l.get("item_id")]
        items = await db.meal_items.find(
            {"id": {"$in": item_ids}}, {"_id": 0},
        ).to_list(len(item_ids) or 1)
        by_id = {i["id"]: i for i in items}

        clean: list[dict] = []
        for raw in body.lines:
            iid = str(raw.get("item_id") or "").strip()
            item = by_id.get(iid)
            if not item:
                raise HTTPException(status_code=400,
                                    detail=f"Unknown item_id: {iid or '(blank)'}")
            qty = _parse_amount(raw.get("qty"))
            if qty is None or qty <= 0:
                continue  # blank/zero silently dropped
            clean.append({
                "id": str(raw.get("id") or uuid.uuid4()),
                "item_id": iid,
                "item_name": item.get("name"),
                "category_key": item.get("category_key"),
                "qty": round(qty, 4),
                "unit": item.get("unit"),
            })

        stamp = {
            "updated_at": now_utc().isoformat(),
            "updated_by": user.get("id"),
            "updated_by_name": user.get("full_name") or user.get("email"),
        }
        await db.meal_issues.update_one(
            {"date": d},
            {"$set": {"date": d, "lines": clean, **stamp},
             "$setOnInsert": {"id": str(uuid.uuid4())}},
            upsert=True,
        )
        await _signal_meals("issues", d)
        return {"date": d, "lines": clean}

    @router.patch("/meals/issues/{date_str}")
    async def patch_issue_lines(
        date_str: str, body: LinesPatchIn,
        user: dict = Depends(require_chef_or_admin),
    ):
        """Merge ONLY the edited lines into the day's issues doc — each
        item updated atomically (positional $set / $push / $pull) so
        concurrent machines editing different items never clash."""
        d = _not_future(_valid_date(date_str))
        item_ids = [str(l.get("item_id") or "") for l in body.upserts if l.get("item_id")]
        items = await db.meal_items.find(
            {"id": {"$in": item_ids}}, {"_id": 0},
        ).to_list(len(item_ids) or 1)
        by_id = {i["id"]: i for i in items}
        await db.meal_issues.update_one(
            {"date": d},
            {"$setOnInsert": {"id": str(uuid.uuid4()), "date": d, "lines": []}},
            upsert=True,
        )
        removes = [str(r) for r in body.removes]
        for raw in body.upserts:
            iid = str(raw.get("item_id") or "").strip()
            item = by_id.get(iid)
            if not item:
                raise HTTPException(status_code=400,
                                    detail=f"Unknown item_id: {iid or '(blank)'}")
            qty = _parse_amount(raw.get("qty"))
            if qty is None or qty <= 0:
                removes.append(iid)
                continue
            line = {
                "id": str(uuid.uuid4()),
                "item_id": iid,
                "item_name": item.get("name"),
                "category_key": item.get("category_key"),
                "qty": round(qty, 4),
                "unit": item.get("unit"),
            }
            res = await db.meal_issues.update_one(
                {"date": d, "lines.item_id": iid}, {"$set": {"lines.$": line}})
            if res.matched_count == 0:
                await db.meal_issues.update_one({"date": d}, {"$push": {"lines": line}})
        for iid in removes:
            await db.meal_issues.update_one(
                {"date": d}, {"$pull": {"lines": {"item_id": iid}}})
        await db.meal_issues.update_one({"date": d}, {"$set": {
            "updated_at": now_utc().isoformat(),
            "updated_by": user.get("id"),
            "updated_by_name": user.get("full_name") or user.get("email"),
        }})
        await _signal_meals("issues", d)
        doc = await db.meal_issues.find_one({"date": d}, {"_id": 0})
        return {"date": d, "lines": (doc or {}).get("lines") or []}

    # ------------------------------------------------------------------
    # Wastage & losses — event log with reason + optional notes.
    # ------------------------------------------------------------------
    def _valid_reason(r: str) -> str:
        r = (r or "").strip().lower()
        if r not in VALID_WASTAGE_REASONS:
            raise HTTPException(status_code=400,
                                detail=f"reason must be one of {list(VALID_WASTAGE_REASONS)}")
        return r

    @router.get("/meals/wastage")
    async def list_wastage(
        start: str, end: str, user: dict = Depends(require_chef_or_admin),
    ):
        s, e = _valid_date(start), _valid_date(end)
        if s > e:
            raise HTTPException(status_code=400, detail="start must be before end")
        rows = await db.meal_wastage.find(
            {"date": {"$gte": s, "$lte": e}}, {"_id": 0},
        ).sort("date", 1).to_list(400)
        return {"start": s, "end": e, "wastage": rows,
                "reasons": list(VALID_WASTAGE_REASONS)}

    @router.put("/meals/wastage/{date_str}")
    async def upsert_wastage(
        date_str: str, body: WastageUpsertIn,
        user: dict = Depends(require_chef_or_admin),
    ):
        """Replace all wastage lines for a date. Same shape as issues but
        each line carries {reason, notes}. Zero/blank qty rows silently
        dropped so a partial save doesn't null everything."""
        d = _not_future(_valid_date(date_str))
        item_ids = [str(l.get("item_id") or "") for l in body.lines if l.get("item_id")]
        items = await db.meal_items.find(
            {"id": {"$in": item_ids}}, {"_id": 0},
        ).to_list(len(item_ids) or 1)
        by_id = {i["id"]: i for i in items}

        clean: list[dict] = []
        for raw in body.lines:
            iid = str(raw.get("item_id") or "").strip()
            item = by_id.get(iid)
            if not item:
                raise HTTPException(status_code=400,
                                    detail=f"Unknown item_id: {iid or '(blank)'}")
            qty = _parse_amount(raw.get("qty"))
            if qty is None or qty <= 0:
                continue
            reason = _valid_reason(raw.get("reason") or "wasted")
            notes = str(raw.get("notes") or "").strip()[:400]
            clean.append({
                "id": str(raw.get("id") or uuid.uuid4()),
                "item_id": iid,
                "item_name": item.get("name"),
                "category_key": item.get("category_key"),
                "qty": round(qty, 4),
                "unit": item.get("unit"),
                "reason": reason,
                "notes": notes,
            })

        stamp = {
            "updated_at": now_utc().isoformat(),
            "updated_by": user.get("id"),
            "updated_by_name": user.get("full_name") or user.get("email"),
        }
        await db.meal_wastage.update_one(
            {"date": d},
            {"$set": {"date": d, "lines": clean, **stamp},
             "$setOnInsert": {"id": str(uuid.uuid4())}},
            upsert=True,
        )
        await _signal_meals("wastage", d)
        return {"date": d, "lines": clean}

    @router.patch("/meals/wastage/{date_str}")
    async def patch_wastage_lines(
        date_str: str, body: LinesPatchIn,
        user: dict = Depends(require_chef_or_admin),
    ):
        """Merge ONLY the edited wastage lines into the day's doc — each
        item updated atomically (positional $set / $push / $pull) so
        concurrent machines editing different items never clash.  Mirrors
        the issues PATCH, but each line carries reason + notes."""
        d = _not_future(_valid_date(date_str))
        item_ids = [str(l.get("item_id") or "") for l in body.upserts if l.get("item_id")]
        items = await db.meal_items.find(
            {"id": {"$in": item_ids}}, {"_id": 0},
        ).to_list(len(item_ids) or 1)
        by_id = {i["id"]: i for i in items}
        await db.meal_wastage.update_one(
            {"date": d},
            {"$setOnInsert": {"id": str(uuid.uuid4()), "date": d, "lines": []}},
            upsert=True,
        )
        removes = [str(r) for r in body.removes]
        for raw in body.upserts:
            iid = str(raw.get("item_id") or "").strip()
            item = by_id.get(iid)
            if not item:
                raise HTTPException(status_code=400,
                                    detail=f"Unknown item_id: {iid or '(blank)'}")
            qty = _parse_amount(raw.get("qty")) or 0.0
            notes = str(raw.get("notes") or "").strip()[:400]
            # Persist any line with a positive qty OR a non-empty note
            # (notes-only rows are legitimate — "check tomorrow" scribble
            # before the chef weighs the loss). Rows with neither are
            # treated as "remove this line".
            if qty <= 0 and not notes:
                removes.append(iid)
                continue
            reason = _valid_reason(raw.get("reason") or "wasted")
            line = {
                "id": str(uuid.uuid4()),
                "item_id": iid,
                "item_name": item.get("name"),
                "category_key": item.get("category_key"),
                "qty": round(qty, 4),
                "unit": item.get("unit"),
                "reason": reason,
                "notes": notes,
            }
            res = await db.meal_wastage.update_one(
                {"date": d, "lines.item_id": iid}, {"$set": {"lines.$": line}})
            if res.matched_count == 0:
                await db.meal_wastage.update_one({"date": d}, {"$push": {"lines": line}})
        for iid in removes:
            await db.meal_wastage.update_one(
                {"date": d}, {"$pull": {"lines": {"item_id": iid}}})
        await db.meal_wastage.update_one({"date": d}, {"$set": {
            "updated_at": now_utc().isoformat(),
            "updated_by": user.get("id"),
            "updated_by_name": user.get("full_name") or user.get("email"),
        }})
        await _signal_meals("wastage", d)
        doc = await db.meal_wastage.find_one({"date": d}, {"_id": 0})
        return {"date": d, "lines": (doc or {}).get("lines") or []}

    # ------------------------------------------------------------------
    # Stock on hand — opening + Σ purchases − Σ issues − Σ wastage,
    # per item.
    # ------------------------------------------------------------------
    async def _stock_snapshot(as_of_iso: str):
        """Shared stock math for /meals/stock and reorder suggestions."""
        items = await db.meal_items.find(
            {"active": True}, {"_id": 0},
        ).sort([("category_key", 1), ("sort_order", 1), ("name", 1)]).to_list(500)
        cats = await _purchase_categories()
        cat_label = {c["key"]: c["label"] for c in cats}

        purch_docs = await db.meal_purchases.find(
            {"date": {"$lte": as_of_iso}}, {"_id": 0, "date": 1, "lines": 1},
        ).to_list(5000)
        iss_docs = await db.meal_issues.find(
            {"date": {"$lte": as_of_iso}}, {"_id": 0, "date": 1, "lines": 1},
        ).to_list(5000)
        wast_docs = await db.meal_wastage.find(
            {"date": {"$lte": as_of_iso}}, {"_id": 0, "date": 1, "lines": 1},
        ).to_list(5000)

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
        purch_amount = _sum_amount_from(purch_docs)

        rows = []
        for it in items:
            iid = it["id"]
            opening = float(it.get("opening_stock") or 0)
            p = round(purch_from.get(iid, 0.0), 4)
            iq = round(iss_from.get(iid, 0.0), 4)
            w = round(wast_from.get(iid, 0.0), 4)
            on_hand = round(opening + p - iq - w, 4)
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
            issued_value = round(iq * avg_rate, 2)
            wasted_value = round(w * avg_rate, 2)
            on_hand_value = round(opening_value + purch_amt - issued_value - wasted_value, 2)
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
                "on_hand": on_hand,
                "min_stock": min_s,
                "low": low,
                # Amounts (in ₹). avg_rate is weighted-avg purchase price.
                "avg_rate": avg_rate,
                "opening_value": opening_value,
                "purchased_amount": purch_amt,
                "issued_value": issued_value,
                "wasted_value": wasted_value,
                "on_hand_value": on_hand_value,
            })
        return rows, cats

    @router.get("/meals/stock")
    async def stock_on_hand(
        as_of: Optional[str] = Query(None),
        user: dict = Depends(require_chef_or_admin),
    ):
        as_of_iso = _valid_date(as_of) if as_of else local_date_str(None)
        rows, cats = await _stock_snapshot(as_of_iso)
        return {"as_of": as_of_iso, "rows": rows,
                "low_count": sum(1 for r in rows if r["low"]),
                "categories": cats, "units": list(VALID_UNITS)}

    def _range_or_default(start: Optional[str], end: Optional[str]) -> tuple[str, str]:
        e = _valid_date(end) if end else local_date_str(None)
        s = _valid_date(start) if start else \
            (date.fromisoformat(e) - timedelta(days=29)).isoformat()
        if s > e:
            raise HTTPException(status_code=400, detail="start must be before end")
        return s, e

    @router.get("/meals/items/{item_id}/ledger")
    async def item_ledger(
        item_id: str,
        start: Optional[str] = Query(None),
        end: Optional[str] = Query(None),
        user: dict = Depends(require_chef_or_admin),
    ):
        """Merged purchase/issue/wastage history for one item, newest first."""
        item = await db.meal_items.find_one({"id": item_id}, {"_id": 0})
        if not item:
            raise HTTPException(status_code=404, detail="Item not found")
        s, e = _range_or_default(start, end)
        q = {"date": {"$gte": s, "$lte": e}, "lines.item_id": item_id}
        proj = {"_id": 0, "date": 1, "lines": 1, "updated_by_name": 1}
        purch = await db.meal_purchases.find(q, proj).to_list(400)
        iss = await db.meal_issues.find(q, proj).to_list(400)
        wast = await db.meal_wastage.find(q, proj).to_list(400)

        events: list[dict] = []
        tot = {"purchased_qty": 0.0, "purchased_amount": 0.0,
               "issued_qty": 0.0, "wasted_qty": 0.0}

        def _collect(docs, typ):
            for doc in docs:
                for line in doc.get("lines") or []:
                    if line.get("item_id") != item_id:
                        continue
                    qty = float(line.get("qty") or 0)
                    ev = {"date": doc["date"], "type": typ, "qty": qty,
                          "by": doc.get("updated_by_name")}
                    if typ == "purchase":
                        ev["rate"] = line.get("rate")
                        ev["amount"] = line.get("amount")
                        tot["purchased_qty"] += qty
                        tot["purchased_amount"] += float(line.get("amount") or 0)
                    elif typ == "issue":
                        tot["issued_qty"] += qty
                    else:
                        ev["reason"] = line.get("reason")
                        ev["notes"] = line.get("notes")
                        tot["wasted_qty"] += qty
                    events.append(ev)

        _collect(purch, "purchase")
        _collect(iss, "issue")
        _collect(wast, "wastage")
        events.sort(key=lambda x: (x["date"], x["type"]), reverse=True)

        # Current on-hand (same math as /meals/stock, single item, as of today).
        today = local_date_str(None)
        as_of = item.get("opening_stock_as_of") or "1970-01-01"
        oq = {"date": {"$gte": as_of, "$lte": today}, "lines.item_id": item_id}

        async def _qty_sum(coll) -> float:
            total = 0.0
            for doc in await coll.find(oq, {"_id": 0, "lines": 1}).to_list(2000):
                for line in doc.get("lines") or []:
                    if line.get("item_id") == item_id:
                        total += float(line.get("qty") or 0)
            return total

        on_hand = round(float(item.get("opening_stock") or 0)
                        + await _qty_sum(db.meal_purchases)
                        - await _qty_sum(db.meal_issues)
                        - await _qty_sum(db.meal_wastage), 4)
        return {"item": item, "start": s, "end": e, "events": events,
                "totals": {k: round(v, 4) for k, v in tot.items()},
                "on_hand": on_hand}

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
                if rate is None or rate < 0:
                    raise HTTPException(status_code=400,
                                        detail=f"Rate for '{item['name']}' must be ≥ 0")
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

            await db.meal_purchases.update_one(
                {"date": d},
                {"$set": {"date": d, "lines": clean_lines,
                          "amounts": amounts, **stamp},
                 "$setOnInsert": {"id": str(uuid.uuid4())}},
                upsert=True,
            )
            await _signal_meals("purchases", d)
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
        await db.meal_purchases.update_one(
            {"date": d},
            {"$set": {"date": d, "amounts": amounts, **stamp},
             "$setOnInsert": {"id": str(uuid.uuid4())}},
            upsert=True,
        )
        await _signal_meals("purchases", d)
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
        item_ids = [str(l.get("item_id") or "") for l in body.upserts if l.get("item_id")]
        items = await db.meal_items.find(
            {"id": {"$in": item_ids}}, {"_id": 0},
        ).to_list(len(item_ids) or 1)
        by_id = {i["id"]: i for i in items}
        await db.meal_purchases.update_one(
            {"date": d},
            {"$setOnInsert": {"id": str(uuid.uuid4()), "date": d,
                              "lines": [], "amounts": {}}},
            upsert=True,
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
            if rate is None or rate < 0:
                raise HTTPException(status_code=400,
                                    detail=f"Rate for '{item['name']}' must be ≥ 0")
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
            res = await db.meal_purchases.update_one(
                {"date": d, "lines.item_id": iid}, {"$set": {"lines.$": line}})
            if res.matched_count == 0:
                await db.meal_purchases.update_one({"date": d}, {"$push": {"lines": line}})
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
            await db.meal_purchases.update_one(
                {"date": d},
                {"$set": {**sets, "date": d,
                          "updated_at": now_iso,
                          "updated_by": user.get("id"),
                          "updated_by_name": user.get("full_name") or user.get("email"),
                          "source": "bulk_upload"},
                 "$setOnInsert": {"id": str(uuid.uuid4())}},
                upsert=True,
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

        athlete_like = {
            c["key"] async for c in db.categories.find(
                {"is_athlete_like": True}, {"_id": 0, "key": 1})
        } or {"athlete", "elite"}

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
        tot_grp = {"athletes": {k: 0 for k in MEAL_KEYS},
                   "staff":    {k: 0 for k in MEAL_KEYS}}
        tot_purch = {k: 0.0 for k in cat_keys}
        cur = s_d
        while cur <= e_d:
            iso = cur.isoformat()
            a, st = _grp(iso, "athletes"), _grp(iso, "staff")
            amounts = purch_by_date.get(iso, {})
            day_expense = round(sum(float(v or 0) for v in amounts.values()), 2)
            days_out.append({
                "date": iso,
                "athletes": a,
                "staff": st,
                "meal_count": a["total"] + st["total"],
                "purchases": {k: amounts.get(k) for k in cat_keys if amounts.get(k)},
                "expense_total": day_expense,
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
        snap_rows2, _ = await _stock_snapshot(e)
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
            },
        }

    @router.get("/meals/kitchen-analytics")
    async def kitchen_analytics(
        start: str, end: str,
        user: dict = Depends(require_chef_or_admin),
    ):
        """Kitchen graphics panel (Feb 2026 user request).

        Aggregates purchases + issues in the given window and returns
        the numbers needed to plot:
          • Daily amount trend
          • Top items by amount + top items by qty
          • Category-wise % split
          • Item-wise breakdown (full list, sortable client-side)

        Issue amounts are valued at the weighted-avg purchase rate for
        each item over the same window (falls back to the current
        stock snapshot when the item has no purchase in the window)
        so purchases and issues use comparable rupee figures.
        """
        s, e = _valid_date(start), _valid_date(end)
        if s > e:
            raise HTTPException(status_code=400, detail="start must be before end")
        s_d, e_d = date.fromisoformat(s), date.fromisoformat(e)
        if (e_d - s_d).days > 400:
            raise HTTPException(status_code=400, detail="Range too large (max ~13 months)")

        # ---- Item + category master (for names / labels) ----
        items = await db.meal_items.find(
            {}, {"_id": 0, "id": 1, "name": 1, "unit": 1, "category_key": 1},
        ).to_list(2000)
        by_id = {i["id"]: i for i in items}
        cats = await _purchase_categories()
        cat_label = {c["key"]: c.get("label") or c["key"] for c in cats}

        # ---- Pull purchase + issue docs for the window ----
        # `amounts` is included so we can reconcile bulk-uploaded /
        # legacy purchase docs (which carry category totals but no
        # per-item `lines`) into the daily trend + category share.
        purch_docs = await db.meal_purchases.find(
            {"date": {"$gte": s, "$lte": e}},
            {"_id": 0, "date": 1, "lines": 1, "amounts": 1},
        ).to_list(5000)
        iss_docs = await db.meal_issues.find(
            {"date": {"$gte": s, "$lte": e}},
            {"_id": 0, "date": 1, "lines": 1},
        ).to_list(5000)

        # ---- Weighted-avg rate per item from THIS window's purchases ----
        # Falls back to current stock avg_rate when an item was issued but
        # never purchased in the window (opening-stock consumption).
        purch_qty: dict[str, float] = {}
        purch_amt: dict[str, float] = {}
        for doc in purch_docs:
            for ln in (doc.get("lines") or []):
                iid = ln.get("item_id")
                q = float(ln.get("qty") or 0)
                r = float(ln.get("rate") or 0)
                if not iid or q <= 0:
                    continue
                purch_qty[iid] = purch_qty.get(iid, 0.0) + q
                purch_amt[iid] = purch_amt.get(iid, 0.0) + q * r

        snap_rows, _snap_cats = await _stock_snapshot(e)
        snap_rate = {r["item_id"]: float(r.get("avg_rate") or 0) for r in snap_rows}

        def _rate_for(iid: str) -> float:
            if purch_qty.get(iid, 0) > 0:
                return purch_amt[iid] / purch_qty[iid]
            return snap_rate.get(iid, 0.0)

        # ---- Roll-ups ----
        def _blank_day():
            return {"amount": 0.0, "qty": 0.0, "lines": 0,
                    "itemised_amount": 0.0, "unitemised_amount": 0.0}

        def _blank_item():
            return {"qty": 0.0, "amount": 0.0, "lines": 0}

        # Seed every day in the window with a zero row so charts show
        # gaps as flat points instead of skipping the label.
        purch_daily: dict[str, dict] = {}
        iss_daily: dict[str, dict] = {}
        cur = s_d
        while cur <= e_d:
            iso = cur.isoformat()
            purch_daily[iso] = _blank_day()
            iss_daily[iso] = _blank_day()
            cur += timedelta(days=1)

        purch_items: dict[str, dict] = {}
        iss_items: dict[str, dict] = {}
        purch_cat: dict[str, float] = {}
        iss_cat: dict[str, float] = {}
        unitemised_total = 0.0

        for doc in purch_docs:
            d = doc["date"]
            slot = purch_daily.setdefault(d, _blank_day())
            # Truth for the day's spend = sum of `amounts` if present
            # (line-based edits recompute `amounts` from lines, so this
            # covers BOTH modern per-item entry AND legacy bulk-upload
            # docs — see upsert_purchase / patch_purchase_lines).
            amounts_map = doc.get("amounts") or {}
            day_total = sum(float(v or 0) for v in amounts_map.values())
            itemised_from_lines = 0.0
            for ln in (doc.get("lines") or []):
                iid = ln.get("item_id")
                q = float(ln.get("qty") or 0)
                r = float(ln.get("rate") or 0)
                if not iid or q <= 0:
                    continue
                amt = q * r
                itemised_from_lines += amt
                slot["qty"] += q
                slot["lines"] += 1
                it = purch_items.setdefault(iid, _blank_item())
                it["qty"] += q
                it["amount"] += amt
                it["lines"] += 1
            # Category share is drawn from `amounts` so bulk-uploaded
            # days still contribute to the pie.
            for ckey, v in amounts_map.items():
                purch_cat[ckey] = purch_cat.get(ckey, 0.0) + float(v or 0)
            # If no `amounts` (very early docs), fall back to lines.
            eff_day_total = day_total if amounts_map else itemised_from_lines
            slot["amount"] += eff_day_total
            slot["itemised_amount"] += itemised_from_lines
            slot["unitemised_amount"] += max(0.0, eff_day_total - itemised_from_lines)
            unitemised_total += max(0.0, eff_day_total - itemised_from_lines)

        for doc in iss_docs:
            d = doc["date"]
            slot = iss_daily.setdefault(d, _blank_day())
            for ln in (doc.get("lines") or []):
                iid = ln.get("item_id")
                q = float(ln.get("qty") or 0)
                if not iid or q <= 0:
                    continue
                rate = _rate_for(iid)
                amt = q * rate
                slot["amount"] += amt
                slot["qty"] += q
                slot["lines"] += 1
                it = iss_items.setdefault(iid, _blank_item())
                it["qty"] += q
                it["amount"] += amt
                it["lines"] += 1
                info = by_id.get(iid) or {}
                ckey = info.get("category_key") or "uncategorised"
                iss_cat[ckey] = iss_cat.get(ckey, 0.0) + amt

        def _daily_series(daily: dict) -> list:
            return [
                {"date": d,
                 "amount": round(v["amount"], 2),
                 "qty": round(v["qty"], 3),
                 "lines": v["lines"]}
                for d, v in sorted(daily.items())
            ]

        def _item_rows(items_agg: dict) -> list:
            rows = []
            for iid, v in items_agg.items():
                info = by_id.get(iid) or {}
                rows.append({
                    "item_id": iid,
                    "name": info.get("name") or "(deleted item)",
                    "unit": info.get("unit"),
                    "category_key": info.get("category_key"),
                    "category_label": cat_label.get(info.get("category_key"),
                                                   (info.get("category_key") or "").replace("_", " ").title()),
                    "qty": round(v["qty"], 3),
                    "amount": round(v["amount"], 2),
                    "lines": v["lines"],
                })
            rows.sort(key=lambda r: r["amount"], reverse=True)
            return rows

        def _cat_pct(cat_agg: dict) -> list:
            total = sum(cat_agg.values()) or 1.0
            rows = []
            for k, v in cat_agg.items():
                rows.append({
                    "key": k,
                    "label": cat_label.get(k, k.replace("_", " ").title()),
                    "amount": round(v, 2),
                    "pct": round(v * 100.0 / total, 1),
                })
            rows.sort(key=lambda r: r["amount"], reverse=True)
            return rows

        purch_item_rows = _item_rows(purch_items)
        iss_item_rows = _item_rows(iss_items)

        def _pack(daily, items_rows, cat_rows, unitemised=0.0) -> dict:
            total_amount = round(sum(d["amount"] for d in daily), 2)
            total_qty_lines = sum(d["lines"] for d in daily)
            itemised_amount = round(sum(r["amount"] for r in items_rows), 2)
            return {
                "daily": daily,
                "top_by_amount": items_rows[:12],
                "top_by_qty": sorted(items_rows, key=lambda r: r["qty"], reverse=True)[:12],
                "category_totals": cat_rows,
                "items": items_rows,
                "total_amount": total_amount,
                "itemised_amount": itemised_amount,
                "unitemised_amount": round(max(0.0, total_amount - itemised_amount), 2),
                "total_lines": total_qty_lines,
                "item_count": len(items_rows),
            }

        return {
            "start": s, "end": e,
            "purchases": _pack(_daily_series(purch_daily), purch_item_rows, _cat_pct(purch_cat), unitemised_total),
            "issues":    _pack(_daily_series(iss_daily),   iss_item_rows,   _cat_pct(iss_cat)),
        }

    return router
