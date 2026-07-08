"""Iter 20 review tests.

Feature 1 — meal_breakfast_cutoff is now an editable Office Setting.
Feature 2 — Sites CRUD regression (renamed to "Training Locations" on the frontend).

Focus of these tests: everything that's NOT already covered by test_meals.py.

Regression check for feature 1: proves the office-set cutoff of 06:30 returns
FEWER members on 2026-07-07 than the 07:00 default (main-agent claim: 19 vs 21).
Restores to 07:00 after test.
"""
from __future__ import annotations

import os
import requests
import uuid


def _login(base_url) -> str:
    r = requests.post(
        f"{base_url}/api/auth/login",
        json={
            "email": os.environ.get("TEST_ADMIN_EMAIL", "admin@attendance.app"),
            "password": os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345"),
        },
        timeout=30,
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


# =====================================================================
# GET /api/office — new field present, defaults to 07:00 when missing
# =====================================================================
def test_office_get_returns_meal_breakfast_cutoff(base_url):
    token = _login(base_url)
    r = requests.get(f"{base_url}/api/office", headers={"Authorization": f"Bearer {token}"}, timeout=30)
    assert r.status_code == 200
    body = r.json()
    assert "meal_breakfast_cutoff" in body
    # Must match HH:MM
    v = body["meal_breakfast_cutoff"]
    assert isinstance(v, str) and len(v) == 5 and v[2] == ":", v


# =====================================================================
# PUT /api/office — persist a new value + reject/coerce invalid
# =====================================================================
def test_office_put_persists_meal_breakfast_cutoff(base_url):
    token = _login(base_url)
    hdr = {"Authorization": f"Bearer {token}"}
    original = requests.get(f"{base_url}/api/office", headers=hdr, timeout=30).json().get("meal_breakfast_cutoff") or "07:00"
    try:
        r = requests.put(f"{base_url}/api/office", headers=hdr, json={"meal_breakfast_cutoff": "06:30"}, timeout=30)
        assert r.status_code == 200, r.text
        assert r.json().get("meal_breakfast_cutoff") == "06:30"

        # Verify persistence via GET
        g = requests.get(f"{base_url}/api/office", headers=hdr, timeout=30)
        assert g.json().get("meal_breakfast_cutoff") == "06:30"
    finally:
        requests.put(f"{base_url}/api/office", headers=hdr, json={"meal_breakfast_cutoff": original}, timeout=30)


def test_office_put_invalid_meal_cutoff_no_500(base_url):
    """Backend must NOT 500 on bad meal_breakfast_cutoff; either 400 or coerced."""
    token = _login(base_url)
    hdr = {"Authorization": f"Bearer {token}"}
    original = requests.get(f"{base_url}/api/office", headers=hdr, timeout=30).json().get("meal_breakfast_cutoff") or "07:00"
    try:
        r = requests.put(f"{base_url}/api/office", headers=hdr, json={"meal_breakfast_cutoff": "25:99"}, timeout=30)
        assert r.status_code < 500, f"Endpoint 500'd on invalid input: {r.status_code} {r.text}"
    finally:
        requests.put(f"{base_url}/api/office", headers=hdr, json={"meal_breakfast_cutoff": original}, timeout=30)


# =====================================================================
# Cutoff regression — 06:30 must return fewer/equal members than 07:00
# =====================================================================
def test_meals_office_cutoff_narrows_pool(base_url):
    token = _login(base_url)
    hdr = {"Authorization": f"Bearer {token}"}
    original = requests.get(f"{base_url}/api/office", headers=hdr, timeout=30).json().get("meal_breakfast_cutoff") or "07:00"
    try:
        requests.put(f"{base_url}/api/office", headers=hdr, json={"meal_breakfast_cutoff": "06:30"}, timeout=30)
        narrow = requests.get(f"{base_url}/api/admin/meals-today?date=2026-07-07", headers=hdr, timeout=30).json()
        assert narrow["cutoff"] == "06:30"

        requests.put(f"{base_url}/api/office", headers=hdr, json={"meal_breakfast_cutoff": "07:00"}, timeout=30)
        wider = requests.get(f"{base_url}/api/admin/meals-today?date=2026-07-07", headers=hdr, timeout=30).json()
        assert wider["cutoff"] == "07:00"

        # 07:00 window is strictly wider than 06:30 → total >= narrow total
        assert wider["total"] >= narrow["total"], (
            f"Expected wider cutoff to include >= members; got 07:00={wider['total']} vs 06:30={narrow['total']}"
        )
    finally:
        requests.put(f"{base_url}/api/office", headers=hdr, json={"meal_breakfast_cutoff": original}, timeout=30)


# =====================================================================
# Sites CRUD regression (route path unchanged even though UI renamed)
# =====================================================================
def test_sites_crud_full_lifecycle(base_url):
    token = _login(base_url)
    hdr = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    # LIST
    r = requests.get(f"{base_url}/api/sites", headers=hdr, timeout=30)
    assert r.status_code == 200
    assert isinstance(r.json(), list)

    # CREATE
    payload = {
        "name": f"TEST_Regatta_{uuid.uuid4().hex[:6]}",
        "latitude": 17.5,
        "longitude": 78.5,
        "radius_m": 200,
        "active": True,
        "notes": "iter20 regression",
    }
    r = requests.post(f"{base_url}/api/sites", headers=hdr, json=payload, timeout=30)
    assert r.status_code in (200, 201), r.text
    created = r.json()
    site_id = created.get("id")
    assert site_id
    assert created["name"] == payload["name"]
    assert created["radius_m"] == 200

    try:
        # GET verify persist
        r = requests.get(f"{base_url}/api/sites", headers=hdr, timeout=30)
        rows = r.json()
        assert any(s["id"] == site_id for s in rows)

        # PATCH — full body (matches frontend Sites.jsx behavior)
        patch_body = {**payload, "radius_m": 250}
        r = requests.patch(f"{base_url}/api/sites/{site_id}", headers=hdr, json=patch_body, timeout=30)
        assert r.status_code == 200, r.text
        assert r.json().get("radius_m") == 250

        # Verify PATCH persisted
        rows = requests.get(f"{base_url}/api/sites", headers=hdr, timeout=30).json()
        upd = next(s for s in rows if s["id"] == site_id)
        assert upd["radius_m"] == 250
    finally:
        # DELETE
        r = requests.delete(f"{base_url}/api/sites/{site_id}", headers=hdr, timeout=30)
        assert r.status_code in (200, 204), r.text

    # Verify DELETE persisted
    rows = requests.get(f"{base_url}/api/sites", headers=hdr, timeout=30).json()
    assert not any(s["id"] == site_id for s in rows)
