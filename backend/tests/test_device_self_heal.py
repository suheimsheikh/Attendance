"""
Regression: JWT with a wiped/ghost device row must self-heal on first
request (Feb 2026 user report: "This device is no longer authorised"
after restoring a foreign backup into preview).

Ground rules:
  • JWT is validly signed by us and not expired  → trusted
  • JWT.sub maps to an active user record        → trusted
  • device row is missing OR points to a user that no longer exists
    → operational artifact of a restore, not a security event

Under those conditions get_current_user() upserts the device row back
to the JWT holder with status=approved instead of 401'ing.
"""
import os
import time
import uuid

import httpx
import jwt
import pytest


API_URL = os.environ.get("API_BASE_URL") or "http://localhost:8001"
ADMIN_EMAIL = "admin@attendance.app"
ADMIN_PASSWORD = "Admin@12345"

# JWT secret is loaded from the same env the backend uses. Tests must
# run against the same process so the shared secret matches.
from services.auth_utils import JWT_SECRET, JWT_ALGO  # noqa: E402


def _mint_token(user_id: str, device_id: str) -> str:
    payload = {
        "sub": user_id,
        "device_id": device_id,
        "exp": int(time.time()) + 300,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


@pytest.fixture(scope="module")
def admin_user_id():
    r = httpx.post(f"{API_URL}/api/auth/login",
                   json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                   timeout=15)
    r.raise_for_status()
    return r.json()["user"]["id"]


def test_self_heal_when_device_row_missing(admin_user_id):
    """Case A: the JWT references a device_id whose row was wiped by a
    restore. First request auto-rebinds it to the admin and succeeds."""
    fresh_device = f"pytest-wiped-{uuid.uuid4().hex[:8]}"
    token = _mint_token(admin_user_id, fresh_device)
    r = httpx.get(f"{API_URL}/api/meals/vendors",
                  headers={"Authorization": f"Bearer {token}"}, timeout=10)
    assert r.status_code == 200, r.text


def test_still_rejects_deliberately_revoked_device(admin_user_id):
    """Case B: a device that was DELIBERATELY revoked (status='revoked')
    must NOT self-heal — admins revoke intentionally. Only wiped / ghost
    rows self-heal."""
    from pymongo import MongoClient
    # Talk to Mongo directly to plant a 'revoked' device row.
    mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    client = MongoClient(mongo_url)
    db_name = os.environ.get("DB_NAME") or "test_database"
    db = client[db_name]
    dev_id = f"pytest-revoked-{uuid.uuid4().hex[:8]}"
    try:
        db.devices.insert_one({
            "id": str(uuid.uuid4()),
            "device_id": dev_id,
            "user_id": admin_user_id,
            "status": "revoked",
        })
        token = _mint_token(admin_user_id, dev_id)
        r = httpx.get(f"{API_URL}/api/meals/vendors",
                      headers={"Authorization": f"Bearer {token}"}, timeout=15)
        assert r.status_code == 401, r.text
        assert "no longer authorised" in (r.json().get("detail") or "").lower()
    finally:
        db.devices.delete_one({"device_id": dev_id})
        client.close()
