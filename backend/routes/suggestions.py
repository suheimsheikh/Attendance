"""App-improvement suggestions. Any signed-in user can submit an idea and
see their own submissions; admins see everything and can triage (status +
note). Stored in the `suggestions` collection keyed by a uuid `id`."""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from services.time_utils import now_utc

STATUSES = ("new", "planned", "in_progress", "done", "declined")


class SuggestionIn(BaseModel):
    text: str = Field(min_length=3, max_length=4000)
    category: Optional[str] = None  # free-text tag e.g. "Grid", "Meals"


class SuggestionUpdateIn(BaseModel):
    status: Optional[str] = None
    admin_note: Optional[str] = None


def make_router(db, get_current_user, require_admin, write_audit) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["suggestions"])

    @router.post("/suggestions")
    async def create_suggestion(body: SuggestionIn, user: dict = Depends(get_current_user)):
        text = body.text.strip()
        if not text:
            raise HTTPException(status_code=400, detail="Please write your suggestion")
        doc = {
            "id": str(uuid.uuid4()),
            "user_id": user["id"],
            "user_name": user.get("full_name") or user.get("email"),
            "user_category": user.get("category"),
            "category": (body.category or "").strip() or None,
            "text": text,
            "status": "new",
            "admin_note": None,
            "created_at": now_utc().isoformat(),
            "updated_at": now_utc().isoformat(),
        }
        await db.suggestions.insert_one(dict(doc))
        return doc

    @router.get("/suggestions/mine")
    async def my_suggestions(user: dict = Depends(get_current_user)):
        rows = await db.suggestions.find(
            {"user_id": user["id"]}, {"_id": 0},
        ).sort("created_at", -1).to_list(500)
        return {"rows": rows}

    @router.get("/admin/suggestions")
    async def all_suggestions(status: Optional[str] = None, admin: dict = Depends(require_admin)):
        q: dict = {}
        if status and status in STATUSES:
            q["status"] = status
        rows = await db.suggestions.find(q, {"_id": 0}).sort("created_at", -1).to_list(2000)
        counts_agg = await db.suggestions.aggregate([
            {"$group": {"_id": "$status", "n": {"$sum": 1}}},
        ]).to_list(50)
        counts = {c["_id"]: c["n"] for c in counts_agg}
        return {"rows": rows, "counts": counts, "total": sum(counts.values())}

    @router.patch("/admin/suggestions/{sid}")
    async def update_suggestion(sid: str, body: SuggestionUpdateIn, admin: dict = Depends(require_admin)):
        cur = await db.suggestions.find_one({"id": sid}, {"_id": 0})
        if not cur:
            raise HTTPException(status_code=404, detail="Suggestion not found")
        upd: dict = {"updated_at": now_utc().isoformat()}
        if body.status is not None:
            if body.status not in STATUSES:
                raise HTTPException(status_code=400, detail=f"status must be one of {', '.join(STATUSES)}")
            upd["status"] = body.status
        if body.admin_note is not None:
            upd["admin_note"] = body.admin_note.strip() or None
        await db.suggestions.update_one({"id": sid}, {"$set": upd})
        await write_audit(db, actor=admin, action="suggestion_update", entity_type="suggestion",
                          entity_id=sid, entity_name=(cur.get("text") or "")[:60],
                          before={"status": cur.get("status")}, after={k: upd[k] for k in upd if k != "updated_at"},
                          reason="Suggestion triaged")
        return await db.suggestions.find_one({"id": sid}, {"_id": 0})

    return router
