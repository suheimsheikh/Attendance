"""Iteration 24 (Feb 2026) — deeper contract tests for:

  • Approvals-summary reconciliation (badge count bug fix)
  • /api/leaves defensive against missing user_id
  • Calendar-grid cell_meta shape (P/HD/LT/LV/TR/CO/PS/BK)
  • Churn-risk row shape + sort invariant + filter semantics

These live alongside test_churn_and_approvals_summary.py (the smoke
tests the main agent added this session) and go one level deeper —
we assert the *structure of the tooltip metadata* and the filter
predicates the review request calls out.
"""
from __future__ import annotations

import os
from datetime import date

import pytest
import requests


# ---------- /api/leaves defensive shape --------------------------------------

def test_leaves_endpoint_returns_200(admin_client, base_url):
    """Even with legacy rows missing user_id in the DB, the endpoint
    must never 500 — the ApprovalsUnified Promise.all fails hard
    otherwise."""
    r = admin_client.get(f"{base_url}/api/leaves", timeout=30)
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), list)


def test_leaves_admin_returns_valid_status_field(admin_client, base_url):
    """Legacy check — every enriched leave carries a status field. The
    server-side ?status= filter is intentionally NOT enforced here (the
    frontend does client-side filtering) — assert only that no row is
    malformed / missing status."""
    r = admin_client.get(f"{base_url}/api/leaves", timeout=30)
    assert r.status_code == 200
    for row in r.json():
        assert row.get("status") in ("pending", "approved", "rejected", "cancelled"), row


# ---------- Approvals summary reconciliation --------------------------------

def test_approvals_summary_no_phantom_leaves(admin_client, base_url):
    """The classic prod bug: summary said 82 pending, actual queue was
    empty. Assert summary counts are <= queue counts for each type."""
    summary = admin_client.get(
        f"{base_url}/api/admin/approvals-summary", timeout=15
    ).json()
    leaves = admin_client.get(
        f"{base_url}/api/leaves?status=pending", timeout=30
    ).json()
    # Legacy call may not accept ?status, so also count by hand:
    pending_leaves = [leave for leave in leaves if leave.get("status") == "pending"]
    assert summary["leaves"] <= len(pending_leaves), (
        summary["leaves"], len(pending_leaves)
    )
    assert summary["overtime"] == 0
    # Total is arithmetic sum.
    assert summary["total"] == (
        summary["leaves"] + summary["overtime"] + summary["devices"]
        + summary["checkins"] + summary["corrections"]
    )


# ---------- Calendar-grid cell_meta ----------------------------------------

def test_calendar_grid_cell_meta_shapes(admin_client, base_url):
    """Verify cell_meta carries the right keys per cell code."""
    m = date.today()
    month = f"{m.year:04d}-{m.month:02d}"
    r = admin_client.get(
        f"{base_url}/api/reports/calendar-grid",
        params={"month": month}, timeout=45,
    )
    assert r.status_code == 200
    rows = r.json().get("rows") or []
    days = r.json().get("days") or []
    if not rows:
        pytest.skip("Empty preview DB — no rows to validate cell_meta on")

    saw_att = False
    saw_leave_like = False
    saw_break = False
    for row in rows:
        cell_meta = row.get("cell_meta") or {}
        cells = row.get("cells") or []
        for idx, code in enumerate(cells):
            if idx >= len(days):
                continue
            iso = days[idx]
            meta = cell_meta.get(iso)
            if not meta:
                # Only P/HD/LT/LV/TR/CO/PS/BK cells carry meta — WO/HO/AB/LF do not.
                assert code in ("", "WO", "HO", "AB", "P", "HD", "LT",
                                "LV", "TR", "CO", "PS", "BK", "LF"), code
                continue
            if code in ("P", "HD", "LT"):
                # Presence rows should surface check_in_at (may be missing on
                # very old rows but should be present for anything recent).
                assert isinstance(meta, dict)
                # late_minutes only surfaces on LT cells.
                if code == "LT":
                    # late_minutes may be 0/missing if the row was set is_late
                    # without a numeric — that's still valid, we just assert
                    # type when present.
                    if "late_minutes" in meta:
                        assert isinstance(meta["late_minutes"], int)
                saw_att = True
            elif code in ("LV", "TR", "CO", "PS"):
                # Leave-family cells carry `range`; optional reason & approved_by.
                assert "range" in meta, meta
                if "approved_by" in meta:
                    assert isinstance(meta["approved_by"], str)
                saw_leave_like = True
            elif code == "BK":
                # BK cells carry break_name; optional applied_by + range.
                assert "break_name" in meta or "range" in meta, meta
                saw_break = True

    # We don't require ALL three to exist in the preview DB, but at least
    # one should — otherwise cell_meta is empty everywhere and the tooltip
    # feature is silently broken.
    assert saw_att or saw_leave_like or saw_break, \
        "No cell_meta rows in the entire month payload"


