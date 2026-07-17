"""Early-out reason capture — /api/attendance/geo-toggle

Validates the 13 Feb 2026 addition: when a member checks out MORE THAN
15 minutes before their scheduled `work_end`, an optional `early_out_reason`
sent alongside the check-out payload is persisted on the attendance row as
`early_out_reason` + `early_out_minutes`, and the reason is surfaced back
via /api/me/profile-details → early_outs_this_month[].reason.

Rather than fighting real-time clocks, we mutate the admin user's
`work_end` to something well in the future (23:59) so any check-out done
"now" is guaranteed to be more than 15 minutes early — deterministic and
independent of when the test runs.
"""
from __future__ import annotations

import os
import requests


BASE = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")


def _admin_headers(base_url) -> dict:
    r = requests.post(
        f"{base_url}/api/auth/login",
        json={"email": "admin@attendance.app",
              "password": os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345")},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _clean_session(base_url, headers):
    """Ensure admin is checked-OUT so the next call opens a fresh session."""
    me = requests.get(f"{base_url}/api/attendance/status",
                      headers=headers, timeout=30).json()
    if me.get("checked_in"):
        requests.post(f"{base_url}/api/attendance/geo-toggle",
                      headers=headers,
                      json={"latitude": 0, "longitude": 0},
                      timeout=30)


def test_early_out_reason_persisted_when_leaving_early(base_url, mongo_db):
    """Check-out with `early_out_reason` when >15 min before work_end
    stamps both the reason and the minute count on the attendance row."""
    if mongo_db is None:
        import pytest
        pytest.skip("mongo_db fixture unavailable")

    headers = _admin_headers(base_url)
    admin_me = requests.get(f"{base_url}/api/auth/me",
                            headers=headers, timeout=30).json()
    admin_id = admin_me["id"]

    original_work_end = admin_me.get("work_end")
    # Push work_end to end-of-day so "now" is guaranteed early.
    mongo_db.users.update_one({"id": admin_id},
                              {"$set": {"work_end": "23:59"}})
    try:
        _clean_session(base_url, headers)
        # Fresh check-IN.
        r1 = requests.post(f"{base_url}/api/attendance/geo-toggle",
                           headers=headers,
                           json={"latitude": 0, "longitude": 0},
                           timeout=30)
        assert r1.status_code == 200 and r1.json()["action"] == "checkin"

        reason_text = "Early-out reason smoke — medical appt"
        r2 = requests.post(f"{base_url}/api/attendance/geo-toggle",
                           headers=headers,
                           json={"latitude": 0, "longitude": 0,
                                 "early_out_reason": reason_text},
                           timeout=30)
        assert r2.status_code == 200 and r2.json()["action"] == "checkout"

        # Latest session for admin — should carry the stamp.
        row = mongo_db.attendance.find_one(
            {"user_id": admin_id},
            sort=[("check_in_at", -1)],
        )
        assert row is not None, "no attendance row found for admin"
        assert row.get("early_out_reason") == reason_text
        assert (row.get("early_out_minutes") or 0) >= 15
    finally:
        # Restore work_end so we don't poison other tests.
        if original_work_end:
            mongo_db.users.update_one({"id": admin_id},
                                      {"$set": {"work_end": original_work_end}})
        else:
            mongo_db.users.update_one({"id": admin_id},
                                      {"$unset": {"work_end": ""}})


def test_early_out_reason_omitted_when_on_time(base_url, mongo_db):
    """Check-out when NOT leaving early keeps `early_out_reason=None`
    and `early_out_minutes=0` even if a reason string was supplied."""
    if mongo_db is None:
        import pytest
        pytest.skip("mongo_db fixture unavailable")

    headers = _admin_headers(base_url)
    admin_me = requests.get(f"{base_url}/api/auth/me",
                            headers=headers, timeout=30).json()
    admin_id = admin_me["id"]

    original_work_end = admin_me.get("work_end")
    # Push work_end into the past so "now" is well after end-of-work.
    mongo_db.users.update_one({"id": admin_id},
                              {"$set": {"work_end": "00:01"}})
    try:
        _clean_session(base_url, headers)
        r1 = requests.post(f"{base_url}/api/attendance/geo-toggle",
                           headers=headers,
                           json={"latitude": 0, "longitude": 0},
                           timeout=30)
        assert r1.json()["action"] == "checkin"

        r2 = requests.post(f"{base_url}/api/attendance/geo-toggle",
                           headers=headers,
                           json={"latitude": 0, "longitude": 0,
                                 "early_out_reason": "should be ignored"},
                           timeout=30)
        assert r2.json()["action"] == "checkout"

        row = mongo_db.attendance.find_one(
            {"user_id": admin_id},
            sort=[("check_in_at", -1)],
        )
        assert row is not None
        assert row.get("early_out_minutes", 0) == 0
        # Reason field is None (or missing) when not actually early.
        assert not row.get("early_out_reason")
    finally:
        if original_work_end:
            mongo_db.users.update_one({"id": admin_id},
                                      {"$set": {"work_end": original_work_end}})
        else:
            mongo_db.users.update_one({"id": admin_id},
                                      {"$unset": {"work_end": ""}})
