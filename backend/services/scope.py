"""
Shared category-scope helpers for roster endpoints.

Both `routes/muster.py` and `routes/meals.py` need to filter the users
collection to a "scope" (athletes / staff / coach / executive /
non-athletes / all). This module is the single source of truth for
that logic so a category rename or a new scope only needs to change
in one place.
"""
from __future__ import annotations

from typing import Iterable


# Default fallback if the categories master collection is empty
# (fresh install / test env).
DEFAULT_ATHLETE_LIKE = ("athlete", "elite")

# Valid scope strings accepted by the roster endpoints. Kept here so
# validators / tests can reference a single tuple.
VALID_SCOPES = ("all", "athletes", "staff", "coach", "executive", "non_athletes")


async def athlete_like_keys(db) -> list[str]:
    """Category keys flagged `is_athlete_like=True` in the categories
    master. Historically muster only queried 'athlete' which silently
    hid Elite squad members (bug 04 Feb 2026). Falls back to
    (athlete, elite) if the master collection is empty."""
    keys: set[str] = set()
    async for c in db.categories.find({"is_athlete_like": True}, {"_id": 0, "key": 1}):
        k = c.get("key")
        if k:
            keys.add(k)
    if not keys:
        keys = set(DEFAULT_ATHLETE_LIKE)
    return list(keys)


async def scoped_user_query(
    db, scope: str, *, admin_can_widen: bool = True,
) -> dict:
    """Build the users-collection filter for a roster endpoint.

    `admin_can_widen=False` (used by coaches/escorts and by the meal
    muster's chef/coach paths) forces the athlete-only roster
    regardless of `scope`. Admins pass `admin_can_widen=True` and get
    the wider selection.

    Scope handling (when `admin_can_widen=True`):
      • "athletes"     → athlete_like categories
      • "staff"        → category == "staff"
      • "coach"        → category == "coach"
      • "executive"    → category == "executive"
      • "non_athletes" → category NOT in athlete_like
      • "all" (or unknown) → no category filter
    """
    keys = await athlete_like_keys(db)
    if not admin_can_widen or scope == "athletes":
        return {"category": {"$in": keys}}
    if scope == "non_athletes":
        return {"category": {"$nin": keys}}
    if scope in ("staff", "coach", "executive"):
        return {"category": scope}
    # "all" or unknown → no category filter
    return {}
