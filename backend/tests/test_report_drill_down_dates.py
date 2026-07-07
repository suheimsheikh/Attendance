"""Drill-down date arrays on `/api/reports/hours` (a.k.a. payroll).

Backs the Attendance-table hover tooltip in `Reports.jsx` — every count
column exposes a matching `dates_*` array of ISO YYYY-MM-DD strings so
admins can hover on the number and see WHICH days it came from.

Invariant: `len(dates_X) == days_X` for every category, and each date
falls inside the report window.
"""
from __future__ import annotations

import datetime as dt


DATE_KEYS = [
    "dates_present",
    "dates_off",
    "dates_absent",
    "dates_late",
    "dates_leave",
    "dates_tour",
    "dates_break",
    "dates_half_day",
    "dates_comp_off_used",
    "dates_comp_off_applied",
    "dates_comp_off_earned",
    "dates_escort",
    "dates_overtime_served",
    "dates_overtime_applied",
    "dates_overtime_approved",
]


def _month_window() -> tuple[str, str]:
    today = dt.date.today()
    start = today.replace(day=1).isoformat()
    return start, today.isoformat()


def test_every_date_key_is_present_and_a_list(admin_client, base_url):
    """Every row exposes each `dates_*` key as a list (possibly empty)."""
    start, end = _month_window()
    body = admin_client.get(f"{base_url}/api/reports/hours",
                            params={"start": start, "end": end}, timeout=30).json()
    rows = body["rows"]
    assert rows, "no members returned — DB likely empty"
    for row in rows:
        for k in DATE_KEYS:
            assert k in row, f"{k} missing from row {row.get('member_name')}"
            assert isinstance(row[k], list), f"{k} not a list on {row.get('member_name')}"


def test_count_matches_length_of_dates_array(admin_client, base_url):
    """`days_leave == len(dates_leave)` for every scalar/list pair the
    UI actually renders. Guards against off-by-one drift when the
    dedupe rules for the count and the array diverge."""
    start, end = _month_window()
    body = admin_client.get(f"{base_url}/api/reports/hours",
                            params={"start": start, "end": end}, timeout=30).json()
    pairs = [
        ("days_present", "dates_present"),
        ("days_off", "dates_off"),
        ("days_absent", "dates_absent"),
        ("late_days", "dates_late"),
        ("days_leave", "dates_leave"),
        ("days_tour", "dates_tour"),
        ("days_break", "dates_break"),
        ("half_days", "dates_half_day"),
        ("comp_off_used", "dates_comp_off_used"),
        ("comp_off_applied", "dates_comp_off_applied"),
        ("comp_off_earned", "dates_comp_off_earned"),
        ("escort_days", "dates_escort"),
    ]
    for row in body["rows"]:
        for count_k, dates_k in pairs:
            assert row[count_k] == len(row[dates_k]), (
                f"{row['member_name']}: {count_k}={row[count_k]} but "
                f"len({dates_k})={len(row[dates_k])} ({row[dates_k]})"
            )


def test_dates_fall_inside_report_window(admin_client, base_url):
    """No `dates_*` entry may fall outside [start, end]."""
    start, end = _month_window()
    body = admin_client.get(f"{base_url}/api/reports/hours",
                            params={"start": start, "end": end}, timeout=30).json()
    sd, ed = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    for row in body["rows"]:
        for k in DATE_KEYS:
            for iso in row[k]:
                d_ = dt.date.fromisoformat(iso)
                assert sd <= d_ <= ed, (
                    f"{row['member_name']} {k}={iso} outside {start}..{end}"
                )


def test_dates_arrays_are_sorted_and_unique(admin_client, base_url):
    """Sorted ascending + no duplicates — the UI concatenates them
    into a `title` string, duplicates would confuse admins."""
    start, end = _month_window()
    body = admin_client.get(f"{base_url}/api/reports/hours",
                            params={"start": start, "end": end}, timeout=30).json()
    for row in body["rows"]:
        for k in DATE_KEYS:
            arr = row[k]
            assert arr == sorted(arr), f"{row['member_name']} {k} not sorted: {arr}"
            assert len(arr) == len(set(arr)), f"{row['member_name']} {k} has dupes: {arr}"
