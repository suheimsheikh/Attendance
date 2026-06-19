"""
Guest check-in / check-out — coaches and admins can log non-member visitors
(family, prospects, dignitaries) with a name + photo. Each guest gets a small
audit trail (who checked them in, who checked them out, timestamps) and shows
up on the Presence Board in a dedicated Guests column.

This is intentionally separate from the `users` collection — guests are not
members and don't have logins, leaves, or attendance reports.

Collection: `guests`
  {
    id, name, photo (data URL, capped same as members),
    date (YYYY-MM-DD office-local — used for `/today` lookup),
    checked_in_at, checked_in_by_id, checked_in_by_name,
    checked_out_at, checked_out_by_id, checked_out_by_name,
  }
"""
from __future__ import annotations

import base64
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["guests"])


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class GuestCheckinIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    photo: Optional[str] = None  # data:image/... URL (optional — guests may decline)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _now_utc() -> datetime:
    return datetime.now(timezone.utc)


# Mirror the members photo cap so guests can't inflate the DB.
MAX_PHOTO_BYTES = 250 * 1024


def _check_photo_size(photo: Optional[str]) -> None:
    if not photo:
        return
    if not photo.startswith("data:"):
        return  # don't validate arbitrary URLs
    # base64 portion lives after the first comma
    _, _, b64 = photo.partition(",")
    try:
        size = len(base64.b64decode(b64, validate=False))
    except Exception:
        return
    if size > MAX_PHOTO_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"Photo too large ({size // 1024} KB). Max {MAX_PHOTO_BYTES // 1024} KB.",
        )


# ---------------------------------------------------------------------------
# Public router (mounted from server.py with `db` and the auth dependency)
# ---------------------------------------------------------------------------
def make_router(db, require_coach_or_admin, local_date_str) -> APIRouter:
    """Bind the routes to backend dependencies and return the router.

    Args:
        db: Motor database instance.
        require_coach_or_admin: FastAPI dependency that returns the current
            user dict and raises 403 if not a coach or admin.
        local_date_str: Function (office_doc | None) -> 'YYYY-MM-DD' in office
            local time. Reused from server.py so guest 'today' matches
            attendance 'today'.
    """

    @router.post("/guests/checkin")
    async def checkin(body: GuestCheckinIn, user: dict = Depends(require_coach_or_admin)):
        _check_photo_size(body.photo)
        office = await db.config.find_one({"id": "office"}, {"_id": 0})
        today = local_date_str(office)
        now = _now_utc().isoformat()
        doc = {
            "id": str(uuid.uuid4()),
            "name": body.name.strip(),
            "photo": body.photo or None,
            "date": today,
            "checked_in_at": now,
            "checked_in_by_id": user["id"],
            "checked_in_by_name": user.get("full_name") or user.get("email") or "",
            "checked_out_at": None,
            "checked_out_by_id": None,
            "checked_out_by_name": None,
        }
        await db.guests.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @router.post("/guests/{guest_id}/checkout")
    async def checkout(guest_id: str, user: dict = Depends(require_coach_or_admin)):
        g = await db.guests.find_one({"id": guest_id}, {"_id": 0})
        if not g:
            raise HTTPException(status_code=404, detail="Guest not found")
        if g.get("checked_out_at"):
            raise HTTPException(status_code=400, detail="Guest already checked out")
        now = _now_utc().isoformat()
        await db.guests.update_one(
            {"id": guest_id},
            {"$set": {
                "checked_out_at": now,
                "checked_out_by_id": user["id"],
                "checked_out_by_name": user.get("full_name") or user.get("email") or "",
            }},
        )
        g["checked_out_at"] = now
        g["checked_out_by_id"] = user["id"]
        g["checked_out_by_name"] = user.get("full_name") or user.get("email") or ""
        return g

    @router.get("/guests/today")
    async def guests_today(user: dict = Depends(require_coach_or_admin)):
        office = await db.config.find_one({"id": "office"}, {"_id": 0})
        today = local_date_str(office)
        rows = await db.guests.find({"date": today}, {"_id": 0}).sort("checked_in_at", -1).to_list(500)
        active = [g for g in rows if not g.get("checked_out_at")]
        return {
            "date": today,
            "active": active,
            "completed": [g for g in rows if g.get("checked_out_at")],
            "active_count": len(active),
            "total_count": len(rows),
        }

    @router.delete("/guests/{guest_id}")
    async def delete_guest(guest_id: str, user: dict = Depends(require_coach_or_admin)):
        """Used to undo an accidental check-in. Only the same coach/admin who
        checked the guest in, or any admin, can delete the record."""
        g = await db.guests.find_one({"id": guest_id}, {"_id": 0, "checked_in_by_id": 1})
        if not g:
            raise HTTPException(status_code=404, detail="Guest not found")
        is_admin = user.get("role") == "admin"
        if not is_admin and g.get("checked_in_by_id") != user["id"]:
            raise HTTPException(status_code=403, detail="Not allowed to delete this guest entry")
        await db.guests.delete_one({"id": guest_id})
        return {"ok": True}

    return router
