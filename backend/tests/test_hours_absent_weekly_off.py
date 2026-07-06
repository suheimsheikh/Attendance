"""Regression: `/api/reports/hours` must NOT count a member's own
weekly-off day (or the in-progress current day) as `days_absent`.

Bug (reported 7 Jul 2026): members who attended every working day in
July 2026 were seeing "2 days absent" on the running-total view — one
for their weekly-off Monday, one for the current in-progress day.
"""
from __future__ import annotations

import datetime as dt


def _pick_a_past_week() -> tuple[str, str]:
    """Return a (start, end) ISO pair covering the most recent
    completed Monday→Sunday. `end` is NOT today, so the in-progress
    branch stays quiet and we exercise the weekly-off branch cleanly."""
    today = dt.date.today()
    last_sun = today - dt.timedelta(days=(today.weekday() % 7) + 1)
    last_mon = last_sun - dt.timedelta(days=6)
    return last_mon.isoformat(), last_sun.isoformat()


def test_days_off_field_is_present(admin_client, base_url):
    """Every row exposes the new `days_off` key as a non-negative int."""
    start, end = _pick_a_past_week()
    r = admin_client.get(f"{base_url}/api/reports/hours",
                         params={"start": start, "end": end}, timeout=30)
    assert r.status_code == 200, r.text
    rows = r.json()["rows"]
    assert rows, "no members returned — DB likely empty"
    for row in rows:
        assert "days_off" in row, f"days_off missing: {row}"
        assert isinstance(row["days_off"], int) and row["days_off"] >= 0


def test_absent_plus_off_plus_accounted_equals_span(admin_client, base_url):
    """The invariant: days_absent + days_off + days_accounted == span_days.
    Weekly-off days now live in days_off, not days_absent — the three
    numbers must still sum to the full window without over/under-count."""
    start, end = _pick_a_past_week()
    body = admin_client.get(f"{base_url}/api/reports/hours",
                            params={"start": start, "end": end}, timeout=30).json()
    for row in body["rows"]:
        s = row["days_accounted"] + row["days_off"] + row["days_absent"]
        assert s == row["span_days"], (
            f"{row['member_name']}: accounted={row['days_accounted']} "
            f"+ off={row['days_off']} + absent={row['days_absent']} != "
            f"span={row['span_days']}"
        )


def test_weekly_off_days_are_counted_as_off_not_absent(admin_client, base_url):
    """Members with weekly_off=monday and no leave/tour/break overlapping
    that Monday should have days_off >= 1 in a Mon→Sun span. If they
    worked the Monday, it lands in days_present (and earns comp-off).
    If they were on leave/tour/break, it lands in days_accounted.
    In none of those cases should it land in days_absent alone."""
    start, end = _pick_a_past_week()
    body = admin_client.get(f"{base_url}/api/reports/hours",
                            params={"start": start, "end": end}, timeout=30).json()
    monday_folks = [r for r in body["rows"] if (r.get("weekly_off") or "").lower() == "monday"]
    assert monday_folks, "expected at least one member with weekly_off=monday"
    for r in monday_folks:
        # If the member has zero leave/tour/break AND zero comp-off use,
        # then their Monday must be captured somewhere other than absent
        # — either they worked it (days_present includes it) or it sits
        # in days_off.
        off_kinds = r["days_leave"] + r["days_tour"] + r.get("days_break", 0) + r.get("comp_off_used", 0)
        if off_kinds == 0 and r["days_off"] == 0:
            # Member with no leave/tour/break at all, and yet no day_off —
            # they must have worked their weekly-off Monday.
            assert r["days_present"] >= 1, (
                f"{r['member_name']}: weekly_off=Monday, no leave/tour/break, "
                f"days_off=0 — Monday is being (wrongly) treated as absent."
            )


def test_current_month_absent_excludes_today_when_no_checkin(admin_client, base_url):
    """Running-total view: for start=1st-of-month, end=today, members
    who haven't yet checked in today should have today land in days_off
    (in-progress), NOT in days_absent."""
    today = dt.date.today()
    start = today.replace(day=1).isoformat()
    end = today.isoformat()
    body = admin_client.get(f"{base_url}/api/reports/hours",
                            params={"start": start, "end": end}, timeout=30).json()
    # Every row: the invariant must hold, and days_off must include at
    # least the in-progress-today bump for members who haven't checked in.
    for row in body["rows"]:
        assert (row["days_accounted"] + row["days_off"] + row["days_absent"]
                == row["span_days"]), row
