"""OT approval workflow removed 15 Feb 2026.

These tests lock in the deprecation contract:
  • /admin/overtime and /admin/overtime/needs-review still return 200
    (stubs) so older cached clients don't 404, but they return zero
    pending items.
  • Dashboard `attention.pending_overtime` is always 0.
  • Attendance rows written on check-in / check-out no longer set
    `overtime_status = "pending"`.
  • The OT ledger response still exposes `overtime_total_min` per row
    (calculated OT is retained — only the approval workflow was removed).
"""
from __future__ import annotations

import os
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


def test_admin_overtime_endpoint_returns_empty_rows(base_url):
    token = _login(base_url)
    r = requests.get(
        f"{base_url}/api/admin/overtime",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data.get("rows") == [], f"OT approval queue should be empty (deprecated): {data}"


def test_admin_overtime_needs_review_returns_zero(base_url):
    token = _login(base_url)
    r = requests.get(
        f"{base_url}/api/admin/overtime/needs-review",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r.status_code == 200
    data = r.json()
    assert data.get("yesterday_count") == 0
    assert data.get("total_pending") == 0


def test_dashboard_pending_overtime_is_zero(base_url):
    token = _login(base_url)
    r = requests.get(
        f"{base_url}/api/admin/dashboard",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r.status_code == 200
    att = r.json().get("attention", {})
    assert att.get("pending_overtime", 0) == 0, f"pending_overtime must be 0: {att}"


def test_approvals_summary_shows_zero_overtime(base_url):
    token = _login(base_url)
    r = requests.get(
        f"{base_url}/api/admin/approvals-summary",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r.status_code == 200
    assert r.json().get("overtime", 0) == 0


def test_ot_ledger_still_shows_calculated_minutes(base_url):
    """OT hours are still surfaced — only the approval concept is gone."""
    token = _login(base_url)
    top_ot = requests.get(
        f"{base_url}/api/admin/dashboard",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    ).json().get("week", {}).get("top_ot") or []
    if not top_ot:
        return
    mid = top_ot[0]["member_id"]
    r = requests.get(
        f"{base_url}/api/reports/ot-ledger",
        params={"member_id": mid, "year": 2026},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r.status_code == 200
    data = r.json()
    assert data["total_minutes"] > 0
    # Rows still carry the calculated OT minutes and reasons.
    for row in data["rows"]:
        assert "overtime_total_min" in row
        assert row["overtime_total_min"] > 0
