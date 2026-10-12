"""Presence ↔ Grid parity for athlete-like members (12 Oct 2026).

User rule: athletes are tracked ONLY on camp days. The Grid blanks a
non-camp athlete (and excludes them from totals), and shows NJ/LF outside
their joining/leaving window. The Presence Board must reflect the SAME
truth — a non-camp athlete on leave/tour/break must NOT leak into the
"Away" column, and a pre-joining / left athlete must not appear either.

These tests assert that, for any given date, the set of athlete-like
members shown on /api/presence equals the set the Grid tracks with a
real (non-blank, non-NJ/LF) code that day.
"""
from __future__ import annotations

import os

import pytest
import requests

ATHLETE_LIKE = {"athlete", "elite"}
# Codes the Grid uses for days that are NOT "tracked" for a member
# (blank / pre-joining / left). None == an empty/unclassified cell.
UNTRACKED = {"", "NJ", "LF", None}


def _login(base_url) -> str:
    r = requests.post(
        f"{base_url}/api/auth/login",
        json={"email": os.environ.get("TEST_ADMIN_EMAIL", "admin@attendance.app"),
              "password": os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345")},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def _presence(base_url, token, on):
    r = requests.get(f"{base_url}/api/presence", headers={"Authorization": f"Bearer {token}"},
                     params={"on": on}, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


def _grid(base_url, token, month):
    r = requests.get(f"{base_url}/api/reports/calendar-grid",
                     headers={"Authorization": f"Bearer {token}"},
                     params={"month": month}, timeout=60)
    assert r.status_code == 200, r.text
    return r.json()


# Weekend-camp dates (Agape Sat/Sun) + a weekday camp date — these exercise
# the day-of-week match and the joining-window exclusion.
@pytest.mark.parametrize("on", ["2026-07-11", "2026-07-18", "2026-08-20"])
def test_presence_athletes_match_grid_tracked(base_url, on):
    token = _login(base_url)
    month = on[:7]
    pres = _presence(base_url, token, on)
    grid = _grid(base_url, token, month)
    days = grid["days"]
    if on not in days:
        pytest.skip(f"{on} not in grid month {month}")
    di = days.index(on)

    cell, cat = {}, {}
    for row in grid["rows"]:
        cell[row["member_id"]] = row["cells"][di]
        cat[row["member_id"]] = row.get("category")

    shown = {m["id"] for m in pres["members"] if m["category"] in ATHLETE_LIKE}
    tracked = {uid for uid, c in cell.items()
               if cat.get(uid) in ATHLETE_LIKE and c not in UNTRACKED}

    only_presence = shown - tracked   # shown on board but Grid blanks/excludes
    only_grid = tracked - shown       # Grid tracks but board hides
    assert not only_presence, (
        f"{on}: athletes on Presence board that the Grid does NOT track: "
        + ", ".join(sorted(f"{u}={cell.get(u)!r}" for u in only_presence))[:300]
    )
    assert not only_grid, (
        f"{on}: athletes the Grid tracks but Presence hides: "
        + ", ".join(sorted(f"{u}={cell.get(u)!r}" for u in only_grid))[:300]
    )


def test_live_board_has_no_noncamp_athletes_in_away(base_url):
    """If no camp is active today, no athlete-like member may appear in the
    merged Away column (on_leave / on_tour) — they're not expected at all."""
    token = _login(base_url)
    today = _presence(base_url, token, on=None)
    away_ath = [m for m in today["members"]
                if m["status"] in ("on_leave", "on_tour") and m["category"] in ATHLETE_LIKE]
    # Only meaningful when the board has athlete-like members at all.
    cnt = requests.get(f"{base_url}/api/camps", headers={"Authorization": f"Bearer {token}"},
                       timeout=30).json()
    todays = [c for c in cnt
              if (c.get("start_date") or "9999") <= today["date"] <= (c.get("end_date") or "")]
    if todays:
        pytest.skip("a camp is active today — athletes may legitimately be away")
    assert not away_ath, (
        "non-camp athletes leaked into the Away column: "
        + ", ".join(sorted(m["full_name"] for m in away_ath))[:300]
    )
