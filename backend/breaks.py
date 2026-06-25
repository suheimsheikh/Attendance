"""
Break = a holiday / rest / off-day overlay for a set of members.

While a break is active, the affected members are treated like an approved
leave on the Presence Board — they show up under the **Leave** column with
a "On break" detail, do not contribute to the Absent tally, and never
trigger "late" badges or parent-notify dispatches.

Scope picker (frontend) maps to backend `scope` field:
  - "all"         → every member is on break
  - "athletes"    → all athletes
  - "coaches"     → all coaches
  - "staff"       → all staff
  - "institution" → every athlete of `institution`
  - "selected"    → only the explicit `member_ids` list

Use cases:
  - Public holiday → scope=all
  - Athlete rest day → scope=athletes (or scope=institution for one school)
  - Personal break for a select group → scope=selected + member_ids
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

router = APIRouter(prefix="/api", tags=["breaks"])

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

ScopeT = Literal["all", "athletes", "coaches", "staff", "institution", "fleet", "selected"]


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class BreakIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    scope: ScopeT
    start_date: str
    end_date: str
    institution: Optional[str] = None  # required when scope == "institution"
    fleet: Optional[str] = None        # required when scope == "fleet"
    member_ids: List[str] = Field(default_factory=list)  # required when scope == "selected"
    notes: Optional[str] = None

    @field_validator("start_date", "end_date")
    @classmethod
    def _check_date(cls, v: str) -> str:
        if not _DATE_RE.match(v):
            raise ValueError("must be YYYY-MM-DD")
        return v


class BreakPatch(BaseModel):
    name: Optional[str] = None
    scope: Optional[ScopeT] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    institution: Optional[str] = None
    fleet: Optional[str] = None
    member_ids: Optional[List[str]] = None
    notes: Optional[str] = None


# ---------------------------------------------------------------------------
# Helpers (importable from server.py for use in presence)
# ---------------------------------------------------------------------------
def break_active_on(brk: dict, today_str: str) -> bool:
    if not brk:
        return False
    if brk.get("start_date") and brk["start_date"] > today_str:
        return False
    if brk.get("end_date") and brk["end_date"] < today_str:
        return False
    return True


def break_applies_to(brk: dict, member: dict) -> bool:
    """Whether `member` is covered by `brk`'s scope rule."""
    scope = brk.get("scope")
    if scope == "all":
        return True
    if scope == "athletes":
        return (member.get("category") or "").lower() == "athlete"
    if scope == "coaches":
        return (member.get("category") or "").lower() == "coach"
    if scope == "staff":
        return (member.get("category") or "").lower() == "staff"
    if scope == "institution":
        inst = brk.get("institution")
        if not inst:
            return False
        return (member.get("institution") or "") == inst
    if scope == "fleet":
        fl = brk.get("fleet")
        if not fl:
            return False
        return (member.get("fleet") or "") == fl
    if scope == "selected":
        return member.get("id") in (brk.get("member_ids") or [])
    return False


async def fetch_breaks_active_on(db, today_str: str) -> List[dict]:
    cursor = db.breaks.find(
        {"start_date": {"$lte": today_str}, "end_date": {"$gte": today_str}},
        {"_id": 0},
    )
    return await cursor.to_list(500)


def resolve_member_break(member: dict, breaks_today: List[dict]) -> Optional[dict]:
    """Pick the first break whose scope covers this member today. Selected /
    institution-specific breaks win over scope=all when both match."""
    if not breaks_today:
        return None
    matches = [b for b in breaks_today if break_applies_to(b, member)]
    if not matches:
        return None
    priority = {"selected": 0, "institution": 1, "fleet": 1, "athletes": 2, "coaches": 2, "staff": 2, "all": 3}
    matches.sort(key=lambda b: priority.get(b.get("scope"), 9))
    return matches[0]


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------
def make_router(db, require_admin) -> APIRouter:
    """Bind the break CRUD routes to the backend's DB and auth dependency."""

    @router.get("/breaks")
    async def list_breaks(admin: dict = Depends(require_admin)):
        return await db.breaks.find({}, {"_id": 0}).sort("start_date", -1).to_list(500)

    @router.post("/breaks")
    async def create_break(body: BreakIn, admin: dict = Depends(require_admin)):
        if body.start_date > body.end_date:
            raise HTTPException(status_code=400, detail="start_date must be on or before end_date")
        if body.scope == "institution" and not body.institution:
            raise HTTPException(status_code=400, detail="institution is required when scope is 'institution'")
        if body.scope == "fleet" and not body.fleet:
            raise HTTPException(status_code=400, detail="fleet is required when scope is 'fleet'")
        if body.scope == "selected" and not body.member_ids:
            raise HTTPException(status_code=400, detail="At least one member must be selected")
        doc = body.model_dump()
        doc["id"] = str(uuid.uuid4())
        doc["created_at"] = datetime.now(timezone.utc).isoformat()
        doc["created_by"] = admin["id"]
        await db.breaks.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @router.get("/breaks/{break_id}")
    async def get_break(break_id: str, admin: dict = Depends(require_admin)):
        b = await db.breaks.find_one({"id": break_id}, {"_id": 0})
        if not b:
            raise HTTPException(status_code=404, detail="Break not found")
        return b

    @router.patch("/breaks/{break_id}")
    async def patch_break(break_id: str, body: BreakPatch, admin: dict = Depends(require_admin)):
        payload = {k: v for k, v in body.model_dump().items() if v is not None}
        if not payload:
            raise HTTPException(status_code=400, detail="No fields to update")
        existing = await db.breaks.find_one({"id": break_id}, {"_id": 0})
        if not existing:
            raise HTTPException(status_code=404, detail="Break not found")
        sd = payload.get("start_date", existing["start_date"])
        ed = payload.get("end_date", existing["end_date"])
        if sd > ed:
            raise HTTPException(status_code=400, detail="start_date must be on or before end_date")
        scope = payload.get("scope", existing.get("scope"))
        if scope == "institution" and not (payload.get("institution") or existing.get("institution")):
            raise HTTPException(status_code=400, detail="institution is required when scope is 'institution'")
        if scope == "fleet" and not (payload.get("fleet") or existing.get("fleet")):
            raise HTTPException(status_code=400, detail="fleet is required when scope is 'fleet'")
        if scope == "selected" and not (payload.get("member_ids") or existing.get("member_ids")):
            raise HTTPException(status_code=400, detail="At least one member must be selected")
        payload["updated_at"] = datetime.now(timezone.utc).isoformat()
        payload["updated_by"] = admin["id"]
        await db.breaks.update_one({"id": break_id}, {"$set": payload})
        return await db.breaks.find_one({"id": break_id}, {"_id": 0})

    @router.delete("/breaks/{break_id}")
    async def delete_break(break_id: str, admin: dict = Depends(require_admin)):
        res = await db.breaks.delete_one({"id": break_id})
        if res.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Break not found")
        return {"ok": True}

    return router
