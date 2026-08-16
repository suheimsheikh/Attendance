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

import logging
import uuid
from datetime import date, datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
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
    async def create_category(body: CategoryIn, admin: dict = Depends(require_admin)):
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
            "created_by": admin.get("id"),
        }
        await db.categories.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @router.patch("/masters/categories/{cat_id}")
    async def update_category(
        cat_id: str, body: CategoryPatch, admin: dict = Depends(require_admin)
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
             "institution": 1, "leaving_date": 1, "role": 1},
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
            #   • category is in the meal_eligible set
            # Failures are counted as skipped so a batch with ONE
            # ineligible member still marks the rest.
            if u.get("role") == "admin":
                skipped += 1
                continue
            if is_ex_member(u, today_iso=d):
                skipped += 1
                continue
            if u.get("category") not in eligible_cats:
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

    return router
