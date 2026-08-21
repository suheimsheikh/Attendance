"""
Behaviour-lock unit tests for `holidays._bucket_leave_rows`.

Written Feb 2026 alongside the guard-clause refactor (5-level nesting →
flat continue-based branches). These tests pin the exact aggregates the
pre-refactor version returned so any future edit that regresses the
Leave / Balance summary card will surface immediately in CI.

Pure, in-process — no DB, no HTTP, no fixtures. Runs in <1ms.
"""
from __future__ import annotations

import pytest

from holidays import _bucket_leave_rows, _tally_approved_leave


# ── Helpers ──────────────────────────────────────────────────────────
def L(start, end, type_, status, **extra):
    """Compact factory so each test row fits on one line."""
    return {"start_date": start, "end_date": end, "type": type_,
            "status": status, **extra}


TODAY = "2026-06-15"


def test_empty_input_returns_all_zeros():
    out = _bucket_leave_rows([], TODAY)
    assert out == {
        "paid_used": 0.0,
        "pending_leave_days": 0.0,
        "future_approved_leave_days": 0.0,
        "tour_ytd_days": 0,
        "pending_tour_days": 0,
        "lop_ytd_days": 0.0,
        "leave_full_count": 0,
        "leave_half_count": 0,
    }


def test_approved_leave_uses_stamped_paid_leave_used():
    """paid_leave_used stamp on the row wins over the raw window length."""
    rows = [L("2026-06-01", "2026-06-05", "leave", "approved",
              paid_leave_used=3.0, lop_days=2.0)]
    out = _bucket_leave_rows(rows, TODAY)
    assert out["paid_used"] == 3.0
    assert out["lop_ytd_days"] == 2.0
    assert out["leave_full_count"] == 1
    assert out["leave_half_count"] == 0


def test_approved_leave_legacy_row_falls_back_to_window_length():
    """Rows without paid_leave_used → count the whole inclusive window."""
    rows = [L("2026-06-01", "2026-06-05", "leave", "approved")]
    out = _bucket_leave_rows(rows, TODAY)
    assert out["paid_used"] == 5   # inclusive


def test_half_day_leave_bumps_half_counter_not_full():
    rows = [L("2026-06-01", "2026-06-01", "leave", "approved",
              half_day=True, paid_leave_used=0.5)]
    out = _bucket_leave_rows(rows, TODAY)
    assert out["leave_half_count"] == 1
    assert out["leave_full_count"] == 0
    assert out["paid_used"] == 0.5


def test_future_approved_leave_is_flagged():
    """start_date strictly after `today` → future_approved_leave_days bucket."""
    rows = [L("2026-08-01", "2026-08-03", "leave", "approved",
              paid_leave_used=3)]
    out = _bucket_leave_rows(rows, TODAY)
    assert out["future_approved_leave_days"] == 3


def test_today_start_is_not_future():
    """A row that starts *on* today is currently-active, not future."""
    rows = [L(TODAY, TODAY, "leave", "approved", paid_leave_used=1)]
    out = _bucket_leave_rows(rows, TODAY)
    assert out["future_approved_leave_days"] == 0


def test_pending_leave_uses_window_length_not_paid_leave_used():
    """Pending rows haven't been ladder-stamped; count the raw window."""
    rows = [L("2026-06-01", "2026-06-03", "leave", "pending",
              paid_leave_used=99)]   # should be ignored
    out = _bucket_leave_rows(rows, TODAY)
    assert out["pending_leave_days"] == 3
    assert out["paid_used"] == 0


def test_approved_tour_accumulates_and_ignores_paid_leave_used():
    rows = [L("2026-05-01", "2026-05-03", "tour", "approved",
              paid_leave_used=999)]
    out = _bucket_leave_rows(rows, TODAY)
    assert out["tour_ytd_days"] == 3
    assert out["paid_used"] == 0


def test_pending_tour_accumulates_separately():
    rows = [L("2026-05-01", "2026-05-02", "tour", "pending")]
    out = _bucket_leave_rows(rows, TODAY)
    assert out["pending_tour_days"] == 2
    assert out["tour_ytd_days"] == 0


def test_unknown_row_type_is_ignored():
    """comp_off rows are accounted elsewhere; unknown types are no-ops."""
    rows = [
        L("2026-06-01", "2026-06-05", "comp_off", "approved"),
        L("2026-06-06", "2026-06-06", "posting", "approved"),
        L("2026-06-07", "2026-06-07", "leave", "rejected"),   # not approved/pending
    ]
    out = _bucket_leave_rows(rows, TODAY)
    for k, v in out.items():
        assert v == 0 or v == 0.0, f"{k} should be zero, got {v}"


def test_mixed_bag_matches_prerefactor_totals():
    """Regression fingerprint: 6 rows spanning every branch of the
    original nested implementation. If any bucket drifts, this test
    surfaces it."""
    rows = [
        L("2026-01-10", "2026-01-12", "leave", "approved", paid_leave_used=3, lop_days=1),
        L("2026-02-05", "2026-02-05", "leave", "approved", half_day=True, paid_leave_used=0.5),
        L("2026-07-01", "2026-07-03", "leave", "approved", paid_leave_used=3),   # future
        L("2026-06-20", "2026-06-22", "leave", "pending"),
        L("2026-03-15", "2026-03-17", "tour",  "approved"),
        L("2026-07-10", "2026-07-11", "tour",  "pending"),
    ]
    out = _bucket_leave_rows(rows, TODAY)
    assert out["paid_used"] == pytest.approx(6.5)
    assert out["lop_ytd_days"] == 1.0
    assert out["future_approved_leave_days"] == 3
    assert out["pending_leave_days"] == 3
    assert out["tour_ytd_days"] == 3
    assert out["pending_tour_days"] == 2
    assert out["leave_full_count"] == 2   # jan + jul
    assert out["leave_half_count"] == 1   # feb


def test_tally_approved_leave_mutates_agg_in_place():
    """The extracted helper is called with a fresh aggregate; verify
    it mutates every relevant key correctly."""
    agg = {
        "paid_used": 0.0, "pending_leave_days": 0.0,
        "future_approved_leave_days": 0.0, "tour_ytd_days": 0,
        "pending_tour_days": 0, "lop_ytd_days": 0.0,
        "leave_full_count": 0, "leave_half_count": 0,
    }
    row = L("2026-09-01", "2026-09-03", "leave", "approved",
            paid_leave_used=3, lop_days=1, half_day=False)
    _tally_approved_leave(agg, row, n=3, today=TODAY)
    assert agg["paid_used"] == 3
    assert agg["lop_ytd_days"] == 1.0
    assert agg["future_approved_leave_days"] == 3
    assert agg["leave_full_count"] == 1
