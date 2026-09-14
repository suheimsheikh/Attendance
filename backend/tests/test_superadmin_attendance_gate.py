"""Super-Admin gate for attendance corrections (Jun 2026, user request):

"All changes, edits, deletions to Attendance need to be part of the audit
log and sent to Super Admin for approval in the same approvals screen as
Leave."

Behaviour under test:
  1. A NON-super admin filing an attendance correction does NOT auto-apply
     — it lands pending with needs_super_admin=True.
  2. A non-super admin cannot approve/reject that row (403).
  3. A Super Admin (admin_client — phone on SUPER_ADMIN_PHONES) can approve
     it and the change applies.
  4. A non-super admin filing a LEAVE correction still auto-applies
     (scope is attendance-only).

The seeded admin (admin@attendance.app) is the Super Admin in every
environment (phone 9849002111 backfilled on boot), so admin_client acts
as the Super Admin here.
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest
import requests


@pytest.fixture(scope="module")
def plain_admin_session(admin_client, base_url):
    """A fresh admin with NO super-admin phone → is_super_admin == False."""
    email = f"plainadmin-{uuid.uuid4().hex[:6]}@yachtclub.in"
    pw = "Plain@1234"
    r = admin_client.post(f"{base_url}/api/members", json={
        "email": email, "password": pw,
        "full_name": "Plain Admin", "role": "admin", "category": "executive",
    }, timeout=30)
    assert r.status_code == 200, r.text
    uid = r.json()["id"]
    tok = requests.post(f"{base_url}/api/auth/login",
                        json={"email": email, "password": pw},
                        timeout=15).json()["access_token"]
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {tok}",
                      "Content-Type": "application/json"})
    yield s
    try:
        admin_client.delete(f"{base_url}/api/members/{uid}", timeout=15)
    except Exception:
        pass


@pytest.fixture(scope="module")
def throwaway_athlete(admin_client, base_url):
    """A dedicated athlete so the gate test's applied attendance row never
    pollutes a real member's history. Deleted (with its attendance) after."""
    email = f"gate-athlete-{uuid.uuid4().hex[:6]}@yachtclub.in"
    r = admin_client.post(f"{base_url}/api/members", json={
        "email": email, "password": "Gate@1234",
        "full_name": "Gate Test Athlete", "role": "member", "category": "athlete",
    }, timeout=30)
    assert r.status_code == 200, r.text
    row = r.json()
    yield row
    try:
        admin_client.delete(f"{base_url}/api/members/{row['id']}", timeout=15)
    except Exception:
        pass


def test_plain_admin_is_not_super(plain_admin_session, base_url):
    me = plain_admin_session.get(f"{base_url}/api/auth/me", timeout=15).json()
    assert me.get("is_super_admin") is False


def test_admin_is_super(admin_client, base_url):
    me = admin_client.get(f"{base_url}/api/auth/me", timeout=15).json()
    assert me.get("is_super_admin") is True


def test_attendance_correction_needs_super_admin_end_to_end(
    admin_client, base_url, plain_admin_session, throwaway_athlete,
):
    aid = throwaway_athlete["id"]

    # 1. Non-super admin files an attendance missed_checkin — must NOT
    #    auto-apply; must be pending + needs_super_admin.
    cid = None
    for delta in range(2, 30):
        d = (date.today() - timedelta(days=delta)).isoformat()
        r = plain_admin_session.post(f"{base_url}/api/corrections", json={
            "entity_type": "attendance", "kind": "missed_checkin",
            "target_date": d,
            "payload": {"check_in_time": "09:00", "check_out_time": "18:00"},
            "reason": "super-admin gate regression",
            "on_behalf_of": aid,
        }, timeout=15)
        if r.status_code == 200:
            body = r.json()
            cid = body["id"]
            break
    assert cid, "could not file an attendance correction on a clean date"
    assert body.get("auto_approved") is False
    assert body.get("needs_super_admin") is True

    # Persisted row is pending with the flag set.
    pend = admin_client.get(f"{base_url}/api/admin/corrections?status=pending",
                            timeout=15).json()
    row = next((x for x in pend if x["id"] == cid), None)
    assert row and row["status"] == "pending"
    assert row.get("needs_super_admin") is True

    # 2. Non-super admin cannot decide it.
    r = plain_admin_session.post(
        f"{base_url}/api/admin/corrections/{cid}/decide",
        json={"status": "approved"}, timeout=15)
    assert r.status_code == 403, r.text

    # 3. Super Admin approves → applies.
    r = admin_client.post(
        f"{base_url}/api/admin/corrections/{cid}/decide",
        json={"status": "approved"}, timeout=15)
    assert r.status_code == 200, r.text
    assert r.json().get("applied"), "super-admin approval must apply the change"


def test_leave_correction_still_auto_applies_for_plain_admin(
    admin_client, base_url, plain_admin_session, throwaway_athlete,
):
    """Scope is attendance-only. A non-super admin's LEAVE correction still
    auto-applies (needs_super_admin stays False)."""
    aid = throwaway_athlete["id"]
    # Give the athlete an approved leave to correct.
    start = (date.today() - timedelta(days=3)).isoformat()
    end = start
    lr = admin_client.post(f"{base_url}/api/leaves", json={
        "user_id": aid, "type": "leave",
        "start_date": start, "end_date": end,
        "reason": "gate leave", "status": "approved",
    }, timeout=15)
    if lr.status_code != 200:
        pytest.skip(f"could not seed an approved leave: {lr.status_code} {lr.text[:120]}")
    leave_id = lr.json().get("id")
    assert leave_id

    r = plain_admin_session.post(f"{base_url}/api/corrections", json={
        "entity_type": "leave", "kind": "leave_type_change",
        "entity_id": leave_id, "target_date": start,
        "payload": {"type": "tour"}, "reason": "leave auto-apply regression",
        "on_behalf_of": aid,
    }, timeout=15)
    assert r.status_code == 200, r.text
    assert r.json().get("auto_approved") is True
    assert r.json().get("needs_super_admin") in (False, None)
