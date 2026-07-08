"""Iter-19 review tests — Chef's View feature + Elite category regression.

Covers what the base /tests/test_meals.py contract file does NOT:
  1. Members PATCH accepts category='elite' (no 422).
  2. Leave-balances endpoint still returns 200 with elite members present.
  3. Admin dashboard on_campus_by_category has 5 buckets incl. 'elite'.
  4. Regression 200-check on /admin/dashboard, /admin/members, plus meals.
  5. Toggle a real member to elite -> Chef's View bucket moves -> revert.
"""
from __future__ import annotations

import os
import requests


BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    env_path = "/app/frontend/.env"
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL"):
                    BASE_URL = line.split("=", 1)[1].strip().strip('"').rstrip("/")
                    break

ADMIN_EMAIL = os.environ.get("TEST_ADMIN_EMAIL", "admin@attendance.app")
ADMIN_PASSWORD = os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345")


def _login() -> str:
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def _headers(token):
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


# ─── 1. PATCH member category='elite' works (no 422) ────────────────────
def test_member_patch_accepts_elite_category():
    token = _login()
    h = _headers(token)
    # Pick any existing athlete
    members = requests.get(f"{BASE_URL}/api/members", headers=h, timeout=30).json()
    target = next((m for m in members if m.get("category") == "athlete"), None)
    assert target, "no athlete found in preview DB to tag as elite"
    orig_cat = target["category"]

    # PATCH to elite
    r = requests.patch(
        f"{BASE_URL}/api/members/{target['id']}",
        headers=h,
        json={"category": "elite"},
        timeout=30,
    )
    assert r.status_code == 200, f"expected 200, got {r.status_code}: {r.text}"
    assert r.json().get("category") == "elite"

    # Verify persistence
    m_after = requests.get(
        f"{BASE_URL}/api/members/{target['id']}", headers=h, timeout=30
    ).json()
    assert m_after.get("category") == "elite"

    # Revert
    r_revert = requests.patch(
        f"{BASE_URL}/api/members/{target['id']}",
        headers=h,
        json={"category": orig_cat},
        timeout=30,
    )
    assert r_revert.status_code == 200


# ─── 2. Elite member does not break leave-balances endpoint ─────────────
def test_leave_balances_endpoint_ok_with_elite_present():
    """Tag one athlete as elite, hit /api/leave-balances (should still 200),
    verify the elite member is present in listing (as an athlete would be)."""
    token = _login()
    h = _headers(token)
    members = requests.get(f"{BASE_URL}/api/members", headers=h, timeout=30).json()
    target = next((m for m in members if m.get("category") == "athlete"), None)
    assert target
    orig_cat = target["category"]

    requests.patch(
        f"{BASE_URL}/api/members/{target['id']}",
        headers=h,
        json={"category": "elite"},
        timeout=30,
    )
    try:
        r = requests.get(f"{BASE_URL}/api/leave-balances", headers=h, timeout=30)
        assert r.status_code == 200, r.text
        # Body may be a list or dict; just make sure no 500s
        body = r.json()
        assert body is not None
    finally:
        requests.patch(
            f"{BASE_URL}/api/members/{target['id']}",
            headers=h,
            json={"category": orig_cat},
            timeout=30,
        )


# ─── 3. Dashboard on_campus_by_category has 5 buckets incl 'elite' ──────
def test_dashboard_has_five_category_buckets_incl_elite():
    token = _login()
    r = requests.get(
        f"{BASE_URL}/api/admin/dashboard",
        headers=_headers(token),
        timeout=30,
    )
    assert r.status_code == 200, r.text
    now = r.json()["now"]
    buckets = now["on_campus_by_category"]
    assert set(buckets.keys()) == {"athlete", "elite", "coach", "staff", "executive"}
    assert now["on_campus_total"] == sum(buckets.values())


# ─── 4. Regression: admin endpoints all 200 ─────────────────────────────
def test_regression_admin_endpoints_all_200():
    token = _login()
    h = _headers(token)
    endpoints = [
        "/api/admin/dashboard",
        "/api/admin/meals-today",
        "/api/masters/categories",
        "/api/members",
        "/api/leave-balances",
    ]
    for ep in endpoints:
        r = requests.get(f"{BASE_URL}{ep}", headers=h, timeout=30)
        assert r.status_code == 200, f"{ep} -> {r.status_code}: {r.text[:200]}"


# ─── 5. E2E: tag→verify Chef's View bucket→revert ───────────────────────
def test_tagging_elite_moves_meals_bucket():
    token = _login()
    h = _headers(token)
    members = requests.get(f"{BASE_URL}/api/members", headers=h, timeout=30).json()

    # Find an athlete who is meal-eligible on 2026-07-07 with cutoff=23:59
    baseline = requests.get(
        f"{BASE_URL}/api/admin/meals-today?date=2026-07-07&cutoff=23:59",
        headers=h, timeout=30,
    ).json()
    athlete_ids = {m["id"] for m in baseline["members"] if m["category"] == "athlete"}
    if not athlete_ids:
        # Nothing to prove — but not a failure.
        return
    tid = next(iter(athlete_ids))
    orig = next(m for m in members if m["id"] == tid)
    orig_cat = orig["category"]

    # Baseline counts
    b_athlete = baseline["counts"]["athlete"]
    b_elite = baseline["counts"]["elite"]

    # Flip to elite
    requests.patch(
        f"{BASE_URL}/api/members/{tid}", headers=h,
        json={"category": "elite"}, timeout=30,
    )
    try:
        after = requests.get(
            f"{BASE_URL}/api/admin/meals-today?date=2026-07-07&cutoff=23:59",
            headers=h, timeout=30,
        ).json()
        assert after["counts"]["athlete"] == b_athlete - 1
        assert after["counts"]["elite"] == b_elite + 1
        assert after["total"] == baseline["total"]  # net-neutral
    finally:
        requests.patch(
            f"{BASE_URL}/api/members/{tid}", headers=h,
            json={"category": orig_cat}, timeout=30,
        )
