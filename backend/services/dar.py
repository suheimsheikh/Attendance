"""Daily Activity Report (DAR) policy helpers shared by the DAR router,
the check-out path in server.py and the Grid engine in routes/reports.py.

Policy doc lives on db.config under id="dar_policy":
  enabled, effective_from (YYYY-MM-DD), min_chars, group_name
Members: category in DAR_CATEGORIES and not `dar_exempt`.
"""
from datetime import date, timedelta
from typing import Iterable, Optional

from fastapi import HTTPException

DAR_CATEGORIES = {"staff", "coach", "executive"}
DAR_DEFAULTS = {"enabled": True, "min_chars": 20, "group_name": "YCH DAR"}


def dar_required_for(user: dict) -> bool:
    if not user or user.get("status") == "left" or user.get("dar_exempt"):
        return False
    return user.get("category") in DAR_CATEGORIES or bool(user.get("dar_required"))


DAR_USER_FILTER = {"status": {"$ne": "left"},
                   "$or": [{"category": {"$in": sorted(DAR_CATEGORIES)}}, {"dar_required": True}]}


async def get_dar_policy(db, today_iso: str) -> dict:
    doc = await db.config.find_one({"id": "dar_policy"}, {"_id": 0})
    if not doc:
        doc = {"id": "dar_policy", **DAR_DEFAULTS, "effective_from": today_iso}
        await db.config.update_one({"id": "dar_policy"}, {"$setOnInsert": doc}, upsert=True)
    out = {**DAR_DEFAULTS, **doc}
    out.pop("id", None)
    return out


def validate_dar_text(text: Optional[str], min_chars: int) -> str:
    clean = (text or "").strip()
    if len(clean) < min_chars:
        raise HTTPException(status_code=400, detail=f"DAR must be at least {min_chars} characters")
    return clean


def dar_day_applies(policy: dict, iso: str, today_iso: str) -> bool:
    """A day counts for DAR when policy is on, day >= effective_from and day < today."""
    if not policy.get("enabled", True):
        return False
    eff = policy.get("effective_from") or today_iso
    return eff <= iso < today_iso


async def compute_missed_by_user(db, users: Iterable[dict], start_iso: str, end_iso: str,
                                 today_iso: str, policy: Optional[dict] = None) -> dict:
    """{user_id: [iso, ...]} of worked days (attendance row with check-in)
    that have no DAR, for DAR-required users only, within [start, end]."""
    policy = policy or await get_dar_policy(db, today_iso)
    required = [u for u in users if dar_required_for(u)]
    if not required:
        return {}
    ids = [u["id"] for u in required]
    end_cap = min(end_iso, (date.fromisoformat(today_iso) - timedelta(days=1)).isoformat())
    if end_cap < start_iso:
        return {u["id"]: [] for u in required}
    worked: dict = {}
    async for a in db.attendance.find(
        {"user_id": {"$in": ids}, "date": {"$gte": start_iso, "$lte": end_cap}, "check_in_at": {"$ne": None}},
        {"_id": 0, "user_id": 1, "date": 1},
    ):
        worked.setdefault(a["user_id"], set()).add(a["date"])
    filed: dict = {}
    async for d in db.dars.find(
        {"user_id": {"$in": ids}, "date": {"$gte": start_iso, "$lte": end_cap}},
        {"_id": 0, "user_id": 1, "date": 1},
    ):
        filed.setdefault(d["user_id"], set()).add(d["date"])
    out = {}
    for u in required:
        uid = u["id"]
        missed = sorted(
            iso for iso in worked.get(uid, set())
            if dar_day_applies(policy, iso, today_iso) and iso not in filed.get(uid, set())
        )
        out[uid] = missed
    return out
