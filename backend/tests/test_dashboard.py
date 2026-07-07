"""Contract tests for GET /api/admin/dashboard.

Exercises the aggregator endpoint that powers the single-glance
`/admin/dashboard` page. Uses the live preview backend via the
`base_url` fixture, matching the style of test_smoke_flows.py.
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


def test_dashboard_requires_auth(base_url):
    r = requests.get(f"{base_url}/api/admin/dashboard", timeout=30)
    assert r.status_code in (401, 403)


def test_dashboard_rejects_bogus_token(base_url):
    r = requests.get(
        f"{base_url}/api/admin/dashboard",
        headers={"Authorization": "Bearer not-a-real-token"},
        timeout=30,
    )
    assert r.status_code in (401, 403)


def test_dashboard_payload_shape(base_url):
    token = _login(base_url)
    r = requests.get(
        f"{base_url}/api/admin/dashboard",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    body = r.json()

    for key in ("generated_at", "today", "now", "week", "month", "attention"):
        assert key in body, f"missing top-level key: {key}"

    # Now block
    now = body["now"]
    assert set(now.keys()) >= {
        "on_campus_total", "on_campus_by_category", "late_today",
        "absent_athletes_today", "guests_present", "escorts_present",
        "pending_approvals",
    }
    assert set(now["on_campus_by_category"].keys()) >= {
        "athlete", "coach", "staff", "executive",
    }
    pa = now["pending_approvals"]
    assert set(pa.keys()) >= {"leaves", "overtime", "devices", "total"}
    assert pa["total"] == pa["leaves"] + pa["overtime"] + pa["devices"]

    # Week block — sparkline must be 7 days
    week = body["week"]
    assert set(week.keys()) >= {
        "start_date", "end_date", "sparkline", "top_late",
        "birthdays", "events",
    }
    assert len(week["sparkline"]) == 7
    for pt in week["sparkline"]:
        assert {"date", "athletes", "staff"} <= pt.keys()
        assert isinstance(pt["athletes"], int) and pt["athletes"] >= 0
        assert isinstance(pt["staff"], int) and pt["staff"] >= 0
    # top_late ordering — non-increasing by late_days
    lds = [m["late_days"] for m in week["top_late"]]
    assert lds == sorted(lds, reverse=True)

    # Month block
    month = body["month"]
    assert set(month.keys()) >= {
        "start_date", "end_date", "staff_hours", "ot_hours",
        "leave_days_consumed", "new_members",
    }
    for k in ("staff_hours", "ot_hours", "leave_days_consumed"):
        assert isinstance(month[k], (int, float)) and month[k] >= 0
    assert isinstance(month["new_members"], int) and month["new_members"] >= 0

    # Attention block — all ints, all non-negative
    att = body["attention"]
    for k in ("pending_leaves", "pending_overtime", "pending_devices",
              "stale_sessions", "athletes_no_parent_contact"):
        assert k in att, f"missing attention.{k}"
        assert isinstance(att[k], int) and att[k] >= 0

    # Cross-check: attention.pending_leaves == now.pending_approvals.leaves
    assert att["pending_leaves"] == pa["leaves"]
    assert att["pending_overtime"] == pa["overtime"]
    assert att["pending_devices"] == pa["devices"]
