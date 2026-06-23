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

    @router.post("/regattas/import-yai")
    async def import_yai(admin: dict = Depends(require_admin)):
        """Idempotently seed/refresh the Yachting Association of India (YAI)
        2026 + early-2027 domestic sailing calendar. Matches on
        (name, start_date) so re-running won't create duplicates — existing
        rows are updated in place, new ones are inserted.

        Pulled and curated from https://www.yai.org.in/events.html (last
        synced: June 2026). Re-run any time YAI publishes new events; the
        endpoint can be safely called from preview and production alike."""
        now = datetime.now(timezone.utc).isoformat()
        inserted = 0
        updated = 0
        for ev in YAI_2026_CALENDAR:
            existing = await db.regattas.find_one(
                {"name": ev["name"], "start_date": ev["start_date"]}, {"_id": 0, "id": 1}
            )
            doc = {
                **ev,
                "created_by": admin["id"],
                "source": "yai-calendar",
                "synced_at": now,
            }
            if existing:
                await db.regattas.update_one(
                    {"id": existing["id"]},
                    {"$set": {**doc, "updated_at": now, "updated_by": admin["id"]}},
                )
                updated += 1
            else:
                doc["id"] = str(uuid.uuid4())
                doc["created_at"] = now
                await db.regattas.insert_one(doc)
                inserted += 1
        return {"ok": True, "inserted": inserted, "updated": updated, "total": len(YAI_2026_CALENDAR)}

    return router


