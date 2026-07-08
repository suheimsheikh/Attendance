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

import uuid
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from services.time_utils import local_date_str, now_utc, office_tz


DEFAULT_MEAL_CUTOFF = "07:00"
SEEDED_CATEGORY_KEYS = {"athlete", "elite", "coach", "staff", "executive"}
VALID_COLORS = {"sky", "rose", "emerald", "amber", "violet", "slate"}


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


def make_router(db, require_admin, get_current_user) -> APIRouter:
    router = APIRouter(prefix="/api")

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
        cutoff: Optional[str] = Query(None, description="HH:MM meal cut-off override (defaults to office setting)"),
        date_str: Optional[str] = Query(None, alias="date", description="YYYY-MM-DD (defaults to today, office-local)"),
        admin: dict = Depends(require_admin),
    ):
        """Return meal-eligible members for a given day (defaults to today).

        A member is meal-eligible if:
          • Their category is `meal_eligible=True` in the categories master
            (all 5 seeded categories are eligible by default), AND
          • They have an attendance row for the target date with
            `check_in_at` translating to office-local ≤ `cutoff`.

        Cutoff resolution: query param > office.meal_breakfast_cutoff >
        DEFAULT_MEAL_CUTOFF ("07:00"). Admins tune the office-wide default
        on the Office Settings page.

        Returns counts per category + a flat member list (photo + name +
        institution + fleet + check-in time) for the chef's printable
        drill-down.
        """
        office = await db.config.find_one({"id": "office"})
        # Resolution order: explicit query param → office setting → default.
        # An explicit BAD query param 400s (catches frontend bugs). A bad
        # office setting silently falls back (so the admin can still open
        # the page and fix the setting).
        if cutoff is not None:
            h, m = _parse_hm(cutoff)          # raises 400 on bad input
            effective_cutoff = f"{h:02d}:{m:02d}"
        else:
            effective_cutoff = (office or {}).get("meal_breakfast_cutoff") or DEFAULT_MEAL_CUTOFF
            if not _valid_hm(effective_cutoff):
                effective_cutoff = DEFAULT_MEAL_CUTOFF
            h, m = _parse_hm(effective_cutoff)
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

        # Build the office-local cut-off moment for the target day, then
        # convert to UTC for a fast ISO-string range comparison on
        # `check_in_at` (both sides are stored/compared as UTC ISO 8601 strings).
        cutoff_local = datetime(today_d.year, today_d.month, today_d.day,
                                h, m, 0, tzinfo=tz)
        from datetime import timezone as _tz
        cutoff_utc_str = cutoff_local.astimezone(_tz.utc).isoformat()

        # Pull today's earliest check-in per user (a member can have
        # multiple sessions if they check out & back in — the first one
        # is what counts for the meal window).
        attendances = await db.attendance.find(
            {"date": today_iso, "check_in_at": {"$ne": None, "$lte": cutoff_utc_str}},
            {"_id": 0, "user_id": 1, "check_in_at": 1},
        ).to_list(5000)

        earliest_by_user: dict[str, str] = {}
        for row in attendances:
            uid = row.get("user_id")
            ci = row.get("check_in_at")
            if not uid or not ci:
                continue
            if uid not in earliest_by_user or ci < earliest_by_user[uid]:
                earliest_by_user[uid] = ci

        # Fetch matching users + their category metadata.
        user_ids = list(earliest_by_user.keys())
        users = []
        if user_ids:
            users = await db.users.find(
                {"id": {"$in": user_ids}},
                {"_id": 0, "id": 1, "full_name": 1, "category": 1, "photo_thumb": 1,
                 "institution": 1, "fleet": 1},
            ).to_list(5000)

        # Pull categories master so the tile colors + labels come from
        # a single source of truth (rather than hard-coded on the front-end).
        cats = await db.categories.find(
            {"active": True, "meal_eligible": True},
            {"_id": 0, "key": 1, "label": 1, "color": 1, "sort_order": 1},
        ).sort("sort_order", 1).to_list(50)
        cat_by_key = {c["key"]: c for c in cats}

        # Filter out users whose category is not meal-eligible (defense
        # in depth — every seeded category is currently eligible).
        members = []
        counts: dict[str, int] = {c["key"]: 0 for c in cats}
        for u in users:
            key = u.get("category")
            if key not in cat_by_key:
                continue
            counts[key] += 1
            members.append({
                "id": u["id"],
                "full_name": u.get("full_name"),
                "category": key,
                "photo_thumb": u.get("photo_thumb"),
                "institution": u.get("institution"),
                "fleet": u.get("fleet"),
                "check_in_at": earliest_by_user.get(u["id"]),
            })

        # Sort members: by category sort_order, then alphabetically —
        # matches how the drill-down groups on the frontend.
        cat_order = {c["key"]: c.get("sort_order", 999) for c in cats}
        members.sort(key=lambda x: (cat_order.get(x["category"], 999),
                                     (x["full_name"] or "").lower()))

        return {
            "today": today_iso,
            "cutoff": f"{h:02d}:{m:02d}",
            "configured_cutoff": (office or {}).get("meal_breakfast_cutoff") or DEFAULT_MEAL_CUTOFF,
            "generated_at": now_utc().isoformat(),
            "categories": cats,   # ordered, with colors/labels
            "counts": counts,      # {category_key: n}
            "total": sum(counts.values()),
            "members": members,
        }

    return router
