"""
Camp = a time-bounded scheduling overlay for institutional athletes.

A camp pins a specific `start_time`/`end_time` (and optional `late_grace_minutes`
override) to a date range, with optional day-of-week filtering. Enrolled members
are evaluated for late/absent against the camp's times instead of their personal
`work_start`/`work_end` whenever the camp is active.

Rationale: YCH runs camps for Rainbow Home, MJPT, Agape Home, etc. Those
athletes don't have a 9-to-5 schedule — they only attend camps. Today they
show up as "Absent" every weekday. With camps in place, they're only judged
against camp days, and athletes with no camp & no work_start fall back to
"Not yet due" (no longer marked absent).
"""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timezone
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["camps"])

WEEKDAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
WEEKDAY_FROM_INT = dict(enumerate(WEEKDAY_KEYS))  # 0=mon ... 6=sun


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


# kind: "camp" = local daily training schedule (drives late/absent for athletes).
#       "outstation" = a travel event (regatta for athletes / tour for staff &
#       coaches) at a `location`; enrolled members are auto-excused (shown
#       "on tour / at regatta", never absent) for the whole date range and are
#       not required to check in. Times are optional for outstation events.
CampKind = Literal["camp", "outstation"]


class CampIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: CampKind = "camp"
    location: Optional[str] = None  # where the camp/regatta/tour is held
    institution: Optional[str] = None  # purely informational filter
    start_date: str
    end_date: str
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    days_of_week: List[Literal["mon","tue","wed","thu","fri","sat","sun"]] = Field(default_factory=list)
    member_ids: List[str] = Field(default_factory=list)
    late_grace_minutes: Optional[int] = None
    notes: Optional[str] = None

    @field_validator("start_date", "end_date")
    @classmethod
    def _check_date(cls, v: str) -> str:
        if not _DATE_RE.match(v):
            raise ValueError("must be YYYY-MM-DD")
        return v

    @field_validator("start_time", "end_time")
    @classmethod
    def _check_time(cls, v: Optional[str]) -> Optional[str]:
        if v is None or v == "":
            return None
        if not _TIME_RE.match(v):
            raise ValueError("must be HH:MM (24-hour)")
        return v


class CampPatch(BaseModel):
    name: Optional[str] = None
    kind: Optional[CampKind] = None
    location: Optional[str] = None
    institution: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    days_of_week: Optional[List[Literal["mon","tue","wed","thu","fri","sat","sun"]]] = None
    member_ids: Optional[List[str]] = None
    late_grace_minutes: Optional[int] = None
    notes: Optional[str] = None


# ---------------------------------------------------------------------------
# Helpers (importable from server.py for use in presence / late computation)
# ---------------------------------------------------------------------------
def weekday_key(d: datetime) -> str:
    """Return the camp-format weekday key (mon..sun) for a local date."""
    return WEEKDAY_FROM_INT[d.weekday()]


def camp_active_on(camp: dict, today_str: str, weekday: str) -> bool:
    """True when a camp's date range covers `today_str` and its days_of_week
    filter (if any) includes `weekday`."""
    if not camp:
        return False
    if camp.get("start_date") and camp["start_date"] > today_str:
        return False
    if camp.get("end_date") and camp["end_date"] < today_str:
        return False
    dows = camp.get("days_of_week") or []
    if dows and weekday not in dows:
        return False
    return True


def camp_applies_to(camp: dict, member: dict) -> bool:
    """True when `member` is enrolled in `camp`. Enrollment rule:
    - If `member_ids` is non-empty, member must be in that list.
    - Else if `institution` is set, any member of that institution applies.
    - Else: camp applies to nobody (an admin must enroll someone first)."""
    mids = camp.get("member_ids") or []
    if mids:
        return member.get("id") in mids
    inst = camp.get("institution")
    if inst:
        return (member.get("institution") or "") == inst
    return False


async def fetch_camps_active_on(db, today_str: str) -> List[dict]:
    """Return all camps whose date range covers `today_str` — used as a one-shot
    bulk fetch by the presence endpoint so we don't hit the DB per member."""
    cursor = db.camps.find(
        {"start_date": {"$lte": today_str}, "end_date": {"$gte": today_str}},
        {"_id": 0},
    )
    return await cursor.to_list(500)


