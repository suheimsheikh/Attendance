"""Tests for meals red-flag day-flags endpoint, meal-calendar totals, and wages backfill."""
import os
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://attendance-portal-56.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "admin@attendance.app"
ADMIN_PASSWORD = "Admin@12345"


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=30)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    data = r.json()
    tok = data.get("token") or data.get("access_token")
    assert tok, f"no token: {data}"
    return tok


@pytest.fixture(scope="module")
def h(token):
    return {"Authorization": f"Bearer {token}"}


def test_day_flags_2026_08_15(h):
    r = requests.get(f"{API}/meals/day-flags", params={"date": "2026-08-15"}, headers=h, timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    flags = data.get("flags") or []
    codes = {f.get("code") for f in flags}
    # main agent said expected: no_headcount, issue_no_price, negative_stock
    assert any(c in codes for c in ["no_headcount", "issue_no_price", "negative_stock"]), f"got codes={codes}"
    sevs = {f.get("severity") for f in flags}
    assert sevs & {"high", "medium"}, f"expected high/medium sev, got {sevs}"


def test_meal_calendar_totals_and_flags(h):
    r = requests.get(f"{API}/meals/meal-calendar", params={"start": "2026-06-01", "end": "2026-09-30"}, headers=h, timeout=60)
    assert r.status_code == 200, r.text
    data = r.json()
    totals = data.get("totals") or {}
    for k in ["main_meals", "cost_per_athlete_day", "athlete_days", "issue_cost_per_meal_incl_wages"]:
        assert k in totals, f"missing totals key {k}: {list(totals.keys())}"
    rows = data.get("rows") or data.get("days") or []
    assert rows, "empty rows"
    # per-day rows should have flags array
    sample = rows[0]
    assert "flags" in sample, f"row missing flags: {list(sample.keys())}"


def test_meal_calendar_wages_75000_per_month(h):
    r = requests.get(f"{API}/meals/meal-calendar", params={"start": "2026-06-01", "end": "2026-09-30"}, headers=h, timeout=60)
    assert r.status_code == 200
    data = r.json()
    months = data.get("months") or data.get("month_subtotals") or []
    # Try to find monthly subtotals - print structure if not matching
    if not months:
        # fallback: sum wages per month from rows
        rows = data.get("rows") or data.get("days") or []
        from collections import defaultdict
        wage_by_month = defaultdict(float)
        for r_ in rows:
            d = r_.get("date", "")
            m = d[:7]
            wage_by_month[m] += float(r_.get("wage_cost", 0) or r_.get("wages", 0) or r_.get("wage", 0) or 0)
        for month in ["2026-06", "2026-07", "2026-08", "2026-09"]:
            assert abs(wage_by_month.get(month, 0) - 75000) < 1, f"month {month} wages={wage_by_month.get(month)}"
    else:
        got = {m.get("month") or m.get("ym"): float(m.get("wages", 0) or m.get("wage", 0) or 0) for m in months}
        for mm in ["2026-06", "2026-07", "2026-08", "2026-09"]:
            assert abs(got.get(mm, 0) - 75000) < 1, f"month {mm} wages={got.get(mm)} all={got}"


def test_cost_per_athlete_day_is_3x_cost_per_meal(h):
    r = requests.get(f"{API}/meals/meal-calendar", params={"start": "2026-06-01", "end": "2026-09-30"}, headers=h, timeout=60)
    data = r.json()
    totals = data.get("totals") or {}
    per_meal = float(totals.get("issue_cost_per_meal_incl_wages") or 0)
    per_ath = float(totals.get("cost_per_athlete_day") or 0)
    if per_meal > 0:
        assert abs(per_ath - 3 * per_meal) < 0.5, f"per_ath={per_ath} per_meal={per_meal}"
