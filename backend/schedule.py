"""
Schedule exceptions & holidays.

Two override layers sit on top of the normal start-time resolution
(personal work_start → active camp → office default):

  1. Weekly overrides — stored on the office config doc as
     `weekly_overrides = { "sun": {"start_time": "08:00", "end_time": "10:00"}, ... }`.
     e.g. "every Sunday athletes start at 08:00 instead of 06:00".

  2. Schedule exceptions — a `schedule_exceptions` collection, two kinds:
       - "holiday": a date (or date range) on which nobody is expected. Enrolled
         members are never marked Absent; camps are suspended; check-in stays
         allowed for anyone who shows up.
       - "timing": a one-off date (or short range) with a different start/end
         time for everyone.

Precedence for a given day (campus-wide):
    holiday  >  one-off date timing  >  weekly override  >  (camp / personal / default)
A one-off date timing/holiday always wins over a weekly override.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

router = APIRouter(prefix="/api", tags=["schedule"])

WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class ExceptionIn(BaseModel):
    kind: Literal["holiday", "timing"]
    name: Optional[str] = None
    start_date: str
    end_date: str
    start_time: Optional[str] = None
    end_time: Optional[str] = None

    @field_validator("start_date", "end_date")
    @classmethod
    def _date(cls, v: str) -> str:
        if not _DATE_RE.match(v):
            raise ValueError("must be YYYY-MM-DD")
        return v

    @field_validator("start_time", "end_time")
    @classmethod
    def _time(cls, v: Optional[str]) -> Optional[str]:
        if v is None or v == "":
            return None
        if not _TIME_RE.match(v):
            raise ValueError("must be HH:MM (24-hour)")
        return v


class ExceptionPatch(BaseModel):
    kind: Optional[Literal["holiday", "timing"]] = None
    name: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None


class WeeklyOverridesIn(BaseModel):
    # { "sun": {"start_time": "08:00", "end_time": "10:00"}, ... }
    overrides: dict = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Helpers (importable from server.py)
# ---------------------------------------------------------------------------
async def fetch_exceptions_active_on(db, date_str: str) -> List[dict]:
    """All schedule exceptions whose date range covers `date_str`."""
    return await db.schedule_exceptions.find(
        {"start_date": {"$lte": date_str}, "end_date": {"$gte": date_str}},
        {"_id": 0},
    ).to_list(200)


def resolve_day_schedule(date_str: str, weekday: str, exceptions: List[dict], weekly_overrides: dict) -> Optional[dict]:
    """Resolve the campus-wide schedule override for a single day, applying the
    documented precedence. Returns one of:
      - {"holiday": True, "name": ...}
      - {"holiday": False, "start_time": HH:MM|None, "end_time": HH:MM|None, "source": "date"|"weekly"}
      - None  (no override → caller falls back to camp/personal/default)
    """
    hol = next((e for e in exceptions if e.get("kind") == "holiday"), None)
    if hol:
        return {"holiday": True, "name": hol.get("name") or "Holiday"}
    tim = next((e for e in exceptions if e.get("kind") == "timing" and e.get("start_time")), None)
    if tim:
        return {"holiday": False, "start_time": tim.get("start_time"), "end_time": tim.get("end_time"), "source": "date"}
    wk = (weekly_overrides or {}).get(weekday)
    if wk and wk.get("start_time"):
        return {"holiday": False, "start_time": wk.get("start_time"), "end_time": wk.get("end_time"), "source": "weekly"}
    return None


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------
def make_router(db, require_admin, get_current_user) -> APIRouter:

    @router.get("/schedule/exceptions")
    async def list_exceptions(user: dict = Depends(get_current_user)):
        rows = await db.schedule_exceptions.find({}, {"_id": 0}).sort("start_date", -1).to_list(500)
        return rows

    @router.post("/schedule/exceptions")
    async def create_exception(body: ExceptionIn, admin: dict = Depends(require_admin)):
        if body.start_date > body.end_date:
            raise HTTPException(status_code=400, detail="start_date must be on or before end_date")
        if body.kind == "timing" and not body.start_time:
            raise HTTPException(status_code=400, detail="Timing changes require a start_time")
        if body.start_time and body.end_time and body.start_time >= body.end_time:
            raise HTTPException(status_code=400, detail="start_time must be before end_time")
        doc = body.model_dump()
        doc["id"] = str(uuid.uuid4())
        doc["created_at"] = datetime.now(timezone.utc).isoformat()
        doc["created_by"] = admin["id"]
        await db.schedule_exceptions.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @router.patch("/schedule/exceptions/{exc_id}")
    async def patch_exception(exc_id: str, body: ExceptionPatch, admin: dict = Depends(require_admin)):
        payload = {k: v for k, v in body.model_dump().items() if v is not None}
        if not payload:
            raise HTTPException(status_code=400, detail="No fields to update")
        existing = await db.schedule_exceptions.find_one({"id": exc_id}, {"_id": 0})
        if not existing:
            raise HTTPException(status_code=404, detail="Not found")
        sd = payload.get("start_date", existing["start_date"])
        ed = payload.get("end_date", existing["end_date"])
        if sd > ed:
            raise HTTPException(status_code=400, detail="start_date must be on or before end_date")
        await db.schedule_exceptions.update_one({"id": exc_id}, {"$set": payload})
        return await db.schedule_exceptions.find_one({"id": exc_id}, {"_id": 0})

    @router.delete("/schedule/exceptions/{exc_id}")
    async def delete_exception(exc_id: str, admin: dict = Depends(require_admin)):
        res = await db.schedule_exceptions.delete_one({"id": exc_id})
        if res.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Not found")
        return {"ok": True}

    @router.get("/schedule/weekly")
    async def get_weekly(user: dict = Depends(get_current_user)):
        office = await db.config.find_one({"id": "office"}, {"_id": 0, "weekly_overrides": 1})
        return {"overrides": (office or {}).get("weekly_overrides") or {}}

    @router.put("/schedule/weekly")
    async def put_weekly(body: WeeklyOverridesIn, admin: dict = Depends(require_admin)):
        clean: dict = {}
        for day, val in (body.overrides or {}).items():
            if day not in WEEKDAY_KEYS or not isinstance(val, dict):
                continue
            st = val.get("start_time")
            et = val.get("end_time")
            if st and not _TIME_RE.match(st):
                raise HTTPException(status_code=400, detail=f"{day}: start_time must be HH:MM")
            if et and not _TIME_RE.match(et):
                raise HTTPException(status_code=400, detail=f"{day}: end_time must be HH:MM")
            if st and et and st >= et:
                raise HTTPException(status_code=400, detail=f"{day}: start_time must be before end_time")
            if st:  # only store days that actually set a start override
                clean[day] = {"start_time": st, "end_time": et or None}
        await db.config.update_one({"id": "office"}, {"$set": {"weekly_overrides": clean}})
        return {"overrides": clean}

    return router
