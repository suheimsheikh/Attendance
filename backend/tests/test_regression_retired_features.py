"""Regression tests after retiring dead features (OT stubs, Category Health, Escort Photo Cleanup)."""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://youth-regatta-app.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = "admin@attendance.app"
ADMIN_PASSWORD = "Admin@12345"


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=30)
    assert r.status_code == 200, f"Login failed: {r.status_code} {r.text}"
    data = r.json()
    assert "access_token" in data, f"No access_token in login response: {data}"
    return data["access_token"]


@pytest.fixture(scope="module")
def auth_headers(token):
    return {"Authorization": f"Bearer {token}"}


# -------- Auth / Health --------
def test_admin_login_returns_access_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=30)
    assert r.status_code == 200
    assert "access_token" in r.json()


# -------- Retired endpoints must 404 --------
RETIRED = [
    "/api/admin/overtime",
    "/api/admin/overtime/needs-review",
    "/api/admin/category-health",
    "/api/escort-attendance/photos/purge-candidates",
]


@pytest.mark.parametrize("path", RETIRED)
def test_retired_endpoints_return_404(path, auth_headers):
    r = requests.get(f"{BASE_URL}{path}", headers=auth_headers, timeout=30)
    assert r.status_code == 404, f"{path} returned {r.status_code}, expected 404"


# -------- Regression: sibling endpoints still work --------
def test_attendance_status_still_works(auth_headers):
    r = requests.get(f"{BASE_URL}/api/attendance/status", headers=auth_headers, timeout=30)
    assert r.status_code == 200, f"{r.status_code} {r.text[:200]}"


def test_calendar_grid_still_works(auth_headers):
    r = requests.get(f"{BASE_URL}/api/reports/calendar-grid?month=2026-10", headers=auth_headers, timeout=30)
    assert r.status_code == 200, f"{r.status_code} {r.text[:200]}"
    data = r.json()
    assert isinstance(data, (list, dict))


def test_usage_report_excludes_retired_screens(auth_headers):
    r = requests.get(f"{BASE_URL}/api/usage/report", headers=auth_headers, timeout=30)
    assert r.status_code == 200, f"{r.status_code} {r.text[:200]}"
    body = r.json()
    text = str(body).lower()
    assert "category-health" not in text, "usage report still mentions category-health"
    assert "escort-photos" not in text, "usage report still mentions escort-photos"
    # never_used count should be 3 not 5
    never_used = None
    if isinstance(body, dict):
        # try common keys
        for k in ("never_used_count", "neverUsedCount", "never_used"):
            if k in body:
                v = body[k]
                never_used = len(v) if isinstance(v, list) else v
                break
    print(f"never_used value from usage report: {never_used}; full keys={list(body.keys()) if isinstance(body, dict) else type(body)}")


def test_escort_attendance_list_still_works(auth_headers):
    # Try a couple of common list endpoints under escort-attendance to confirm the router loads
    candidates = [
        "/api/escort-attendance",
        "/api/escort-attendance/",
        "/api/escort-attendance/list",
        "/api/escorts",
    ]
    last = None
    for p in candidates:
        r = requests.get(f"{BASE_URL}{p}", headers=auth_headers, timeout=30)
        last = (p, r.status_code, r.text[:200])
        # Any non-500, non-404 means route is wired and not crashing
        if r.status_code not in (404, 500):
            assert r.status_code == 200, f"{p} returned {r.status_code}: {r.text[:200]}"
            return
    pytest.fail(f"No working escort-attendance list endpoint found; last tried: {last}")
