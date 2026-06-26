"""
Holidays + Comp-Off balance.

A Holiday row is a calendar date marker. It does NOT auto-create a Break
(per user decision — Holidays and Breaks are managed separately). The
Holiday list drives comp-off accrual:

  - Each calendar date the member has attendance for, where that date is
    EITHER the member's `weekly_off` OR matches a Holiday row, accrues
    +1 comp-off credit.
  - Each approved `comp_off` leave consumes credits at 1-per-calendar-day.
  - `available = accrued − used`.

The leave create endpoint hard-blocks a `comp_off` request that exceeds
`available` (per user decision — admin manages exceptions by adding
opening leave balance, not by silent over-draw).
"""
from __future__ import annotations

import re
import uuid
from datetime import date, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class HolidayIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    date: str
    notes: Optional[str] = None

    @field_validator("date")
    @classmethod
    def _check_date(cls, v: str) -> str:
        if not _DATE_RE.match(v):
            raise ValueError("date must be YYYY-MM-DD")
        return v


class HolidayPatch(BaseModel):
    name: Optional[str] = None
    date: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("date")
    @classmethod
    def _check_date(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not _DATE_RE.match(v):
            raise ValueError("date must be YYYY-MM-DD")
        return v


# ---------------------------------------------------------------------------
# Comp-off balance helper (importable from routes/leaves.py for create-time
# validation)
# ---------------------------------------------------------------------------
WEEKDAY_KEY = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def _days_inclusive(start_iso: str, end_iso: str) -> int:
    try:
        return (date.fromisoformat(end_iso) - date.fromisoformat(start_iso)).days + 1
    except Exception:
        return 1


async def compute_comp_off_balance(db, user: dict, year: Optional[str] = None) -> dict:
    """Compute the live comp-off balance for `user`.

    Sources of accrual:
      - attendance rows whose `date` falls on the user's `weekly_off`, or
      - attendance rows whose `date` matches a Holiday in the holidays
        collection.
    A single date that satisfies both conditions still counts as one credit
    (no double-dipping).

    Sources of consumption:
      - approved leaves of type=comp_off, counted as (end - start + 1) days.
    """
    if not year:
        # Default to current calendar year. Caller can pass an explicit year
        # if they want to scope the report (e.g. for a yearly closing view).
        year = str(date.today().year)
    weekly_off = (user.get("weekly_off") or "").lower()

    # Pull all holidays once (small set; rarely exceeds ~30 rows/year).
    holidays = await db.holidays.find({}, {"_id": 0}).to_list(500)
    holiday_dates = {h["date"] for h in holidays}
    holiday_name_by_date = {h["date"]: h.get("name") or "Holiday" for h in holidays}

    # All attendance rows for this user in the target year.
    yr_start = f"{year}-01-01"
    yr_end = f"{year}-12-31"
    atts = await db.attendance.find(
        {"user_id": user["id"], "date": {"$gte": yr_start, "$lte": yr_end}},
        {"_id": 0, "date": 1},
    ).to_list(2000)

    # De-dupe by date — a member with two sessions on the same day still
    # accrues one credit, not two.
    distinct_dates = sorted({a["date"] for a in atts})
    breakdown: List[dict] = []
    accrued = 0
    for ds in distinct_dates:
        try:
            wd = WEEKDAY_KEY[date.fromisoformat(ds).weekday()]
        except Exception:
            continue
        is_weekly_off = bool(weekly_off) and wd == weekly_off
        is_holiday = ds in holiday_dates
        if not (is_weekly_off or is_holiday):
            continue
        accrued += 1
        breakdown.append({
            "date": ds,
            "kind": "holiday" if is_holiday else "weekly_off",
            "holiday_name": holiday_name_by_date.get(ds) if is_holiday else None,
        })

    # Consumed: approved comp_off leaves within the same year.
    used_leaves = await db.leaves.find({
        "user_id": user["id"],
        "type": "comp_off",
        "status": "approved",
        "start_date": {"$lte": yr_end},
        "end_date": {"$gte": yr_start},
    }, {"_id": 0, "start_date": 1, "end_date": 1}).to_list(500)
    used = sum(_days_inclusive(L["start_date"], L["end_date"]) for L in used_leaves)

    return {
        "year": year,
        "accrued": accrued,
        "used": used,
        "available": max(0, accrued - used),
        "breakdown": breakdown,
    }


# ---------------------------------------------------------------------------
# Router factory
# ---------------------------------------------------------------------------
def make_router(db, require_admin, get_current_user) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["holidays"])

    @router.get("/holidays")
    async def list_holidays(_user: dict = Depends(get_current_user)):
        """List every Holiday row, ordered by date. Authenticated read so
        members can see which days carry comp-off accrual eligibility."""
        rows = await db.holidays.find({}, {"_id": 0}).sort("date", 1).to_list(500)
        return rows

    @router.post("/holidays")
    async def create_holiday(body: HolidayIn, admin: dict = Depends(require_admin)):
        # Prevent duplicates on the same calendar date — keeps the comp-off
        # accrual logic simple (one credit per attended date).
        existing = await db.holidays.find_one({"date": body.date}, {"_id": 0})
        if existing:
            raise HTTPException(status_code=400, detail=f"A holiday already exists on {body.date}: {existing['name']}")
        doc = {
            "id": str(uuid.uuid4()),
            "name": body.name.strip(),
            "date": body.date,
            "notes": (body.notes or "").strip() or None,
            "created_by": admin["id"],
            "created_at": _iso_now(),
        }
        await db.holidays.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @router.patch("/holidays/{holiday_id}")
    async def update_holiday(holiday_id: str, body: HolidayPatch, admin: dict = Depends(require_admin)):
        update = body.model_dump(exclude_unset=True)
        if "name" in update and update["name"] is not None:
            update["name"] = update["name"].strip()
        if "notes" in update and update["notes"] is not None:
            update["notes"] = update["notes"].strip() or None
        if "date" in update and update["date"] is not None:
            # If the date is being moved, guard against collision with another row.
            dup = await db.holidays.find_one({"date": update["date"], "id": {"$ne": holiday_id}}, {"_id": 0})
            if dup:
                raise HTTPException(status_code=400, detail=f"Another holiday already exists on {update['date']}: {dup['name']}")
        update["updated_at"] = _iso_now()
        res = await db.holidays.update_one({"id": holiday_id}, {"$set": update})
        if res.matched_count == 0:
            raise HTTPException(status_code=404, detail="Holiday not found")
        row = await db.holidays.find_one({"id": holiday_id}, {"_id": 0})
        return row

    @router.delete("/holidays/{holiday_id}")
    async def delete_holiday(holiday_id: str, admin: dict = Depends(require_admin)):
        res = await db.holidays.delete_one({"id": holiday_id})
        if res.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Holiday not found")
        return {"ok": True}

    @router.get("/me/comp-off-balance")
    async def my_comp_off_balance(user: dict = Depends(get_current_user)):
        return await compute_comp_off_balance(db, user)

    @router.get("/members/{member_id}/comp-off-balance")
    async def member_comp_off_balance(member_id: str, _admin: dict = Depends(require_admin)):
        u = await db.users.find_one({"id": member_id}, {"_id": 0})
        if not u:
            raise HTTPException(status_code=404, detail="Member not found")
        return await compute_comp_off_balance(db, u)

    return router


def _iso_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
