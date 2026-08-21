"""
Behaviour-lock unit tests for `routes.reports._classify_timeline_day`
— the pure classifier extracted from `member_timeline` during the
Feb 2026 complexity pass.

Pins every branch of the primary-bucket priority rules so the
attendance drill-down modal keeps saying the right thing.
"""
from __future__ import annotations

from routes.reports import _classify_timeline_day


TODAY = "2026-06-15"
YESTERDAY = "2026-06-14"


# ── No accounted markers → uses weekly-off / today / absent fallback
def test_no_markers_on_weekly_off_says_off_weekly():
    assert _classify_timeline_day(
        [], iso=YESTERDAY, today_iso=TODAY, is_weekly_off=True,
    ) == "off_weekly"


def test_no_markers_on_today_says_off_in_progress():
    """A blank row for today is still 'in progress' — the member
    might yet check in, so we don't call them absent."""
    assert _classify_timeline_day(
        [], iso=TODAY, today_iso=TODAY, is_weekly_off=False,
    ) == "off_in_progress"


def test_no_markers_on_past_workday_says_absent():
    assert _classify_timeline_day(
        [], iso=YESTERDAY, today_iso=TODAY, is_weekly_off=False,
    ) == "absent"


def test_weekly_off_beats_today_when_both_apply():
    """If today happens to be the weekly-off, we still prefer the
    weekly-off label so the report reads 'weekly off', not 'in
    progress'. Locks the branch order."""
    assert _classify_timeline_day(
        [], iso=TODAY, today_iso=TODAY, is_weekly_off=True,
    ) == "off_weekly"


# ── Accounted markers → priority-based selection
def test_present_wins_over_leave_and_escort():
    """Priority ordering: present > leave > tour > … > escort."""
    got = _classify_timeline_day(
        ["escort", "leave", "present"], iso=YESTERDAY,
        today_iso=TODAY, is_weekly_off=False,
    )
    assert got == "present"


def test_leave_wins_over_tour_and_break():
    got = _classify_timeline_day(
        ["break", "tour", "leave"], iso=YESTERDAY,
        today_iso=TODAY, is_weekly_off=False,
    )
    assert got == "leave"


def test_break_wins_over_escort_when_no_higher_marker():
    """Break is ACCOUNTED and higher priority than escort — the day
    reads 'Break / Holiday' not 'Escort duty'."""
    got = _classify_timeline_day(
        ["escort", "break"], iso=YESTERDAY,
        today_iso=TODAY, is_weekly_off=False,
    )
    assert got == "break"


def test_escort_only_on_workday_falls_back_to_absent():
    """`escort` is NOT in ACCOUNTED, so escort alone on a workday
    counts as absent — the escort duty didn't excuse absence. Locks
    the pre-refactor behaviour (verified in original inline code)."""
    got = _classify_timeline_day(
        ["escort"], iso=YESTERDAY,
        today_iso=TODAY, is_weekly_off=False,
    )
    assert got == "absent"


def test_accounted_marker_beats_weekly_off():
    """A member who worked on their weekly-off day is Present, not
    'off_weekly'. Regression guard for the comp-off accrual case."""
    got = _classify_timeline_day(
        ["present"], iso=YESTERDAY,
        today_iso=TODAY, is_weekly_off=True,
    )
    assert got == "present"


def test_unknown_bucket_still_returns_first_when_no_priority_match():
    """Defensive: buckets contains only unknown labels → returns the
    first one so the row still renders SOMETHING sensible instead of
    crashing."""
    got = _classify_timeline_day(
        ["mystery", "unknown"], iso=YESTERDAY,
        today_iso=TODAY, is_weekly_off=False,
    )
    assert got == "absent"   # nothing is accounted → fallback branch


def test_posting_and_comp_off_are_accounted():
    """Explicit lock for the two less-obvious accounted markers."""
    assert _classify_timeline_day(
        ["posting"], iso=YESTERDAY, today_iso=TODAY, is_weekly_off=False,
    ) == "posting"
    assert _classify_timeline_day(
        ["comp_off"], iso=YESTERDAY, today_iso=TODAY, is_weekly_off=False,
    ) == "comp_off"


def test_late_coming_is_accounted():
    """Late-coming approved is a real presence — not absent, even
    though the check-in fell outside the standard window."""
    got = _classify_timeline_day(
        ["late_coming"], iso=YESTERDAY,
        today_iso=TODAY, is_weekly_off=False,
    )
    assert got == "late_coming"
