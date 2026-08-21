"""
Behaviour-lock unit tests for the two meal-window picker helpers
extracted from `routes.meals.meals_today` (Feb 2026 pass):

  * `_earliest_check_in_before(sessions, cutoff_utc)`
      → breakfast eligibility rule.
  * `_covering_session_check_in(sessions, anchor_utc)`
      → lunch / dinner "still on campus at anchor" rule.

Both are pure predicates on session lists — no DB, no HTTP. These
tests pin the exact edge-cases the Chef's View relies on so a future
edit that shifts "≤" to "<" or the like trips CI immediately.
"""
from __future__ import annotations

from routes.meals import (
    _earliest_check_in_before,
    _covering_session_check_in,
)

BF = "2026-08-20T07:00:00+00:00"
LU = "2026-08-20T10:00:00+00:00"
DI = "2026-08-20T18:00:00+00:00"


def _sess(ci=None, co=None):
    """Compact session dict factory."""
    return {"check_in_at": ci, "check_out_at": co}


# ── _earliest_check_in_before ────────────────────────────────────────
def test_breakfast_empty_sessions_none():
    assert _earliest_check_in_before([], BF) is None


def test_breakfast_returns_earliest_when_before_cutoff():
    """If ANY check-in is ≤ the cut-off, the EARLIEST one wins — the
    frontend surfaces this timestamp in the drill-down."""
    s = [_sess("2026-08-20T08:15:00+00:00"),
         _sess("2026-08-20T06:45:00+00:00"),
         _sess("2026-08-20T09:00:00+00:00")]
    assert _earliest_check_in_before(s, BF) == "2026-08-20T06:45:00+00:00"


def test_breakfast_boundary_is_inclusive():
    """A check-in exactly AT the cut-off counts — locks the '≤' contract."""
    s = [_sess("2026-08-20T07:00:00+00:00")]
    assert _earliest_check_in_before(s, BF) == "2026-08-20T07:00:00+00:00"


def test_breakfast_arrives_late_returns_none():
    """All sessions after the cut-off → member misses breakfast."""
    s = [_sess("2026-08-20T07:00:01+00:00"),
         _sess("2026-08-20T08:00:00+00:00")]
    assert _earliest_check_in_before(s, BF) is None


def test_breakfast_ignores_sessions_with_no_check_in():
    """A leave/tour or malformed row without check_in_at is skipped."""
    s = [_sess(None), _sess("2026-08-20T06:30:00+00:00")]
    assert _earliest_check_in_before(s, BF) == "2026-08-20T06:30:00+00:00"


def test_breakfast_only_null_check_ins_returns_none():
    s = [_sess(None), _sess(None)]
    assert _earliest_check_in_before(s, BF) is None


# ── _covering_session_check_in ───────────────────────────────────────
def test_lunch_empty_sessions_none():
    assert _covering_session_check_in([], LU) is None


def test_lunch_open_session_that_started_before_anchor_covers():
    """Checked in before 10:00 with no checkout → still on campus."""
    s = [_sess("2026-08-20T06:30:00+00:00", None)]
    assert _covering_session_check_in(s, LU) == "2026-08-20T06:30:00+00:00"


def test_lunch_closed_session_that_ends_after_anchor_covers():
    """Checked out AFTER 10:00 → present at the lunch anchor."""
    s = [_sess("2026-08-20T06:30:00+00:00", "2026-08-20T11:00:00+00:00")]
    assert _covering_session_check_in(s, LU) == "2026-08-20T06:30:00+00:00"


def test_lunch_closed_session_that_ends_before_anchor_does_not_cover():
    """Left before 10:00 → skips lunch."""
    s = [_sess("2026-08-20T06:30:00+00:00", "2026-08-20T09:00:00+00:00")]
    assert _covering_session_check_in(s, LU) is None


def test_lunch_check_out_exactly_at_anchor_does_not_cover():
    """Boundary: `co > anchor` — a check-out EXACTLY at the anchor
    means the member left AT lunch time; treated as not-present.
    Locks the '>' vs '>=' contract."""
    s = [_sess("2026-08-20T06:30:00+00:00", "2026-08-20T10:00:00+00:00")]
    assert _covering_session_check_in(s, LU) is None


def test_lunch_late_arrival_after_anchor_does_not_cover():
    """Checked in AFTER the anchor → not on campus at that time."""
    s = [_sess("2026-08-20T10:15:00+00:00", None)]
    assert _covering_session_check_in(s, LU) is None


def test_lunch_check_in_exactly_at_anchor_covers():
    """Boundary: `ci ≤ anchor` — a check-in EXACTLY at the anchor
    means the member arrived at lunch time; treated as present.
    Locks the '≤' vs '<' contract."""
    s = [_sess("2026-08-20T10:00:00+00:00", None)]
    assert _covering_session_check_in(s, LU) == "2026-08-20T10:00:00+00:00"


def test_lunch_returns_first_covering_session_when_multiple():
    """Two sessions bracket the anchor — the FIRST one that covers wins."""
    s = [_sess("2026-08-20T06:30:00+00:00", "2026-08-20T09:00:00+00:00"),   # left before
         _sess("2026-08-20T09:45:00+00:00", None)]                            # covers
    assert _covering_session_check_in(s, LU) == "2026-08-20T09:45:00+00:00"


def test_lunch_ignores_sessions_with_no_check_in():
    """Malformed/leave rows are silently skipped without crashing."""
    s = [_sess(None), _sess("2026-08-20T06:30:00+00:00", None)]
    assert _covering_session_check_in(s, LU) == "2026-08-20T06:30:00+00:00"


def test_dinner_uses_same_rule_at_1800():
    """Same helper drives dinner — one contract, two anchors."""
    s = [_sess("2026-08-20T09:00:00+00:00", "2026-08-20T19:00:00+00:00")]
    assert _covering_session_check_in(s, DI) == "2026-08-20T09:00:00+00:00"
    # Left before 18:00 → no dinner.
    s2 = [_sess("2026-08-20T09:00:00+00:00", "2026-08-20T17:00:00+00:00")]
    assert _covering_session_check_in(s2, DI) is None
