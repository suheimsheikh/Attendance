"""Password hashing + JWT token issuance.

Reads JWT_SECRET_KEY / JWT_ALGORITHM / JWT_EXPIRES_MINUTES from the
process env (loaded from `backend/.env` at app startup).
"""
from __future__ import annotations

import os
from datetime import timedelta
from typing import Optional

import bcrypt
import jwt

from .time_utils import now_utc

JWT_SECRET = os.environ["JWT_SECRET_KEY"]
JWT_ALGO = os.environ["JWT_ALGORITHM"]
JWT_EXPIRES_MINUTES = int(os.environ["JWT_EXPIRES_MINUTES"])


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def create_token(user_id: str, role: str, device_id: Optional[str] = None,
                 expires_minutes: Optional[int] = None) -> str:
    exp_minutes = expires_minutes if expires_minutes is not None else JWT_EXPIRES_MINUTES
    payload = {
        "sub": user_id,
        "role": role,
        "exp": now_utc() + timedelta(minutes=exp_minutes),
    }
    if device_id:
        payload["device_id"] = device_id
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)
