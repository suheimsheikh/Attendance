import os
import sys
import pytest
import requests
from pathlib import Path
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
def base_url():
    assert BASE_URL, "REACT_APP_BACKEND_URL is required"
    return BASE_URL


@pytest.fixture(scope="session")
def admin_token(base_url):
    r = requests.post(f"{base_url}/api/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                      timeout=30)
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    return r.json()["access_token"]


@pytest.fixture(scope="session")
def admin_client(base_url, admin_token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {admin_token}",
                      "Content-Type": "application/json"})
    return s


@pytest.fixture(scope="session")
def athlete(admin_client, base_url):
    """Pick an existing athlete (or create one) to drive muster + leave tests.
    Re-used across all flows so we don't litter the DB."""
    import uuid
    listing = admin_client.get(f"{base_url}/api/members", timeout=30).json()
    target = next((m for m in listing if m.get("category") == "athlete"), None)
    if target:
        return target

    body = {
        "email": f"smoke-{uuid.uuid4().hex[:6]}@athletes.local",
        "password": "Smoke@1234",
        "full_name": "Smoke Test Athlete",
        "role": "member",
        "category": "athlete",
    }
    r = admin_client.post(f"{base_url}/api/members", json=body, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="session")
def shared_state():
    return {}
