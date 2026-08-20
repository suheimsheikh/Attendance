"""
Authentication + device-approval endpoints — split out of `server.py`
during the 06/2026 modularisation pass.

Covers:
  • POST /api/auth/login           — email + password login (admin path).
  • GET  /api/auth/me              — current user, enriched with the live
                                     leave balance.
  • POST /api/auth/phone           — passwordless phone sign-in with
                                     device-approval gate.
  • GET  /api/auth/phone/status    — long-poll status check while a device
                                     waits for admin approval.
  • GET  /api/admin/devices        — admin device queue.
  • POST /api/admin/devices/{id}/approve | reject | revoke | reinstate

The `make_router(...)` factory receives all callable dependencies so this
module has no import-cycle with `server.py`.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, timedelta
from typing import List, Literal, Optional

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr

from models import UserPublic
from services.permissions import is_super_admin, _SUPER_ADMIN_PHONES
from services.time_utils import now_utc, local_date_str
from services.phone import normalize_phone, phone_key

logger = logging.getLogger(__name__)


# -------------------- Pydantic bodies --------------------
class LoginIn(BaseModel):
    email: EmailStr
    password: str


class PhoneLoginIn(BaseModel):
    phone: str
    device_id: str
    device_name: Optional[str] = None
    model: Optional[str] = None
    platform: Optional[str] = None
    # Self-introduction provided on first sign-in (used to pre-fill the
    # admin approval form for brand-new members).
    full_name: Optional[str] = None
    rank: Optional[str] = None
    category: Optional[Literal["athlete", "staff", "coach", "executive"]] = None


class DeviceApproveIn(BaseModel):
    full_name: Optional[str] = None
    # `chef` role added 4 Feb 2026 with the Roles master — kitchen staff
    # who need read-access to Muster/Presence/Chef's View but no admin
    # rights. Category stays as-is (Elite still on the wishlist).
    role: Literal["admin", "member", "chef"] = "member"
    category: Literal["athlete", "elite", "staff", "coach", "executive"] = "athlete"
    rank: Optional[str] = None


def _user_public(u: dict) -> UserPublic:
    return UserPublic(**{k: u.get(k) for k in UserPublic.model_fields})


def make_router(
    db,
    require_admin,
    get_current_user,
    verify_password,
    hash_password,
    create_token,
    jwt_secret: str,
    jwt_algo: str,
    device_token_minutes: int,
) -> APIRouter:
    router = APIRouter(prefix="/api")

    def _device_token_response(user: dict, device_id: str) -> dict:
        token = create_token(
            user["id"], user.get("role", "member"),
            device_id=device_id, expires_minutes=device_token_minutes,
        )
        return {
            "status": "approved",
            "access_token": token,
            "token_type": "bearer",
            "user": _user_public(user),
        }

    async def _match_user_by_phone(digits: str) -> Optional[dict]:
        key = phone_key(digits)
        if not key:
            return None
        # Fast path: indexed denormalised last-10-digit key, backfilled at
        # startup. Falls back to the legacy full-scan match for any users
        # not yet backfilled (handles a freshly-restored DB without the
        # index field).
        match = await db.users.find_one(
            {"mobile_last10": key}, {"_id": 0, "hashed_password": 0}
        )
        if match:
            return match
        async for u in db.users.find({"mobile": {"$ne": None}}, {"_id": 0, "id": 1, "mobile": 1}):
            if phone_key(u.get("mobile") or "") == key:
                return await db.users.find_one({"id": u["id"]}, {"_id": 0, "hashed_password": 0})
        return None

    async def _match_escort_by_phone(digits: str) -> Optional[dict]:
        """Map a phone-number to an `escorts` row, mirroring the user
        matcher: indexed mobile_last10 key first, then full scan keyed by
        the normalized form. Only active escorts WITHIN their validity
        window match — replaced/left escorts no longer log in, and
        active escorts outside [valid_from, valid_until] also can't sign
        in (added 28 Jun 2026 with the escort dates feature).
        """
        from services.time_utils import now_utc as _now
        key = phone_key(digits)
        if not key:
            return None

        def _in_window(esc: dict) -> bool:
            today_iso = _now().date().isoformat()
            vf = esc.get("valid_from")
            vu = esc.get("valid_until")
            # Open ends are tolerated (legacy rows pre-feature). When
            # both are set, the gate enforces vf <= today <= vu.
            if vf and today_iso < vf:
                return False
            if vu and today_iso > vu:
                return False
            return True

        match = await db.escorts.find_one(
            {"mobile_last10": key, "status": "active"}, {"_id": 0}
        )
        if match and _in_window(match):
            return match
        async for e in db.escorts.find({"status": "active"},
                                       {"_id": 0, "id": 1, "phone": 1}):
            if phone_key(e.get("phone") or "") == key:
                full = await db.escorts.find_one({"id": e["id"]}, {"_id": 0})
                if full and _in_window(full):
                    return full
        return None

    async def _enrich_devices(devices: List[dict]) -> List[dict]:
        uids = list({d["user_id"] for d in devices if d.get("user_id")})
        # Also resolve admin display names for the audit-trail line.
        actor_ids = list({d["last_action_by"] for d in devices if d.get("last_action_by")})
        lookup_ids = list(set(uids + actor_ids))
        users = await db.users.find({"id": {"$in": lookup_ids}}, {"_id": 0}).to_list(2000)
        umap = {u["id"]: u for u in users}
        for d in devices:
            u = umap.get(d.get("user_id"))
            d["member_name"] = u["full_name"] if u else None
            d["member_role"] = u["role"] if u else None
            d["member_category"] = u["category"] if u else None
            d["member_rank"] = u.get("rank") if u else None
            actor = umap.get(d.get("last_action_by"))
            d["last_action_by_name"] = actor["full_name"] if actor else None
        return devices

    async def _stamp_action(device_pk: str, new_status: str, admin_id: str,
                            extra: Optional[dict] = None) -> int:
        """Update a device's status AND the audit trail in one shot.
        Returns matched_count so callers can 404 on missing devices."""
        payload = {
            "status": new_status,
            "last_action": new_status,
            "last_action_by": admin_id,
            "last_action_at": now_utc().isoformat(),
        }
        if extra:
            payload.update(extra)
        res = await db.devices.update_one({"id": device_pk}, {"$set": payload})
        return res.matched_count

    # ------------------------------------------------------------------
    # Auth routes
    # ------------------------------------------------------------------
    LOGIN_MAX_ATTEMPTS = 5
    LOGIN_WINDOW_MIN = 15

    @router.post("/auth/login")
    async def login(body: LoginIn, request: Request):
        # Brute-force guard: 5 failed attempts per (ip, email) in a 15-min
        # sliding window → 429. Attempts clear on successful login.
        ip = (request.headers.get("x-forwarded-for")
              or (request.client.host if request.client else "unknown")).split(",")[0].strip()
        identifier = f"{ip}:{body.email.lower()}"
        now = now_utc()
        cutoff = (now - timedelta(minutes=LOGIN_WINDOW_MIN)).isoformat()
        rec = await db.login_attempts.find_one({"identifier": identifier}, {"_id": 0})
        recent = [t for t in (rec or {}).get("attempts", []) if t >= cutoff]
        if len(recent) >= LOGIN_MAX_ATTEMPTS:
            raise HTTPException(status_code=429,
                                detail="Too many failed attempts. Try again in 15 minutes.")
        user = await db.users.find_one({"email": body.email})
        if not user or not verify_password(body.password, user["hashed_password"]):
            await db.login_attempts.update_one(
                {"identifier": identifier},
                {"$set": {"identifier": identifier, "attempts": recent + [now.isoformat()]}},
                upsert=True,
            )
            raise HTTPException(status_code=401, detail="Incorrect email or password")
        await db.login_attempts.delete_one({"identifier": identifier})
        token = create_token(user["id"], user.get("role", "member"))
        return {
            "access_token": token,
            "token_type": "bearer",
            "user": _user_public(user),
        }

    @router.get("/auth/me", response_model=UserPublic)
    async def me(user: dict = Depends(get_current_user)):
        # Enrich the response with the LIVE leave balance (opening − YTD-approved
        # leave days). This mirrors the computation in `GET /members` so the
        # leave-application form on `/my-leaves` can show "you have N days left"
        # without an additional round-trip. We only run the YTD aggregation for
        # non-athletes who have an opening balance set — saves work for athletes
        # (who use the Breaks workflow) and for newly-onboarded staff whose
        # opening balance hasn't been seeded yet.
        enriched = dict(user)
        if user.get("category") != "athlete" and user.get("leave_balance_opening") is not None:
            office = await db.config.find_one({"id": "office"})
            year = local_date_str(office)[:4]
            rows = await db.leaves.find({
                "user_id": user["id"], "status": "approved", "type": "leave",
                "start_date": {"$gte": f"{year}-01-01", "$lte": f"{year}-12-31"},
            }, {"_id": 0, "start_date": 1, "end_date": 1, "paid_leave_used": 1}).to_list(500)
            taken = 0.0
            for leave in rows:
                # New ladder rows carry `paid_leave_used` — only that slice draws
                # from the paid pool. Legacy rows (pre-ladder) count fully.
                if "paid_leave_used" in leave and leave["paid_leave_used"] is not None:
                    taken += float(leave["paid_leave_used"])
                else:
                    try:
                        taken += (date.fromisoformat(leave["end_date"]) - date.fromisoformat(leave["start_date"])).days + 1
                    except Exception:
                        taken += 1
            opening = float(user["leave_balance_opening"])
            enriched["leave_balance_remaining"] = round(opening - taken, 1)
        # Super-admin flag (04 Feb 2026) — driven by env whitelist,
        # NOT stored in the DB. Frontend uses this to hide the Hours
        # columns on Reports for regular admins.
        enriched["is_super_admin"] = is_super_admin(enriched)
        return UserPublic(**{k: enriched.get(k) for k in UserPublic.model_fields})

    @router.post("/auth/phone")
    async def phone_login(body: PhoneLoginIn):
        digits = normalize_phone(body.phone)
        if len(digits) < 6:
            raise HTTPException(status_code=400, detail="Enter a valid phone number")
        now = now_utc().isoformat()
        matched = await _match_user_by_phone(digits)

        # Super-admin break-glass (24 Feb 2026): a phone on the
        # SUPER_ADMIN_PHONES env whitelist is guaranteed a way in, even
        # on a fresh production DB where the phone was never stamped
        # against a user record OR where an escort happens to share
        # the whitelisted phone digits. Three shapes we handle:
        #   1. No user at all with this phone → create a fresh admin.
        #   2. Existing user with this phone, non-admin role → elevate.
        #   3. Existing admin (typical case) → no-op, downstream
        #      auto-approve branch handles it.
        # This MUST run BEFORE the escort-match block below, otherwise
        # an escort sharing the whitelisted digits pre-empts the rescue
        # and the super-admin lands on the escort flow instead of the
        # admin dashboard (regression caught by bug-test iteration 27).
        # Deliberately narrow: only phones on the env whitelist can
        # trigger this, so a member changing their phone to an admin's
        # digits can never self-promote.
        if _SUPER_ADMIN_PHONES and phone_key(digits) in {phone_key(p) for p in _SUPER_ADMIN_PHONES}:
            if not matched:
                # First try to restore the seeded admin row (admin@attendance.app)
                # if it exists and has no mobile — the common prod-drift scenario.
                # This keeps the identity stable across recoveries and avoids
                # sprinkling ghost `super-admin-<phone>@attendance.app` rows in
                # the DB.
                seed_admin = await db.users.find_one(
                    {"email": "admin@attendance.app"},
                    {"_id": 0, "hashed_password": 0},
                )
                if seed_admin and not (seed_admin.get("mobile") or "").strip():
                    await db.users.update_one(
                        {"id": seed_admin["id"]},
                        {"$set": {"role": "admin", "mobile": digits,
                                  "mobile_last10": phone_key(digits) or None}},
                    )
                    matched = await db.users.find_one({"id": seed_admin["id"]}, {"_id": 0, "hashed_password": 0})
                    logger.info("Break-glass: restored seeded admin %s (phone %s)",
                                seed_admin.get("email"), digits)
                else:
                    # No seeded admin row (or it already has a different mobile)
                    # — synthesise a fresh super-admin user.
                    new_admin_id = str(uuid.uuid4())
                    await db.users.insert_one({
                        "id": new_admin_id,
                        "email": f"super-admin-{digits}@attendance.app",
                        "full_name": (body.full_name or "").strip() or "Super Admin",
                        "role": "admin",
                        "category": "staff",
                        "rank": "Super Admin",
                        "mobile": digits,
                        "mobile_last10": phone_key(digits) or None,
                        "photo": None,
                        "hashed_password": hash_password(uuid.uuid4().hex),
                        "created_at": now,
                    })
                    matched = await db.users.find_one({"id": new_admin_id}, {"_id": 0, "hashed_password": 0})
                    logger.info("Break-glass: created super-admin user for phone %s", digits)
            elif matched.get("role") != "admin":
                await db.users.update_one(
                    {"id": matched["id"]},
                    {"$set": {"role": "admin", "mobile": digits,
                              "mobile_last10": phone_key(digits) or None}},
                )
                matched = await db.users.find_one({"id": matched["id"]}, {"_id": 0, "hashed_password": 0})
                logger.info("Break-glass: elevated %s to admin (super phone %s)",
                            matched.get("email"), digits)

        # Escort phone match — runs only when no employee/user matched (so a
        # phone listed against both a member AND an escort still routes to
        # the member). Escorts are passwordless (no device approval gate):
        # one phone = one escort identity. The frontend recognises the
        # `is_escort` flag and redirects to /escort-checkin.
        if not matched:
            esc = await _match_escort_by_phone(digits)
            if esc:
                token = jwt.encode(
                    {"sub": esc["id"], "is_escort": True,
                     "exp": now_utc() + timedelta(minutes=device_token_minutes)},
                    jwt_secret, algorithm=jwt_algo,
                )
                return {
                    "status": "approved",
                    "access_token": token,
                    "token_type": "bearer",
                    "is_escort": True,
                    "user": {
                        "id": esc["id"],
                        "full_name": esc["name"],
                        "phone": esc.get("phone"),
                        "institution": esc.get("institution"),
                        "is_escort": True,
                        "escort_id": esc["id"],
                        "role": None,
                        "category": None,
                    },
                }

        device = await db.devices.find_one({"device_id": body.device_id}, {"_id": 0})
        meta = {
            "phone": digits,
            "device_name": body.device_name,
            "model": body.model,
            "platform": body.platform,
            "updated_at": now,
        }
        # Self-introduction (only meaningful for unmatched / first-time users — never
        # overwrite a real member's stored profile).
        if not matched:
            if body.full_name and body.full_name.strip():
                meta["proposed_full_name"] = body.full_name.strip()
            if body.rank and body.rank.strip():
                meta["proposed_rank"] = body.rank.strip()
            if body.category:
                meta["proposed_category"] = body.category
        if device is None:
            # Atomic upsert so two concurrent /auth/phone calls with the
            # same device_id don't both try to insert and blow up with a
            # DuplicateKeyError (E11000). $setOnInsert fires ONLY when
            # we're the winning writer; the loser's request quietly falls
            # through to the update branch below on the next fetch.
            # Root-caused after user reported "Failed to execute 'json'
            # on Response" (500 → HTML "Internal Server Error") when
            # restoring into preview.
            await db.devices.update_one(
                {"device_id": body.device_id},
                {"$setOnInsert": {
                    "id": str(uuid.uuid4()),
                    "device_id": body.device_id,
                    "status": "pending",
                    "user_id": matched["id"] if matched else None,
                    "created_at": now,
                    "approved_by": None,
                    **meta,
                 }},
                upsert=True,
            )
            device = await db.devices.find_one({"device_id": body.device_id}, {"_id": 0})
        else:
            upd = dict(meta)
            if matched and not device.get("user_id"):
                upd["user_id"] = matched["id"]
            # If this device was previously REJECTED and the user is trying again
            # (e.g. admin rejected by mistake, or member's circumstances changed),
            # flip the status back to "pending" so the new attempt re-appears in
            # the admin Access Requests queue. Without this, the rejected record
            # silently keeps every retry invisible to the admin.
            if device.get("status") == "rejected":
                upd["status"] = "pending"
                upd["last_action"] = "re-requested"
                upd["last_action_at"] = now
            await db.devices.update_one({"device_id": body.device_id}, {"$set": upd})
            device = await db.devices.find_one({"device_id": body.device_id}, {"_id": 0})

        # Admin self-recovery: if this revoked device belongs to (or matches by
        # phone) an admin user, allow the trusted-phone bypass to silently
        # re-approve it. Admins are commonly testing the revoke flow on their
        # own browser and shouldn't get perma-locked out of preview/staging.
        # Non-admins (regular members) stay blocked — the audit trail matters
        # for them and admin re-enable is the documented path.
        # Also recover when the device's linked user no longer exists (ghost
        # link after an admin row was recreated) — otherwise the admin gets
        # perma-403'd on a device pointing at a deleted account.
        device_owner_is_ghost = bool(device.get("user_id")) and not await db.users.find_one(
            {"id": device["user_id"]}, {"_id": 1})
        revoked_admin_self = (
            device["status"] == "revoked"
            and matched
            and matched.get("role") == "admin"
            and (not device.get("user_id") or device.get("user_id") == matched["id"]
                 or device_owner_is_ghost)
        )
        if device["status"] == "revoked" and not revoked_admin_self:
            raise HTTPException(status_code=403, detail="This device was revoked. Contact your admin.")

        # Already approved & linked -> straight in
        if device["status"] == "approved" and device.get("user_id"):
            u = await db.users.find_one({"id": device["user_id"]}, {"_id": 0})
            if u:
                await db.devices.update_one({"device_id": body.device_id}, {"$set": {"last_login_at": now}})
                return _device_token_response(u, body.device_id)

        # Pre-designated admin -> instant approve + login (the original "cinch").
        # Also handles admin self-recovery: if their own browser was previously
        # revoked (e.g. while testing the revoke flow), we silently bring it
        # back to approved and stamp a "recovered" audit note.
        if matched and matched.get("role") == "admin":
            was_revoked = device.get("status") == "revoked"
            update = {
                "status": "approved", "user_id": matched["id"],
                "approved_by": "auto-admin", "approved_at": now, "last_login_at": now,
            }
            if was_revoked:
                update["last_action"] = "auto-recovered-by-admin-phone"
                update["last_action_by"] = matched["id"]
                update["last_action_at"] = now
                logger.info("Admin self-recovery: re-approved revoked device %s for %s",
                            body.device_id, matched.get("full_name"))
            await db.devices.update_one({"device_id": body.device_id}, {"$set": update})
            return _device_token_response(matched, body.device_id)

        # Trusted-phone cinch: if the matched member ALREADY has another approved
        # device, auto-approve this new device too. This covers the very common
        # case where a member's browser cache / PWA install creates a fresh
        # device_id — without this they'd be stuck on "Awaiting approval" forever
        # while their phone is shown as already approved in the admin queue.
        #
        # Important: this branch must NOT auto-recover an explicitly revoked
        # device for non-admin members. Admin self-recovery is handled above
        # by the role==admin branch; for everyone else, revoked stays revoked
        # and they must contact their admin.
        if matched and device["status"] not in ("approved", "revoked"):
            prior = await db.devices.find_one({
                "user_id": matched["id"],
                "status": "approved",
                "device_id": {"$ne": body.device_id},
            }, {"_id": 0, "id": 1})
            if prior:
                await db.devices.update_one({"device_id": body.device_id}, {"$set": {
                    "status": "approved", "user_id": matched["id"],
                    "approved_by": "auto-trusted-phone", "approved_at": now, "last_login_at": now,
                    "last_action": "approved", "last_action_by": "auto-trusted-phone", "last_action_at": now,
                }})
                return _device_token_response(matched, body.device_id)

        return {
            "status": "pending",
            "device_id": body.device_id,
            "matched_member": matched["full_name"] if matched else None,
            "needs_profile": not matched and not (device.get("proposed_full_name") or "").strip(),
        }

    @router.get("/auth/phone/status")
    async def phone_status(device_id: str):
        device = await db.devices.find_one({"device_id": device_id}, {"_id": 0})
        if not device:
            return {"status": "unknown"}
        if device["status"] == "revoked":
            return {"status": "revoked"}
        if device["status"] == "approved" and device.get("user_id"):
            u = await db.users.find_one({"id": device["user_id"]}, {"_id": 0})
            if u:
                await db.devices.update_one({"device_id": device_id},
                                            {"$set": {"last_login_at": now_utc().isoformat()}})
                return _device_token_response(u, device_id)
        return {"status": "pending"}

    # ------------------------------------------------------------------
    # Admin device-management routes
    # ------------------------------------------------------------------
    @router.get("/admin/devices")
    async def list_devices(status_filter: Optional[str] = None, admin: dict = Depends(require_admin)):
        q = {}
        if status_filter:
            q["status"] = status_filter
        devices = await db.devices.find(q, {"_id": 0}).sort("created_at", -1).to_list(1000)
        return await _enrich_devices(devices)

    @router.post("/admin/devices/{device_pk}/approve")
    async def approve_device(device_pk: str, body: DeviceApproveIn, admin: dict = Depends(require_admin)):
        device = await db.devices.find_one({"id": device_pk}, {"_id": 0})
        if not device:
            raise HTTPException(status_code=404, detail="Device request not found")
        now = now_utc().isoformat()
        user_id = device.get("user_id")
        if not user_id:
            digits = device.get("phone") or ""
            email = f"{digits}@attendance.app"
            if await db.users.find_one({"email": email}):
                email = f"{digits}-{uuid.uuid4().hex[:4]}@attendance.app"
            new_user = {
                "id": str(uuid.uuid4()),
                "email": email,
                "full_name": (body.full_name or "New Member").strip(),
                "role": body.role,
                "category": body.category,
                "rank": body.rank,
                "mobile": digits,
                "mobile_last10": phone_key(digits) or None,
                "work_start": None,
                "work_end": None,
                "photo": None,
                "personal_qr": "CARD-" + uuid.uuid4().hex[:12].upper(),
                # Random unguessable password — members sign in via phone;
                # the email/password path must never work with the phone
                # number as a guessable credential.
                "hashed_password": hash_password(uuid.uuid4().hex),
                "created_at": now,
            }
            await db.users.insert_one(new_user)
            user_id = new_user["id"]
        await db.devices.update_one({"id": device_pk}, {"$set": {
            "status": "approved", "user_id": user_id,
            "approved_by": admin["id"], "approved_at": now,
            "last_action": "approved", "last_action_by": admin["id"], "last_action_at": now,
        }})
        return {"ok": True}

    @router.post("/admin/devices/{device_pk}/reject")
    async def reject_device(device_pk: str, admin: dict = Depends(require_admin)):
        if await _stamp_action(device_pk, "rejected", admin["id"]) == 0:
            raise HTTPException(status_code=404, detail="Device request not found")
        return {"ok": True}

    @router.post("/admin/devices/{device_pk}/revoke")
    async def revoke_device(device_pk: str, admin: dict = Depends(require_admin)):
        if await _stamp_action(device_pk, "revoked", admin["id"]) == 0:
            raise HTTPException(status_code=404, detail="Device not found")
        return {"ok": True}

    @router.post("/admin/devices/{device_pk}/reinstate")
    async def reinstate_device(device_pk: str, admin: dict = Depends(require_admin)):
        """Bring a revoked or rejected device back to approved. The device retains
        its existing user_id; if it never had one (a rejected new-signup), the
        admin must re-run the regular approve flow which prompts for a name."""
        device = await db.devices.find_one({"id": device_pk}, {"_id": 0})
        if not device:
            raise HTTPException(status_code=404, detail="Device not found")
        if device.get("status") not in ("revoked", "rejected"):
            raise HTTPException(status_code=400, detail="Only revoked or rejected devices can be re-enabled")
        if not device.get("user_id"):
            raise HTTPException(status_code=400, detail="This device was never linked to a member — use the regular Approve flow")
        await _stamp_action(device_pk, "approved", admin["id"], extra={
            "approved_by": admin["id"],
            "approved_at": now_utc().isoformat(),
        })
        return {"ok": True}

    return router
