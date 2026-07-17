"""Pure-unit tests for the arithmetic / date-projection helpers in
`holidays.py`. Every function under test is DB-free — this suite locks
in the exact numeric contract before any refactor (item O in the
high-risk lane). Extracted 14 Feb 2026.

Coverage:
  • _days_inclusive       — date span arithmetic
  • _bucket_leave_rows    — leave/tour aggregation for the balance card
  • _break_covers_user    — scope resolution for breaks
  • split_leave_days      — the deduction ladder (comp-off → paid → LOP)
  • _expand_date_ranges   — projecting {start,end} rows into ISO date sets
  • _accrual_from_attendance / _accrual_from_tours — comp-off accrual
  • _sum_comp_off_used    — approved-consumption sum across old+new row shapes

If you're touching holidays.py, RUN THIS FIRST. A failure here means
either the change is intentional (update the fixture) or you just
broke wage calculations (revert immediately).
"""
from __future__ import annotations

import pytest

from holidays import (
    _accrual_from_attendance,
    _accrual_from_tours,
    _break_covers_user,
    _bucket_leave_rows,
    _days_inclusive,
    _expand_date_ranges,
    _sum_comp_off_used,
    split_leave_days,
)


# ============================================================================
# _days_inclusive
# ============================================================================
class TestDaysInclusive:
    def test_single_day(self):
        assert _days_inclusive("2026-07-15", "2026-07-15") == 1

    def test_full_week(self):
        assert _days_inclusive("2026-07-13", "2026-07-19") == 7

    def test_across_month_boundary(self):
        assert _days_inclusive("2026-06-29", "2026-07-03") == 5

    def test_backwards_range_returns_negative_plus_one(self):
        # Not typical usage but locks in current behaviour — no crash.
        assert _days_inclusive("2026-07-05", "2026-07-01") == -3

    def test_invalid_dates_fall_back_to_one(self):
        # Bare `except` in the impl swallows any parse error → returns 1.
        assert _days_inclusive("garbage", "also-garbage") == 1
        assert _days_inclusive(None, "2026-07-01") == 1


# ============================================================================
# _bucket_leave_rows
# ============================================================================
class TestBucketLeaveRows:
    TODAY = "2026-07-15"

    def _row(self, **kw):
        base = {"type": "leave", "status": "approved",
                "start_date": "2026-07-10", "end_date": "2026-07-10"}
        base.update(kw)
        return base

    def test_empty_input(self):
        b = _bucket_leave_rows([], self.TODAY)
        assert b == {
            "paid_used": 0.0,
            "pending_leave_days": 0.0,
            "future_approved_leave_days": 0.0,
            "tour_ytd_days": 0,
            "pending_tour_days": 0,
            "lop_ytd_days": 0.0,
            "leave_full_count": 0,
            "leave_half_count": 0,
        }

    def test_approved_leave_with_stamped_paid_used(self):
        rows = [self._row(paid_leave_used=2.0, lop_days=1.0,
                          start_date="2026-07-10", end_date="2026-07-12")]
        b = _bucket_leave_rows(rows, self.TODAY)
        assert b["paid_used"] == 2.0
        assert b["lop_ytd_days"] == 1.0
        assert b["leave_full_count"] == 1
        assert b["leave_half_count"] == 0

    def test_approved_leave_without_paid_stamp_falls_back_to_span(self):
        """Legacy rows without `paid_leave_used` bill the whole window."""
        rows = [self._row(start_date="2026-07-10", end_date="2026-07-12")]
        b = _bucket_leave_rows(rows, self.TODAY)
        assert b["paid_used"] == 3.0  # 3-day span

    def test_future_approved_leave_counted_separately(self):
        rows = [self._row(start_date="2026-08-01", end_date="2026-08-01",
                          paid_leave_used=1.0)]
        b = _bucket_leave_rows(rows, self.TODAY)
        assert b["future_approved_leave_days"] == 1.0
        assert b["paid_used"] == 1.0

    def test_half_day_bumps_half_count(self):
        rows = [self._row(paid_leave_used=0.5, half_day="FN")]
        b = _bucket_leave_rows(rows, self.TODAY)
        assert b["leave_half_count"] == 1
        assert b["leave_full_count"] == 0

    def test_pending_leave_days(self):
        rows = [self._row(status="pending",
                          start_date="2026-07-20", end_date="2026-07-22")]
        b = _bucket_leave_rows(rows, self.TODAY)
        assert b["pending_leave_days"] == 3.0

    def test_approved_tour_totals(self):
        rows = [self._row(type="tour",
                          start_date="2026-07-01", end_date="2026-07-04")]
        b = _bucket_leave_rows(rows, self.TODAY)
        assert b["tour_ytd_days"] == 4
        assert b["paid_used"] == 0.0

    def test_pending_tour_totals(self):
        rows = [self._row(type="tour", status="pending",
                          start_date="2026-08-01", end_date="2026-08-05")]
        b = _bucket_leave_rows(rows, self.TODAY)
        assert b["pending_tour_days"] == 5


