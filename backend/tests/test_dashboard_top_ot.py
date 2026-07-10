"""Test the `top_ot` widget data on the admin dashboard aggregate."""
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


def test_dashboard_week_includes_top_ot_list(base_url):
    token = _login(base_url)
    r = requests.get(
        f"{base_url}/api/admin/dashboard",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    week = r.json().get("week", {})
    assert "top_ot" in week, "top_ot missing from week block"
    top_ot = week["top_ot"]
    assert isinstance(top_ot, list)
    assert len(top_ot) <= 5
    # Each row has the widget-required shape.
    for row in top_ot:
        assert set(("member_id", "name", "category", "ot_minutes")) <= set(row.keys())
        assert isinstance(row["ot_minutes"], int)
        assert row["ot_minutes"] > 0
    # Sorted descending by ot_minutes.
    mins = [r["ot_minutes"] for r in top_ot]
    assert mins == sorted(mins, reverse=True), f"top_ot not desc-sorted: {mins}"
