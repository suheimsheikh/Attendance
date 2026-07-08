"""Iter-18 review tests for the single-glance admin dashboard.

Covers:
- Non-admin rejection of GET /api/admin/dashboard
- Cross-check invariants (attention.pending_leaves == now.pending_approvals.leaves)
- Regression smoke: key admin pages (members, approvals, reports) still 200
"""
from __future__ import annotations

import os
import uuid
import requests

import pytest


def _base_url():
    b = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
    if b:
        return b
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("REACT_APP_BACKEND_URL"):
                return line.split("=", 1)[1].strip().strip('"').rstrip("/")
    raise RuntimeError("REACT_APP_BACKEND_URL not configured")


BASE_URL = _base_url()


def _admin_token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={
            "email": os.environ.get("TEST_ADMIN_EMAIL", "admin@attendance.app"),
            "password": os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345"),
        },
        timeout=30,
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


# ── /api/admin/dashboard non-admin rejection ────────────────────────────────
@pytest.mark.slow
def test_dashboard_rejects_non_admin_token():
    """Create a member (non-admin) via admin, login as that member, ensure
    /admin/dashboard is forbidden."""
    admin = _admin_token()
    email = f"test.dash.{uuid.uuid4().hex[:6]}@example.com"
    pw = "Test@12345"
    r = requests.post(
        f"{BASE_URL}/api/members",
        headers={"Authorization": f"Bearer {admin}"},
        json={
            "email": email,
            "password": pw,
            "full_name": "TEST Dashboard Non-Admin",
            "role": "member",
            "category": "athlete",
        },
        timeout=30,
    )
    assert r.status_code == 200, r.text
    member_id = r.json().get("id")

    login = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": email, "password": pw},
        timeout=30,
    )
    assert login.status_code == 200, login.text
    member_token = login.json()["access_token"]

    dash = requests.get(
        f"{BASE_URL}/api/admin/dashboard",
        headers={"Authorization": f"Bearer {member_token}"},
        timeout=30,
    )
    assert dash.status_code in (401, 403), (
        f"expected 401/403 for non-admin, got {dash.status_code}: {dash.text}"
    )

    # Cleanup — best-effort
    try:
        requests.delete(
            f"{BASE_URL}/api/members/{member_id}",
            headers={"Authorization": f"Bearer {admin}"},
            timeout=15,
        )
    except Exception:
        pass


# ── Deeper invariants on dashboard payload ─────────────────────────────────
def test_dashboard_invariants_deep():
    token = _admin_token()
    r = requests.get(
        f"{BASE_URL}/api/admin/dashboard",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r.status_code == 200
    body = r.json()

    now = body["now"]
    week = body["week"]
    month = body["month"]
    att = body["attention"]

    # on_campus_total == sum of category buckets
    cat = now["on_campus_by_category"]
    assert now["on_campus_total"] == sum(cat.values())

    # 4 required categories
    for k in ("athlete", "coach", "staff", "executive"):
        assert k in cat and isinstance(cat[k], int) and cat[k] >= 0

    # non-negative int counters in now
    for k in ("late_today", "absent_athletes_today", "guests_present",
             "escorts_present"):
        assert isinstance(now[k], int) and now[k] >= 0

    # sparkline exact 7 datapoints with monotonically increasing dates
    dates = [p["date"] for p in week["sparkline"]]
    assert dates == sorted(dates)
    assert len(dates) == 7

    # cross-checks
    pa = now["pending_approvals"]
    assert att["pending_leaves"] == pa["leaves"]
    assert att["pending_overtime"] == pa["overtime"]
    assert att["pending_devices"] == pa["devices"]

    # month values sane
    for k in ("staff_hours", "ot_hours", "leave_days_consumed"):
        assert isinstance(month[k], (int, float)) and month[k] >= 0

    # attention counters
    for k in ("pending_leaves", "pending_overtime", "pending_devices",
             "stale_sessions", "athletes_no_parent_contact"):
        assert isinstance(att[k], int) and att[k] >= 0


# ── Regression: existing admin pages still 200 ─────────────────────────────
def test_regression_admin_endpoints_ok():
    token = _admin_token()
    hdrs = {"Authorization": f"Bearer {token}"}
    endpoints = [
        "/api/members",
        "/api/leaves?status=pending",
        "/api/admin/devices",
        "/api/reports/daily",
    ]
    for ep in endpoints:
        r = requests.get(f"{BASE_URL}{ep}", headers=hdrs, timeout=30)
        assert r.status_code == 200, f"{ep} -> {r.status_code}: {r.text[:200]}"
