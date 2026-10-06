"""Iter91 regression smoke: cleanup batch + shared format helpers + timezone.

Focus:
- /api/version served by routes/office.py (not the removed server.py handler)
- /api/health
- /api/office returns timezone (used by frontend academy tz)
- /api/meals/analytics still exposes purchases.unitemised_amount after cleanup
- /api/recipes still works after dishes_by_meal line simplified
- /api/reports/dar export still works (group_colors removed from PDF helper)
"""
import os
import datetime as dt
import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
ADMIN_EMAIL = "admin@attendance.app"
ADMIN_PASS = os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345")


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASS}, timeout=30)
    assert r.status_code == 200, r.text
    tok = r.json().get("access_token") or r.json().get("token")
    assert tok
    return tok


@pytest.fixture(scope="module")
def auth_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


def test_health_ok():
    r = requests.get(f"{BASE_URL}/api/health", timeout=15)
    assert r.status_code == 200
    assert r.json().get("status") == "ok"


def test_version_endpoint():
    r = requests.get(f"{BASE_URL}/api/version", timeout=15)
    assert r.status_code == 200
    data = r.json()
    assert "version" in data
    assert isinstance(data["version"], str) and len(data["version"]) > 0


def test_office_returns_timezone(auth_headers):
    r = requests.get(f"{BASE_URL}/api/office", headers=auth_headers, timeout=15)
    assert r.status_code == 200
    data = r.json()
    tz = data.get("timezone") or data.get("tz")
    assert tz, f"office payload missing timezone key: {list(data.keys())}"
    assert "Asia/Kolkata" in tz or "/" in tz


def test_meals_analytics_has_unitemised(auth_headers):
    today = dt.date.today().isoformat()
    start = (dt.date.today() - dt.timedelta(days=14)).isoformat()
    r = requests.get(
        f"{BASE_URL}/api/meals/kitchen-analytics",
        params={"start": start, "end": today},
        headers=auth_headers,
        timeout=30,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert "purchases" in data, data
    # The cleanup kept unitemised_amount on purchases
    assert "unitemised_amount" in data["purchases"], list(data["purchases"].keys())


def test_recipes_tree_works(auth_headers):
    r = requests.get(f"{BASE_URL}/api/recipes/tree", headers=auth_headers, timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    assert isinstance(body, (list, dict))


def test_reports_dar_pdf_export(auth_headers):
    today = dt.date.today().isoformat()
    r = requests.get(
        f"{BASE_URL}/api/reports/dar.pdf",
        params={"date": today},
        headers=auth_headers,
        timeout=60,
    )
    # Must not 500 after group_colors param was removed from the PDF helper
    assert r.status_code in (200, 204, 404), r.text[:200]
    if r.status_code == 200:
        assert r.headers.get("content-type", "").startswith("application/pdf") or len(r.content) > 100
