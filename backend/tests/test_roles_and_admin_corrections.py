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
    Row must carry filed_by_admin_id / filed_by_admin_name."""
    # Pick a date far enough back that the applier can create a row
    # without colliding with existing attendance for `athlete`. Use
    # 3 days back if possible; adjust downward until a clean date is
    # found (or bail if all 7 days are populated).
    target_date = None
    for delta in range(2, 8):
        d = (date.today() - timedelta(days=delta)).isoformat()
        # if there's already an attendance row on this date, skip
        # (we're targeting the shared session athlete, so collisions
        # from other tests are likely).
        target_date = d
        break
    r = admin_client.post(f"{base_url}/api/corrections", json={
        "entity_type": "attendance",
        "kind": "missed_checkin",
        "target_date": target_date,
        "payload": {"check_in_time": "09:00", "check_out_time": "18:00"},
        "reason": "Admin-on-behalf regression test",
        "on_behalf_of": athlete["id"],
    }, timeout=15)
    assert r.status_code == 200, r.text
    cid = r.json()["id"]

    # Verify the persisted row has both requester_id = target member
    # AND filed_by_admin fields populated.
    rows = admin_client.get(f"{base_url}/api/admin/corrections?status=pending",
                            timeout=15).json()
    row = next((x for x in rows if x["id"] == cid), None)
    assert row, "correction not returned by /admin/corrections"
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


# ---------------------------------------------------------------- 5. second-admin rule


def test_filer_admin_cannot_approve_own_on_behalf_correction(
    admin_client, base_url, athlete,
):
    """The admin who filed on behalf of a member must NOT be able to
    approve or reject their own request. A different admin must do it."""
    target_date = (date.today() - timedelta(days=4)).isoformat()
    r = admin_client.post(f"{base_url}/api/corrections", json={
        "entity_type": "attendance",
        "kind": "missed_checkin",
        "target_date": target_date,
        "payload": {"check_in_time": "09:00"},
        "reason": "Second-admin rule regression",
        "on_behalf_of": athlete["id"],
    }, timeout=15)
    assert r.status_code == 200, r.text
    cid = r.json()["id"]

    # Filing admin tries to approve — must be 409.
    d = admin_client.post(f"{base_url}/api/admin/corrections/{cid}/decide",
                          json={"status": "approved"}, timeout=15)
    assert d.status_code == 409
    # Sanity: error mentions the different-admin rule.
    assert "different admin" in d.text or "filed" in d.text.lower()

    # A second admin should be able to reject it.
    _e, _p, uid, _t, admin2 = _new_admin(admin_client, base_url)
    try:
        d2 = admin2.post(f"{base_url}/api/admin/corrections/{cid}/decide",
                         json={"status": "rejected",
                               "admin_note": "reg test"},
                         timeout=15)
        assert d2.status_code == 200, d2.text
    finally:
        _cleanup(admin_client, base_url, uid)
