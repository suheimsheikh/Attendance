"""Contract tests for the No-show / Churn early-warning report and the
reconciled approvals-summary badge count.

Added 20 Feb 2026 alongside:
  • /api/reports/churn-risk endpoint (P2 backlog item)
  • Reconciliation of /api/admin/approvals-summary to exclude records
    whose linked user was deleted (fixes the phantom "82 pending" badge
    bug reported in prod).
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


# ---------- Churn-risk endpoint ---------------------------------------------

def test_churn_risk_default_window(base_url):
    """Baseline: endpoint is reachable, returns the documented shape, and
    is sorted worst-first (highest miss_pct → then longest streak)."""
    tok = _login(base_url)
    r = requests.get(
        f"{base_url}/api/reports/churn-risk",
        headers={"Authorization": f"Bearer {tok}"},
        params={"window_days": 30, "threshold": 0.40},
        timeout=45,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    for key in ("start", "end", "window_days", "threshold", "count", "rows"):
        assert key in data, f"missing key: {key}"
    assert data["window_days"] == 30
    assert data["threshold"] == 0.40

    # Sort invariant: strictly non-increasing miss_pct across rows.
    prev = 1.01
    for row in data["rows"]:
        assert row["miss_pct"] <= prev + 1e-9
        prev = row["miss_pct"]


def test_churn_risk_row_shape(base_url):
    tok = _login(base_url)
    r = requests.get(
        f"{base_url}/api/reports/churn-risk",
        headers={"Authorization": f"Bearer {tok}"},
        params={"window_days": 30, "threshold": 0.10},
        timeout=45,
    )
    assert r.status_code == 200
    rows = r.json()["rows"]
    if not rows:
        return  # empty preview DB → nothing to shape-check
    row = rows[0]
    for key in ("member_id", "member_name", "category", "scheduled",
                "present", "missed", "miss_pct", "attendance_pct",
                "streak", "risk_band", "contact", "absent_days"):
        assert key in row, f"missing key {key} in row: {row}"
    # Bands are one of the enumerated values.
    assert row["risk_band"] in ("critical", "high", "watch")
    # attendance_pct + miss_pct ~= 1 (float tolerance).
    assert abs(row["attendance_pct"] + row["miss_pct"] - 1.0) < 1e-6


def test_churn_risk_validates_params(base_url):
    tok = _login(base_url)
    r = requests.get(
        f"{base_url}/api/reports/churn-risk",
        headers={"Authorization": f"Bearer {tok}"},
        params={"window_days": 30, "threshold": 5.0},
        timeout=15,
    )
    assert r.status_code == 400
    r = requests.get(
        f"{base_url}/api/reports/churn-risk",
        headers={"Authorization": f"Bearer {tok}"},
        params={"window_days": 500, "threshold": 0.4},
        timeout=15,
    )
    # window_days capped to 180 — still returns 200 (silently clamped).
    assert r.status_code == 200
    assert r.json()["window_days"] == 180


def test_churn_risk_requires_admin(base_url):
    r = requests.get(f"{base_url}/api/reports/churn-risk", timeout=10)
    assert r.status_code in (401, 403)


# ---------- Approvals-summary reconciliation --------------------------------

def test_approvals_summary_shape(base_url):
    tok = _login(base_url)
    r = requests.get(
        f"{base_url}/api/admin/approvals-summary",
        headers={"Authorization": f"Bearer {tok}"},
        timeout=15,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    for key in ("leaves", "overtime", "devices", "checkins", "corrections", "total"):
        assert key in data
    # Overtime is permanently 0 since 15 Feb 2026 (workflow deprecated).
    assert data["overtime"] == 0
    # total is the sum of the individual queues.
    assert data["total"] == (
        data["leaves"] + data["overtime"] + data["devices"]
        + data["checkins"] + data["corrections"]
    )


def test_approvals_summary_matches_queue(base_url):
    """The badge count must never exceed the number of items that
    actually surface on the Approvals page — otherwise admins see a
    phantom pending count they cannot clear (prod bug 20 Feb 2026)."""
    tok = _login(base_url)
    headers = {"Authorization": f"Bearer {tok}"}

    summary = requests.get(
        f"{base_url}/api/admin/approvals-summary", headers=headers, timeout=15,
    ).json()
    # Fetch the three queues the ApprovalsUnified table renders.
    leaves = requests.get(f"{base_url}/api/leaves", headers=headers, timeout=30).json()
    pending_leaves = sum(1 for l in leaves if l.get("status") == "pending")
    checkins = requests.get(
        f"{base_url}/api/admin/checkin-approvals",
        headers=headers, params={"status": "pending"}, timeout=30,
    ).json()
    pending_checkins = checkins.get("count") if isinstance(checkins, dict) else len(checkins)
    corrections = requests.get(
        f"{base_url}/api/admin/corrections",
        headers=headers, params={"status": "pending"}, timeout=30,
    ).json()
    pending_corrections = len(corrections) if isinstance(corrections, list) else len(corrections.get("items", []))

    # The summary counts should be ≤ what the actual queues render
    # (orphaned rows may be filtered out of the summary but never *added*).
    assert summary["leaves"] <= pending_leaves, (summary["leaves"], pending_leaves)
    assert summary["checkins"] <= pending_checkins, (summary["checkins"], pending_checkins)
    assert summary["corrections"] <= pending_corrections, (summary["corrections"], pending_corrections)


# ---------- Calendar-grid cell_meta enrichment ------------------------------

def test_calendar_grid_returns_cell_meta(base_url):
    """The Grid payload now carries per-cell tooltip metadata so admins
    can see check-in times, leave reasons, and break names on hover."""
    tok = _login(base_url)
    from datetime import date
    m = date.today()
    month = f"{m.year:04d}-{m.month:02d}"
    r = requests.get(
        f"{base_url}/api/reports/calendar-grid",
        headers={"Authorization": f"Bearer {tok}"},
        params={"month": month},
        timeout=45,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    rows = data.get("rows") or []
    if not rows:
        return  # empty preview
    # At least one row should have a cell_meta dict (attendance rows carry
    # check_in_at on P/HD/LT cells).
    assert any(isinstance(r.get("cell_meta"), dict) for r in rows), \
        "cell_meta missing on every row — GridCell tooltips will be empty"
