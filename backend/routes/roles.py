"""Roles master — CRUD for the RBAC role list.

Ships with 3 seeded system roles that map to backend permission checks:

  • admin  — full administrative access (require_admin dependency).
  • member — default; regular user of the app. Sees own attendance,
             files own corrections/leave/OT.
  • chef   — 4 Feb 2026: kitchen staff. Superset of member — also has
             read access to Muster Roll, Presence, and Chef's View.

Seeded rows are marked `is_system=True` and cannot be renamed or
deleted. Their `label` and `description` remain editable so the org
can tune the wording that shows in the Member form.

Custom roles can be added, but until we ship full RBAC (planned Q2
2026) they behave like `member` for permission purposes — the code
does not yet consult the roles master to build permission maps at
runtime. Adding a custom role now is safe (it becomes selectable in
the Member form) but grants no new privileges by itself.

Endpoints:
  GET    /api/masters/roles           — list (auth required, everyone)
  POST   /api/masters/roles           — create (admin)
  PATCH  /api/masters/roles/{role_id} — update (admin)
  DELETE /api/masters/roles/{role_id} — delete (admin)
"""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from services.time_utils import now_utc


# System role keys — these MUST exist in the DB and are seeded on
# startup. The backend hardcodes permission checks against these
# keys, so they cannot be renamed or deleted without a code change.
SEEDED_ROLE_KEYS = {"admin", "member", "chef"}

DEFAULT_SEEDS = [
    {
        "key": "admin",
        "label": "Administrator",
        "description": "Full access to management, reports, approvals, and configuration.",
        "sort_order": 10,
    },
    {
        "key": "chef",
        "label": "Chef",
        "description": "Kitchen staff. Member privileges plus read access to Muster Roll, Presence, and Chef's View.",
        "sort_order": 20,
    },
    {
        "key": "member",
        "label": "Member",
        "description": "Default role — checks in/out, files own corrections, leaves, and OT.",
        "sort_order": 30,
    },
]


class RoleIn(BaseModel):
    key: str = Field(..., min_length=2, max_length=32)
    label: str = Field(..., min_length=2, max_length=60)
    description: Optional[str] = Field(None, max_length=280)
    sort_order: int = 50


class RolePatch(BaseModel):
    label: Optional[str] = Field(None, min_length=2, max_length=60)
    description: Optional[str] = Field(None, max_length=280)
    sort_order: Optional[int] = None
    active: Optional[bool] = None


async def seed_default_roles(db) -> None:
    """Insert any missing seed roles on startup. Idempotent — safe to
    call every boot. Preserves any edits the admin has made to the
    `label` / `description` of existing seeded rows.

    Uses a unique index on `key` + upsert semantics so multiple worker
    processes booting simultaneously (or a restart mid-request) can't
    produce duplicate rows. Added 4 Feb 2026 after Iter 23 review."""
    try:
        await db.roles.create_index("key", unique=True)
    except Exception:
        # Already exists — normal after the first boot.
        pass
    for seed in DEFAULT_SEEDS:
        existing = await db.roles.find_one({"key": seed["key"]})
        if existing:
            continue
        try:
            await db.roles.insert_one({
                "id": str(uuid.uuid4()),
                "key": seed["key"],
                "label": seed["label"],
                "description": seed["description"],
                "sort_order": seed["sort_order"],
                "is_system": True,
                "active": True,
                "created_at": now_utc().isoformat(),
            })
        except Exception:
            # Duplicate key — another worker won the race. Safe to swallow.
            pass


def make_router(db, require_admin, get_current_user) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/masters/roles")
    async def list_roles(user: dict = Depends(get_current_user)):
        """Every authenticated user can list roles so the Member form
        dropdown works. Admin-only writes below."""
        rows = await db.roles.find({}, {"_id": 0}) \
            .sort("sort_order", 1).to_list(50)
        # Hydrate assigned-member counts so the UI can show "42 members"
        # per row and disable delete on non-empty roles.
        pipeline = [{"$group": {"_id": "$role", "n": {"$sum": 1}}}]
        counts = {c["_id"]: c["n"] async for c in db.users.aggregate(pipeline) if c["_id"]}
        for r in rows:
            r["member_count"] = counts.get(r["key"], 0)
            r["is_seeded"] = r["key"] in SEEDED_ROLE_KEYS
        return rows

    @router.post("/masters/roles")
    async def create_role(body: RoleIn, admin: dict = Depends(require_admin)):
        key = body.key.strip().lower()
        if not key.replace("_", "").isalnum():
            raise HTTPException(
                status_code=400,
                detail="Key must be alphanumeric (underscores allowed).",
            )
        if key in SEEDED_ROLE_KEYS:
            raise HTTPException(
                status_code=409,
                detail=f"'{key}' is a seeded system role and is already present.",
            )
        if await db.roles.find_one({"key": key}):
            raise HTTPException(
                status_code=409, detail="A role with that key already exists.",
            )
        doc = {
            "id": str(uuid.uuid4()),
            "key": key,
            "label": body.label.strip(),
            "description": (body.description or "").strip() or None,
            "sort_order": int(body.sort_order),
            "is_system": False,
            "active": True,
            "created_at": now_utc().isoformat(),
            "created_by": admin.get("id"),
        }
        await db.roles.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @router.patch("/masters/roles/{role_id}")
    async def update_role(
        role_id: str, body: RolePatch, admin: dict = Depends(require_admin)
    ):
        row = await db.roles.find_one({"id": role_id}, {"_id": 0})
        if not row:
            raise HTTPException(status_code=404, detail="Role not found")
        update = {}
        if body.label is not None:
            update["label"] = body.label.strip()
        if body.description is not None:
            update["description"] = body.description.strip() or None
        if body.sort_order is not None:
            update["sort_order"] = int(body.sort_order)
        if body.active is not None:
            # System roles cannot be deactivated — they're referenced by
            # hard-coded permission checks (require_admin, chef gating).
            if not body.active and row["key"] in SEEDED_ROLE_KEYS:
                raise HTTPException(
                    status_code=409,
                    detail="System roles cannot be deactivated.",
                )
            update["active"] = bool(body.active)
        if not update:
            return row
        await db.roles.update_one({"id": role_id}, {"$set": update})
        row.update(update)
        return row

    @router.delete("/masters/roles/{role_id}")
    async def delete_role(role_id: str, admin: dict = Depends(require_admin)):
        row = await db.roles.find_one({"id": role_id}, {"_id": 0})
        if not row:
            raise HTTPException(status_code=404, detail="Role not found")
        if row["key"] in SEEDED_ROLE_KEYS:
            raise HTTPException(
                status_code=409,
                detail="System roles are protected — deactivate or edit instead.",
            )
        in_use = await db.users.count_documents({"role": row["key"]})
        if in_use > 0:
            raise HTTPException(
                status_code=409,
                detail=f"{in_use} member(s) still hold this role — reassign first.",
            )
        await db.roles.delete_one({"id": role_id})
        return {"deleted": True}

    return router
