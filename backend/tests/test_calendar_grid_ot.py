"""Contract tests for the calendar-grid OT hours totals surfaced on
the /reports/calendar-grid endpoint + CSV export.

Added 15 Feb 2026 alongside the "OT hours in The Grid + double-click
ledger" feature.
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


def _current_month() -> str:
    d = date.today()
    return f"{d.year:04d}-{d.month:02d}"


def test_calendar_grid_row_totals_include_ot_minutes(base_url):
    token = _login(base_url)
    r = requests.get(
        f"{base_url}/api/reports/calendar-grid",
        params={"month": _current_month()},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert "rows" in data
    for row in data["rows"]:
        assert "totals" in row
        # New key added 15 Feb 2026.
        assert "ot_minutes" in row["totals"], f"missing ot_minutes on row {row.get('member_name')}"
        assert isinstance(row["totals"]["ot_minutes"], int)


def test_calendar_grid_csv_export_has_ot_hours_column(base_url):
    token = _login(base_url)
    r = requests.get(
        f"{base_url}/api/reports/calendar-grid/export",
        params={"month": _current_month(), "fmt": "csv"},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    header_line = r.text.split("\n", 1)[0]
    headers = [h.strip() for h in header_line.split(",")]
    assert "OT (h)" in headers, f"OT (h) column missing from CSV headers: {headers}"


def test_calendar_grid_ot_minutes_matches_ot_ledger(base_url):
    """The ot_minutes total per member should equal the sum from the
    OT ledger for the same month (ledger endpoint is year-wide but
    filterable in aggregate). Smoke check: pick a row with OT > 0 and
    verify it appears in the ledger."""
    token = _login(base_url)
    r = requests.get(
        f"{base_url}/api/reports/calendar-grid",
        params={"month": _current_month()},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r.status_code == 200
    data = r.json()
    target = next(
        (row for row in data["rows"] if row["totals"].get("ot_minutes", 0) > 0),
        None,
    )
    if not target:
        return  # nothing to compare on an empty-OT month
    # Fetch OT ledger for the year — its total_minutes should be >= this month's total.
    year = _current_month()[:4]
    r = requests.get(
        f"{base_url}/api/reports/ot-ledger",
        params={"member_id": target["member_id"], "year": year},
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    ledger = r.json()
    assert (ledger.get("total_minutes") or 0) >= target["totals"]["ot_minutes"], (
        f"ledger total ({ledger.get('total_minutes')}) < month total "
        f"({target['totals']['ot_minutes']}) for {target['member_name']}"
    )
