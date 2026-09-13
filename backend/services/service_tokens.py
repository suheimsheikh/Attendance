"""Long-lived, admin-issued, READ-ONLY API service tokens (PATs).

Additive to the existing JWT auth: only tokens beginning with ``svc_`` take
this path. The plaintext token is shown to the admin exactly once at
creation; the DB stores only an HMAC-SHA256 digest (peppered with the app's
JWT secret) plus a short prefix/last4 for display. A background script pastes
it as ``Authorization: Bearer svc_...``. Read-only is enforced at the app
boundary (see the reject_service_writes middleware in server.py).

Design follows the integration playbook: SHA-256/HMAC for high-entropy random
tokens (not bcrypt/argon2), indexed digest lookup, constant-time compare,
throttled last_used_at, and a single active token that regeneration replaces.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import HTTPException

SERVICE_PREFIX = "svc_"
_MAX_TOKEN_LEN = 512
_TOUCH_INTERVAL_SECONDS = 60
_LAST_TOUCH: dict[str, float] = {}   # per-process throttle for last_used_at


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def is_service_token(token: str) -> bool:
    return bool(token) and token.startswith(SERVICE_PREFIX)


def token_digest(raw_token: str, pepper: str = "") -> str:
    value = raw_token.encode("utf-8")
    if pepper:
        return hmac.new(pepper.encode("utf-8"), value, hashlib.sha256).hexdigest()
    return hashlib.sha256(value).hexdigest()


def generate_service_token() -> str:
    return SERVICE_PREFIX + secrets.token_urlsafe(32)   # 256 bits of entropy


async def create_or_replace_service_token(db, admin_user_id: str, pepper: str = "") -> str:
    """Generate a new token, deactivate any previous one, return plaintext once."""
    await db.service_tokens.create_index("token_hash", unique=True)
    raw = generate_service_token()
    now = _utcnow().isoformat()
    await db.service_tokens.update_many(
        {"active": True}, {"$set": {"active": False, "revoked_at": now}},
    )
    await db.service_tokens.insert_one({
        "id": str(uuid.uuid4()),
        "token_hash": token_digest(raw, pepper),
        "prefix": raw[:12],
        "last4": raw[-4:],
        "active": True,
        "created_at": now,
        "created_by": admin_user_id,
        "last_used_at": None,
    })
    return raw   # never logged or returned again


async def revoke_service_tokens(db) -> int:
    res = await db.service_tokens.update_many(
        {"active": True}, {"$set": {"active": False, "revoked_at": _utcnow().isoformat()}},
    )
    return res.modified_count


async def active_token_status(db) -> Optional[dict]:
    doc = await db.service_tokens.find_one({"active": True}, {"_id": 0, "token_hash": 0})
    return doc


async def authenticate_service_token(db, raw_token: str, pepper: str = "") -> Optional[dict[str, Any]]:
    """Return a synthetic READ-ONLY admin identity for a valid svc_ token.

    Returns None for non-service tokens (caller falls through to JWT).
    Raises 401 for a malformed/invalid/revoked service token.
    """
    if not is_service_token(raw_token):
        return None
    if len(raw_token) > _MAX_TOKEN_LEN:
        raise HTTPException(status_code=401, detail="Invalid authentication token")
    digest = token_digest(raw_token, pepper)
    doc = await db.service_tokens.find_one({"token_hash": digest, "active": True})
    if not doc or not hmac.compare_digest(digest, doc["token_hash"]):
        raise HTTPException(status_code=401, detail="Invalid authentication token")

    tid = doc["id"]
    mono = time.monotonic()
    if mono - _LAST_TOUCH.get(tid, 0) >= _TOUCH_INTERVAL_SECONDS:
        _LAST_TOUCH[tid] = mono
        await db.service_tokens.update_one(
            {"id": tid, "active": True}, {"$set": {"last_used_at": _utcnow().isoformat()}},
        )

    # Synthetic identity: role=admin so it can read admin report endpoints,
    # but read_only=True and the write-guard middleware block all mutations.
    return {
        "id": "service-token:" + tid,
        "full_name": "API Service Token",
        "role": "admin",
        "category": None,
        "is_escort": False,
        "auth_type": "service_token",
        "service_token_id": tid,
        "read_only": True,
    }
