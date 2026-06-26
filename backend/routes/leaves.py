"""
Leave & tour endpoints — split out of `server.py`. Covers individual leave
filing (POST /api/leaves), the member's own list (GET /api/leaves/mine),
the admin all-leaves view (GET /api/leaves), the group-leave admin tool
(POST /api/leaves/group), and the approve / reject mutator
(PATCH /api/leaves/{id}).

The `make_router(...)` factory receives its callable dependencies so this
module has no import-cycle with `server.py`.
"""
from __future__ import annotations

import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from services.time_utils import now_utc, local_date_str


# -------------------- Pydantic bodies --------------------
class LeaveCreate(BaseModel):
    type: str  # leave | tour | comp_off | late_coming
    start_date: str
    end_date: str
    reason: Optional[str] = None
    location: Optional[str] = None
    expected_arrival: Optional[str] = None  # HH:MM for late_coming


class GroupLeaveIn(BaseModel):
    type: str
    user_ids: List[str]
    start_date: str
    end_date: str
    reason: Optional[str] = None
    location: Optional[str] = None
    auto_approve: bool = False


class LeaveDecision(BaseModel):
    status: str  # approved | rejected | pending


def make_router(db, require_admin, get_current_user, compute_comp_off_balance=None) -> APIRouter:
    router = APIRouter(prefix="/api")

    async def _comp_off_guard(target_user: dict, start_date: str, end_date: str, is_auto_approve: bool = False) -> None:
        """Hard-block comp-off applications that exceed the member's available
        balance. Admins filing on behalf with `auto_approve=true` are also
        gated — the user decision was explicit: NO silent over-draw. If an
        admin needs to grant extra paid-leave, they can adjust the opening
        leave balance instead.
        """
        if compute_comp_off_balance is None:
            return  # Helper not wired (older test harnesses) — fail open.
        try:
            requested = (
                __import__("datetime").date.fromisoformat(end_date)
                - __import__("datetime").date.fromisoformat(start_date)
            ).days + 1
        except Exception:
            requested = 1
        if requested <= 0:
            return
        bal = await compute_comp_off_balance(db, target_user)
        if requested > bal["available"]:
            short = requested - bal["available"]
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Comp-off balance is {bal['available']} day"
                    f"{'' if bal['available'] == 1 else 's'} "
                    f"(accrued {bal['accrued']} − used {bal['used']}). "
                    f"This application is for {requested} day{'' if requested == 1 else 's'}, "
                    f"short by {short}. Accrue more comp-off (attend on a holiday "
                    f"or your weekly off) or shorten the request."
                ),
            )

    async def enrich_leaves(leaves: List[dict]) -> List[dict]:
        """Attach member name/category/rank for each leave row. Used by the
        admin views and the exported reports — extracted here so callers
        outside this module can re-use it via the returned helper below."""
        user_ids = list({leave["user_id"] for leave in leaves})
        users = await db.users.find({"id": {"$in": user_ids}}, {"_id": 0}).to_list(2000)
        umap = {u["id"]: u for u in users}
        for leave in leaves:
            u = umap.get(leave["user_id"], {})
            leave["member_name"] = u.get("full_name", "Unknown")
            leave["member_category"] = u.get("category")
            leave["member_rank"] = u.get("rank")
        return leaves

    # Expose for the reports router (no longer lives in server.py).
    router.enrich_leaves = enrich_leaves  # type: ignore[attr-defined]

    @router.post("/leaves")
    async def create_leave(body: LeaveCreate, target_user_id: Optional[str] = None,
                          user: dict = Depends(get_current_user)):
        """Create a leave/tour/comp-off request. Admins may pass `target_user_id`
        to file on behalf of another member."""
        target_user = user
        if target_user_id and target_user_id != user["id"]:
            if user.get("role") != "admin":
                raise HTTPException(status_code=403, detail="Only admins may file on behalf of others")
            target_user = await db.users.find_one({"id": target_user_id}, {"_id": 0})
            if not target_user:
                raise HTTPException(status_code=404, detail="Target member not found")
        # Comp-off: enforce balance ceiling before persisting the row.
        if body.type == "comp_off":
            await _comp_off_guard(target_user, body.start_date, body.end_date)
        office = await db.config.find_one({"id": "office"})
        today = local_date_str(office)
        late_application = bool(body.start_date and body.start_date < today)
        doc = {
            "id": str(uuid.uuid4()),
            "user_id": target_user["id"],
            "type": body.type,
            "start_date": body.start_date,
            "end_date": body.end_date,
            "reason": body.reason,
            "location": body.location,
            "expected_arrival": body.expected_arrival,
            "status": "pending",
            "late_application": late_application,
            "filed_by_admin": user["id"] if target_user["id"] != user["id"] else None,
            "filed_by_admin_name": user["full_name"] if target_user["id"] != user["id"] else None,
            "created_at": now_utc().isoformat(),
        }
        await db.leaves.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @router.get("/leaves/mine")
    async def my_leaves(user: dict = Depends(get_current_user)):
        leaves = await db.leaves.find({"user_id": user["id"]}, {"_id": 0}).sort("created_at", -1).to_list(500)
        return leaves

    @router.get("/leaves")
    async def all_leaves(status_filter: Optional[str] = None, admin: dict = Depends(require_admin)):
        q = {}
        if status_filter == "late":
            q["late_application"] = True
        elif status_filter:
            q["status"] = status_filter
        leaves = await db.leaves.find(q, {"_id": 0}).sort("created_at", -1).to_list(1000)
        return await enrich_leaves(leaves)

    @router.patch("/leaves/{leave_id}")
    async def decide_leave(leave_id: str, body: LeaveDecision, admin: dict = Depends(require_admin)):
        # Stamp the decision audit fields so the admin Approvals table can
        # show "approved by Jane Doe on 25 Jun" alongside the status pill.
        update = {"status": body.status}
        if body.status in ("approved", "rejected"):
            update["decided_by"] = admin["full_name"]
            update["decided_by_id"] = admin["id"]
            update["decided_at"] = now_utc().isoformat()
        else:
            # Re-opening a request back to pending wipes the prior decision
            # stamp so the audit trail doesn't lie about a stale approver.
            update["decided_by"] = None
            update["decided_by_id"] = None
            update["decided_at"] = None
        await db.leaves.update_one({"id": leave_id}, {"$set": update})
        leave = await db.leaves.find_one({"id": leave_id}, {"_id": 0})
        if not leave:
            raise HTTPException(status_code=404, detail="Leave not found")
        return leave

    @router.post("/leaves/group")
    async def group_leave(body: GroupLeaveIn, admin: dict = Depends(require_admin)):
        if not body.user_ids:
            raise HTTPException(status_code=400, detail="Pick at least one member")
        # Comp-off: validate every member's balance up-front, so we never
        # half-insert (partial success would be hard for an admin to reconcile).
        if body.type == "comp_off":
            short_list = []
            for uid in body.user_ids:
                u = await db.users.find_one({"id": uid}, {"_id": 0})
                if not u:
                    continue
                try:
                    await _comp_off_guard(u, body.start_date, body.end_date)
                except HTTPException as exc:
                    short_list.append(f"{u.get('full_name', uid)}: {exc.detail}")
            if short_list:
                raise HTTPException(status_code=400, detail=" • ".join(short_list))
        office = await db.config.find_one({"id": "office"})
        today = local_date_str(office)
        late_application = bool(body.start_date and body.start_date < today)
        docs = []
        for uid in body.user_ids:
            d = {
                "id": str(uuid.uuid4()),
                "user_id": uid,
                "type": body.type,
                "start_date": body.start_date,
                "end_date": body.end_date,
                "reason": body.reason,
                "location": body.location,
                "status": "approved" if body.auto_approve else "pending",
                "late_application": late_application,
                "filed_by_admin": admin["id"],
                "filed_by_admin_name": admin["full_name"],
                "group_leave": True,
                "created_at": now_utc().isoformat(),
            }
            if body.auto_approve:
                d["decided_by"] = admin["full_name"]
                d["decided_at"] = now_utc().isoformat()
            docs.append(d)
        if docs:
            await db.leaves.insert_many(docs)
        return {"ok": True, "created": len(docs), "status": "approved" if body.auto_approve else "pending"}

    return router
