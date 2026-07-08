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

from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from services.time_utils import local_date_str, now_utc, office_tz


DEFAULT_MEAL_CUTOFF = "07:00"


def _parse_hm(cutoff: str) -> tuple[int, int]:
    try:
        h, m = cutoff.split(":")[:2]
        h, m = int(h), int(m)
        if not (0 <= h <= 23 and 0 <= m <= 59):
            raise ValueError
        return h, m
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail="cutoff must be HH:MM (00:00–23:59)")


def make_router(db, require_admin, get_current_user) -> APIRouter:
    router = APIRouter(prefix="/api")

    # ------------------------------------------------------------------
    # Categories master (read-only for now — seeded at startup).
    # Anyone signed in may read this so the Members-form dropdown works
    # for admins editing rows inline.
    # ------------------------------------------------------------------
    @router.get("/masters/categories")
    async def list_categories(user: dict = Depends(get_current_user)):
        rows = await db.categories.find(
            {"active": True},
            {"_id": 0},
        ).sort("sort_order", 1).to_list(50)
        return rows

    # ------------------------------------------------------------------
    # Chef's View
    # ------------------------------------------------------------------
    @router.get("/admin/meals-today")
    async def meals_today(
        cutoff: str = Query(DEFAULT_MEAL_CUTOFF, description="HH:MM meal cut-off (office-local)"),
        date_str: Optional[str] = Query(None, alias="date", description="YYYY-MM-DD (defaults to today, office-local)"),
        admin: dict = Depends(require_admin),
    ):
        """Return meal-eligible members for a given day (defaults to today).

        A member is meal-eligible if:
          • Their category is `meal_eligible=True` in the categories master
            (all 5 seeded categories are eligible by default), AND
          • They have an attendance row for the target date with
            `check_in_at` translating to office-local ≤ `cutoff`
            (default 07:00).

        Returns counts per category + a flat member list (photo + name +
        institution + fleet + check-in time) for the chef's printable
        drill-down.
        """
        h, m = _parse_hm(cutoff)
        office = await db.config.find_one({"id": "office"})
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
            "generated_at": now_utc().isoformat(),
            "categories": cats,   # ordered, with colors/labels
            "counts": counts,      # {category_key: n}
            "total": sum(counts.values()),
            "members": members,
        }

    return router
