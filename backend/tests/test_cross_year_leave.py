"""Cross-year leave proration (12 Oct 2026, review finding #3).

A leave spanning New Year must deduct only its IN-YEAR days from the year's
balance. `_bucket_leave_rows(rows, today, yr_start, yr_end)` prorates the
stamped paid_leave_used by the in-year day fraction; omitting the bounds
keeps the old whole-row maths (back-compat with the behaviour-lock tests).
"""
from __future__ import annotations

from holidays import _bucket_leave_rows, _days_in_window

YR_START, YR_END = "2026-01-01", "2026-12-31"
TODAY = "2026-06-01"


def test_days_in_window_clips_to_year():
    # 29 Dec 2025 → 2 Jan 2026 = 5 days total; 2 fall inside 2026 (Jan 1,2).
    assert _days_in_window("2025-12-29", "2026-01-02", YR_START, YR_END) == 2
    # Fully inside → whole span.
    assert _days_in_window("2026-03-01", "2026-03-05", YR_START, YR_END) == 5
    # Fully outside → 0.
    assert _days_in_window("2025-11-01", "2025-11-03", YR_START, YR_END) == 0


def test_cross_year_leave_prorates_paid_used():
    # 5-day leave, stamp says 5 paid; only 2 days are in 2026 → 2.0 counted.
    rows = [{"type": "leave", "status": "approved",
             "start_date": "2025-12-29", "end_date": "2026-01-02",
             "paid_leave_used": 5, "lop_days": 0}]
    out = _bucket_leave_rows(rows, TODAY, YR_START, YR_END)
    assert out["paid_used"] == 2.0, out["paid_used"]


def test_in_year_leave_unchanged():
    # A leave fully inside the year is unaffected by proration (fraction=1).
    rows = [{"type": "leave", "status": "approved",
             "start_date": "2026-03-01", "end_date": "2026-03-04",
             "paid_leave_used": 4, "lop_days": 0}]
    out = _bucket_leave_rows(rows, TODAY, YR_START, YR_END)
    assert out["paid_used"] == 4.0


def test_backcompat_without_bounds():
    # No bounds → whole-row maths (what the old behaviour-lock tests rely on).
    rows = [{"type": "leave", "status": "approved",
             "start_date": "2025-12-29", "end_date": "2026-01-02",
             "paid_leave_used": 5, "lop_days": 0}]
    out = _bucket_leave_rows(rows, TODAY)
    assert out["paid_used"] == 5.0
