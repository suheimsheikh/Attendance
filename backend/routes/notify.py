"""Parent-notification log, editable bilingual templates, and shared ✓ state.

Powers the one-tap WhatsApp parent-notify flow on the Muster page (absent
+ late). WhatsApp `wa.me` deep links carry text only and give no delivery
receipt, so this records **contact initiated** — proof that a specific
staff member opened a WhatsApp message to a specific parent, when.

Endpoints:
  • POST /api/notify/parent     — record a notify tap (member + parent role
                                  + reason). Server resolves the name/number
                                  from the DB (never trusts the client).
  • GET  /api/notify/today      — distinct "<member>:<role>_mobile" keys
                                  already notified today for a reason, so the
                                  ✓ ticks are shared across every device/user.
  • GET  /api/notify/log        — dated audit log (admins + coaches).
  • GET  /api/notify/templates  — bilingual message templates (with defaults).
  • PUT  /api/notify/templates  — admin-only template edit.
"""
from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from services.time_utils import now_utc, local_date_str

VALID_REASONS = ("absent", "late")
VALID_ROLES = ("father", "mother", "guardian")

# Bilingual defaults. Placeholders: {name} {academy} {day} {time} {minutes}.
DEFAULT_TEMPLATES = {
    "absent_te": (
        "నమస్తే 🙏\n\n"
        "{academy} నుండి {name} గురించి ఒక సందేశం.\n\n"
        "{name} ఈరోజు ({day}) శిక్షణకు హాజరు కాలేదు, మరియు మాకు ఎటువంటి ముందస్తు సమాచారం లేదు "
        "(అనుమతించిన సెలవు లేదా టూర్ నమోదు కాలేదు).\n\n"
        "దయచేసి వారి స్థితిని వీలైనంత త్వరగా తెలియజేయండి. ధన్యవాదాలు."
    ),
    "absent_en": (
        "Namaste 🙏\n\n"
        "This is a note from {academy} regarding {name}.\n\n"
        "{name} has not reported for training today ({day}) and we have no prior information "
        "(no approved leave or tour on record).\n\n"
        "Kindly confirm their status at your earliest. Thank you."
    ),
    "late_te": (
        "నమస్తే 🙏\n\n"
        "{academy} నుండి {name} గురించి ఒక సందేశం.\n\n"
        "{name} ఈరోజు ({day}) శిక్షణకు {time} గంటలకు ఆలస్యంగా హాజరయ్యారు ({minutes} నిమిషాలు ఆలస్యం).\n\n"
        "దయచేసి సమయపాలన పాటించేలా చూడగలరు. ధన్యవాదాలు."
    ),
    "late_en": (
        "Namaste 🙏\n\n"
        "This is a note from {academy} regarding {name}.\n\n"
        "{name} arrived late for training today ({day}) at {time} — {minutes} minutes late.\n\n"
        "Kindly help ensure punctuality going forward. Thank you."
    ),
}


class NotifyIn(BaseModel):
    member_id: str
    parent_role: str  # father | mother | guardian
    reason: str       # absent | late


def make_router(db, get_current_user, require_admin) -> APIRouter:
    router = APIRouter(prefix="/api")

    def _can_notify(user: dict) -> bool:
        # Parent notification is an internal admin/coach/chef action. Escorts
        # are external, institution-scoped tokens and must NOT be able to pull
        # arbitrary members' parent phone numbers (code review, Jun 2026).
        return (
            user.get("role") in ("admin", "chef")
            or user.get("category") == "coach"
        )

    def _can_view_log(user: dict) -> bool:
        # Admins + coaches only (product decision). Escorts/chefs excluded.
        return user.get("role") == "admin" or user.get("category") == "coach"

    @router.post("/notify/parent")
    async def record_parent_notify(body: NotifyIn, user: dict = Depends(get_current_user)):
        if not _can_notify(user):
            raise HTTPException(status_code=403, detail="Not allowed to notify parents")
        reason = (body.reason or "").strip().lower()
        role = (body.parent_role or "").strip().lower()
        if reason not in VALID_REASONS:
            raise HTTPException(status_code=400, detail="reason must be 'absent' or 'late'")
        if role not in VALID_ROLES:
            raise HTTPException(status_code=400, detail="parent_role must be father, mother or guardian")
        member = await db.users.find_one({"id": body.member_id}, {"_id": 0})
        if not member:
            raise HTTPException(status_code=404, detail="Member not found")
        number = (member.get(f"{role}_mobile") or "").strip()
        if not number:
            raise HTTPException(status_code=400, detail=f"No {role} number on file for this member")
        office = await db.config.find_one({"id": "office"})
        today = local_date_str(office)
        doc = {
            "id": str(uuid.uuid4()),
            "date": today,
            "member_id": member["id"],
            "member_name": member.get("full_name"),
            "category": member.get("category"),
            "parent_role": role,
            "parent_number": number,
            "reason": reason,
            "sent_by": user.get("full_name"),
            "sent_by_id": user.get("id"),
            "created_at": now_utc().isoformat(),
        }
        await db.notify_log.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @router.get("/notify/today")
    async def notify_today(reason: str = "absent", user: dict = Depends(get_current_user)):
        if not _can_notify(user):
            raise HTTPException(status_code=403, detail="Not allowed")
        reason = (reason or "").strip().lower()
        if reason not in VALID_REASONS:
            raise HTTPException(status_code=400, detail="reason must be 'absent' or 'late'")
        office = await db.config.find_one({"id": "office"})
        today = local_date_str(office)
        rows = await db.notify_log.find(
            {"date": today, "reason": reason},
            {"_id": 0, "member_id": 1, "parent_role": 1},
        ).to_list(5000)
        keys = sorted({f"{r['member_id']}:{r['parent_role']}_mobile" for r in rows})
        return {"date": today, "reason": reason, "keys": keys}

    @router.get("/notify/log")
    async def notify_log(
        reason: str = "all",
        date: Optional[str] = None,
        limit: int = 300,
        user: dict = Depends(get_current_user),
    ):
        if not _can_view_log(user):
            raise HTTPException(status_code=403, detail="Admins and coaches only")
        q: dict = {}
        r = (reason or "all").strip().lower()
        if r in VALID_REASONS:
            q["reason"] = r
        if date:
            q["date"] = date
        rows = (
            await db.notify_log.find(q, {"_id": 0})
            .sort("created_at", -1)
            .to_list(min(max(int(limit or 300), 1), 1000))
        )
        return rows

    @router.get("/notify/templates")
    async def get_templates(user: dict = Depends(get_current_user)):
        doc = await db.config.find_one({"id": "notify_templates"}, {"_id": 0}) or {}
        return {k: (doc.get(k) or DEFAULT_TEMPLATES[k]) for k in DEFAULT_TEMPLATES}

    @router.put("/notify/templates")
    async def put_templates(body: dict, admin: dict = Depends(require_admin)):
        clean = {}
        for k in DEFAULT_TEMPLATES:
            v = body.get(k)
            if v is not None:
                clean[k] = str(v)[:2000]
        if not clean:
            raise HTTPException(status_code=400, detail="No template fields provided")
        await db.config.update_one(
            {"id": "notify_templates"},
            {"$set": {"id": "notify_templates", **clean}},
            upsert=True,
        )
        return await get_templates(admin)

    return router
