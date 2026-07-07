"""OT-eligibility flag flows end-to-end.

Guards the 7 Jul 2026 admin-controlled OT-eligibility opt-out:
`ot_eligible=False` disables OT accrual for a staff member even when
they clock in early or out late. `None` / `True` preserve the pre-
existing category-based rule.
"""
from __future__ import annotations

import datetime as dt


def test_ot_eligible_defaults_to_none_or_true(admin_client, base_url):
    """Fresh `/auth/me` payload exposes the field. May be missing on
    legacy users — the shape check just guards that PATCH round-trips
    the value the frontend sends."""
    r = admin_client.get(f"{base_url}/api/auth/me", timeout=10)
    assert r.status_code == 200
    body = r.json()
    assert "ot_eligible" in body


def test_ot_eligible_patch_roundtrip(admin_client, base_url, athlete):
    mid = athlete["id"]
    original = athlete.get("ot_eligible")
    try:
        r = admin_client.patch(f"{base_url}/api/members/{mid}",
                               json={"ot_eligible": False}, timeout=15)
        assert r.status_code == 200, r.text
        assert r.json().get("ot_eligible") is False

        r2 = admin_client.patch(f"{base_url}/api/members/{mid}",
                                json={"ot_eligible": True}, timeout=15)
        assert r2.status_code == 200
        assert r2.json().get("ot_eligible") is True
    finally:
        admin_client.patch(f"{base_url}/api/members/{mid}",
                           json={"ot_eligible": original}, timeout=15)


def test_ot_calculation_gated_by_flag():
    """Direct unit test on the calculator so we don't need a whole
    check-in flow to exercise the gate."""
    from services.attendance_calc import compute_overtime_in, compute_overtime_out
    ts = dt.datetime(2026, 7, 7, 6, 0, tzinfo=dt.timezone.utc)
    # Pin the office tz to UTC so the ts arithmetic below is direct.
    office = {"timezone": "UTC"}
    # Staff, work_start 09:00, arriving 06:00 → ~180 min early OT.
    base_member = {"category": "staff", "work_start": "09:00", "work_end": "18:00"}
    early, _ = compute_overtime_in(office, base_member, ts)
    assert early > 60, f"expected early OT ~180, got {early}"

    # Same member with ot_eligible=False → zero.
    opted_out = {**base_member, "ot_eligible": False}
    early2, _ = compute_overtime_in(office, opted_out, ts)
    assert early2 == 0, "ot_eligible=False must suppress early OT"

    # ot_eligible=True is the same as unset for a staff member.
    opted_in = {**base_member, "ot_eligible": True}
    early3, _ = compute_overtime_in(office, opted_in, ts)
    assert early3 == early

    # Same gate for late-out.
    late_ts = dt.datetime(2026, 7, 7, 20, 0, tzinfo=dt.timezone.utc)
    late, _ = compute_overtime_out(office, base_member, late_ts)
    assert late > 60
    late2, _ = compute_overtime_out(office, opted_out, late_ts)
    assert late2 == 0

    # Athletes still never accrue OT regardless of flag (category gate wins).
    athlete_optin = {"category": "athlete", "work_start": "09:00",
                     "work_end": "18:00", "ot_eligible": True}
    e, _ = compute_overtime_in(office, athlete_optin, ts)
    assert e == 0, "athletes must never accrue OT even with ot_eligible=True"
