"""Regression suite for the Presence Board split (Refactor #5, 12 Oct 2026).

`GET /api/presence` moved from server.py → routes/presence_board.py with
ZERO behaviour change. These tests lock the contract so a future edit to
the extracted module can't silently drift the payload:

  * full top-level shape + types
  * counts are internally consistent (buckets sum to total; late subset)
  * every member row carries the full documented key set
  * historical (`?on=`) views are deterministic (identical across calls)
  * historical views set is_historical + suppress the live-only escort strip
  * by_location buckets are well-formed and only cover present members
"""
from __future__ import annotations

import datetime
import os

import requests

TOP_KEYS = {
    "members", "counts", "by_location", "date", "is_historical",
    "admin_contacts", "notify_grace_minutes", "escorts_present",
}

MEMBER_KEYS = {
    "id", "full_name", "role", "category", "rank", "institution", "fleet",
    "leaving_date", "status", "detail", "site_id", "site_name", "since",
    "photo", "flagged", "late", "expected_return", "expected_return_time",
    "overdue_minutes", "geo_in", "geo_out", "father_mobile", "mother_mobile",
    "guardian_mobile", "work_start", "notified_today", "notify_due",
    "excursion_count", "excursions", "sessions_today_count", "leave_kind",
    "half_day", "days_remaining", "days_absent_streak", "check_in_at",
    "check_in_time", "check_out_at", "check_out_time", "stored_hours",
    "auto_checkout", "auto_checkout_reason", "late_minutes",
}

STATUSES = {"on_campus", "temp_out", "on_tour", "on_leave", "absent", "exited", "not_due"}

# A fixed past date — historical views are fully deterministic (no "now").
PAST_DATE = os.environ.get("PRESENCE_PAST_DATE", "2026-09-15")


def _login(base_url) -> str:
    r = requests.post(
        f"{base_url}/api/auth/login",
        json={"email": os.environ.get("TEST_ADMIN_EMAIL", "admin@attendance.app"),
              "password": os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345")},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def _get(base_url, token, on=None):
    params = {"on": on} if on else {}
    r = requests.get(f"{base_url}/api/presence", headers={"Authorization": f"Bearer {token}"},
                     params=params, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


def test_top_level_shape(base_url):
    body = _get(base_url, _login(base_url))
    assert set(body.keys()) == TOP_KEYS, f"unexpected top keys: {set(body.keys()) ^ TOP_KEYS}"
    assert isinstance(body["members"], list)
    assert isinstance(body["counts"], dict)
    assert isinstance(body["by_location"], list)
    assert isinstance(body["escorts_present"], list)
    assert isinstance(body["admin_contacts"], list)
    assert body["is_historical"] is False


def test_counts_are_internally_consistent(base_url):
    body = _get(base_url, _login(base_url))
    counts, members = body["counts"], body["members"]
    assert counts["total"] == len(members)
    bucket_sum = sum(counts[s] for s in STATUSES)
    assert bucket_sum == len(members), (bucket_sum, len(members))
    # `late` is a subset counter, not a status bucket.
    assert counts["late"] == sum(1 for m in members if m.get("late"))
    for s in STATUSES:
        assert counts[s] == sum(1 for m in members if m["status"] == s), s


def test_every_member_has_full_key_set(base_url):
    body = _get(base_url, _login(base_url))
    for m in body["members"]:
        missing = MEMBER_KEYS - set(m.keys())
        assert not missing, f"member {m.get('id')} missing keys: {missing}"
        assert m["status"] in STATUSES
        # Off-status rows must never leak a training-location tag.
        if m["status"] not in ("on_campus", "temp_out"):
            assert m["site_id"] is None and m["site_name"] is None


def test_historical_view_is_deterministic(base_url):
    token = _login(base_url)
    import json
    a = _get(base_url, token, on=PAST_DATE)
    b = _get(base_url, token, on=PAST_DATE)
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True), \
        "historical presence view drifted between two identical calls"
    assert a["is_historical"] is True
    assert a["date"] == PAST_DATE
    # Live-only escort strip is suppressed on past days.
    assert a["escorts_present"] == []


def test_by_location_only_covers_present_members(base_url):
    body = _get(base_url, _login(base_url))
    present = sum(1 for m in body["members"] if m["status"] in ("on_campus", "temp_out"))
    loc_total = sum(b["count"] for b in body["by_location"])
    assert loc_total == present, (loc_total, present)
    for b in body["by_location"]:
        assert {"site_id", "site_name", "count", "by_category"} <= set(b.keys())
        assert b["count"] == sum(b["by_category"].values()) or b["count"] >= sum(b["by_category"].values())
