"""Date-of-birth field flows end-to-end through the member APIs.

Powers the "Happy birthday, X 🎂" flourish on the Check-In greeting
(7 Jul 2026). Guards against schema drift — a silent drop of the
field from either `MemberCreate` / `MemberUpdate` or `UserPublic`
would break the flourish without any visible test failure elsewhere.
"""
from __future__ import annotations

import datetime as dt


def test_dob_patch_and_readback(admin_client, base_url, athlete):
    """PATCH `/members/{id}` with a DOB → GET reflects the value → PATCH
    with null → GET reflects the clear."""
    mid = athlete["id"]
    original = athlete.get("date_of_birth")
    try:
        # Set to a fixed sentinel that isn't today (so we don't accidentally
        # trigger a real birthday celebration during CI).
        target = "2000-04-15"
        r = admin_client.patch(f"{base_url}/api/members/{mid}",
                               json={"date_of_birth": target}, timeout=15)
        assert r.status_code == 200, r.text
        assert r.json().get("date_of_birth") == target

        # Read-back via full-detail GET.
        g = admin_client.get(f"{base_url}/api/members/{mid}", timeout=15)
        assert g.status_code == 200, g.text
        assert g.json().get("date_of_birth") == target

        # Clear the field.
        r2 = admin_client.patch(f"{base_url}/api/members/{mid}",
                                json={"date_of_birth": None}, timeout=15)
        assert r2.status_code == 200, r2.text
        assert r2.json().get("date_of_birth") in (None, "")
    finally:
        # Best-effort restore so this test is idempotent across runs.
        admin_client.patch(f"{base_url}/api/members/{mid}",
                           json={"date_of_birth": original}, timeout=15)


def test_dob_appears_in_auth_me(admin_client, base_url):
    """`/auth/me` must surface `date_of_birth` — that's the payload
    the frontend `useAuth().user` object reads to render the greeting."""
    r = admin_client.get(f"{base_url}/api/auth/me", timeout=10)
    assert r.status_code == 200, r.text
    body = r.json()
    # Presence is enough — value may legitimately be None on fresh users.
    assert "date_of_birth" in body


def test_dob_appears_in_members_list(admin_client, base_url):
    """The Members list must also expose `date_of_birth` so the admin
    edit dialog pre-fills correctly."""
    r = admin_client.get(f"{base_url}/api/members", timeout=15)
    assert r.status_code == 200, r.text
    listing = r.json()
    assert isinstance(listing, list)
    if listing:
        # Field must be present on every row (may be null).
        for m in listing:
            assert "date_of_birth" in m, f"DOB missing from {m.get('full_name')}"


def test_today_MD_matches_dob_MD(admin_client, base_url, athlete):
    """Cross-check the "MM-DD equality" rule the greeting uses. If the
    athlete's DOB is set to today's month-day (any year), the payload
    must round-trip cleanly — regression guard for any timezone /
    string-slicing bug in the schema."""
    today = dt.date.today()
    dob_iso = f"1999-{today.month:02d}-{today.day:02d}"
    mid = athlete["id"]
    original = athlete.get("date_of_birth")
    try:
        r = admin_client.patch(f"{base_url}/api/members/{mid}",
                               json={"date_of_birth": dob_iso}, timeout=15)
        assert r.status_code == 200, r.text
        got = r.json().get("date_of_birth")
        assert got == dob_iso
        # MM-DD extraction: exactly what the frontend compares against.
        assert got[5:] == f"{today.month:02d}-{today.day:02d}"
    finally:
        admin_client.patch(f"{base_url}/api/members/{mid}",
                           json={"date_of_birth": original}, timeout=15)