# ---------------------------------------------------------------------------
# YAI Domestic Sailing Calendar 2026 (curated)
# ---------------------------------------------------------------------------
# Source: https://www.yai.org.in/events.html (synced June 2026).
# `notes` carries the boat class(es). Level is inferred from event scope.
# Re-running /api/regattas/import-yai is idempotent — (name, start_date) is the
# uniqueness key.
YAI_2026_CALENDAR: List[dict] = [
    {"name": "Asian Youth Cup & India International Youth Championship", "start_date": "2026-01-03", "end_date": "2026-01-10", "level": "international", "location": "Chennai", "country": "India", "host_org": "TNSA", "notes": "Optimist (B&G), ILCA4 (B&G), 29er (B&G), 420 Mixed, iQFoil Youth (B&G). YAI Ranking Event."},
    {"name": "National Race Officers Seminar", "start_date": "2026-01-19", "end_date": "2026-01-20", "level": "national", "location": "Girgaon Chowpatty, Mumbai", "country": "India", "host_org": "AYN", "notes": "Seminar."},
    {"name": "Sail India (Asian Games Selection Trials II)", "start_date": "2026-01-21", "end_date": "2026-01-28", "level": "national", "location": "Girgaon Chowpatty, Mumbai", "country": "India", "host_org": "AYN", "notes": "Asian Games selection trials. ILCA 7/6, 49er/49erFX, iQFoil, ILCA4, 29er, 470, 420. YAI Ranking Event."},
    {"name": "Asian Games Selection Trials III", "start_date": "2026-02-07", "end_date": "2026-02-13", "level": "national", "location": "Girgaon Chowpatty, Mumbai", "country": "India", "host_org": "AYN / INWTC (MBI)", "notes": "Asian Games selection trials — same class spread as Trials II. YAI Ranking Event."},
    {"name": "All India Kiteboarding & Formula Kite Championship", "start_date": "2026-02-18", "end_date": "2026-02-21", "level": "national", "location": "Thoothukudi, Tamil Nadu", "country": "India", "host_org": "Aqua Outback", "notes": "Twin Tip Kite, Formula Kite."},
    {"name": "Kiteboarding & Boardsailing Championship 2026", "start_date": "2026-03-18", "end_date": "2026-03-22", "level": "national", "location": "Goa", "country": "India", "host_org": "Premier Kiteboarding Assn / Boardsailing Assn", "notes": "iQFoil, Raceboard, Formula Kite, Twintip. YAI Ranking Event for iQFoil and Formula Kite."},
    {"name": "4th North East Regatta", "start_date": "2026-03-28", "end_date": "2026-04-05", "level": "national", "location": "Shillong", "country": "India", "host_org": "420 Class Assn of India / Umiam SC / Uday Sailing Foundation", "notes": "Optimist (B&G), ILCA4 (B&G), 420 Mixed, 29er (B&G), Techno 293 (B&G). YAI Ranking Event."},
    {"name": "Sail Goa 2026", "start_date": "2026-04-13", "end_date": "2026-04-17", "level": "national", "location": "Dona Paula, Goa", "country": "India", "host_org": "GYA", "notes": "iQFoil (M&W, B&G), Optimist (B&G), ILCA4 (B&G), 420 Mixed, Techno 293 (B&G), Windsurfing Open Foil, Raceboard. YAI Ranking Event."},
    {"name": "Coaching Camp prior to YAI Youth Nationals 2026", "start_date": "2026-04-27", "end_date": "2026-05-01", "level": "national", "location": "Mandwa, Mumbai", "country": "India", "host_org": "YCH", "notes": "Coaching camp — Optimist, ILCA 4/6, 420, 29er, Techno 293, iQFoil."},
    {"name": "YAI Youth Nationals 2026", "start_date": "2026-05-02", "end_date": "2026-05-10", "level": "national", "location": "Mandwa → Marve, Mumbai", "country": "India", "host_org": "YCH → NOAI / CESC / MSC", "notes": "Optimist, ILCA 4, 420, 29er, Techno 293, iQFoil. YAI Ranking Event."},
    {"name": "J/80 Regatta", "start_date": "2026-05-20", "end_date": "2026-05-21", "level": "national", "location": "Chennai Port", "country": "India", "host_org": "RMYC / RMYC Ennore / Royal Mysore SC", "notes": "J/80 keelboat."},
    {"name": "J/80 Offshore Championship", "start_date": "2026-05-22", "end_date": "2026-05-24", "level": "national", "location": "Chennai Port", "country": "India", "host_org": "RMYC / RMYC EC / RMSC", "notes": "J/80 offshore."},
    {"name": "YAI Monsoon Regatta", "start_date": "2026-06-01", "end_date": "2026-06-07", "level": "national", "location": "Hussain Sagar Lake, Hyderabad", "country": "India", "host_org": "YCH", "notes": "Optimist (B&G + Green Fleet), 29er (B&G), ILCA4 (B&G), 420 Mixed. YAI Ranking Event."},
    {"name": "YAI Laser Coaching Camp", "start_date": "2026-07-04", "end_date": "2026-07-09", "level": "national", "location": "Hussain Sagar Lake, Hyderabad", "country": "India", "host_org": "EME Sailing Association MCEME", "notes": "ILCA 7, ILCA 6, ILCA 4 coaching camp."},
    {"name": "World Sailing International Measurers / National Measurers Seminar", "start_date": "2026-07-07", "end_date": "2026-07-09", "level": "international", "location": "Hussain Sagar Lake, Hyderabad", "country": "India", "host_org": "EME Sailing Association MCEME", "notes": "Measurers seminar (technical)."},
    {"name": "World Sailing International Race Officers / National Race Officers Seminar", "start_date": "2026-07-10", "end_date": "2026-07-11", "level": "international", "location": "Hussain Sagar Lake, Hyderabad", "country": "India", "host_org": "EME Sailing Association MCEME", "notes": "Race officers seminar."},
    {"name": "40th International Hyderabad Sailing Week", "start_date": "2026-07-12", "end_date": "2026-07-18", "level": "international", "location": "Hussain Sagar Lake, Hyderabad", "country": "India", "host_org": "EME Sailing Association MCEME", "notes": "ILCA 7, ILCA 6, ILCA 4 (B&G). YAI Ranking Event."},
    {"name": "Cadet Championship", "start_date": "2026-07-16", "end_date": "2026-07-19", "level": "national", "location": "Hussain Sagar Lake, Hyderabad", "country": "India", "host_org": "YCH", "notes": "Cadet class."},
    {"name": "YAI 6th Secunderabad Club Youth Regatta", "start_date": "2026-07-20", "end_date": "2026-07-25", "level": "national", "location": "Secunderabad Club Sailing Annexe, Hussain Sagar Lake", "country": "India", "host_org": "Secunderabad Club & EMESA", "notes": "Optimist (B&G + Green Fleet), ILCA4 (B&G), ILCA6 U21 (B&G), 29er (B&G), 420 Mixed. YAI Ranking Event."},
    {"name": "Raja Bhoj Multiclass Sailing Championship 2026", "start_date": "2026-08-11", "end_date": "2026-08-16", "level": "national", "location": "EME Sailing Club, Upper Lake, Bhopal", "country": "India", "host_org": "EME Sailing Club / NSS / MPYA", "notes": "ILCA 4, 420 Mixed, 29er, iQFoil, Optimist, Techno 293. YAI Ranking Event."},
    {"name": "YAI Junior Sailing Championship 2026", "start_date": "2026-08-26", "end_date": "2026-08-30", "level": "national", "location": "KRS Dam, Mysore", "country": "India", "host_org": "RMSC Mysore / RMYC Chennai / RMYC Ennore / KSSA", "notes": "ILCA 4, 420 Mixed, 29er, iQFoil, Optimist, Techno 293. YAI Ranking Event."},
    {"name": "Eurasia Inclusive Championship 2026 and J/80 Seabird Inclusive Regatta", "start_date": "2026-08-26", "end_date": "2026-08-30", "level": "international", "location": "KRS Dam, Mysore", "country": "India", "host_org": "RMSC Mysore / RMYC Chennai / RMYC Ennore / KSSA", "notes": "Hansa 203, Hansa 303, J/80. Inclusive event."},
    {"name": "Coaching Camp prior to CESC Regatta", "start_date": "2026-10-16", "end_date": "2026-10-22", "level": "national", "location": "Pawna Dam, Pune", "country": "India", "host_org": "NOAI / CESC", "notes": "Coaching camp — Optimist, ILCA 4/6, 420, 29er, Techno 293, Raceboard, iQFoil."},
    {"name": "National Measurers Seminar (Pawna)", "start_date": "2026-10-19", "end_date": "2026-10-22", "level": "national", "location": "Pawna Dam, Pune", "country": "India", "host_org": "NOAI / CESC", "notes": "Measurers seminar."},
    {"name": "CESC Regatta 2026", "start_date": "2026-10-23", "end_date": "2026-10-28", "level": "national", "location": "Pawna Dam, Pune", "country": "India", "host_org": "NOAI / CESC", "notes": "Optimist, ILCA 4/6, 420 Mixed, 29er, Techno 293, Raceboard, iQFoil. YAI Ranking Event."},
    {"name": "YAI Senior National Championship 2026", "start_date": "2026-11-01", "end_date": "2026-11-10", "level": "national", "location": "Mumbai", "country": "India", "host_org": "INWTC (MBI)", "notes": "All senior classes. YAI Ranking Event."},
    {"name": "YAI Team Racing Championships", "start_date": "2026-11-22", "end_date": "2026-11-28", "level": "national", "location": "Mumbai", "country": "India", "host_org": "INWTC (MBI)", "notes": "ILCA 6 — team racing format."},
    {"name": "YAI-Ocean Gold Konkan Offshore Sailing Week 2026", "start_date": "2026-12-01", "end_date": "2026-12-09", "level": "national", "location": "Mumbai to Goa", "country": "India", "host_org": "MG & G Area Sailing Club", "notes": "Keelboats offshore."},
    {"name": "India International Regatta 2027", "start_date": "2027-01-01", "end_date": "2027-01-10", "level": "international", "location": "Chennai", "country": "India", "host_org": "TNSA", "notes": "Optimist, ILCA 4/6, 420 Mixed, 29er, iQFoil. YAI Ranking Event."},
    {"name": "Sail India & YAI Senior National Championship 2027", "start_date": "2027-01-24", "end_date": "2027-01-30", "level": "national", "location": "Mumbai", "country": "India", "host_org": "AYN", "notes": "All Olympic & Asian Games classes + Optimist. YAI Ranking Event."},
]
