"""Regression test — Grid LT total must equal Payroll `late_days`.

Prod bug 20 Feb 2026: The Grid endpoint projected/read `is_late` from
attendance docs, but the docs actually carry the field as `late`. Real
late check-ins were silently degrading into plain `P` cells while the
Attendance report (which correctly reads `late`) surfaced them.

Additionally, `late_coming` leaves used to paint an LT cell even when
the member didn't check in — inflating the Grid Late count above what
Payroll reported. Now `LEAVE_CODE` no longer maps `late_coming` → LT
(only real attendance `late: true` triggers LT).

This test snapshots the invariant so the two numbers can never drift
again.
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


def test_grid_late_equals_payroll_late(base_url):
    tok = _login(base_url)
    hdr = {"Authorization": f"Bearer {tok}"}
    month = _current_month()

    payroll = requests.get(
        f"{base_url}/api/reports/payroll",
        headers=hdr, params={"month": month}, timeout=45,
    )
    assert payroll.status_code == 200, payroll.text
    p_rows = payroll.json().get("rows") or payroll.json()
    assert isinstance(p_rows, list)

    grid = requests.get(
        f"{base_url}/api/reports/calendar-grid",
        headers=hdr, params={"month": month}, timeout=45,
    )
    assert grid.status_code == 200, grid.text
    g_rows = grid.json().get("rows") or []

    payroll_by_uid = {r.get("member_id"): int(r.get("late_days") or 0) for r in p_rows}
    grid_by_uid = {r["member_id"]: int((r.get("totals") or {}).get("late") or 0) for r in g_rows}

    # Aggregate invariant: totals match exactly.
    payroll_total = sum(payroll_by_uid.values())
    grid_total = sum(grid_by_uid.values())
    assert payroll_total == grid_total, (
        f"Late totals diverge: payroll={payroll_total} grid={grid_total}. "
        f"Attendance report reads attendance.`late`; the Grid was reading "
        f"attendance.`is_late` (never stamped)."
    )

    # Per-member invariant: catches drift a single admin might notice
    # before it aggregates into the totals discrepancy.
    mismatches = []
    for uid, gc in grid_by_uid.items():
        pc = payroll_by_uid.get(uid, 0)
        if gc != pc:
            mismatches.append((uid, gc, pc))
    assert not mismatches, (
        f"Per-member Late mismatches (first 5): {mismatches[:5]}. "
        f"Should be zero after the 20 Feb 2026 fix."
    )