# ============================================================================
# _break_covers_user
# ============================================================================
class TestBreakCoversUser:
    USER = {"id": "u1", "institution": "IIT", "fleet": "Optimist", "category": "athlete"}

    def test_scope_all(self):
        assert _break_covers_user({"scope": "all"}, self.USER) is True

    def test_scope_defaults_to_all_when_missing(self):
        assert _break_covers_user({}, self.USER) is True

    def test_institution_match(self):
        assert _break_covers_user({"scope": "institution", "institution": "IIT"}, self.USER) is True
        assert _break_covers_user({"scope": "institution", "institution": "NIT"}, self.USER) is False

    def test_fleet_match(self):
        assert _break_covers_user({"scope": "fleet", "fleet": "Optimist"}, self.USER) is True
        assert _break_covers_user({"scope": "fleet", "fleet": "Laser"}, self.USER) is False

    def test_category_match(self):
        assert _break_covers_user({"scope": "category", "category": "athlete"}, self.USER) is True
        assert _break_covers_user({"scope": "category", "category": "staff"}, self.USER) is False

    def test_selected_by_id(self):
        assert _break_covers_user({"scope": "selected", "member_ids": ["u1", "u2"]}, self.USER) is True
        assert _break_covers_user({"scope": "selected", "member_ids": ["u2"]}, self.USER) is False
        # None member_ids → no crash, evaluates False.
        assert _break_covers_user({"scope": "selected"}, self.USER) is False

    def test_unknown_scope_rejects(self):
        assert _break_covers_user({"scope": "moon-phase"}, self.USER) is False


# ============================================================================
# split_leave_days — THE core ladder
# ============================================================================
class TestSplitLeaveDays:
    """The deduction ladder is the single most consequential arithmetic in
    the app — it determines LOP (loss of pay) which directly affects payroll.
    Every branch below is a payroll-critical scenario."""

    def test_all_comp_off_covers_request(self):
        # 3 days requested, 5 comp-off available → 3 comp-off, 0 paid, 0 lop.
        assert split_leave_days(3, comp_off_avail=5, paid_avail=0) == {
            "comp_off_used": 3, "paid_leave_used": 0.0, "lop_days": 0.0
        }

    def test_comp_off_partial_paid_fills_rest(self):
        # 5 days, 2 comp-off, 10 paid → 2 comp, 3 paid, 0 lop.
        assert split_leave_days(5, comp_off_avail=2, paid_avail=10) == {
            "comp_off_used": 2, "paid_leave_used": 3.0, "lop_days": 0.0
        }

    def test_ladder_exhausted_becomes_lop(self):
        # 5 days, 1 comp, 2 paid → 1 comp + 2 paid + 2 LOP.
        assert split_leave_days(5, comp_off_avail=1, paid_avail=2) == {
            "comp_off_used": 1, "paid_leave_used": 2.0, "lop_days": 2.0
        }

    def test_no_balances_all_lop(self):
        assert split_leave_days(2, comp_off_avail=0, paid_avail=0) == {
            "comp_off_used": 0, "paid_leave_used": 0.0, "lop_days": 2.0
        }

    def test_half_day_never_uses_comp_off(self):
        """Comp-off is atomic: fractional half never rolls into it."""
        r = split_leave_days(0.5, comp_off_avail=5, paid_avail=5)
        assert r["comp_off_used"] == 0
        assert r["paid_leave_used"] == 0.5
        assert r["lop_days"] == 0.0

    def test_half_day_with_only_lop(self):
        r = split_leave_days(0.5, comp_off_avail=0, paid_avail=0)
        assert r == {"comp_off_used": 0, "paid_leave_used": 0.0, "lop_days": 0.5}

    def test_two_and_half_days_full_ladder(self):
        # 2.5 requested, 1 comp, 1 paid → 1 comp + 1 paid + 0.5 LOP.
        r = split_leave_days(2.5, comp_off_avail=1, paid_avail=1)
        assert r == {"comp_off_used": 1, "paid_leave_used": 1.0, "lop_days": 0.5}

    def test_negative_requested_clamps_to_zero(self):
        assert split_leave_days(-3, comp_off_avail=5, paid_avail=5) == {
            "comp_off_used": 0, "paid_leave_used": 0.0, "lop_days": 0.0
        }

    def test_invalid_string_requested_treated_as_zero(self):
        assert split_leave_days("banana", 5, 5) == {
            "comp_off_used": 0, "paid_leave_used": 0.0, "lop_days": 0.0
        }

    def test_negative_balances_clamped(self):
        # Corrupt DB state shouldn't crash — negative balances zero out.
        r = split_leave_days(3, comp_off_avail=-2, paid_avail=-1)
        assert r == {"comp_off_used": 0, "paid_leave_used": 0.0, "lop_days": 3.0}


