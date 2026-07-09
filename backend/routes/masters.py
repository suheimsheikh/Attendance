"""
Institution + Fleet master CRUD — split out of `server.py` during the
06/2026 modularisation pass.

Institutions are the home boards that athletes belong to (MJPT, YCH,
Agape Home, Rainbow Home etc). Fleets are boat classes (Optimist, ILCA 4,
ILCA 6, Opti A, Opti B etc). Both behave like classic master entities:
read-by-anyone, write-by-admin, rename-cascades-to-members.

Covers:
  • GET    /api/institutions
  • POST   /api/institutions
  • PATCH  /api/institutions/{inst_id}
  • DELETE /api/institutions/{inst_id}
  • GET    /api/fleets
  • POST   /api/fleets
  • PATCH  /api/fleets/{fleet_id}
  • DELETE /api/fleets/{fleet_id}
  • POST   /api/fleets/assign     — bulk reassign fleet on N athletes.
"""
from __future__ import annotations

import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from services.time_utils import now_utc


# -------------------- Pydantic bodies --------------------
class InstitutionIn(BaseModel):
    name: str
    short_name: Optional[str] = None
    active: bool = True
    # Per-institution Twilio "from" numbers. When a parent of an athlete in this
    # institution is notified, the SMS/voice call originates from this number
    # instead of the office default — gives each institution its own caller-ID
    # branding (MJPT parents see the MJPT number, YCH parents see YCH, etc.).
    sms_from_number: Optional[str] = None
    voice_from_number: Optional[str] = None


class FleetIn(BaseModel):
    # A "fleet" is a sailing boat class (e.g. Optimist, ILCA 6, 420). Stored
    # as a master so admins get a clean dropdown when editing athletes
    # instead of free-text drift ("420", "Four-twenty", "Dinghy 420"). The
    # `name` is the canonical label and is what's actually written onto
    # each athlete's `fleet` field — renaming the fleet master row
    # cascades the rename through every athlete record.
    name: str
    short_name: Optional[str] = None
    notes: Optional[str] = None
    active: bool = True


class FleetAssignIn(BaseModel):
    fleet: Optional[str] = None       # None / "" clears the fleet for the listed athletes
    member_ids: List[str]


