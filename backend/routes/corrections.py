"""
Corrections facility — a single after-the-fact correction workflow that
lets members request fixes to attendance rows and leave rows, and lets
admins approve or reject each request.

Design goals:
  * ONE endpoint / ONE collection for every kind of correction. New kinds
    plug into a dispatch table (`APPLIERS`) — 20 lines to add one.
  * Only members (not admins) can raise a correction. Admins process the
    queue. Corrections raised by an admin still go through the queue for a
    paper trail (per user policy).
  * 31-day retro window enforced server-side.
  * Rich audit trail — every decision writes to the audit collection.

Kinds shipped in v1 (identified by `entity_type` × `kind`):
  attendance × missed_checkin     — no attendance row exists, create one
  attendance × time_adjust        — attendance row exists, adjust times
  leave      × leave_date_change  — approved leave with wrong dates
  leave      × leave_cancel       — approved leave that shouldn't have run
  leave      × leave_type_change  — approved leave with wrong type

Applying an approved correction dispatches through `APPLIERS[(entity_type, kind)]`.
Each applier receives (db, correction, admin) and mutates the target row.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from services.time_utils import now_utc, local_date_str


# Rolling window in which members may request a correction. Fits the
# "same-week retrospective" policy chosen by admin (option 2b).
CORRECTION_WINDOW_DAYS: int = 31

VALID_ENTITY_KINDS: Dict[str, set] = {
    "attendance": {"missed_checkin", "time_adjust"},
    "leave": {"leave_date_change", "leave_cancel", "leave_type_change"},
}
VALID_STATUSES = {"pending", "approved", "rejected"}


# --- Pydantic models -------------------------------------------------------

class CorrectionCreate(BaseModel):
    entity_type: str
    kind: str
    entity_id: Optional[str] = None   # existing row being adjusted (None for missed_checkin)
    target_date: str                   # YYYY-MM-DD — the date the correction applies to
    payload: Dict[str, Any] = Field(default_factory=dict)
    reason: str
    # Admin-only field (4 Feb 2026) — when an admin files a correction on
    # behalf of a member, this holds that member's user id. The persisted
    # row still gets requester_id=<target_member> (so approvers see it in
    # the correct member's queue and the applier mutates that member's
    # row), but audit fields record the filing admin so the "second-admin
    # approval" rule can enforce filer ≠ approver.
    on_behalf_of: Optional[str] = None


class CorrectionDecision(BaseModel):
    status: str                        # "approved" | "rejected"
    admin_note: Optional[str] = None


# --- Applier dispatch table -----------------------------------------------
#
# Each entry is an async function(db, correction, admin) -> dict.
# Returns a small summary the audit log can quote back.

async def _apply_missed_checkin(db, c: dict, admin: dict) -> dict:
    """Materialise a check-in for a date that has no attendance row."""
    p = c["payload"]
    check_in_time = p.get("check_in_time")   # HH:MM
    check_out_time = p.get("check_out_time")  # optional HH:MM
    if not check_in_time:
        raise HTTPException(status_code=400, detail="payload.check_in_time is required")
    # Reject if a row already exists for this date (they wanted `time_adjust`).
    existing = await db.attendance.find_one(
        {"user_id": c["requester_id"], "date": c["target_date"]},
    )
    if existing:
        raise HTTPException(status_code=409, detail="Attendance already exists for this date — use time_adjust instead")
    row = {
        "id": str(uuid4()),
        "user_id": c["requester_id"],
        "user_name": c["requester_name"],
        "date": c["target_date"],
        "check_in_at": f"{c['target_date']}T{check_in_time}:00",
        "check_out_at": f"{c['target_date']}T{check_out_time}:00" if check_out_time else None,
        "method": "correction",
        "checked_in_by": admin.get("full_name"),
        "corrected": True,
        "corrected_via": c["id"],
        "corrected_by": admin.get("full_name"),
        "corrected_at": now_utc().isoformat(),
    }
    await db.attendance.insert_one(row)
    return {"attendance_id": row["id"], "created": True}


async def _apply_time_adjust(db, c: dict, admin: dict) -> dict:
    """Adjust check_in / check_out on an existing attendance row.

    Per admin policy (option 3b), we KEEP the original `late` flag on the
    row so the audit trail shows the anomaly, but stamp `corrected=True`
    + `correction_id` so the UI can render a "corrected" badge alongside.
    """
    if not c.get("entity_id"):
        raise HTTPException(status_code=400, detail="entity_id (attendance row id) is required")
    row = await db.attendance.find_one({"id": c["entity_id"]}, {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail="Target attendance row no longer exists")
    p = c["payload"]
    update: Dict[str, Any] = {
        "corrected": True,
        "corrected_via": c["id"],
        "corrected_by": admin.get("full_name"),
        "corrected_at": now_utc().isoformat(),
        "corrected_from": {
            "check_in_at": row.get("check_in_at"),
            "check_out_at": row.get("check_out_at"),
        },
    }
    if p.get("check_in_time"):
        update["check_in_at"] = f"{row['date']}T{p['check_in_time']}:00"
    if p.get("check_out_time"):
        update["check_out_at"] = f"{row['date']}T{p['check_out_time']}:00"
    await db.attendance.update_one({"id": c["entity_id"]}, {"$set": update})
    return {"attendance_id": c["entity_id"], "updated": list(update.keys())}


async def _apply_leave_date_change(db, c: dict, admin: dict) -> dict:
    if not c.get("entity_id"):
        raise HTTPException(status_code=400, detail="entity_id (leave id) is required")
    leave = await db.leaves.find_one({"id": c["entity_id"]}, {"_id": 0})
    if not leave:
        raise HTTPException(status_code=404, detail="Target leave no longer exists")
    p = c["payload"]
    update: Dict[str, Any] = {
        "corrected": True, "corrected_via": c["id"],
        "corrected_by": admin.get("full_name"),
        "corrected_at": now_utc().isoformat(),
        "corrected_from": {"start_date": leave.get("start_date"), "end_date": leave.get("end_date")},
    }
    if p.get("start_date"):
        update["start_date"] = p["start_date"]
    if p.get("end_date"):
        update["end_date"] = p["end_date"]
    await db.leaves.update_one({"id": c["entity_id"]}, {"$set": update})
    return {"leave_id": c["entity_id"], "updated": list(update.keys())}


async def _apply_leave_cancel(db, c: dict, admin: dict) -> dict:
    if not c.get("entity_id"):
        raise HTTPException(status_code=400, detail="entity_id (leave id) is required")
    res = await db.leaves.update_one(
        {"id": c["entity_id"]},
        {"$set": {
            "status": "cancelled",
            "cancelled_by": admin.get("full_name"),
            "cancelled_via": c["id"],
            "cancelled_at": now_utc().isoformat(),
        }},
    )
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail="Target leave no longer exists")
    return {"leave_id": c["entity_id"], "cancelled": True}


async def _apply_leave_type_change(db, c: dict, admin: dict) -> dict:
    if not c.get("entity_id"):
        raise HTTPException(status_code=400, detail="entity_id (leave id) is required")
    p = c["payload"]
    new_type = p.get("type")
    if not new_type:
        raise HTTPException(status_code=400, detail="payload.type is required (leave / comp_off / tour)")
    leave = await db.leaves.find_one({"id": c["entity_id"]}, {"_id": 0})
    if not leave:
        raise HTTPException(status_code=404, detail="Target leave no longer exists")
    await db.leaves.update_one({"id": c["entity_id"]}, {"$set": {
        "type": new_type,
        "corrected": True, "corrected_via": c["id"],
        "corrected_by": admin.get("full_name"),
        "corrected_at": now_utc().isoformat(),
        "corrected_from": {"type": leave.get("type")},
    }})
    return {"leave_id": c["entity_id"], "new_type": new_type}


APPLIERS: Dict[tuple, Any] = {
    ("attendance", "missed_checkin"):    _apply_missed_checkin,
    ("attendance", "time_adjust"):       _apply_time_adjust,
    ("leave",      "leave_date_change"): _apply_leave_date_change,
    ("leave",      "leave_cancel"):      _apply_leave_cancel,
    ("leave",      "leave_type_change"): _apply_leave_type_change,
}


# --- Router factory --------------------------------------------------------

def make_router(db, require_admin, get_current_user, write_audit) -> APIRouter:
    """Build the corrections router. `write_audit` is passed in from server.py
    to keep this module free of a circular import back into server.
    """
    router = APIRouter(prefix="/api")

    async def _load_correction(cid: str) -> dict:
        c = await db.corrections.find_one({"id": cid}, {"_id": 0})
        if not c:
            raise HTTPException(status_code=404, detail="Correction not found")
        return c

    def _enforce_window(target_date: str):
        try:
            td = date.fromisoformat(target_date)
        except ValueError:
            raise HTTPException(status_code=400, detail="target_date must be YYYY-MM-DD")
        today = date.today()
        if td > today:
            raise HTTPException(status_code=400, detail="target_date cannot be in the future")
        if (today - td).days > CORRECTION_WINDOW_DAYS:
            raise HTTPException(
                status_code=400,
                detail=f"Corrections can only be requested for the last {CORRECTION_WINDOW_DAYS} days",
            )

    @router.post("/corrections")
    async def create_correction(body: CorrectionCreate, user: dict = Depends(get_current_user)):
        """Member raises a correction request. Admins go through the queue
        too (per policy option 4b) — no auto-approval bypass.

        Admins may additionally file corrections on behalf of any member
        by passing `on_behalf_of=<member_id>` (4 Feb 2026). The row is
        stored against the target member but audit fields record the
        filing admin, and the decide endpoint enforces filer ≠ approver
        so a second admin must still sign it off.
        """
        if body.entity_type not in VALID_ENTITY_KINDS:
            raise HTTPException(status_code=400,
                                detail=f"entity_type must be one of {sorted(VALID_ENTITY_KINDS)}")
        if body.kind not in VALID_ENTITY_KINDS[body.entity_type]:
            raise HTTPException(status_code=400,
                                detail=f"kind for {body.entity_type!r} must be one of {sorted(VALID_ENTITY_KINDS[body.entity_type])}")
        if not (body.reason or "").strip():
            raise HTTPException(status_code=400, detail="reason is required")

        # Resolve target member — admin-on-behalf-of flow takes precedence.
        # Only actual admins may impersonate; non-admins get a 403 rather
        # than a silent fallback (would be a spoofing vector otherwise).
        filed_by_admin_id: Optional[str] = None
        filed_by_admin_name: Optional[str] = None
        if body.on_behalf_of:
            if user.get("role") != "admin":
                raise HTTPException(
                    status_code=403,
                    detail="Only admins may file corrections on behalf of another member.",
                )
            target = await db.users.find_one(
                {"id": body.on_behalf_of},
                {"_id": 0, "id": 1, "full_name": 1},
            )
            if not target:
                raise HTTPException(status_code=404, detail="Target member not found")
            requester_id = target["id"]
            requester_name = target["full_name"]
            filed_by_admin_id = user["id"]
            filed_by_admin_name = user["full_name"]
        else:
            requester_id = user["id"]
            requester_name = user["full_name"]

        # Admins bypass the retro window — they're often filing late
        # corrections precisely BECAUSE the member missed the window.
        # Non-admin self-filed requests still respect the policy.
        if user.get("role") != "admin":
            _enforce_window(body.target_date)
        else:
            # Still reject future dates even for admins — nothing to fix.
            try:
                td = date.fromisoformat(body.target_date)
            except ValueError:
                raise HTTPException(status_code=400, detail="target_date must be YYYY-MM-DD")
            if td > date.today():
                raise HTTPException(status_code=400, detail="target_date cannot be in the future")

        doc = {
            "id": str(uuid4()),
            "entity_type": body.entity_type,
            "kind": body.kind,
            "entity_id": body.entity_id,
            "target_date": body.target_date,
            "payload": body.payload or {},
            "reason": body.reason.strip(),
            "status": "pending",
            "requester_id": requester_id,
            "requester_name": requester_name,
            "requested_at": now_utc().isoformat(),
            "decided_by_id": None,
            "decided_by_name": None,
            "decided_at": None,
            "admin_note": None,
            # New audit fields (4 Feb 2026). Nullable for legacy rows.
            "filed_by_admin_id": filed_by_admin_id,
            "filed_by_admin_name": filed_by_admin_name,
        }
        await db.corrections.insert_one(doc)
        return {"ok": True, "id": doc["id"]}

    @router.get("/me/corrections")
    async def my_corrections(user: dict = Depends(get_current_user), status: Optional[str] = None):
        q: Dict[str, Any] = {"requester_id": user["id"]}
        if status:
            q["status"] = status
        rows = await db.corrections.find(q, {"_id": 0}).sort("requested_at", -1).to_list(500)
        return rows

    @router.get("/me/corrections/candidates")
    async def correction_candidates(
        user: dict = Depends(get_current_user),
        on_behalf_of: Optional[str] = None,
    ):
        """Rows the current member is eligible to correct — attendance
        rows from the last N days and their active leave/tour entries.
        Powers the target-row picker inside the Correction request modal
        so members can raise time_adjust / leave_date_change / leave_
        cancel / leave_type_change corrections without first hunting
        down the row on Check-in or Leave/Tour pages.

        Only pulls rows the correction workflow can actually apply to:
        approved leaves (cancellation / date-change / type-change) and
        attendance rows within the retro window (time_adjust). Rejected
        or pending items are hidden — they aren't valid targets.

        Admins may pass `?on_behalf_of=<member_id>` to fetch candidates
        for another member (4 Feb 2026 — supports the admin-on-behalf
        correction flow). Non-admins get 403 if they try.
        """
        target_id = user["id"]
        if on_behalf_of:
            if user.get("role") != "admin":
                raise HTTPException(status_code=403,
                                    detail="Only admins may look up other members' correction candidates.")
            target_id = on_behalf_of
        cutoff = (date.today() - timedelta(days=CORRECTION_WINDOW_DAYS - 1)).isoformat()
        atts = await db.attendance.find(
            {"user_id": target_id, "date": {"$gte": cutoff}},
            {"_id": 0, "id": 1, "date": 1,
             "check_in_at": 1, "check_out_at": 1},
        ).sort("date", -1).to_list(30)
        leaves = await db.leaves.find(
            {"user_id": target_id, "status": "approved",
             "end_date": {"$gte": cutoff}},
            {"_id": 0, "id": 1, "type": 1, "start_date": 1, "end_date": 1,
             "reason": 1},
        ).sort("start_date", -1).to_list(50)
        return {"attendance": atts, "leaves": leaves}

    @router.get("/admin/corrections")
    async def list_corrections(
        status: Optional[str] = "pending",
        entity_type: Optional[str] = None,
        admin: dict = Depends(require_admin),
    ):
        q: Dict[str, Any] = {}
        if status:
            if status not in VALID_STATUSES:
                raise HTTPException(status_code=400, detail=f"status must be one of {sorted(VALID_STATUSES)}")
            q["status"] = status
        if entity_type:
            if entity_type not in VALID_ENTITY_KINDS:
                raise HTTPException(status_code=400, detail=f"entity_type must be one of {sorted(VALID_ENTITY_KINDS)}")
            q["entity_type"] = entity_type
        rows = await db.corrections.find(q, {"_id": 0}).sort("requested_at", -1).to_list(1000)
        return rows

    async def _decide_one(correction: dict, decision: str, note: Optional[str], admin: dict):
        """Shared logic between single-decide and bulk-approve. Applies the
        change (when approved) and stamps decision metadata on the correction.

        Second-admin rule (4 Feb 2026): if the correction was FILED by an
        admin on behalf of a member, the approver must differ from the
        filer. Applies to both approvals and rejections so the filing
        admin can't withdraw + reject their own request to sneak past
        the queue.
        """
        if correction["status"] != "pending":
            raise HTTPException(status_code=409, detail=f"Correction already {correction['status']}")
        if decision not in ("approved", "rejected"):
            raise HTTPException(status_code=400, detail="status must be approved or rejected")
        filed_by = correction.get("filed_by_admin_id")
        if filed_by and filed_by == admin["id"]:
            raise HTTPException(
                status_code=409,
                detail="You filed this correction on behalf of the member — a different admin must approve or reject it.",
            )
        applied: Optional[dict] = None
        if decision == "approved":
            applier = APPLIERS.get((correction["entity_type"], correction["kind"]))
            if not applier:
                raise HTTPException(status_code=500,
                                    detail=f"No applier registered for {correction['entity_type']}/{correction['kind']}")
            applied = await applier(db, correction, admin)
        now = now_utc().isoformat()
        await db.corrections.update_one({"id": correction["id"]}, {"$set": {
            "status": decision,
            "decided_by_id": admin["id"],
            "decided_by_name": admin["full_name"],
            "decided_at": now,
            "admin_note": (note or "").strip() or None,
            "applied": applied,
        }})
        await write_audit(
            db, actor=admin,
            action=f"correction_{decision}",
            entity_type="correction",
            entity_id=correction["id"],
            entity_name=f"{correction['entity_type']}/{correction['kind']} · {correction['requester_name']} · {correction['target_date']}",
            before={"status": "pending"},
            after={"status": decision, "applied": applied, "admin_note": note},
            reason=note or f"{decision} by admin",
        )
        return applied

    @router.post("/admin/corrections/{cid}/decide")
    async def decide_correction(cid: str, body: CorrectionDecision, admin: dict = Depends(require_admin)):
        c = await _load_correction(cid)
        applied = await _decide_one(c, body.status, body.admin_note, admin)
        return {"ok": True, "id": cid, "decision": body.status, "applied": applied}

    @router.post("/admin/corrections/approve-all")
    async def approve_all_corrections(admin: dict = Depends(require_admin)):
        """Bulk-approve every pending correction in one shot. Skips any
        that error out (e.g. the target row was already deleted) — returns
        counts of approved vs skipped so admin knows if follow-up is needed.
        """
        pending = await db.corrections.find({"status": "pending"}, {"_id": 0}).to_list(2000)
        approved = 0
        errors: List[dict] = []
        for c in pending:
            try:
                await _decide_one(c, "approved", "Bulk approved by admin", admin)
                approved += 1
            except HTTPException as e:
                errors.append({"id": c["id"], "detail": e.detail})
        return {"ok": True, "approved": approved, "skipped": len(errors), "errors": errors}

    return router