# ============================================================================
# _expand_date_ranges
# ============================================================================
class TestExpandDateRanges:
    def test_single_row_expanded(self):
        s = _expand_date_ranges(
            [{"start_date": "2026-07-01", "end_date": "2026-07-03"}],
            "2026-01-01", "2026-12-31",
        )
        assert s == {"2026-07-01", "2026-07-02", "2026-07-03"}

    def test_range_clipped_to_year_start(self):
        s = _expand_date_ranges(
            [{"start_date": "2025-12-29", "end_date": "2026-01-02"}],
            "2026-01-01", "2026-12-31",
        )
        assert s == {"2026-01-01", "2026-01-02"}

    def test_range_clipped_to_year_end(self):
        s = _expand_date_ranges(
            [{"start_date": "2026-12-30", "end_date": "2027-01-02"}],
            "2026-01-01", "2026-12-31",
        )
        assert s == {"2026-12-30", "2026-12-31"}

    def test_multi_range_union(self):
        s = _expand_date_ranges(
            [{"start_date": "2026-07-01", "end_date": "2026-07-01"},
             {"start_date": "2026-07-05", "end_date": "2026-07-06"}],
            "2026-01-01", "2026-12-31",
        )
        assert s == {"2026-07-01", "2026-07-05", "2026-07-06"}

    def test_bad_input_returns_empty(self):
        assert _expand_date_ranges([], "not-a-date", "2026-12-31") == set()

    def test_row_with_bad_dates_skipped(self):
        s = _expand_date_ranges(
            [{"start_date": "bad", "end_date": "2026-07-01"},
             {"start_date": "2026-07-05", "end_date": "2026-07-05"}],
            "2026-01-01", "2026-12-31",
        )
        assert s == {"2026-07-05"}


# ============================================================================
# _accrual_from_attendance
# ============================================================================
class TestAccrualFromAttendance:
    def test_no_attendance_zero_accrual(self):
        count, rows = _accrual_from_attendance([], "sunday", set())
        assert count == 0 and rows == []

    def test_sunday_attendance_accrues(self):
        # 2026-07-05 is a Sunday, 2026-07-06 is Monday.
        count, rows = _accrual_from_attendance(
            ["2026-07-05", "2026-07-06"], "sunday", set()
        )
        assert count == 1
        assert rows == [{"date": "2026-07-05", "kind": "weekly_off"}]

    def test_weekday_off_not_sunday(self):
        # Same dates but user's weekly-off is Wednesday — Sunday no longer counts.
        count, _ = _accrual_from_attendance(["2026-07-05"], "wednesday", set())
        assert count == 0

    def test_posting_window_blanks_accrual(self):
        """Sunday attendance during an approved posting doesn't accrue."""
        count, _ = _accrual_from_attendance(
            ["2026-07-05"], "sunday", posting_dates={"2026-07-05"}
        )
        assert count == 0

    def test_bad_date_string_skipped(self):
        count, _ = _accrual_from_attendance(["not-a-date"], "sunday", set())
        assert count == 0


