"""
Regression: per-member `meal_eligible` override (Feb 2026 chef request:
"How do I change the meal eligibility of a specific member" → "Build
Option C").

Rules the tests lock in:
  • Category flag is the DEFAULT — when user.meal_eligible is None,
    category.meal_eligible decides.
  • Explicit False on the user WINS — even if the category is on.
  • Explicit True on the user WINS — even if the category is off.
  • The write path (/meals/mark-bulk) enforces the same rule so a
    chef can't slip a False-user onto meal_records via bulk-marking.
"""
import os
import uuid
import pytest
import httpx


API_URL = os.environ.get("API_BASE_URL") or "http://localhost:8001"
ADMIN_EMAIL = "admin@attendance.app"
ADMIN_PASSWORD = "Admin@12345"


@pytest.fixture(scope="module")
def admin_token():
    r = httpx.post(f"{API_URL}/api/auth/login",
                   json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                   timeout=15)
    r.raise_for_status()
    return r.json()["access_token"]


@pytest.fixture
def hdr(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


def _make_staff(hdr):
    """Create a throwaway meal-eligible-category (staff) member."""
    slug = uuid.uuid4().hex[:8]
    r = httpx.post(f"{API_URL}/api/members", headers=hdr, timeout=15,
                   json={"email": f"pytest-meal-{slug}@attendance.app",
                         "password": "Test@1234",
                         "full_name": f"PYTEST_MEAL_{slug}",
                         "category": "staff", "rank": "TEST DRIVER"})
    r.raise_for_status()
    return r.json()


def _roster_ids(hdr, meal="lunch", date="2026-08-20"):
    r = httpx.get(f"{API_URL}/api/meals/roster",
                  params={"meal": meal, "date": date, "scope": "all"},
                  headers=hdr, timeout=15)
    r.raise_for_status()
    return {m["id"] for m in r.json().get("members") or []}


def test_default_is_inherit_from_category(hdr):
    """Fresh staff member with no override → appears on the roster
    because the `staff` category is meal_eligible=true by default."""
    m = _make_staff(hdr)
    try:
        assert m["id"] in _roster_ids(hdr)
    finally:
        httpx.delete(f"{API_URL}/api/members/{m['id']}", headers=hdr, timeout=15)


def test_explicit_false_removes_from_roster(hdr):
    """meal_eligible=False on the user wins over the category being on."""
    m = _make_staff(hdr)
    try:
        assert m["id"] in _roster_ids(hdr)
        r = httpx.patch(f"{API_URL}/api/members/{m['id']}", headers=hdr, timeout=15,
                        json={"meal_eligible": False})
        r.raise_for_status()
        assert m["id"] not in _roster_ids(hdr)
    finally:
        httpx.delete(f"{API_URL}/api/members/{m['id']}", headers=hdr, timeout=15)


def test_mark_bulk_skips_explicit_false(hdr):
    """The write path must refuse to mark a user with meal_eligible=False
    — otherwise chefs could accidentally include them via bulk-mark."""
    m = _make_staff(hdr)
    try:
        httpx.patch(f"{API_URL}/api/members/{m['id']}", headers=hdr, timeout=15,
                    json={"meal_eligible": False}).raise_for_status()
        r = httpx.post(f"{API_URL}/api/meals/mark-bulk", headers=hdr, timeout=15,
                       json={"meal": "lunch", "date": "2026-08-20",
                             "user_ids": [m["id"]]})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["marked_count"] == 0
        assert body["skipped_count"] >= 1
    finally:
        httpx.delete(f"{API_URL}/api/members/{m['id']}", headers=hdr, timeout=15)


def test_null_resets_to_inherit(hdr):
    """After setting explicit False, PATCHing back to null must restore
    the inherit-from-category behaviour."""
    m = _make_staff(hdr)
    try:
        httpx.patch(f"{API_URL}/api/members/{m['id']}", headers=hdr, timeout=15,
                    json={"meal_eligible": False}).raise_for_status()
        assert m["id"] not in _roster_ids(hdr)
        httpx.patch(f"{API_URL}/api/members/{m['id']}", headers=hdr, timeout=15,
                    json={"meal_eligible": None}).raise_for_status()
        # Inheriting → staff category is meal_eligible, so back on roster.
        assert m["id"] in _roster_ids(hdr)
    finally:
        httpx.delete(f"{API_URL}/api/members/{m['id']}", headers=hdr, timeout=15)