def resolve_member_camp(member: dict, camps_today: List[dict], weekday: str, today_str: str) -> Optional[dict]:
    """Pick the *training camp* that applies to this member today. Outstation
    events (regattas/tours) are excluded — they never act as a daily schedule.
    If multiple match, the one with explicit member_ids wins (more specific)
    over an institution-wide one."""
    matches = [c for c in camps_today
               if c.get("kind", "camp") != "outstation"
               and camp_active_on(c, today_str, weekday) and camp_applies_to(c, member)]
    if not matches:
        return None
    matches.sort(key=lambda c: 0 if (c.get("member_ids") or []) else 1)
    return matches[0]


def resolve_member_outstation(member: dict, camps_today: List[dict], today_str: str) -> Optional[dict]:
    """Pick the active outstation event (regatta/tour) this member is enrolled in
    today, if any. Outstation events ignore day-of-week filtering — a travel
    window covers every day in its date range. Explicit member_ids win over an
    institution-wide enrollment."""
    matches = [c for c in camps_today
               if c.get("kind") == "outstation"
               and (not c.get("start_date") or c["start_date"] <= today_str)
               and (not c.get("end_date") or c["end_date"] >= today_str)
               and camp_applies_to(c, member)]
    if not matches:
        return None
    matches.sort(key=lambda c: 0 if (c.get("member_ids") or []) else 1)
    return matches[0]


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------
def make_router(db, require_admin) -> APIRouter:
    """Bind the camp CRUD routes to the backend's DB and auth dependency."""

    @router.get("/camps")
    async def list_camps(admin: dict = Depends(require_admin)):
        rows = await db.camps.find({}, {"_id": 0}).sort("start_date", -1).to_list(500)
        return rows

    @router.post("/camps")
    async def create_camp(body: CampIn, admin: dict = Depends(require_admin)):
        if body.start_date > body.end_date:
            raise HTTPException(status_code=400, detail="start_date must be on or before end_date")
        if body.kind == "camp":
            if not body.start_time or not body.end_time:
                raise HTTPException(status_code=400, detail="Camps require start_time and end_time")
            if body.start_time >= body.end_time:
                raise HTTPException(status_code=400, detail="start_time must be before end_time")
        elif body.start_time and body.end_time and body.start_time >= body.end_time:
            raise HTTPException(status_code=400, detail="start_time must be before end_time")
        doc = body.model_dump()
        doc["id"] = str(uuid.uuid4())
        doc["created_at"] = datetime.now(timezone.utc).isoformat()
        doc["created_by"] = admin["id"]
        await db.camps.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @router.get("/camps/{camp_id}")
    async def get_camp(camp_id: str, admin: dict = Depends(require_admin)):
        c = await db.camps.find_one({"id": camp_id}, {"_id": 0})
        if not c:
            raise HTTPException(status_code=404, detail="Camp not found")
        return c

    @router.patch("/camps/{camp_id}")
    async def patch_camp(camp_id: str, body: CampPatch, admin: dict = Depends(require_admin)):
        payload = {k: v for k, v in body.model_dump().items() if v is not None}
        if not payload:
            raise HTTPException(status_code=400, detail="No fields to update")
        # Cross-field validation when one side is being changed.
        existing = await db.camps.find_one({"id": camp_id}, {"_id": 0})
        if not existing:
            raise HTTPException(status_code=404, detail="Camp not found")
        sd = payload.get("start_date", existing["start_date"])
        ed = payload.get("end_date", existing["end_date"])
        st = payload.get("start_time", existing.get("start_time"))
        et = payload.get("end_time", existing.get("end_time"))
        if sd > ed:
            raise HTTPException(status_code=400, detail="start_date must be on or before end_date")
        if st and et and st >= et:
            raise HTTPException(status_code=400, detail="start_time must be before end_time")
        payload["updated_at"] = datetime.now(timezone.utc).isoformat()
        payload["updated_by"] = admin["id"]
        await db.camps.update_one({"id": camp_id}, {"$set": payload})
        doc = await db.camps.find_one({"id": camp_id}, {"_id": 0})
        return doc

    @router.delete("/camps/{camp_id}")
    async def delete_camp(camp_id: str, admin: dict = Depends(require_admin)):
        res = await db.camps.delete_one({"id": camp_id})
        if res.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Camp not found")
        return {"ok": True}

    return router