# ============================================================================
# _accrual_from_tours
# ============================================================================
class TestAccrualFromTours:
    def test_no_tours(self):
        c, _ = _accrual_from_tours([], "sunday", "2026-07-15", set(),
                                   "2026-01-01", "2026-12-31")
        assert c == 0

    def test_tour_covering_sunday_accrues(self):
        c, rows = _accrual_from_tours(
            [{"start_date": "2026-07-04", "end_date": "2026-07-06"}],
            "sunday", "2026-07-15", att_seen=set(),
            yr_start="2026-01-01", yr_end="2026-12-31",
        )
        assert c == 1
        assert rows == [{"date": "2026-07-05", "kind": "tour_weekly_off"}]

    def test_future_tour_day_not_counted(self):
        """Only past-or-today Sundays inside a tour accrue."""
        c, _ = _accrual_from_tours(
            [{"start_date": "2026-07-01", "end_date": "2026-07-31"}],
            "sunday", today_iso="2026-07-15", att_seen=set(),
            yr_start="2026-01-01", yr_end="2026-12-31",
        )
        # Sundays in July before-or-on 15th: 5, 12. → 2 accruals.
        assert c == 2

    def test_dedupe_against_attendance(self):
        """A Sunday already accrued via attendance doesn't double-count from a tour."""
        c, _ = _accrual_from_tours(
            [{"start_date": "2026-07-04", "end_date": "2026-07-06"}],
            "sunday", "2026-07-15", att_seen={"2026-07-05"},
            yr_start="2026-01-01", yr_end="2026-12-31",
        )
        assert c == 0

    def test_overlapping_tours_dedupe_against_each_other(self):
        c, _ = _accrual_from_tours(
            [{"start_date": "2026-07-04", "end_date": "2026-07-06"},
             {"start_date": "2026-07-05", "end_date": "2026-07-05"}],
            "sunday", "2026-07-15", set(),
            "2026-01-01", "2026-12-31",
        )
        assert c == 1  # Not 2 — same Sunday.


# ============================================================================
# _sum_comp_off_used
# ============================================================================
class TestSumCompOffUsed:
    def test_new_stamped_rows(self):
        rows = [
            {"type": "leave", "comp_off_used": 3},
            {"type": "leave", "comp_off_used": 2},
        ]
        assert _sum_comp_off_used(rows) == 5

    def test_new_row_with_zero_stamp_counts_zero(self):
        rows = [{"type": "leave", "comp_off_used": 0}]
        assert _sum_comp_off_used(rows) == 0

    def test_legacy_comp_off_type_bills_full_span(self):
        rows = [{"type": "comp_off",
                 "start_date": "2026-07-01", "end_date": "2026-07-03"}]
        assert _sum_comp_off_used(rows) == 3

    def test_stamped_row_wins_over_type(self):
        """New stamp takes priority even if the row is legacy `type=comp_off`."""
        rows = [{"type": "comp_off", "comp_off_used": 1,
                 "start_date": "2026-07-01", "end_date": "2026-07-05"}]
        assert _sum_comp_off_used(rows) == 1

    def test_mixed_shapes(self):
        rows = [
            {"type": "leave", "comp_off_used": 2},
            {"type": "comp_off",
             "start_date": "2026-07-01", "end_date": "2026-07-01"},
        ]
        assert _sum_comp_off_used(rows) == 3

    def test_none_stamp_and_no_type_returns_zero(self):
        rows = [{"type": "leave", "comp_off_used": None}]
        assert _sum_comp_off_used(rows) == 0


# ============================================================================
# Regression sentinel — end-to-end split_leave_days scenarios that MUST
# stay stable. If any of these change, wages change.
# ============================================================================
@pytest.mark.parametrize("requested, comp, paid, expected", [
    # (requested, comp_avail, paid_avail, {expected split})
    (1,   0, 0, {"comp_off_used": 0, "paid_leave_used": 0.0, "lop_days": 1.0}),
    (1,   1, 0, {"comp_off_used": 1, "paid_leave_used": 0.0, "lop_days": 0.0}),
    (1,   0, 1, {"comp_off_used": 0, "paid_leave_used": 1.0, "lop_days": 0.0}),
    (5,   2, 2, {"comp_off_used": 2, "paid_leave_used": 2.0, "lop_days": 1.0}),
    (0.5, 5, 5, {"comp_off_used": 0, "paid_leave_used": 0.5, "lop_days": 0.0}),
    (1.5, 1, 0, {"comp_off_used": 1, "paid_leave_used": 0.0, "lop_days": 0.5}),
    (10,  3, 4, {"comp_off_used": 3, "paid_leave_used": 4.0, "lop_days": 3.0}),
])
def test_split_leave_days_regression_sentinel(requested, comp, paid, expected):
    assert split_leave_days(requested, comp, paid) == expected
