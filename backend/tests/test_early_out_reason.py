"""Early-out reason capture — /api/attendance/geo-toggle

When a member checks out MORE THAN 15 minutes before their scheduled
`work_end`, an optional `early_out_reason` sent with the check-out is
persisted on the attendance row as `early_out_reason` + `early_out_minutes`.

Uses throwaway staff members whose `work_end` is set at creation (23:59 =
"now" is always early; 00:01 = "now" is never early), so the admin account
is never checked in/out by tests. Check-outs carry `dar_text` to satisfy
the DAR-before-checkout gate.
"""
from __future__ import annotations

import pytest

DAR = "Automated test — daily activity report text."


def _toggle(client, base_url, **extra):
    r = client.post(f"{base_url}/api/attendance/geo-toggle",
                    json={"latitude": 0, "longitude": 0, **extra}, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


def _latest_row(mongo_db, user_id):
    return mongo_db.attendance.find_one({"user_id": user_id}, sort=[("check_in_at", -1)])


def test_early_out_reason_persisted_when_leaving_early(base_url, mongo_db, make_member):
    if mongo_db is None:
        pytest.skip("mongo_db fixture unavailable")
    m = make_member("staff", login=True, work_start="00:00", work_end="23:59")
    assert _toggle(m["client"], base_url)["action"] == "checkin"
    reason_text = "Early-out reason smoke — medical appt"
    out = _toggle(m["client"], base_url, early_out_reason=reason_text, dar_text=DAR)
    assert out["action"] == "checkout"
    row = _latest_row(mongo_db, m["id"])
    assert row is not None
    assert row.get("early_out_reason") == reason_text
    assert (row.get("early_out_minutes") or 0) >= 15


def test_early_out_reason_omitted_when_on_time(base_url, mongo_db, make_member):
    if mongo_db is None:
        pytest.skip("mongo_db fixture unavailable")
    m = make_member("staff", login=True, work_start="00:00", work_end="00:01")
    assert _toggle(m["client"], base_url)["action"] == "checkin"
    out = _toggle(m["client"], base_url, early_out_reason="should be ignored", dar_text=DAR)
    assert out["action"] == "checkout"
    row = _latest_row(mongo_db, m["id"])
    assert row is not None
    assert row.get("early_out_minutes", 0) == 0
    # Reason field is None (or missing) when not actually early.
    assert not row.get("early_out_reason")
