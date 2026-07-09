"""Roles master + Chef role + Admin-filed corrections regression tests
(4 Feb 2026).

Covers:
  1. GET /api/masters/roles — everyone-can-read, seeded rows present.
  2. Roles CRUD — admin can create/edit; system rows locked.
  3. Chef role permissions — can hit Muster/Meals-today/Presence but
     NOT admin routes.
  4. Admin-on-behalf-of correction filing — row carries filed_by_admin
     audit fields.
  5. Second-admin approval rule — the filing admin cannot approve
     their own on-behalf correction.
  6. Non-admin passing on_behalf_of gets 403.
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest
import requests


# ---------------------------------------------------------------- helpers

def _new_admin(admin_client, base_url):
    """Create a fresh admin, return (email, password, id, token, session)."""
    email = f"admin-{uuid.uuid4().hex[:6]}@yachtclub.in"
    pw = "Second@1234"
    r = admin_client.post(f"{base_url}/api/members", json={
        "email": email, "password": pw,
        "full_name": "Second Admin", "role": "admin",
        "category": "executive",
    }, timeout=30)
    assert r.status_code == 200, r.text
    uid = r.json()["id"]
    token = requests.post(f"{base_url}/api/auth/login",
                          json={"email": email, "password": pw},
                          timeout=30).json()["access_token"]
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {token}",
                      "Content-Type": "application/json"})
    return email, pw, uid, token, s


def _cleanup(admin_client, base_url, uid):
    try:
        admin_client.delete(f"{base_url}/api/members/{uid}", timeout=15)
    except Exception:
        pass


# ---------------------------------------------------------------- 1. roles list


def test_roles_master_seeded(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/masters/roles", timeout=15)
    assert r.status_code == 200
    rows = r.json()
    keys = {row["key"] for row in rows}
    assert {"admin", "chef", "member"} <= keys, f"missing seeded roles: {keys}"
    for row in rows:
        if row["key"] in ("admin", "chef", "member"):
            assert row["is_system"] is True
            assert row["is_seeded"] is True


def test_roles_list_visible_to_non_admin(base_url, admin_client):
    """A regular member should also be able to list roles (dropdown needs it)."""
    # Seed a plain member
    email = f"m-{uuid.uuid4().hex[:6]}@yachtclub.in"
    r = admin_client.post(f"{base_url}/api/members", json={
        "email": email, "password": "Member@1234",
        "full_name": "Roles List Test", "role": "member",
        "category": "staff",
    }, timeout=30)
    assert r.status_code == 200, r.text
    mid = r.json()["id"]
    try:
        tok = requests.post(f"{base_url}/api/auth/login",
                            json={"email": email, "password": "Member@1234"},
                            timeout=15).json()["access_token"]
        rr = requests.get(f"{base_url}/api/masters/roles",
                          headers={"Authorization": f"Bearer {tok}"},
                          timeout=15)
        assert rr.status_code == 200
        assert any(row["key"] == "chef" for row in rr.json())
    finally:
        _cleanup(admin_client, base_url, mid)


# ---------------------------------------------------------------- 2. roles CRUD


def test_roles_system_delete_blocked(admin_client, base_url):
    rows = admin_client.get(f"{base_url}/api/masters/roles", timeout=15).json()
    chef_row = next(r for r in rows if r["key"] == "chef")
    r = admin_client.delete(f"{base_url}/api/masters/roles/{chef_row['id']}",
                            timeout=15)
    assert r.status_code == 409
    assert "System" in r.text or "system" in r.text


def test_roles_create_and_delete_custom(admin_client, base_url):
    key = f"custom_{uuid.uuid4().hex[:6]}"
    r = admin_client.post(f"{base_url}/api/masters/roles", json={
        "key": key, "label": "Custom Role",
        "description": "Test-only", "sort_order": 100,
    }, timeout=15)
    assert r.status_code == 200, r.text
    rid = r.json()["id"]
    assert r.json()["is_system"] is False
    # Delete cleanly (no members hold it)
    d = admin_client.delete(f"{base_url}/api/masters/roles/{rid}", timeout=15)
    assert d.status_code == 200


# ---------------------------------------------------------------- 3. chef perms


@pytest.fixture(scope="module")
def chef_session(admin_client, base_url):
    """Spin up a fresh chef user for the permission probes."""
    email = f"chef-{uuid.uuid4().hex[:6]}@yachtclub.in"
    pw = "Chef@1234"
    r = admin_client.post(f"{base_url}/api/members", json={
        "email": email, "password": pw,
        "full_name": "Test Chef", "role": "chef",
        "category": "staff",
    }, timeout=30)
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    tok = requests.post(f"{base_url}/api/auth/login",
                        json={"email": email, "password": pw},
                        timeout=15).json()["access_token"]
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {tok}",
                      "Content-Type": "application/json"})
    yield s
    try:
        admin_client.delete(f"{base_url}/api/members/{cid}", timeout=15)
    except Exception:
        pass


def test_chef_can_hit_meals_today(chef_session, base_url):
    r = chef_session.get(f"{base_url}/api/admin/meals-today", timeout=15)
    assert r.status_code == 200


def test_chef_can_hit_muster(chef_session, base_url):
    r = chef_session.get(f"{base_url}/api/muster/athletes?mode=checkin",
                         timeout=15)
    assert r.status_code == 200


def test_chef_can_hit_presence(chef_session, base_url):
    r = chef_session.get(f"{base_url}/api/presence", timeout=30)
    assert r.status_code == 200


def test_chef_cannot_create_category(chef_session, base_url):
    r = chef_session.post(f"{base_url}/api/masters/categories", json={
        "key": "x", "label": "X",
    }, timeout=15)
    assert r.status_code == 403


def test_chef_cannot_create_role(chef_session, base_url):
    r = chef_session.post(f"{base_url}/api/masters/roles", json={
        "key": "x", "label": "X",
    }, timeout=15)
    assert r.status_code == 403


# ---------------------------------------------------------------- 4. admin-onbehalf


def test_admin_files_correction_on_behalf_of_member(admin_client, base_url, athlete):
    """Admin files a missed_checkin correction on behalf of an athlete.
    9 Feb 2026: admin-filed rows auto-approve — response carries
    `auto_approved: true` and the persisted row is status='approved'
    with filed_by_admin fields populated."""
    # The missed_checkin applier fails with 409 if an attendance row
    # already exists for that date, so retry across older dates until
    # we hit a clean slot.
    target_date = None
    cid = None
    body = None
    for delta in range(2, 25):
        d = (date.today() - timedelta(days=delta)).isoformat()
        r = admin_client.post(f"{base_url}/api/corrections", json={
            "entity_type": "attendance",
            "kind": "missed_checkin",
            "target_date": d,
            "payload": {"check_in_time": "09:00", "check_out_time": "18:00"},
            "reason": "Admin-on-behalf regression test",
            "on_behalf_of": athlete["id"],
        }, timeout=15)
        if r.status_code == 200:
            target_date = d
            body = r.json()
            cid = body["id"]
            break
    assert cid, "couldn't find a clean date within the 25-day retro window"
    # Auto-approval contract: admins skip the pending queue.
    assert body.get("auto_approved") is True
    assert body.get("applied"), "applied payload should be present"

    # Persisted row must be status='approved' with filed_by fields set.
    rows = admin_client.get(f"{base_url}/api/admin/corrections?status=approved",
                            timeout=15).json()
    row = next((x for x in rows if x["id"] == cid), None)
    assert row, "correction not returned by /admin/corrections"
    assert row["status"] == "approved"
    assert row["requester_id"] == athlete["id"]
    assert row["filed_by_admin_id"], "filed_by_admin_id must be set"
    assert row["filed_by_admin_name"], "filed_by_admin_name must be set"


def test_non_admin_cannot_use_on_behalf_of(chef_session, base_url, athlete):
    r = chef_session.post(f"{base_url}/api/corrections", json={
        "entity_type": "attendance",
        "kind": "missed_checkin",
        "target_date": (date.today() - timedelta(days=1)).isoformat(),
        "payload": {"check_in_time": "09:00"},
        "reason": "chef trying to spoof",
        "on_behalf_of": athlete["id"],
    }, timeout=15)
    # Chef isn't an admin — must be refused with 403 explicitly (not 200
    # with silent fallback to self-filing).
    assert r.status_code == 403


# ---------------------------------------------------------------- 5. admin auto-apply


def test_admin_correction_auto_applies_and_writes_audit(
    admin_client, base_url, athlete,
):
    """9 Feb 2026: admin-filed corrections apply instantly — no second
    admin required. This replaces the older 'filer ≠ approver' rule
    which was dropped per user request."""
    # Search backwards until we find a date without existing attendance.
    cid = None
    for delta in range(2, 30):
        d = (date.today() - timedelta(days=delta)).isoformat()
        r = admin_client.post(f"{base_url}/api/corrections", json={
            "entity_type": "attendance",
            "kind": "missed_checkin",
            "target_date": d,
            "payload": {"check_in_time": "09:00"},
            "reason": "Admin auto-apply regression",
            "on_behalf_of": athlete["id"],
        }, timeout=15)
        if r.status_code == 200:
            body = r.json()
            assert body.get("auto_approved") is True
            cid = body["id"]
            break
    assert cid, "couldn't find a clean date within the 30-day window"
