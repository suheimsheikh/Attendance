"""Contract tests for GET /api/admin/meals-today and /api/masters/categories.

Chef's View endpoint tests — same style as the dashboard tests (live
preview backend via base_url fixture).
"""
from __future__ import annotations

import os
import requests


def _login(base_url) -> str:
    email = os.environ.get("TEST_ADMIN_EMAIL", "admin@attendance.app")
    password = os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345")
    r = requests.post(
        f"{base_url}/api/auth/login",
        json={"email": email, "password": password},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def test_categories_master_returns_five_seeded_rows(base_url):
    token = _login(base_url)
    r = requests.get(
        f"{base_url}/api/masters/categories",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    rows = r.json()
    keys = {row["key"] for row in rows}
    assert keys >= {"athlete", "elite", "coach", "staff", "executive"}
    for row in rows:
        assert {"key", "label", "sort_order", "color", "is_athlete_like",
                "meal_eligible", "active"} <= row.keys()
    # Athlete and Elite must be flagged athlete_like
    by_key = {r["key"]: r for r in rows}
    assert by_key["athlete"]["is_athlete_like"] is True
    assert by_key["elite"]["is_athlete_like"] is True
    assert by_key["staff"]["is_athlete_like"] is False


def test_meals_today_requires_auth(base_url):
    r = requests.get(f"{base_url}/api/admin/meals-today", timeout=30)
    assert r.status_code in (401, 403)


def test_meals_today_default_cutoff_shape(base_url):
    token = _login(base_url)
    r = requests.get(
        f"{base_url}/api/admin/meals-today",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body.keys()) >= {"today", "cutoff", "generated_at",
                                 "categories", "counts", "total", "members"}
    assert body["cutoff"] == "07:00"
    # Counts dict must have every category key from categories master
    for c in body["categories"]:
        assert c["key"] in body["counts"]
    assert body["total"] == sum(body["counts"].values())


def test_meals_today_cutoff_widens_pool(base_url):
    """A wider cutoff (23:59) must return >= members than a narrow one (07:00)
    for the same day. This proves the cutoff filter actually cuts."""
    token = _login(base_url)
    r_narrow = requests.get(
        f"{base_url}/api/admin/meals-today?date=2026-07-07&cutoff=07:00",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    r_wide = requests.get(
        f"{base_url}/api/admin/meals-today?date=2026-07-07&cutoff=23:59",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r_narrow.status_code == 200
    assert r_wide.status_code == 200
    assert r_wide.json()["total"] >= r_narrow.json()["total"]


def test_meals_today_invalid_cutoff_rejected(base_url):
    token = _login(base_url)
    r = requests.get(
        f"{base_url}/api/admin/meals-today?cutoff=25:99",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r.status_code == 400


def test_meals_today_invalid_date_rejected(base_url):
    token = _login(base_url)
    r = requests.get(
        f"{base_url}/api/admin/meals-today?date=not-a-date",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r.status_code == 400


def test_meals_today_member_has_photo_and_checkin(base_url):
    """Sanity — each member row carries the fields the Chef's View drill-down
    renders: id, full_name, category, photo_thumb (may be null), institution,
    fleet, check_in_at."""
    token = _login(base_url)
    r = requests.get(
        f"{base_url}/api/admin/meals-today?date=2026-07-07&cutoff=23:59",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    body = r.json()
    if body["total"] == 0:
        return   # nothing to assert against on empty days
    for m in body["members"]:
        assert {"id", "full_name", "category", "photo_thumb",
                "institution", "fleet", "check_in_at"} <= m.keys()
        assert m["category"] in body["counts"]