# ---------- Churn-risk deep shape + sort --------------------------------

def test_churn_risk_deep_row_shape(admin_client, base_url):
    """Row shape must carry contact:{relation,name,mobile}, last_seen,
    absent_days list, and a valid risk_band."""
    r = admin_client.get(
        f"{base_url}/api/reports/churn-risk",
        params={"window_days": 60, "threshold": 0.10}, timeout=45,
    )
    assert r.status_code == 200
    payload = r.json()
    assert "count" in payload and payload["count"] == len(payload["rows"])
    if not payload["rows"]:
        pytest.skip("Preview DB has no churn-risk rows")

    for row in payload["rows"]:
        # required keys
        for key in ("member_id", "member_name", "category", "scheduled",
                    "present", "missed", "miss_pct", "attendance_pct",
                    "streak", "last_seen", "absent_days", "risk_band"):
            assert key in row, f"missing {key} in {row}"
        assert row["scheduled"] >= 5  # min_scheduled default
        # gate: miss_pct >= threshold OR streak >= 3
        assert row["miss_pct"] >= 0.10 or row["streak"] >= 3
        # attendance_pct + miss_pct ≈ 1
        assert abs(row["attendance_pct"] + row["miss_pct"] - 1.0) < 1e-6
        assert row["risk_band"] in ("critical", "high", "watch")
        assert isinstance(row["absent_days"], list)
        # contact may be None (no phones on file) but if present, must have
        # {relation, name, mobile}
        if row.get("contact"):
            for k in ("relation", "name", "mobile"):
                assert k in row["contact"]


def test_churn_risk_sorted_worst_first(admin_client, base_url):
    """Verify sort order: miss_pct desc, then streak desc."""
    r = admin_client.get(
        f"{base_url}/api/reports/churn-risk",
        params={"window_days": 60, "threshold": 0.05}, timeout=45,
    )
    assert r.status_code == 200
    rows = r.json()["rows"]
    for a, b in zip(rows, rows[1:]):
        # Primary key: miss_pct desc
        if a["miss_pct"] > b["miss_pct"] + 1e-9:
            continue
        # Tie on miss_pct → streak must be non-increasing
        if abs(a["miss_pct"] - b["miss_pct"]) < 1e-9:
            assert a["streak"] >= b["streak"], (a, b)
        else:
            pytest.fail(f"Rows out of order: {a['miss_pct']} then {b['miss_pct']}")


def test_churn_risk_threshold_out_of_range(admin_client, base_url):
    r = admin_client.get(
        f"{base_url}/api/reports/churn-risk",
        params={"window_days": 30, "threshold": -0.1}, timeout=10,
    )
    assert r.status_code == 400
    r = admin_client.get(
        f"{base_url}/api/reports/churn-risk",
        params={"window_days": 30, "threshold": 1.5}, timeout=10,
    )
    assert r.status_code == 400


def test_churn_risk_window_clamps_to_180(admin_client, base_url):
    r = admin_client.get(
        f"{base_url}/api/reports/churn-risk",
        params={"window_days": 999, "threshold": 0.4}, timeout=45,
    )
    assert r.status_code == 200
    assert r.json()["window_days"] == 180


def test_churn_risk_unauthenticated(base_url):
    r = requests.get(f"{base_url}/api/reports/churn-risk", timeout=10)
    assert r.status_code in (401, 403)
