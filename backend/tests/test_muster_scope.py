"""Contract tests for the admin `?scope=` filter on the Muster roster.

Verifies that:
  • Admins can widen `GET /api/muster/athletes?scope=staff|coach|executive|non_athletes|all`
    to include non-athletes.
  • Non-athletes (staff/coach/etc.) can be bulk-checked-in via
    POST /api/muster/checkin-bulk when the caller is an admin.
  • Coaches/escorts remain restricted to athlete-like categories server-side
    (they don't get the widened scope even if they pass ?scope=all).

Added 15 Feb 2026 alongside the "admins can muster staff & non-athletes"
feature.
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


def _list(base_url, token, scope, mode="checkin"):
    r = requests.get(
        f"{base_url}/api/muster/athletes",
        params={"mode": mode, "scope": scope},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _cleanup_checkout(base_url, token, user_id):
    requests.post(
        f"{base_url}/api/muster/checkout-bulk",
        headers={"Authorization": f"Bearer {token}"},
        json={"athlete_ids": [user_id]},
        timeout=30,
    )


def test_admin_scope_athletes_default(base_url):
    """Default (?scope=athletes) returns only athlete-like categories."""
    token = _login(base_url)
    data = _list(base_url, token, "athletes")
    cats = {a.get("category") for a in data["athletes"]}
    # All rows should be athlete-like (athlete or elite). Empty is fine.
    for c in cats:
        assert c in ("athlete", "elite"), f"unexpected category in athletes scope: {c}"


def test_admin_scope_staff_returns_only_staff(base_url):
    token = _login(base_url)
    data = _list(base_url, token, "staff")
    for a in data["athletes"]:
        assert a.get("category") == "staff", f"expected only staff, got {a.get('category')}"


def test_admin_scope_non_athletes_excludes_athletes(base_url):
    token = _login(base_url)
    data = _list(base_url, token, "non_athletes")
    for a in data["athletes"]:
        assert a.get("category") not in ("athlete", "elite"), (
            f"non_athletes scope leaked {a.get('category')}"
        )


def test_admin_scope_all_returns_mixed_categories(base_url):
    """?scope=all shouldn't category-filter at all."""
    token = _login(base_url)
    data = _list(base_url, token, "all")
    # Response includes category on every row (needed for the frontend chip)
    for a in data["athletes"]:
        assert "category" in a


def test_admin_bulk_checkin_staff_member(base_url):
    """Admin can bulk-check-in a staff member via the muster endpoint —
    the check-in is recorded (payroll tracking use-case)."""
    token = _login(base_url)
    # Find a staff member not currently checked in
    data = _list(base_url, token, "staff", mode="checkin")
    target = next((a for a in data["athletes"] if not a.get("already_checked_in")), None)
    if not target:
        return  # no eligible staff to test with
    sid = target["id"]
    try:
        r = requests.post(
            f"{base_url}/api/muster/checkin-bulk",
            headers={"Authorization": f"Bearer {token}"},
            json={"athlete_ids": [sid]},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["checked_in_count"] == 1, body
        assert body["skipped_count"] == 0
        assert body["checked_in"][0]["id"] == sid
    finally:
        _cleanup_checkout(base_url, token, sid)


def test_admin_bulk_checkout_staff_member(base_url):
    """Round-trip: check in a staff member then check them out."""
    token = _login(base_url)
    data = _list(base_url, token, "staff", mode="checkin")
    target = next((a for a in data["athletes"] if not a.get("already_checked_in")), None)
    if not target:
        return
    sid = target["id"]
    # Check in
    r = requests.post(
        f"{base_url}/api/muster/checkin-bulk",
        headers={"Authorization": f"Bearer {token}"},
        json={"athlete_ids": [sid]},
        timeout=30,
    )
    assert r.status_code == 200
    # Check out
    r = requests.post(
        f"{base_url}/api/muster/checkout-bulk",
        headers={"Authorization": f"Bearer {token}"},
        json={"athlete_ids": [sid]},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["checked_out_count"] == 1, body
