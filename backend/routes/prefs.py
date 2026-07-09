"""Per-user UI preferences (4 Feb 2026).

Stores a small free-form JSON blob on the user record so device-local
UI state (sidebar collapse, last-opened tab, etc.) syncs across an
admin's laptop, phone, and iPad without them having to reconfigure
each device.

Endpoints:
  GET   /api/me/ui-prefs           — current user's prefs (empty {} if none)
  PATCH /api/me/ui-prefs           — merge-patch the prefs blob

Kept intentionally simple: any JSON-serialisable dict is accepted, no
schema. Callers namespace their keys (`sidebar_collapsed`, `presence_
layout`, etc.). Size-capped at 4 KB serialised to prevent runaway
growth if a page starts stashing large state.
"""
from __future__ import annotations

import json
from typing import Any, Dict

from fastapi import APIRouter, Body, Depends, HTTPException


MAX_PREFS_BYTES = 4 * 1024   # 4 KB — plenty for booleans/arrays/short strings


def make_router(db, get_current_user) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/me/ui-prefs")
    async def get_ui_prefs(user: dict = Depends(get_current_user)) -> Dict[str, Any]:
        row = await db.users.find_one({"id": user["id"]}, {"_id": 0, "ui_prefs": 1})
        return (row or {}).get("ui_prefs") or {}

    @router.patch("/me/ui-prefs")
    async def patch_ui_prefs(
        body: Dict[str, Any] = Body(...),
        user: dict = Depends(get_current_user),
    ) -> Dict[str, Any]:
        # Reject empty patches early — a no-op PATCH is almost always a
        # bug on the caller side (stale hook effect), not intentional.
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="Body must be a JSON object")
        # Load current, merge, size-check, then write. `find_one_and_update`
        # with dot-path $set on top-level keys would race with a parallel
        # patch from a different tab — the read-merge-write here is
        # correct enough for UI prefs (order-independent, last-writer-wins
        # per key is fine).
        row = await db.users.find_one({"id": user["id"]}, {"_id": 0, "ui_prefs": 1})
        current: Dict[str, Any] = (row or {}).get("ui_prefs") or {}
        merged = {**current, **body}
        # Drop keys explicitly set to None so callers can un-remember a pref.
        merged = {k: v for k, v in merged.items() if v is not None}
        # Serialised size guard — protects against a bug that starts
        # stashing arrays of arrays in here.
        blob_size = len(json.dumps(merged, default=str))
        if blob_size > MAX_PREFS_BYTES:
            raise HTTPException(
                status_code=413,
                detail=f"ui_prefs exceeds {MAX_PREFS_BYTES}-byte limit ({blob_size}B).",
            )
        await db.users.update_one(
            {"id": user["id"]}, {"$set": {"ui_prefs": merged}}
        )
        return merged

    return router
