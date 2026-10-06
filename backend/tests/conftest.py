import os
import sys
import pytest
import requests
from pathlib import Path
from typing import Any, Optional
from dotenv import load_dotenv

# Make `services/`, `parents_import_utils`, and the other top-level backend
# modules importable when pytest runs from `/app/backend`.
BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_ROOT))

# Load backend/.env so unit tests can import services that read env vars at
# module-import time (JWT_SECRET_KEY etc.).
load_dotenv(BACKEND_ROOT / ".env")

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    # Fallback to reading frontend/.env directly (the public preview URL)
    env_path = "/app/frontend/.env"
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL"):
                    BASE_URL = line.split("=", 1)[1].strip().strip('"').rstrip("/")
                    break

ADMIN_EMAIL = os.environ.get("TEST_ADMIN_EMAIL", "admin@attendance.app")
ADMIN_PASSWORD = os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345")


@pytest.fixture(scope="session")
def base_url() -> str:
    assert BASE_URL, "REACT_APP_BACKEND_URL is required"
    return BASE_URL


@pytest.fixture(scope="session")
def admin_token(base_url: str) -> str:
    r = requests.post(f"{base_url}/api/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                      timeout=30)
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    return r.json()["access_token"]


@pytest.fixture(scope="session")
def admin_client(base_url: str, admin_token: str) -> requests.Session:
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {admin_token}",
                      "Content-Type": "application/json"})
    return s


def login_session(base_url: str, email: str, password: str) -> requests.Session:
    r = requests.post(f"{base_url}/api/auth/login",
                      json={"email": email, "password": password}, timeout=30)
    assert r.status_code == 200, f"login {email}: {r.status_code} {r.text}"
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {r.json()['access_token']}",
                      "Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def make_member():
    """Factory for throwaway members; all are deleted at session end.
    make_member(category="staff", role="executive", login=True) → dict with
    `password` and (when login=True) an authenticated `client` session."""
    import uuid
    # Own login + URL so modules that override admin_client/base_url don't clash.
    base_url = BASE_URL
    admin_client = login_session(BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD)
    created = []

    def _make(category: str = "athlete", role: str = "member", login: bool = False, **extra) -> dict:
        sfx = uuid.uuid4().hex[:8]
        body = {"email": f"test_{sfx}@ishowedup-test.example.com", "password": "Test@12345",
                "full_name": f"TEST {category.title()} {sfx}", "role": role,
                "category": category, **extra}
        r = admin_client.post(f"{base_url}/api/members", json=body, timeout=30)
        assert r.status_code == 200, r.text
        m = r.json()
        created.append(m["id"])
        m["password"] = body["password"]
        if login:
            m["client"] = login_session(base_url, body["email"], body["password"])
        return m

    yield _make
    for mid in created:
        admin_client.delete(f"{base_url}/api/members/{mid}",
                            params={"reason": "test cleanup"}, timeout=30)


# Throwaway accounts other test modules create with their own fixtures. Any
# created DURING this session are deleted at the end so they never show up in
# preview's real lists (absentee prompt, muster, grid). Fixed, reused fixture
# accounts (admin2.test@…, coach.test@…) don't match and are kept.
_TEST_EMAIL_RE = (r"(@ishowedup-test\.example\.com|@meals\.example\.com|^smoke-[^@]*@example\.com"
                  r"|^lop-[^@]*@attendance\.app|^smoke-[^@]*@athletes\.local)$")


@pytest.fixture(scope="session", autouse=True)
def _sweep_session_test_members():
    from datetime import datetime, timezone
    started = datetime.now(timezone.utc).isoformat()
    yield
    mongo_url, db_name = os.environ.get("MONGO_URL"), os.environ.get("DB_NAME")
    if not (mongo_url and db_name):
        return
    from pymongo import MongoClient
    users = MongoClient(mongo_url)[db_name].users
    ids = [u["id"] for u in users.find(
        {"created_at": {"$gte": started}, "email": {"$regex": _TEST_EMAIL_RE}}, {"_id": 0, "id": 1})]
    if not ids:
        return
    s = login_session(BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD)
    for uid in ids:
        s.delete(f"{BASE_URL}/api/members/{uid}", params={"reason": "test cleanup"}, timeout=30)


@pytest.fixture(scope="session")
def athlete(make_member) -> dict:
    """Throwaway athlete for muster + leave tests (never a real member)."""
    return make_member("athlete")


@pytest.fixture(scope="session")
def second_admin_client(make_member) -> requests.Session:
    """A different (non-super) admin — the 2-admin rule blocks the filer
    from approving their own on-behalf leave / correction."""
    import random
    return make_member("staff", role="admin", login=True,
                       mobile=f"90{random.randint(10**7, 10**8 - 1)}")["client"]


@pytest.fixture(scope="session")
def shared_state() -> dict:
    return {}


@pytest.fixture(scope="session")
def mongo_db() -> Optional[Any]:
    """Direct pymongo handle to the app's MongoDB. Only used by tests
    that need to seed fields the API doesn't expose (e.g. server-
    stamped `photo_captured_at` for stale-photo detection).

    Returns None if `MONGO_URL` / `DB_NAME` aren't configured — tests
    using this fixture should `pytest.skip()` on None."""
    url = os.environ.get("MONGO_URL")
    name = os.environ.get("DB_NAME")
    if not url or not name:
        return None
    try:
        from pymongo import MongoClient
        client = MongoClient(url)
        return client[name]
    except Exception:
        return None
