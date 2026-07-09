"""04 Feb 2026 — Reports column consolidation + super-admin gating +
attendance-ledger drill-down endpoint.

Covers:
  1. Non-super-admin CSV has 17 columns (no Hours group).
  2. Non-super-admin /auth/me sees is_super_admin=False.
  3. Attendance ledger endpoint returns per-date rows with `status`
     bucketed correctly.
  4. Attendance ledger date range validation.
"""
from __future__ import annotations

from datetime import date, timedelta

import requests


def test_hours_csv_default_admin_hides_hours_group(admin_client, base_url):
    """Default admin (no mobile whitelisted) should get 17-column CSV
    without the Hours group. Envelope must include OT + CO singletons."""
    y = date.today().year
    start = f"{y}-01-01"
    end = f"{y}-12-31"
    r = admin_client.get(
        f"{base_url}/api/reports/hours/export",
        params={"start": start, "end": end, "fmt": "csv"},
        timeout=30,
    )
    assert r.status_code == 200, r.text[:200]
    header_line = r.text.split("\n", 1)[0]
    headers = [h.strip() for h in header_line.split(",")]
    # Hours group hidden.
    assert "Tot h" not in headers, f"Tot h should be hidden for non-super-admin: {headers}"
    assert "Avg h" not in headers
    # OT + CO singletons present.
    assert "OT" in headers
    assert "CO" in headers
    # Total column count = 17.
    assert len(headers) == 17, f"expected 17 cols, got {len(headers)}: {headers}"


def test_auth_me_reports_is_super_admin_false_for_default_admin(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/auth/me", timeout=10)
    assert r.status_code == 200
    assert r.json().get("is_super_admin") is False


def test_attendance_ledger_returns_daily_rows(admin_client, base_url, athlete):
    """Range must return one row per calendar day (inclusive) with a
    non-empty status classification."""
    today = date.today()
    start = (today - timedelta(days=6)).isoformat()
    end = today.isoformat()
    r = admin_client.get(
        f"{base_url}/api/reports/attendance-ledger",
        params={"member_id": athlete["id"], "start": start, "end": end},
        timeout=15,
    )
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["member_id"] == athlete["id"]
    # 7 days inclusive.
    assert len(d["rows"]) == 7
    # Every row must have a status.
    for row in d["rows"]:
        assert row.get("status"), f"row missing status: {row}"
        assert row["status"] in {
            "Present", "Late", "Half day",
            "Leave", "Tour", "Posting", "Comp-off",
            "Weekly off", "Holiday", "Absent",
        }, f"unknown status: {row['status']}"
    # Counts must sum to len(rows).
    assert sum(d["counts"].values()) == len(d["rows"])


def test_attendance_ledger_rejects_bad_range(admin_client, base_url, athlete):
    r = admin_client.get(
        f"{base_url}/api/reports/attendance-ledger",
        params={"member_id": athlete["id"],
                "start": "2026-12-31", "end": "2026-01-01"},
        timeout=15,
    )
    assert r.status_code == 400
    assert "end" in r.text.lower()


def test_attendance_ledger_rejects_bad_dates(admin_client, base_url, athlete):
    r = admin_client.get(
        f"{base_url}/api/reports/attendance-ledger",
        params={"member_id": athlete["id"],
                "start": "not-a-date", "end": "2026-01-01"},
        timeout=15,
    )
    assert r.status_code == 400
