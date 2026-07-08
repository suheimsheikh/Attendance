"""Check-in approvals — admin queue for late & off-geofence check-ins.

Every check-in that landed with `late=True` or `out_of_geofence=True`
is stamped `approval_status="pending"` at ingest time (see server.py
geo-toggle + routes/muster.py bulk endpoints). This module exposes the
admin workflow to review them:

  • GET  /api/admin/checkin-approvals?status=pending|approved|rejected
  • POST /api/admin/checkin-approvals/{id}/decide  body {decision, note?}

Also exposes an aggregated pending-count endpoint used by the sidebar
badge on Approvals:

  • GET /api/admin/approvals-summary
    → {leaves, overtime, devices, checkins, total}

A "rejected" decision is note-only per user brief (24 Jul 2026):
the check-in stays valid, hours still count, appears in reports; the
rejection just flags for future policy or communication.
"""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from services.time_utils import now_utc


class DecideIn(BaseModel):
    decision: Literal["approved", "rejected"]
    note: Optional[str] = None


def make_router(db, require_admin, write_audit) -> APIRouter:
    router = APIRouter(prefix="/api/admin")

    @router.get("/checkin-approvals")
    async def list_checkin_approvals(
        status: str = Query("pending", pattern="^(pending|approved|rejected|all)$"),
        limit: int = Query(200, ge=1, le=1000),
        admin: dict = Depends(require_admin),
    ):
        """List attendance rows in the given approval state, newest first.

        Members' `full_name` + `photo_thumb` are hydrated so the frontend
        can render an avatar list without a second round-trip.
        """
        q: dict = {}
        if status == "all":
            q["approval_status"] = {"$in": ["pending", "approved", "rejected"]}
        else:
            q["approval_status"] = status

        rows = await db.attendance.find(
            q,
            {"_id": 0, "id": 1, "user_id": 1, "date": 1, "check_in_at": 1,
             "late": 1, "late_minutes": 1, "out_of_geofence": 1,
             "distance_m": 1, "site_name": 1, "geo_reason": 1,
             "method": 1, "checked_in_by": 1, "approval_status": 1,
             "approval_flags": 1, "approval_note": 1,
             "approved_by": 1, "approved_at": 1},
        ).sort("check_in_at", -1).to_list(limit)

        # Hydrate member info in one round-trip
        user_ids = list({r["user_id"] for r in rows if r.get("user_id")})
        users = await db.users.find(
            {"id": {"$in": user_ids}},
            {"_id": 0, "id": 1, "full_name": 1, "category": 1, "photo_thumb": 1,
             "institution": 1, "fleet": 1},
        ).to_list(len(user_ids) or 1)
        by_id = {u["id"]: u for u in users}

        for r in rows:
            u = by_id.get(r.get("user_id")) or {}
            r["full_name"]   = u.get("full_name")
            r["category"]    = u.get("category")
            r["photo_thumb"] = u.get("photo_thumb")
            r["institution"] = u.get("institution")
            r["fleet"]       = u.get("fleet")
        return {"items": rows, "count": len(rows), "status": status}

    @router.post("/checkin-approvals/{attendance_id}/decide")
    async def decide_checkin(
        attendance_id: str,
        body: DecideIn,
        admin: dict = Depends(require_admin),
    ):
        """Approve or reject a flagged check-in. Both decisions are
        note-only — the attendance row stays intact, hours still count,
        and it still shows in reports. The `approval_note` field is a
        required text on rejections (>= 3 chars) so the paper trail is
        actionable.
        """
        row = await db.attendance.find_one({"id": attendance_id}, {"_id": 0})
        if not row:
            raise HTTPException(status_code=404, detail="Attendance row not found")
        if row.get("approval_status") not in ("pending", "approved", "rejected"):
            raise HTTPException(
                status_code=400,
                detail="This attendance row is not flagged for approval.",
            )
        note = (body.note or "").strip() or None
        if body.decision == "rejected" and (not note or len(note) < 3):
            raise HTTPException(
                status_code=400,
                detail="A note (>= 3 characters) is required when rejecting.",
            )

        now = now_utc()
        update = {
            "approval_status": body.decision,
            "approval_note": note,
            "approved_by": admin.get("full_name"),
            "approved_by_id": admin.get("id"),
            "approved_at": now.isoformat(),
        }
        await db.attendance.update_one({"id": attendance_id}, {"$set": update})

        # Audit trail — every decision is captured with the previous status
        # so future disputes have a full paper trail.
        await write_audit(
            db,
            actor=admin,
            action=f"checkin_{body.decision}",
            entity_type="attendance",
            entity_id=attendance_id,
            entity_name=row.get("date"),
            before={"approval_status": row.get("approval_status"),
                    "approval_note": row.get("approval_note")},
            after={"approval_status": body.decision, "approval_note": note},
            reason=note,
        )
        return {"ok": True, "id": attendance_id, "decision": body.decision,
                "approved_at": update["approved_at"]}

    @router.get("/approvals-summary")
    async def approvals_summary(admin: dict = Depends(require_admin)):
        """Aggregated pending counts across every approval queue —
        powers the sidebar badge on 'Approvals' and the Dashboard.
        """
        leaves    = await db.leaves.count_documents({"status": "pending"})
        overtime  = await db.attendance.count_documents({"overtime_status": "pending"})
        devices   = await db.devices.count_documents({"status": "pending"})
        checkins  = await db.attendance.count_documents({"approval_status": "pending"})
        return {
            "leaves": leaves,
            "overtime": overtime,
            "devices": devices,
            "checkins": checkins,
            "total": leaves + overtime + devices + checkins,
        }

    return router
