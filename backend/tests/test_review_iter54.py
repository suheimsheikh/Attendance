"""Backend tests for iteration 54: Rules sign-off + Elite DAR-required.

Covers:
- GET /api/rules returns version 2026-09, 25 rules, required=true for staff
- POST /api/rules/accept is idempotent
- GET /api/admin/rules/acceptances returns accepted/pending counts
- PATCH /api/members/{elite_id} {dar_required:true} then
  GET /api/admin/dar/missed?month=2026-09 includes that member;
  restore dar_required=false when done.
"""
import os
import pytest
import requests

BASE = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")

ADMIN_EMAIL = "admin@attendance.app"
ADMIN_PW = "Admin@12345"
STAFF_EMAIL = "dar.test@example.com"
STAFF_PW = "Dar@12345"


def _login(email, pw):
    r = requests.post(f"{BASE}/api/auth/login", json={"email": email, "password": pw})
    assert r.status_code == 200, f"login {email}: {r.status_code} {r.text}"
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def admin_token():
    return _login(ADMIN_EMAIL, ADMIN_PW)


@pytest.fixture(scope="module")
def staff_token():
    return _login(STAFF_EMAIL, STAFF_PW)


@pytest.fixture(scope="module")
def admin_h(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module")
def staff_h(staff_token):
    return {"Authorization": f"Bearer {staff_token}"}


# --- Rules ---
def test_rules_get_shape_and_required(staff_h):
    r = requests.get(f"{BASE}/api/rules", headers=staff_h)
    assert r.status_code == 200
    body = r.json()
    assert body.get("version") == "2026-09"
    sections = body.get("sections") or []
    total = sum(len(s.get("rules") or []) for s in sections)
    assert total == 25, f"Expected 25 rules total, got {total}"
    assert body.get("required") is True


def test_rules_accept_idempotent(staff_h):
    r1 = requests.post(f"{BASE}/api/rules/accept", headers=staff_h)
    assert r1.status_code == 200
    a1 = r1.json()
    assert a1.get("version") == "2026-09"
    assert "accepted_at" in a1
    r2 = requests.post(f"{BASE}/api/rules/accept", headers=staff_h)
    assert r2.status_code == 200
    a2 = r2.json()
    # idempotent: same record (same id, same accepted_at)
    assert a2.get("id") == a1.get("id")
    assert a2.get("accepted_at") == a1.get("accepted_at")


def test_admin_rules_acceptances(admin_h):
    r = requests.get(f"{BASE}/api/admin/rules/acceptances", headers=admin_h)
    assert r.status_code == 200
    body = r.json()
    assert body.get("version") == "2026-09"
    assert isinstance(body.get("rows"), list)
    assert isinstance(body.get("accepted"), int)
    assert isinstance(body.get("pending"), int)
    assert body["accepted"] + body["pending"] == len(body["rows"])


# --- Elite DAR-required ---
def _find_elite_member(admin_h):
    r = requests.get(f"{BASE}/api/members", headers=admin_h)
    assert r.status_code == 200, r.text
    members = r.json() if isinstance(r.json(), list) else r.json().get("members", [])
    for m in members:
        cat = (m.get("category") or "").lower()
        if cat in ("elite", "athlete") and m.get("status") != "left":
            return m
    return None


def test_patch_elite_dar_required_appears_in_missed(admin_h):
    elite = _find_elite_member(admin_h)
    if not elite:
        pytest.skip("No elite/athlete member available")
    mid = elite["id"]
    try:
        r = requests.patch(f"{BASE}/api/members/{mid}", json={"dar_required": True}, headers=admin_h)
        assert r.status_code in (200, 204), f"PATCH: {r.status_code} {r.text}"

        # verify persisted
        gr = requests.get(f"{BASE}/api/members/{mid}", headers=admin_h)
        if gr.status_code == 200:
            assert gr.json().get("dar_required") is True

        # missed report
        mr = requests.get(f"{BASE}/api/admin/dar/missed?month=2026-09", headers=admin_h)
        assert mr.status_code == 200, mr.text
        data = mr.json()
        rows = data.get("rows") or data.get("members") or data
        ids = []
        if isinstance(rows, list):
            ids = [r.get("member_id") or r.get("user_id") or r.get("id") for r in rows]
        assert mid in ids, f"elite {mid} not in missed rows; got {ids}"
    finally:
        # restore
        rr = requests.patch(f"{BASE}/api/members/{mid}", json={"dar_required": False}, headers=admin_h)
        assert rr.status_code in (200, 204)
