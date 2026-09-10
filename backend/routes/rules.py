"""Attendance Rules sign-off. Rules text + version live in config
(id="rules_policy"); acceptances in `rules_acceptances` (user_id, version)."""
from __future__ import annotations

import uuid
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from services.time_utils import now_utc

RULES_VERSION = "2026-09"
RULES_REQUIRED_CATEGORIES = ["staff", "coach", "executive"]
DEFAULT_RULES = [
    ("Working hours & check-in", [
        "Standard working day is 09:30 to 18:00 (Asia/Kolkata) unless a different shift is set on your profile by Admin.",
        "Weekly off is Sunday by default, or the day set on your profile.",
        "You must check in on arrival and check out on departure every working day using the app (self check-in, QR at the office, or the Muster Roll taken by a coach/admin).",
        "Check-ins are geolocation-verified. You must be within the office / approved training-site geofence; check-ins from outside are flagged for admin review.",
        "Sharing your phone, checking in on someone else's behalf, or otherwise falsifying a check-in is a disciplinary offence. Every record carries who created it, when and from where.",
    ]),
    ("Punctuality", [
        "There is no grace period. A check-in after your shift start time is recorded as Late (LT) and the minutes late are counted for the month.",
        "Checking out before your shift end time is recorded as Early Out (EO). Provide a reason at check-out.",
        "Overtime is recognised only when you are at least 30 minutes before shift start or after shift end and are checked in/out through the app.",
        "If you forget to check out you will be reminded at 20:00. Missing check-outs must be corrected within the correction window.",
    ]),
    ("Absence", [
        "A working day with no check-in, no approved leave, no tour, no holiday and no break is recorded as Absent (AB) once the day has ended.",
        "If you are Absent on the working day immediately before or after your weekly off, the weekly off is also counted as Absent.",
        "Absences without approved leave are Loss of Pay (LOP).",
        "Repeated unapproved absence (3 or more in a month) is escalated to management.",
    ]),
    ("Leave", [
        "All leave — paid leave, comp-off, tour/posting — must be applied for in the app and approved by an Admin before it counts.",
        "Leave requires at least 3 days' notice. Shorter notice can only be filed by an Admin on your behalf in genuine emergencies.",
        "Leave may be full day or half day (Forenoon 09:30–13:30 / Postnoon 13:30–18:00). A half day deducts 0.5.",
        "Leave is deducted comp-off first, then paid leave. Days beyond your balance are approved only as LOP with a written override reason.",
        "Your opening paid-leave balance is set on your profile; your live balance is visible under My Leaves.",
    ]),
    ("Comp-off, tours and holidays", [
        "You earn one comp-off for each weekly off on which you are checked in at work or on an approved tour/regatta/camp.",
        "Approved tour, posting or camp days are recorded as Tour (TR) / Posting (PS) and count as worked. Declared Holidays (HO) and academy Breaks (BK) require no attendance.",
    ]),
    ("Daily Activity Report", [
        "If you are required to file a Daily Activity Report (DAR), your check-out is not complete until the DAR is entered. A worked day with no DAR counts as a missed DAR and is reported to payroll.",
    ]),
    ("Corrections & records", [
        "Missed check-ins, wrong times or wrong leave dates must be raised as a Correction Request in the app within 31 days, with a reason.",
        "Once a month has been locked for payroll, no corrections, leave approvals or edits are possible for that month.",
        "Your monthly attendance sheet (the Grid) is the single source of truth for payroll.",
        "All entries and changes are permanently logged with actor, timestamp and reason. Tampering, or attempting to bypass geolocation, is grounds for disciplinary action.",
    ]),
]


class RulesPolicyIn(BaseModel):
    version: Optional[str] = None
    sections: Optional[List[dict]] = None
    required_categories: Optional[List[str]] = None


