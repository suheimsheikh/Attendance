"""Weekly random photo refresh (Jun 2026, user request).

Verifies the pure decision helper `_weekly_photo_due` in server.py:
  1. Guarantee: for every member+week, the member's LAST working day of the
     week triggers the refresh (so it fires once/week as long as they check
     in on/after their random day).
  2. Never triggers on the member's weekly-off.
  3. Random / no-pattern: the assigned day varies across members and across
     weeks (not everyone on the same day).
  4. Already-refreshed weeks are skipped.
"""
from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_ROOT))

import server  # noqa: E402

_due = server._weekly_photo_due
_wk = server._iso_week_key
NAMES = server._WEEKDAY_NAMES


def _mondays(n=8):
    """First Monday on/after a fixed anchor, then n consecutive weeks."""
    d = date(2026, 6, 1)  # a Monday
    while d.weekday() != 0:
        d += timedelta(days=1)
    return [d + timedelta(weeks=i) for i in range(n)]


def test_last_working_day_always_triggers():
    """For any member and week, checking in on the last working day must
    trigger the refresh — this is what makes 'once a week for sure' hold."""
    for uid in [f"user-{i}" for i in range(50)]:
        for weekly_off in NAMES:
            for monday in _mondays():
                office = {"default_weekly_off": weekly_off}
                user = {"id": uid, "weekly_off": weekly_off, "photo": "x"}
                working = [i for i in range(7) if NAMES[i] != weekly_off]
                last_wd = working[-1]
                last_day = monday + timedelta(days=last_wd)
                assert _due(user, office, last_day) is True, (
                    f"{uid} off={weekly_off} week={_wk(monday)} last working day "
                    f"{NAMES[last_wd]} should trigger")


def test_never_triggers_on_weekly_off():
    for uid in [f"u-{i}" for i in range(30)]:
        for weekly_off in NAMES:
            off_idx = NAMES.index(weekly_off)
            for monday in _mondays(4):
                office = {"default_weekly_off": weekly_off}
                user = {"id": uid, "weekly_off": weekly_off, "photo": "x"}
                off_day = monday + timedelta(days=off_idx)
                assert _due(user, office, off_day) is False


def test_fires_exactly_once_across_a_full_week():
    """Walking each working day Mon→last, the trigger flips True at the
    assigned day and stays True (fire on FIRST check-in on/after it)."""
    for uid in [f"m-{i}" for i in range(40)]:
        weekly_off = "sunday"
        office = {"default_weekly_off": weekly_off}
        user = {"id": uid, "weekly_off": weekly_off, "photo": "x"}
        monday = _mondays(1)[0]
        working = [i for i in range(7) if NAMES[i] != weekly_off]
        results = [_due(user, office, monday + timedelta(days=wd)) for wd in working]
        # Monotonic: once True it stays True; at least the last day is True.
        assert results[-1] is True
        first_true = results.index(True)
        assert all(results[first_true:]), f"{uid}: not monotonic {results}"
        assert not any(results[:first_true]), f"{uid}: fired too early {results}"


def test_not_synchronised_across_members():
    """Different members get different assigned days in the same week
    (i.e. not everyone prompted on the same day)."""
    weekly_off = "sunday"
    office = {"default_weekly_off": weekly_off}
    monday = _mondays(1)[0]
    working = [i for i in range(7) if NAMES[i] != weekly_off]
    first_true_days = []
    for uid in [f"s-{i}" for i in range(60)]:
        user = {"id": uid, "weekly_off": weekly_off, "photo": "x"}
        results = [_due(user, office, monday + timedelta(days=wd)) for wd in working]
        first_true_days.append(working[results.index(True)])
    assert len(set(first_true_days)) >= 3, (
        f"expected assigned days to be spread out, got {sorted(set(first_true_days))}")


def test_already_refreshed_this_week_is_skipped():
    weekly_off = "sunday"
    office = {"default_weekly_off": weekly_off}
    monday = _mondays(1)[0]
    week_key = _wk(monday)
    working = [i for i in range(7) if NAMES[i] != weekly_off]
    last_day = monday + timedelta(days=working[-1])
    user = {"id": "already", "weekly_off": weekly_off, "photo": "x",
            "photo_refresh_week": week_key}
    assert _due(user, office, last_day) is False


def test_no_photo_is_handled_by_caller_not_weekly():
    # _weekly_photo_due assumes a photo exists (missing photos are forced by
    # the endpoint separately); it still shouldn't crash without the field.
    weekly_off = "sunday"
    office = {"default_weekly_off": weekly_off}
    monday = _mondays(1)[0]
    last_day = monday + timedelta(days=5)
    user = {"id": "nophoto", "weekly_off": weekly_off}
    assert _due(user, office, last_day) in (True, False)
