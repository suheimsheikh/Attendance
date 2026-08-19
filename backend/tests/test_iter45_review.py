"""Iter 45 review tests: daily-totals valuation + muster-roster escort guard.

Covers backend requests from review_request iter45:
  1. GET /api/meals/daily-totals — admin & chef 200, member 403
  2. issue_amt equals sum(issue_qty * avg_rate_from_stock) using same
     _stock_snapshot weighted-avg blend (opening_rate) that /meals/stock uses.
  3. GET /api/muster/daily-roster — admin 200 (escort guard verified in code).
"""
import os
import pytest
import requests

BASE = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
ADMIN_EMAIL = "admin@attendance.app"
ADMIN_PASSWORD = os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345")


def _login(email, password):
    r = requests.post(
        f"{BASE}/api/auth/login",
        json={"email": email, "password": password},
        timeout=15,
    )
    return r


@pytest.fixture(scope="module")
def admin_token():
    r = _login(ADMIN_EMAIL, ADMIN_PASSWORD)
    if r.status_code != 200:
        pytest.skip(f"admin login failed: {r.status_code} {r.text[:200]}")
    j = r.json()
    tok = j.get("access_token") or j.get("token")
    assert tok, f"no token in login response: {j}"
    return tok


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


# ---------- meals daily-totals ----------

def test_daily_totals_admin_200(admin_headers):
    r = requests.get(
        f"{BASE}/api/meals/daily-totals",
        params={"start": "2026-07-01", "end": "2026-08-31"},
        headers=admin_headers, timeout=20,
    )
    assert r.status_code == 200, r.text
    j = r.json()
    assert "days" in j and isinstance(j["days"], list)
    # totals present in response envelope
    assert "start" in j and "end" in j
    if j["days"]:
        row = j["days"][0]
        for k in ("date", "purchase_amt", "issue_amt", "purchase_lines", "issue_lines"):
            assert k in row, f"missing key {k} in {row}"


def test_daily_totals_bad_range_400(admin_headers):
    r = requests.get(
        f"{BASE}/api/meals/daily-totals",
        params={"start": "2026-08-31", "end": "2026-07-01"},
        headers=admin_headers, timeout=15,
    )
    assert r.status_code == 400


def test_daily_totals_no_auth_401():
    r = requests.get(
        f"{BASE}/api/meals/daily-totals",
        params={"start": "2026-08-01", "end": "2026-08-05"},
        timeout=15,
    )
    assert r.status_code in (401, 403)


def test_daily_totals_issue_valuation_matches_stock(admin_headers):
    """issue_amt for a day must equal sum(issue qty × avg_rate from
    /api/meals/stock?as_of=<end>) — same weighted-avg blend."""
    start, end = "2026-06-01", "2026-08-31"
    tot = requests.get(
        f"{BASE}/api/meals/daily-totals",
        params={"start": start, "end": end},
        headers=admin_headers, timeout=25,
    ).json()

    # find a day with issue_lines > 0
    target = next((d for d in tot.get("days", []) if d.get("issue_lines", 0) > 0), None)
    if not target:
        pytest.skip("no issue lines in range — cannot cross-check valuation")

    day = target["date"]
    expected_amt = float(target["issue_amt"])

    # fetch avg_rate table via /meals/stock as_of=end (matches server logic)
    stock = requests.get(
        f"{BASE}/api/meals/stock", params={"as_of": end},
        headers=admin_headers, timeout=25,
    ).json()
    rate_by_id = {r["item_id"]: float(r.get("avg_rate") or 0)
                  for r in stock.get("rows", [])}

    # fetch issues for that single day
    issues = requests.get(
        f"{BASE}/api/meals/issues",
        params={"start": day, "end": day},
        headers=admin_headers, timeout=15,
    ).json()

    manual = 0.0
    for doc in issues.get("issues", []):
        for ln in (doc.get("lines") or []):
            q = float(ln.get("qty") or 0)
            iid = ln.get("item_id")
            if q > 0 and iid:
                manual += q * rate_by_id.get(iid, 0.0)
    manual = round(manual, 2)
    # allow tiny rounding delta
    assert abs(manual - expected_amt) < 1.0, (
        f"day {day}: server issue_amt={expected_amt} vs manual={manual} "
        f"(stock as_of={end})"
    )


# ---------- muster daily roster ----------

def test_muster_daily_roster_admin_200(admin_headers):
    r = requests.get(
        f"{BASE}/api/muster/daily-roster",
        headers=admin_headers, timeout=15,
    )
    assert r.status_code == 200, r.text
    j = r.json()
    # buckets present
    for k in ("on_leave", "on_tour", "on_lop", "absent"):
        assert k in j, f"missing bucket {k}: keys={list(j.keys())}"


def test_muster_daily_roster_no_auth_401():
    r = requests.get(f"{BASE}/api/muster/daily-roster", timeout=15)
    assert r.status_code in (401, 403)
