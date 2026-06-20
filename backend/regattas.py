"""
Regatta = a national / international sailing event YCH athletes may attend.
Unlike a camp (which is a daily training schedule), a regatta is a discrete
travel-and-compete window — we just record name, level, location, and dates so
they show up on the unified Calendar view alongside camps.

Collection: `regattas`
  { id, name, level: "international"|"national"|"state"|"club",
    location, country, start_date, end_date, host_org, notes,
    created_at, created_by }
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
router = APIRouter(prefix="/api", tags=["regattas"])

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
RegattaLevel = Literal["international", "national", "state", "club"]


class RegattaIn(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    level: RegattaLevel = "national"
    location: Optional[str] = None       # city / venue
    country: Optional[str] = None        # ISO name or free text
    start_date: str
    end_date: str
    host_org: Optional[str] = None       # organising body (e.g. "World Sailing")
    notes: Optional[str] = None

    @field_validator("start_date", "end_date")
    @classmethod
    def _date(cls, v: str) -> str:
        if not _DATE_RE.match(v):
            raise ValueError("must be YYYY-MM-DD")
        return v


class RegattaPatch(BaseModel):
    name: Optional[str] = None
    level: Optional[RegattaLevel] = None
    location: Optional[str] = None
    country: Optional[str] = None
    start_date: Optional[str] = None
    end_date: Optional[str] = None
    host_org: Optional[str] = None
    notes: Optional[str] = None


async def fetch_regattas_overlapping(db, range_start: str, range_end: str) -> List[dict]:
    """Return regattas whose [start_date, end_date] overlaps [range_start, range_end].
    Used by the Calendar view to fetch a single month at a time."""
    cursor = db.regattas.find(
        {"start_date": {"$lte": range_end}, "end_date": {"$gte": range_start}},
        {"_id": 0},
    )
    return await cursor.to_list(500)


def make_router(db, require_admin) -> APIRouter:
    @router.get("/regattas")
    async def list_regattas(admin: dict = Depends(require_admin)):
        return await db.regattas.find({}, {"_id": 0}).sort("start_date", -1).to_list(500)

    @router.post("/regattas")
    async def create_regatta(body: RegattaIn, admin: dict = Depends(require_admin)):
        if body.start_date > body.end_date:
            raise HTTPException(status_code=400, detail="start_date must be on or before end_date")
        doc = body.model_dump()
        doc["id"] = str(uuid.uuid4())
        doc["created_at"] = datetime.now(timezone.utc).isoformat()
        doc["created_by"] = admin["id"]
        await db.regattas.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @router.patch("/regattas/{regatta_id}")
    async def patch_regatta(regatta_id: str, body: RegattaPatch, admin: dict = Depends(require_admin)):
        payload = {k: v for k, v in body.model_dump().items() if v is not None}
        if not payload:
            raise HTTPException(status_code=400, detail="No fields to update")
        existing = await db.regattas.find_one({"id": regatta_id}, {"_id": 0})
        if not existing:
            raise HTTPException(status_code=404, detail="Regatta not found")
        sd = payload.get("start_date", existing["start_date"])
        ed = payload.get("end_date", existing["end_date"])
        if sd > ed:
            raise HTTPException(status_code=400, detail="start_date must be on or before end_date")
        payload["updated_at"] = datetime.now(timezone.utc).isoformat()
        payload["updated_by"] = admin["id"]
        await db.regattas.update_one({"id": regatta_id}, {"$set": payload})
        return await db.regattas.find_one({"id": regatta_id}, {"_id": 0})

    @router.delete("/regattas/{regatta_id}")
    async def delete_regatta(regatta_id: str, admin: dict = Depends(require_admin)):
        res = await db.regattas.delete_one({"id": regatta_id})
        if res.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Regatta not found")
        return {"ok": True}

    return router
