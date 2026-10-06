"""Iter88 — two-admin approval for admin-filed attendance corrections.

Rules under test (Oct/Jan 2026, user request):
  * non-super admin files attendance correction → pending w/ needs_second_admin=True,
    needs_super_admin=False, filer_id=<admin>; never auto-applied
  * the FILER cannot approve or reject their own request (even via bulk approve-all)
  * ANOTHER non-super admin OR a super-admin can decide the row
  * super-admin's own attendance correction still auto-applies
  * legacy pending rows (needs_super_admin=True, no needs_second_admin) are now
    approvable by another non-super admin (two-admin rule, retroactive)
  * member archive/delete queued by non-super admin STAYS super-admin only
"""
import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("REACT_APP_BACKEND_URL"):
                BASE_URL = line.split("=", 1)[1].strip().strip('"').rstrip("/")

SUPER_EMAIL = "admin@attendance.app"
SUPER_PWD = "Admin@12345"
ADMIN2_EMAIL = "admin2.test@example.com"
ADMIN2_PWD = "Admin@12345"


def _login(email, pwd):
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": pwd}, timeout=30)
    assert r.status_code == 200, f"login {email}: {r.status_code} {r.text}"
    return r.json()["access_token"]


def _s(token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def super_client():
    return _s(_login(SUPER_EMAIL, SUPER_PWD))


@pytest.fixture(scope="module")
def admin2_client(super_client, mongo):
    # Ensure admin2 exists (preview DB sometimes forks without it).
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": ADMIN2_EMAIL, "password": ADMIN2_PWD}, timeout=30)
    if r.status_code != 200:
        body = {
            "email": ADMIN2_EMAIL, "password": ADMIN2_PWD,
            "full_name": "Admin Two Test", "role": "admin",
            "category": "staff", "mobile": "9000000002",
        }
        rr = super_client.post(f"{BASE_URL}/api/members", json=body, timeout=30)
        assert rr.status_code == 200, f"create admin2 failed: {rr.text}"
    return _s(_login(ADMIN2_EMAIL, ADMIN2_PWD))


@pytest.fixture(scope="module")
def me_super(super_client):
    return super_client.get(f"{BASE_URL}/api/auth/me", timeout=30).json()


@pytest.fixture(scope="module")
def me_admin2(admin2_client):
    return admin2_client.get(f"{BASE_URL}/api/auth/me", timeout=30).json()


@pytest.fixture(scope="module")
def mongo():
    from pymongo import MongoClient
    url = os.environ.get("MONGO_URL")
    name = os.environ.get("DB_NAME")
    assert url and name, "MONGO_URL/DB_NAME required"
    return MongoClient(url)[name]


@pytest.fixture(scope="module")
def throwaway(super_client, mongo):
    """A throwaway staff member with 5 seeded attendance rows in Dec 2025."""
    sfx = uuid.uuid4().hex[:6]
    body = {
        "email": f"TEST_throwaway_{sfx}@example.com",
        "password": "Test@1234",
        "full_name": f"TEST Throwaway Member {sfx}",
        "role": "member",
        "category": "staff",
        "work_start": "09:00",
        "work_end": "18:00",
    }
    r = super_client.post(f"{BASE_URL}/api/members", json=body, timeout=30)
    assert r.status_code == 200, r.text
    m = r.json()
    # seed 5 past attendance rows
    seeds = []
    for i, d in enumerate(["2025-12-10", "2025-12-11", "2025-12-12", "2025-12-15", "2025-12-16"]):
        row = {
            "id": str(uuid.uuid4()),
            "user_id": m["id"],
            "user_name": m["full_name"],
            "date": d,
            "check_in_at": f"{d}T09:30:00+05:30",
            "check_out_at": f"{d}T18:00:00+05:30",
            "method": "manual",
            "late": True,
            "late_minutes": 30,
        }
        seeds.append(row)
    mongo.attendance.insert_many(seeds)
    yield {"member": m, "att_rows": seeds}
    # Cleanup
    mongo.attendance.delete_many({"user_id": m["id"]})
    mongo.corrections.delete_many({"$or": [{"requester_id": m["id"]}, {"entity_id": m["id"]}]})
    mongo.audit_log.delete_many({"entity_id": {"$in": [c["id"] for c in mongo.corrections.find({"requester_id": m["id"]})]}})
    mongo.users.delete_one({"id": m["id"]})


@pytest.fixture(scope="module")
def throwaway_admin(super_client, mongo):
    """A throwaway ADMIN (non-super: mobile 9000055501, not in SUPER_ADMIN_PHONES)."""
    sfx = uuid.uuid4().hex[:6]
    body = {
        "email": f"TEST_tw_admin_{sfx}@example.com",
        "password": "Test@1234",
        "full_name": f"TEST Throwaway Admin {sfx}",
        "role": "admin",
        "category": "staff",
        "mobile": f"900005{sfx[:4]}",
    }
    r = super_client.post(f"{BASE_URL}/api/members", json=body, timeout=30)
    assert r.status_code == 200, r.text
    m = r.json()
    tok = _login(body["email"], body["password"])
    cli = _s(tok)
    me = cli.get(f"{BASE_URL}/api/auth/me", timeout=30).json()
    assert me.get("role") == "admin"
    assert me.get("is_super_admin") in (False, None), f"throwaway admin should not be super: {me}"
    yield {"member": m, "client": cli, "me": me, "email": body["email"]}
    mongo.corrections.delete_many({"$or": [{"filed_by_id": m["id"]}, {"filed_by_admin_id": m["id"]}, {"requester_id": m["id"]}]})
    mongo.users.delete_one({"id": m["id"]})


# ---------------------------------------------------------------- backend tests


def test_01_admin2_files_time_adjust_pending(admin2_client, throwaway, mongo, me_admin2):
    att = throwaway["att_rows"][0]
    body = {
        "entity_type": "attendance", "kind": "time_adjust",
        "entity_id": att["id"], "target_date": att["date"],
        "on_behalf_of": throwaway["member"]["id"],
        "payload": {"check_in_time": "09:00"},
        "reason": "Iter88 admin2 time adjust",
    }
    r = admin2_client.post(f"{BASE_URL}/api/corrections", json=body, timeout=30)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["auto_approved"] is False
    assert j["needs_second_admin"] is True
    doc = mongo.corrections.find_one({"id": j["id"]}, {"_id": 0})
    assert doc["needs_second_admin"] is True
    assert doc["needs_super_admin"] is False
    assert doc["status"] == "pending"
    assert doc["filed_by_id"] == me_admin2["id"]
    # stash
    throwaway["c1_id"] = j["id"]


def test_02_filer_cannot_decide(admin2_client, throwaway):
    cid = throwaway["c1_id"]
    r = admin2_client.post(f"{BASE_URL}/api/admin/corrections/{cid}/decide",
                           json={"status": "approved"}, timeout=30)
    assert r.status_code == 403
    assert "another admin" in r.json().get("detail", "").lower()
    # reject path by filer also blocked
    r2 = admin2_client.post(f"{BASE_URL}/api/admin/corrections/{cid}/decide",
                            json={"status": "rejected", "admin_note": "nope"}, timeout=30)
    assert r2.status_code == 403


def test_03_approve_all_skips_filer_own(admin2_client, throwaway):
    cid = throwaway["c1_id"]
    r = admin2_client.post(f"{BASE_URL}/api/admin/corrections/approve-all", json={}, timeout=30)
    assert r.status_code == 200, r.text
    j = r.json()
    # row must be in errors (skipped), not approved
    err_ids = [e["id"] for e in j.get("errors", [])]
    assert cid in err_ids, f"c1 should be skipped, got {j}"


def test_04_other_nonsuper_admin_can_approve(throwaway_admin, admin2_client, throwaway, mongo):
    cid = throwaway["c1_id"]
    r = throwaway_admin["client"].post(
        f"{BASE_URL}/api/admin/corrections/{cid}/decide",
        json={"status": "approved"}, timeout=30)
    assert r.status_code == 200, r.text
    # verify applied: check attendance row updated
    att = mongo.attendance.find_one({"id": throwaway["att_rows"][0]["id"]}, {"_id": 0})
    assert att.get("corrected") is True
    assert att.get("corrected_via") == cid
    doc = mongo.corrections.find_one({"id": cid}, {"_id": 0})
    assert doc["status"] == "approved"
    assert doc["decided_by_id"] == throwaway_admin["me"]["id"]


def test_05_reject_path_other_nonsuper(admin2_client, throwaway_admin, throwaway, mongo):
    """admin2 files a second correction, throwaway non-super admin rejects it."""
    att = throwaway["att_rows"][1]
    body = {
        "entity_type": "attendance", "kind": "time_adjust",
        "entity_id": att["id"], "target_date": att["date"],
        "on_behalf_of": throwaway["member"]["id"],
        "payload": {"check_in_time": "09:05"},
        "reason": "Iter88 to-reject",
    }
    r = admin2_client.post(f"{BASE_URL}/api/corrections", json=body, timeout=30)
    assert r.status_code == 200
    cid = r.json()["id"]
    # throwaway admin rejects with note
    r2 = throwaway_admin["client"].post(
        f"{BASE_URL}/api/admin/corrections/{cid}/decide",
        json={"status": "rejected", "admin_note": "not needed"}, timeout=30)
    assert r2.status_code == 200, r2.text
    doc = mongo.corrections.find_one({"id": cid}, {"_id": 0})
    assert doc["status"] == "rejected"
    # verify att row NOT corrected
    att_db = mongo.attendance.find_one({"id": att["id"]}, {"_id": 0})
    assert att_db.get("corrected") is not True


def test_06_super_admin_can_approve_admin2_filed(super_client, admin2_client, throwaway, mongo):
    att = throwaway["att_rows"][2]
    body = {
        "entity_type": "attendance", "kind": "time_adjust",
        "entity_id": att["id"], "target_date": att["date"],
        "on_behalf_of": throwaway["member"]["id"],
        "payload": {"check_in_time": "09:00"},
        "reason": "Iter88 super approves",
    }
    r = admin2_client.post(f"{BASE_URL}/api/corrections", json=body, timeout=30)
    cid = r.json()["id"]
    r2 = super_client.post(f"{BASE_URL}/api/admin/corrections/{cid}/decide",
                           json={"status": "approved"}, timeout=30)
    assert r2.status_code == 200, r2.text
    assert mongo.corrections.find_one({"id": cid})["status"] == "approved"


def test_07_super_admin_own_correction_autoapplies(super_client, throwaway, mongo):
    att = throwaway["att_rows"][3]
    body = {
        "entity_type": "attendance", "kind": "time_adjust",
        "entity_id": att["id"], "target_date": att["date"],
        "on_behalf_of": throwaway["member"]["id"],
        "payload": {"check_in_time": "09:00"},
        "reason": "Iter88 super auto",
    }
    r = super_client.post(f"{BASE_URL}/api/corrections", json=body, timeout=30)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["auto_approved"] is True
    doc = mongo.corrections.find_one({"id": j["id"]}, {"_id": 0})
    assert doc["status"] == "approved"
    assert doc.get("needs_second_admin") is False


def test_08_legacy_pending_doc_two_admin_rule(mongo, admin2_client, throwaway_admin, throwaway, me_admin2):
    """Insert OLD-shape pending row directly: needs_super_admin:True, no
    needs_second_admin. Expect filer→403, throwaway non-super admin→200."""
    att = throwaway["att_rows"][4]
    cid = str(uuid.uuid4())
    legacy = {
        "id": cid,
        "entity_type": "attendance", "kind": "time_adjust",
        "entity_id": att["id"], "target_date": att["date"],
        "payload": {"check_in_time": "09:00"},
        "reason": "legacy row",
        "status": "pending",
        "requester_id": throwaway["member"]["id"],
        "requester_name": throwaway["member"]["full_name"],
        "requested_at": "2025-12-20T12:00:00+00:00",
        "needs_super_admin": True,
        "filed_by_admin_id": me_admin2["id"],
        "filed_by_admin_name": me_admin2.get("full_name"),
    }
    mongo.corrections.insert_one(dict(legacy))
    try:
        # filer blocked
        r = admin2_client.post(f"{BASE_URL}/api/admin/corrections/{cid}/decide",
                               json={"status": "approved"}, timeout=30)
        assert r.status_code == 403, r.text
        # other non-super admin can approve
        r2 = throwaway_admin["client"].post(
            f"{BASE_URL}/api/admin/corrections/{cid}/decide",
            json={"status": "approved"}, timeout=30)
        assert r2.status_code == 200, r2.text
        assert mongo.corrections.find_one({"id": cid})["status"] == "approved"
    finally:
        mongo.corrections.delete_one({"id": cid})


def test_09_member_archive_stays_super_admin_only(admin2_client, super_client, throwaway_admin, mongo, super_client_mkmember):
    """admin2 queues archive → non-super admin cannot approve, super can."""
    m = super_client_mkmember
    r = admin2_client.post(f"{BASE_URL}/api/members/{m['id']}/archive", timeout=30)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j.get("queued") is True
    cid = j["id"]
    doc = mongo.corrections.find_one({"id": cid}, {"_id": 0})
    assert doc["entity_type"] == "member" and doc["kind"] == "member_archive"
    # throwaway non-super admin cannot approve
    r2 = throwaway_admin["client"].post(f"{BASE_URL}/api/admin/corrections/{cid}/decide",
                                        json={"status": "approved"}, timeout=30)
    assert r2.status_code == 403, r2.text
    assert "super admin" in r2.json().get("detail", "").lower()
    # super admin can
    r3 = super_client.post(f"{BASE_URL}/api/admin/corrections/{cid}/decide",
                           json={"status": "approved"}, timeout=30)
    assert r3.status_code == 200, r3.text
    assert mongo.users.find_one({"id": m["id"]}).get("archived") is True


@pytest.fixture(scope="module")
def super_client_mkmember(super_client, mongo):
    """Extra throwaway member, separate from `throwaway` so test_09 archive doesn't nuke it."""
    sfx = uuid.uuid4().hex[:6]
    body = {
        "email": f"TEST_arch_{sfx}@example.com",
        "password": "Test@1234",
        "full_name": f"TEST Archive Target {sfx}",
        "role": "member", "category": "staff",
    }
    r = super_client.post(f"{BASE_URL}/api/members", json=body, timeout=30)
    assert r.status_code == 200, r.text
    m = r.json()
    yield m
    mongo.corrections.delete_many({"$or": [{"requester_id": m["id"]}, {"entity_id": m["id"]}]})
    mongo.users.delete_one({"id": m["id"]})