def make_router(db, require_admin, get_current_user) -> APIRouter:
    router = APIRouter(prefix="/api")

    # ------------------------------------------------------------------
    # Institutions
    # ------------------------------------------------------------------
    @router.get("/institutions")
    async def list_institutions(user: dict = Depends(get_current_user)):
        rows = await db.institutions.find({}, {"_id": 0}).sort("name", 1).to_list(500)
        pipeline = [{"$group": {"_id": "$institution", "n": {"$sum": 1}}}]
        counts = {c["_id"]: c["n"] async for c in db.users.aggregate(pipeline)}
        for r in rows:
            r["member_count"] = counts.get(r["name"], 0)
        return rows

    @router.post("/institutions")
    async def create_institution(body: InstitutionIn, admin: dict = Depends(require_admin)):
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Name required")
        if await db.institutions.find_one({"name": name}):
            raise HTTPException(status_code=409, detail="Institution already exists")
        doc = {
            "id": str(uuid.uuid4()),
            "name": name,
            "short_name": (body.short_name or "").strip() or None,
            "active": body.active,
            "sms_from_number": (body.sms_from_number or "").strip() or None,
            "voice_from_number": (body.voice_from_number or "").strip() or None,
            "created_at": now_utc().isoformat(),
        }
        await db.institutions.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @router.patch("/institutions/{inst_id}")
    async def update_institution(inst_id: str, body: InstitutionIn,
                                 admin: dict = Depends(require_admin)):
        inst = await db.institutions.find_one({"id": inst_id}, {"_id": 0})
        if not inst:
            raise HTTPException(status_code=404, detail="Not found")
        old_name = inst["name"]
        new_name = body.name.strip()
        await db.institutions.update_one({"id": inst_id}, {"$set": {
            "name": new_name,
            "short_name": (body.short_name or "").strip() or None,
            "active": body.active,
            "sms_from_number": (body.sms_from_number or "").strip() or None,
            "voice_from_number": (body.voice_from_number or "").strip() or None,
        }})
        if new_name != old_name:
            await db.users.update_many({"institution": old_name},
                                       {"$set": {"institution": new_name}})
        return {"ok": True}

    @router.delete("/institutions/{inst_id}")
    async def delete_institution(inst_id: str, admin: dict = Depends(require_admin)):
        inst = await db.institutions.find_one({"id": inst_id}, {"_id": 0})
        if not inst:
            raise HTTPException(status_code=404, detail="Not found")
        in_use = await db.users.count_documents({"institution": inst["name"]})
        if in_use > 0:
            raise HTTPException(
                status_code=409,
                detail=f"{in_use} members still use this institution — reassign first.",
            )
        await db.institutions.delete_one({"id": inst_id})
        return {"ok": True}

    # ------------------------------------------------------------------
    # Fleets — same shape & lifecycle as Institutions; every athlete's
    # `fleet` field points to one of these names.
    # ------------------------------------------------------------------
    @router.get("/fleets")
    async def list_fleets(user: dict = Depends(get_current_user)):
        rows = await db.fleets.find({}, {"_id": 0}).sort("name", 1).to_list(500)
        pipeline = [{"$group": {"_id": "$fleet", "n": {"$sum": 1}}}]
        counts = {c["_id"]: c["n"] async for c in db.users.aggregate(pipeline) if c["_id"]}
        for r in rows:
            r["athlete_count"] = counts.get(r["name"], 0)
        return rows

    @router.post("/fleets")
    async def create_fleet(body: FleetIn, admin: dict = Depends(require_admin)):
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="Name required")
        if await db.fleets.find_one({"name": name}):
            raise HTTPException(status_code=409, detail="Fleet already exists")
        doc = {
            "id": str(uuid.uuid4()),
            "name": name,
            "short_name": (body.short_name or "").strip() or None,
            "notes": (body.notes or "").strip() or None,
            "active": body.active,
            "created_at": now_utc().isoformat(),
        }
        await db.fleets.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @router.patch("/fleets/{fleet_id}")
    async def update_fleet(fleet_id: str, body: FleetIn,
                           admin: dict = Depends(require_admin)):
        fleet = await db.fleets.find_one({"id": fleet_id}, {"_id": 0})
        if not fleet:
            raise HTTPException(status_code=404, detail="Not found")
        old_name = fleet["name"]
        new_name = body.name.strip()
        await db.fleets.update_one({"id": fleet_id}, {"$set": {
            "name": new_name,
            "short_name": (body.short_name or "").strip() or None,
            "notes": (body.notes or "").strip() or None,
            "active": body.active,
        }})
        # Cascade rename: every athlete with the old fleet name gets retagged.
        if new_name != old_name:
            await db.users.update_many({"fleet": old_name}, {"$set": {"fleet": new_name}})
            # Also retag any breaks that target the old fleet.
            await db.breaks.update_many({"fleet": old_name}, {"$set": {"fleet": new_name}})
        return {"ok": True}

    @router.delete("/fleets/{fleet_id}")
    async def delete_fleet(fleet_id: str, admin: dict = Depends(require_admin)):
        fleet = await db.fleets.find_one({"id": fleet_id}, {"_id": 0})
        if not fleet:
            raise HTTPException(status_code=404, detail="Not found")
        in_use = await db.users.count_documents({"fleet": fleet["name"]})
        if in_use > 0:
            raise HTTPException(
                status_code=409,
                detail=f"{in_use} athlete(s) still in this fleet — reassign first.",
            )
        await db.fleets.delete_one({"id": fleet_id})
        return {"ok": True}

    @router.post("/fleets/assign")
    async def assign_fleet(body: FleetAssignIn, admin: dict = Depends(require_admin)):
        """Bulk-set the fleet on a group of athletes from the Fleet master page.
        Pass `fleet: null` (or empty string) to UN-assign the picked athletes."""
        if not body.member_ids:
            raise HTTPException(status_code=400, detail="member_ids required")
        target = (body.fleet or "").strip() or None
        if target is not None:
            # Sanity check: the fleet must exist in master.
            exists = await db.fleets.find_one({"name": target}, {"_id": 1})
            if not exists:
                raise HTTPException(
                    status_code=404,
                    detail=f"Fleet '{target}' not in master — create it first.",
                )
        # Include every athlete-like category (Athlete + Elite + any custom
        # athlete-like category the admin has added). Previously hardcoded
        # to "athlete" only, which silently skipped Elite squad members
        # during bulk fleet assignment (bug reported 04 Feb 2026).
        athlete_keys = set()
        async for c in db.categories.find({"is_athlete_like": True}, {"_id": 0, "key": 1}):
            k = c.get("key")
            if k:
                athlete_keys.add(k)
        if not athlete_keys:
            athlete_keys = {"athlete", "elite"}
        res = await db.users.update_many(
            {"id": {"$in": body.member_ids}, "category": {"$in": list(athlete_keys)}},
            {"$set": {"fleet": target}},
        )
        return {"modified": res.modified_count}

    return router
