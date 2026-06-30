"""
Satellite-site geofences — additional locations beyond the main office
where attendance check-ins should still be considered on-site. Added
28 Jun 2026 to support sessions at the neighbouring Rowing Academy.

The main `OfficeConfig.latitude/longitude/radius_m` is the *primary*
geofence; satellite sites are additive. At check-in time the closest
geofence wins (see `services.geo.resolve_site`).

Covers:
  • GET    /api/sites            — list all sites (everyone).
  • POST   /api/sites            — admin create.
  • PATCH  /api/sites/{site_id}  — admin update.
  • DELETE /api/sites/{site_id}  — admin delete.
"""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from services.time_utils import now_utc


class SiteIn(BaseModel):
    name: str = Field(min_length=1)
    latitude: float
    longitude: float
    radius_m: int = Field(default=150, gt=0, lt=5000)
    active: bool = True
    notes: Optional[str] = None


def make_router(db, require_admin, get_current_user) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/sites")
    async def list_sites(user: dict = Depends(get_current_user)):
        rows = await db.sites.find({}, {"_id": 0}).sort("name", 1).to_list(500)
        return rows

    @router.post("/sites")
    async def create_site(body: SiteIn, admin: dict = Depends(require_admin)):
        name = body.name.strip()
        if await db.sites.find_one({"name": name}):
            raise HTTPException(status_code=409, detail="Site already exists")
        doc = {
            "id": str(uuid.uuid4()),
            "name": name,
            "latitude": float(body.latitude),
            "longitude": float(body.longitude),
            "radius_m": int(body.radius_m),
            "active": body.active,
            "notes": (body.notes or "").strip() or None,
            "created_at": now_utc().isoformat(),
            "created_by": admin["id"],
        }
        await db.sites.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @router.patch("/sites/{site_id}")
    async def update_site(site_id: str, body: SiteIn, admin: dict = Depends(require_admin)):
        site = await db.sites.find_one({"id": site_id}, {"_id": 0, "id": 1})
        if not site:
            raise HTTPException(status_code=404, detail="Not found")
        await db.sites.update_one({"id": site_id}, {"$set": {
            "name": body.name.strip(),
            "latitude": float(body.latitude),
            "longitude": float(body.longitude),
            "radius_m": int(body.radius_m),
            "active": body.active,
            "notes": (body.notes or "").strip() or None,
            "updated_at": now_utc().isoformat(),
            "updated_by": admin["id"],
        }})
        return await db.sites.find_one({"id": site_id}, {"_id": 0})

    @router.delete("/sites/{site_id}")
    async def delete_site(site_id: str, admin: dict = Depends(require_admin)):
        """Delete a site. Existing attendance rows that reference this site
        keep their stamped `site_name` (we only remove the master row), so
        historical reports stay readable even after the site is retired."""
        res = await db.sites.delete_one({"id": site_id})
        if res.deleted_count == 0:
            raise HTTPException(status_code=404, detail="Not found")
        return {"ok": True}

    return router
