"""Ledgers should default to month-scoped windows (15 Feb 2026 user
request: "All ledgers should be restricted to the current month").

Verifies that:
  • /reports/ot-ledger, /reports/leave-ledger, /reports/comp-off-ledger
    all accept a `month=YYYY-MM` query param.
  • The month-scoped response returns fewer rows than the year-scoped
    response for the same member (when both are non-zero).
  • Backward compatibility: `year=YYYY` still works.
  • The response carries a `window_label` echoing the effective window.
"""
from __future__ import annotations

import os
from datetime import date
import requests


def _login(base_url) -> str:
    r = requests.post(
        f"{base_url}/api/auth/login",
        json={"email": os.environ.get("TEST_ADMIN_EMAIL", "admin@attendance.app"),
              "password": os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345")},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def _find_ot_member(base_url, token) -> str | None:
    """Pick any member with OT this year via the dashboard's top_ot list."""
    r = requests.get(
        f"{base_url}/api/admin/dashboard",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r.status_code == 200
    top_ot = r.json().get("week", {}).get("top_ot") or []
    return top_ot[0]["member_id"] if top_ot else None


def test_ot_ledger_accepts_month_and_returns_narrower_window(base_url):
    token = _login(base_url)
    mid = _find_ot_member(base_url, token)
    if not mid:
        return  # no OT anywhere → nothing to compare
    y = date.today().year
    m = f"{y}-{date.today().month:02d}"
    r_m = requests.get(
        f"{base_url}/api/reports/ot-ledger",
        params={"member_id": mid, "month": m},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    ).json()
    r_y = requests.get(
        f"{base_url}/api/reports/ot-ledger",
        params={"member_id": mid, "year": y},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    ).json()
    assert r_m.get("window_label") == m
    assert r_y.get("window_label") == str(y)
    assert len(r_m["rows"]) <= len(r_y["rows"])
    assert r_m["total_minutes"] <= r_y["total_minutes"]
    # Every row in the month response must be inside the month bounds.
    for row in r_m["rows"]:
        assert row["date"].startswith(m), f"row date {row['date']} escaped window {m}"


def test_leave_ledger_accepts_month_param(base_url):
    token = _login(base_url)
    # any member will do
    users = requests.get(
        f"{base_url}/api/members",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    ).json()
    mid = users[0]["id"]
    m = f"{date.today().year}-{date.today().month:02d}"
    r = requests.get(
        f"{base_url}/api/reports/leave-ledger",
        params={"member_id": mid, "month": m},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data.get("window_label") == m
    assert data.get("start", "").startswith(m)


def test_comp_off_ledger_accepts_month_param(base_url):
    token = _login(base_url)
    users = requests.get(
        f"{base_url}/api/members",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    ).json()
    mid = users[0]["id"]
    m = f"{date.today().year}-{date.today().month:02d}"
    r = requests.get(
        f"{base_url}/api/reports/comp-off-ledger",
        params={"member_id": mid, "month": m},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    assert r.json().get("window_label") == m


def test_ledger_endpoints_require_month_or_year(base_url):
    """Neither param → 400. Guards against silent full-history dumps."""
    token = _login(base_url)
    users = requests.get(
        f"{base_url}/api/members",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    ).json()
    mid = users[0]["id"]
    for path in ("ot-ledger", "leave-ledger", "comp-off-ledger"):
        r = requests.get(
            f"{base_url}/api/reports/{path}",
            params={"member_id": mid},
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        # FastAPI turns HTTPException into 400 status
        assert r.status_code == 400, f"{path} without year/month should 400: {r.status_code}"
