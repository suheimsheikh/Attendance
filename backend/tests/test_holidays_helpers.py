"""
Behaviour-lock unit tests for the two pure helpers extracted from
`holidays.py` during the Feb 2026 complexity pass:

  * `_split_comp_off_sources`   — used by compute_balance_summary
  * `_expand_ranges_to_isos`    — used by _absent_days_ytd for both
                                   leaves and breaks

These are pure, sync, and DB-free so they run in <1ms and can catch
any silent drift in the summary card (member Leave & Tour page).
"""
from __future__ import annotations

from datetime import date

from holidays import _split_comp_off_sources, _expand_ranges_to_isos


# ── _split_comp_off_sources ──────────────────────────────────────────
def test_split_returns_zeros_when_breakdown_empty():
    assert _split_comp_off_sources({"accrued": 0, "breakdown": []}) == (0, 0, 0)


def test_split_missing_breakdown_key_is_treated_as_empty():
    assert _split_comp_off_sources({"accrued": 0}) == (0, 0, 0)


def test_split_counts_tour_weekly_off_as_one_per_row():
    co = {"accrued": 3, "breakdown": [
        {"kind": "tour_weekly_off", "date": "2026-01-04"},
        {"kind": "tour_weekly_off", "date": "2026-01-11"},
        {"kind": "attendance",      "date": "2026-01-05"},
    ]}
    f_att, f_tour, f_open = _split_comp_off_sources(co)
    assert f_tour == 2
    assert f_open == 0
    assert f_att == 1                # 3 total − 2 tour − 0 opening


def test_split_uses_count_field_for_opening_seed():
    """The opening breakdown row carries `count` (multi-day seed) — the
    sum of counts (not the row count) is what accrues."""
    co = {"accrued": 12, "breakdown": [
        {"kind": "opening", "count": 10},
        {"kind": "tour_weekly_off"},
    ]}
    f_att, f_tour, f_open = _split_comp_off_sources(co)
    assert f_open == 10
    assert f_tour == 1
    assert f_att == 1                # 12 − 1 − 10


def test_split_handles_missing_count_gracefully():
    """Opening rows without an explicit count contribute 0."""
    co = {"accrued": 0, "breakdown": [{"kind": "opening"}]}
    assert _split_comp_off_sources(co) == (0, 0, 0)


# ── _expand_ranges_to_isos ───────────────────────────────────────────
LO = date(2026, 1, 1)
HI = date(2026, 12, 31)


def test_expand_empty_rows_returns_empty_set():
    assert _expand_ranges_to_isos([], clip_lo=LO, clip_hi=HI) == set()


def test_expand_single_day_range():
    got = _expand_ranges_to_isos(
        [{"start_date": "2026-06-15", "end_date": "2026-06-15"}],
        clip_lo=LO, clip_hi=HI,
    )
    assert got == {"2026-06-15"}


def test_expand_multi_day_inclusive():
    got = _expand_ranges_to_isos(
        [{"start_date": "2026-06-01", "end_date": "2026-06-03"}],
        clip_lo=LO, clip_hi=HI,
    )
    assert got == {"2026-06-01", "2026-06-02", "2026-06-03"}


def test_expand_clips_to_window_lo():
    """Range extends before clip_lo → only the in-window part is emitted."""
    got = _expand_ranges_to_isos(
        [{"start_date": "2025-12-28", "end_date": "2026-01-02"}],
        clip_lo=LO, clip_hi=HI,
    )
    assert got == {"2026-01-01", "2026-01-02"}


def test_expand_clips_to_window_hi():
    """Range extends beyond clip_hi → only the in-window part is emitted."""
    got = _expand_ranges_to_isos(
        [{"start_date": "2026-12-30", "end_date": "2027-01-03"}],
        clip_lo=LO, clip_hi=HI,
    )
    assert got == {"2026-12-30", "2026-12-31"}


def test_expand_skips_row_that_fails_iso_parse():
    """Bad dates are silently skipped; other rows still contribute."""
    rows = [
        {"start_date": "bad-date", "end_date": "2026-06-01"},
        {"start_date": "2026-06-02", "end_date": "2026-06-02"},
    ]
    got = _expand_ranges_to_isos(rows, clip_lo=LO, clip_hi=HI)
    assert got == {"2026-06-02"}


def test_expand_keep_filter_drops_rows_pre_expansion():
    """The `keep` callable filters BEFORE expansion — proves we don't
    pay the range-walk cost for excluded rows."""
    rows = [
        {"start_date": "2026-06-01", "end_date": "2026-06-03", "scope": "keep"},
        {"start_date": "2026-07-01", "end_date": "2026-07-05", "scope": "drop"},
    ]
    got = _expand_ranges_to_isos(
        rows, clip_lo=LO, clip_hi=HI,
        keep=lambda r: r.get("scope") == "keep",
    )
    assert got == {"2026-06-01", "2026-06-02", "2026-06-03"}


def test_expand_deduplicates_overlapping_ranges():
    """Two overlapping leave rows → each ISO appears exactly once (set)."""
    rows = [
        {"start_date": "2026-06-01", "end_date": "2026-06-03"},
        {"start_date": "2026-06-02", "end_date": "2026-06-04"},
    ]
    got = _expand_ranges_to_isos(rows, clip_lo=LO, clip_hi=HI)
    assert got == {"2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"}


def test_expand_returns_empty_when_range_is_wholly_outside_window():
    got = _expand_ranges_to_isos(
        [{"start_date": "2025-01-01", "end_date": "2025-06-01"}],
        clip_lo=LO, clip_hi=HI,
    )
    assert got == set()
