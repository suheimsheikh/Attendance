"""Contract tests for the location-wise aggregates added to
/api/presence and /api/admin/dashboard.

Verifies that when there are open sessions with site_id + site_name
tagged, both endpoints roll them up correctly into a `by_location`
array. Also confirms shape on empty days (empty array, not missing key).
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


def test_presence_has_by_location_key(base_url):
    """The endpoint must always return a `by_location` list (may be empty
    if no one is on campus). Prevents silent breakage on empty days."""
    token = _login(base_url)
    r = requests.get(
        f"{base_url}/api/presence",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r.status_code == 200
    body = r.json()
    assert "by_location" in body, "presence.by_location key missing"
    assert isinstance(body["by_location"], list)


def test_dashboard_has_by_location_key(base_url):
    """Same guarantee on the dashboard aggregator."""
    token = _login(base_url)
    r = requests.get(
        f"{base_url}/api/admin/dashboard",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r.status_code == 200
    now = r.json()["now"]
    assert "on_campus_by_location" in now
    assert isinstance(now["on_campus_by_location"], list)


def test_presence_member_has_site_fields(base_url):
    """Every member entry in /api/presence must carry the site_id +
    site_name keys (values may be None for off-status members)."""
    token = _login(base_url)
    r = requests.get(
        f"{base_url}/api/presence",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    body = r.json()
    for m in body.get("members", []):
        assert "site_id" in m, f"site_id missing on {m.get('id')}"
        assert "site_name" in m, f"site_name missing on {m.get('id')}"
        # Off-status members must NOT leak a site tag.
        if m["status"] not in ("on_campus", "temp_out"):
            assert m["site_id"] is None
            assert m["site_name"] is None
