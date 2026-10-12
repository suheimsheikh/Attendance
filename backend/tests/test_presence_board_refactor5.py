"""Refactor #5 regression — GET /api/presence Presence Board moved to
routes/presence_board.py. Confirms contract + historical determinism +
sibling ephemeral presence endpoints still work.
"""
import os
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
ADMIN_EMAIL = "admin@attendance.app"
ADMIN_PASSWORD = os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345")


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={
        "email": ADMIN_EMAIL, "password": ADMIN_PASSWORD,
    }, timeout=30)
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text[:200]}"
    tok = r.json().get("token") or r.json().get("access_token")
    assert tok, f"no token in login response: {r.json()}"
    return tok


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


# ---- Live Presence Board shape ----

def test_presence_live_contract(admin_headers):
    r = requests.get(f"{BASE_URL}/api/presence", headers=admin_headers, timeout=60)
    assert r.status_code == 200, r.text[:300]
    d = r.json()
    for key in ("members", "counts", "by_location", "date", "is_historical",
                "admin_contacts", "notify_grace_minutes", "escorts_present"):
        assert key in d, f"missing key {key} in live presence"
    assert d["is_historical"] is False
    assert isinstance(d["members"], list)
    assert isinstance(d["escorts_present"], list)
    assert isinstance(d["admin_contacts"], list)
    assert isinstance(d["notify_grace_minutes"], int)


def test_presence_counts_sum_to_total(admin_headers):
    r = requests.get(f"{BASE_URL}/api/presence", headers=admin_headers, timeout=60)
    c = r.json()["counts"]
    total = c["total"]
    bucket_sum = (c["on_campus"] + c["temp_out"] + c["exited"] + c["on_tour"]
                  + c["on_leave"] + c["absent"] + c["not_due"])
    assert bucket_sum == total, f"buckets {bucket_sum} != total {total}"
    # late is a subset counter, not additive
    assert c["late"] <= c["on_campus"] + c["temp_out"]


def test_presence_member_keys_and_null_site_for_off_status(admin_headers):
    r = requests.get(f"{BASE_URL}/api/presence", headers=admin_headers, timeout=60)
    members = r.json()["members"]
    required = {"status", "detail", "site_id", "site_name", "geo_in", "geo_out",
                "notify_due", "excursions", "days_absent_streak"}
    for m in members[:50]:
        missing = required - set(m.keys())
        assert not missing, f"member missing keys {missing}"
    # Off-status rows must have null site_id and site_name
    off_statuses = {"on_tour", "on_leave", "absent", "exited", "not_due"}
    for m in members:
        if m["status"] in off_statuses:
            assert m["site_id"] is None, f"{m['status']} row has site_id={m['site_id']}"
            assert m["site_name"] is None, f"{m['status']} row has site_name={m['site_name']}"


def test_presence_by_location_only_present(admin_headers):
    r = requests.get(f"{BASE_URL}/api/presence", headers=admin_headers, timeout=60)
    d = r.json()
    present_count = d["counts"]["on_campus"] + d["counts"]["temp_out"]
    bl = d["by_location"]
    assert isinstance(bl, list)
    agg = 0
    for b in bl:
        assert set(b.keys()) >= {"site_id", "site_name", "count", "by_category"}
        agg += b["count"]
    assert agg == present_count, f"by_location sum {agg} != present {present_count}"


# ---- Historical determinism ----

def test_presence_historical_shape_and_determinism(admin_headers):
    url = f"{BASE_URL}/api/presence?on=2026-09-15"
    r1 = requests.get(url, headers=admin_headers, timeout=60)
    r2 = requests.get(url, headers=admin_headers, timeout=60)
    assert r1.status_code == 200 and r2.status_code == 200
    d1, d2 = r1.json(), r2.json()
    assert d1["is_historical"] is True
    assert d1["date"] == "2026-09-15"
    assert d1["escorts_present"] == []
    assert d1 == d2, "historical presence not byte-identical across calls"


# ---- Sibling ephemeral presence endpoints must still work ----

def test_presence_public_no_auth():
    r = requests.get(f"{BASE_URL}/api/presence/public", timeout=15)
    assert r.status_code == 200, r.text[:200]
    d = r.json()
    assert "count" in d and "users" in d
    assert isinstance(d["users"], list)


def test_presence_ping_and_online(admin_headers):
    r = requests.post(f"{BASE_URL}/api/presence/ping", headers=admin_headers,
                      json={"where": "regression-test"}, timeout=15)
    assert r.status_code == 200, r.text[:200]
    assert r.json().get("ok") is True
    r2 = requests.get(f"{BASE_URL}/api/presence/online", headers=admin_headers, timeout=15)
    assert r2.status_code == 200
    assert "users" in r2.json()


# ---- Admin dashboard mirror ----

def test_admin_dashboard_on_campus_by_location(admin_headers):
    r = requests.get(f"{BASE_URL}/api/admin/dashboard", headers=admin_headers, timeout=60)
    assert r.status_code == 200, r.text[:200]
    now = r.json().get("now") or {}
    assert "on_campus_by_location" in now, f"missing on_campus_by_location in dashboard.now: {list(now.keys())}"
    assert isinstance(now["on_campus_by_location"], list)