def make_router(db, get_current_user, require_admin, write_audit) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["rules"])

    async def _policy() -> dict:
        doc = await db.config.find_one({"id": "rules_policy"}, {"_id": 0})
        if not doc:
            doc = {"id": "rules_policy", "version": RULES_VERSION,
                   "sections": [{"heading": h, "rules": r} for h, r in DEFAULT_RULES],
                   "required_categories": RULES_REQUIRED_CATEGORIES}
            await db.config.update_one({"id": "rules_policy"}, {"$setOnInsert": doc}, upsert=True)
        doc.pop("id", None)
        return doc

    def _required(user: dict, policy: dict) -> bool:
        return user.get("category") in (policy.get("required_categories") or []) and user.get("status") != "left"

    @router.get("/rules")
    async def get_rules(user: dict = Depends(get_current_user)):
        p = await _policy()
        acc = await db.rules_acceptances.find_one({"user_id": user["id"], "version": p["version"]}, {"_id": 0})
        return {**p, "required": _required(user, p), "accepted": acc}

    @router.post("/rules/accept")
    async def accept_rules(user: dict = Depends(get_current_user)):
        p = await _policy()
        existing = await db.rules_acceptances.find_one({"user_id": user["id"], "version": p["version"]}, {"_id": 0})
        if existing:
            return existing
        doc = {"id": str(uuid.uuid4()), "user_id": user["id"], "user_name": user.get("full_name"),
               "category": user.get("category"), "version": p["version"], "accepted_at": now_utc().isoformat()}
        await db.rules_acceptances.insert_one(dict(doc))
        await write_audit(db, actor=user, action="rules_accepted", entity_type="rules", entity_id=p["version"],
                          entity_name=f"Attendance Rules v{p['version']}", before=None, after={"accepted_at": doc["accepted_at"]},
                          reason="Member accepted the Attendance Rules")
        return doc

    @router.put("/admin/rules")
    async def put_rules(body: RulesPolicyIn, admin: dict = Depends(require_admin)):
        before = await _policy()
        upd = {}
        new_version = before["version"]
        if body.version and body.version.strip():
            upd["version"] = body.version.strip()
            new_version = upd["version"]
        content_changed = False
        if body.sections is not None:
            secs = [{"heading": str(s.get("heading") or "").strip(), "rules": [str(r).strip() for r in (s.get("rules") or []) if str(r).strip()]}
                    for s in body.sections if isinstance(s, dict)]
            if not any(s["rules"] for s in secs):
                raise HTTPException(status_code=400, detail="At least one rule is required")
            upd["sections"] = secs
            content_changed = secs != (before.get("sections") or [])
        if body.required_categories is not None:
            upd["required_categories"] = [c for c in body.required_categories if c in ("staff", "coach", "executive", "elite", "athlete")]
        # Sign-off integrity: acceptances are keyed by version, so changing
        # the rule TEXT without bumping the version would leave employees
        # marked as having accepted wording they never saw. Force a new
        # version whenever the content actually changes.
        if content_changed and new_version == before["version"]:
            raise HTTPException(
                status_code=400,
                detail="Change the version when you edit the rule text so the team re-signs the updated rules.",
            )
        if upd:
            await db.config.update_one({"id": "rules_policy"}, {"$set": upd}, upsert=True)
            await write_audit(db, actor=admin, action="rules_policy_update", entity_type="config", entity_id="rules_policy",
                              entity_name="Attendance Rules",
                              before={"version": before["version"], "sections": before.get("sections")},
                              after={"version": new_version, "sections": upd.get("sections", before.get("sections")), "content_changed": content_changed},
                              reason="Rules edited")
        return await _policy()

    @router.get("/admin/rules/acceptances")
    async def acceptances(admin: dict = Depends(require_admin)):
        p = await _policy()
        users = await db.users.find(
            {"status": {"$ne": "left"}, "category": {"$in": p.get("required_categories") or []}},
            {"_id": 0, "id": 1, "full_name": 1, "category": 1, "rank": 1}).sort("full_name", 1).to_list(2000)
        accs = {a["user_id"]: a async for a in db.rules_acceptances.find({"version": p["version"]}, {"_id": 0})}
        rows = [{"member_id": u["id"], "member_name": u.get("full_name"), "category": u.get("category"), "rank": u.get("rank"),
                 "accepted_at": (accs.get(u["id"]) or {}).get("accepted_at")} for u in users]
        return {"version": p["version"], "rows": rows,
                "accepted": sum(1 for r in rows if r["accepted_at"]), "pending": sum(1 for r in rows if not r["accepted_at"])}

    return router
