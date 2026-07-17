"""Unit tests for `_compute_early_out_at_checkout` — the pure arithmetic
helper extracted from `_geo_toggle` on 14 Feb 2026 as part of the
medium-risk refactor pass. These lock in the exact 15-min grace-window
contract that both the Profile Early-Outs list and the SelfCheckIn
prompt threshold depend on.

Tests are DB-free — the helper is pure, so we invoke it directly
against synthetic `target` + `office` dicts.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from server import _compute_early_out_at_checkout


IST_OFFICE = {"timezone": "Asia/Kolkata"}


def _utc(hour_ist: int, minute_ist: int = 0) -> datetime:
    """Build a UTC datetime that renders as the given IST HH:MM. IST is
    UTC+5:30 so we subtract 5h30m to get the UTC equivalent."""
    total = hour_ist * 60 + minute_ist - (5 * 60 + 30)
    total %= 24 * 60
    return datetime(2026, 2, 14, total // 60, total % 60, tzinfo=timezone.utc)


def test_on_time_returns_zero():
    """Leaving exactly at work_end → 0."""
    assert _compute_early_out_at_checkout(
        _utc(18, 0), {"work_end": "18:00"}, IST_OFFICE
    ) == 0


def test_leaving_five_min_early_under_grace_returns_zero():
    """Within 15-min grace → not counted as early-out."""
    assert _compute_early_out_at_checkout(
        _utc(17, 50), {"work_end": "18:00"}, IST_OFFICE
    ) == 0


def test_leaving_15_min_early_boundary_counts():
    """Exactly 15 min early → counted (boundary is inclusive)."""
    assert _compute_early_out_at_checkout(
        _utc(17, 45), {"work_end": "18:00"}, IST_OFFICE
    ) == 15


def test_leaving_hour_early_counts():
    assert _compute_early_out_at_checkout(
        _utc(17, 0), {"work_end": "18:00"}, IST_OFFICE
    ) == 60


def test_leaving_after_work_end_returns_zero():
    """Late checkout is OT territory, not early-out."""
    assert _compute_early_out_at_checkout(
        _utc(18, 45), {"work_end": "18:00"}, IST_OFFICE
    ) == 0


def test_missing_work_end_returns_zero():
    """No work_end configured on user → helper is a no-op."""
    assert _compute_early_out_at_checkout(
        _utc(12, 0), {}, IST_OFFICE
    ) == 0


@pytest.mark.parametrize("bad_value", ["", "abc", "18", None, ":45"])
def test_malformed_work_end_returns_zero(bad_value):
    """Any parse failure falls through to 0 — never crashes the checkout."""
    assert _compute_early_out_at_checkout(
        _utc(12, 0), {"work_end": bad_value}, IST_OFFICE
    ) == 0
