"""Iter90 — Short-notice office-local date, Correction approve race, Add-member empty strings.

Covers:
  * leaves.py short-notice uses office-local date (today+2 flags short_notice,
    today+10 does not; 3rd short-notice in the month → short_notice_lop + lop_days=requested).
  * corrections.py _decide_one atomic claim — concurrent approvals: exactly ONE 200
    and ONE 409; attendance row created exactly once; final status=approved; no deciding_by_id.
    Also: single approve/reject still works; approve on decided → 409.
"""
import os
import uuid
import threading
import pytest
import requests
from datetime import date, timedelta

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
def mongo():
    from pymongo import MongoClient
    url = os.environ.get("MONGO_URL")
    name = os.environ.get("DB_NAME")
    return MongoClient(url)[name]


@pytest.fixture(scope="module")
def super_client():
    return _s(_login(SUPER_EMAIL, SUPER_PWD))


@pytest.fixture(scope="module")
def admin2_client(super_client):
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": ADMIN2_EMAIL, "password": ADMIN2_PWD}, timeout=30)
    if r.status_code != 200:
        body = {"email": ADMIN2_EMAIL, "password": ADMIN2_PWD, "full_name": "Admin Two Test",
                "role": "admin", "category": "staff", "mobile": "9000000002"}
        super_client.post(f"{BASE_URL}/api/members", json=body, timeout=30)
    return _s(_login(ADMIN2_EMAIL, ADMIN2_PWD))


@pytest.fixture(scope="module")
def office_today(super_client):
    """Office-local today — fetched via the same local_date_str helper by hitting a config endpoint.
    Fallback: compute from Asia/Kolkata."""
    # Use zoneinfo to get Asia/Kolkata today
    try:
        from zoneinfo import ZoneInfo
        from datetime import datetime
        return datetime.now(ZoneInfo("Asia/Kolkata")).date()
    except Exception:
        return date.today()


# ===== Section A: Short-notice office-local date =====

@pytest.fixture(scope="function")
def throwaway_member(super_client, mongo):
    sfx = uuid.uuid4().hex[:6]
    body = {"email": f"TEST_iter90_m_{sfx}@example.com", "password": "Test@1234",
            "full_name": f"TEST Iter90 Member {sfx}", "role": "member", "category": "staff",
            "work_start": "09:00", "work_end": "18:00"}
    r = super_client.post(f"{BASE_URL}/api/members", json=body, timeout=30)
    assert r.status_code == 200, r.text
    m = r.json()
    cli = _s(_login(body["email"], body["password"]))
    yield {"member": m, "client": cli, "email": body["email"]}
    mongo.leaves.delete_many({"user_id": m["id"]})
    mongo.attendance.delete_many({"user_id": m["id"]})
    mongo.corrections.delete_many({"requester_id": m["id"]})
    mongo.users.delete_one({"id": m["id"]})


def test_short_notice_today_plus_2_flags_true(throwaway_member, office_today, mongo):
    sd = (office_today + timedelta(days=2)).isoformat()
    body = {"type": "leave", "start_date": sd, "end_date": sd, "reason": "Iter90 SN+2"}
    r = throwaway_member["client"].post(f"{BASE_URL}/api/leaves", json=body, timeout=30)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["short_notice"] is True, f"Expected short_notice=True for start today+2; got {j}"
    assert j["short_notice_lop"] is False
    mongo.leaves.delete_one({"id": j["id"]})


def test_short_notice_today_plus_10_flags_false(throwaway_member, office_today, mongo):
    sd = (office_today + timedelta(days=10)).isoformat()
    body = {"type": "leave", "start_date": sd, "end_date": sd, "reason": "Iter90 SN+10"}
    r = throwaway_member["client"].post(f"{BASE_URL}/api/leaves", json=body, timeout=30)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["short_notice"] is False, f"Expected short_notice=False for start today+10; got {j}"
    mongo.leaves.delete_one({"id": j["id"]})


def test_short_notice_third_forces_lop(throwaway_member, office_today, mongo):
    """3rd short-notice leave this month → short_notice_lop=True AND lop_days=requested."""
    # Three leaves at today+1, today+2, today+3 — all short-notice
    created_ids = []
    for i in range(1, 4):
        sd = (office_today + timedelta(days=i)).isoformat()
        body = {"type": "leave", "start_date": sd, "end_date": sd, "reason": f"Iter90 SN LOP {i}"}
        r = throwaway_member["client"].post(f"{BASE_URL}/api/leaves", json=body, timeout=30)
        assert r.status_code == 200, r.text
        created_ids.append(r.json()["id"])
    # Fetch 3rd one and verify
    third = mongo.leaves.find_one({"id": created_ids[2]}, {"_id": 0})
    assert third["short_notice"] is True
    assert third["short_notice_lop"] is True, f"3rd SN leave should be LOP: {third}"
    # lop_days should equal requested (1 day inclusive)
    assert third.get("lop_days") == 1, f"Expected lop_days=1 (requested); got {third.get('lop_days')}"
    assert third.get("paid_leave_used", 0) == 0
    assert third.get("comp_off_used", 0) == 0
    for cid in created_ids:
        mongo.leaves.delete_one({"id": cid})


# ===== Section B: Correction race =====

@pytest.fixture(scope="function")
def throwaway_second_admin(super_client, mongo):
    sfx = uuid.uuid4().hex[:6]
    body = {"email": f"TEST_iter90_a_{sfx}@example.com", "password": "Test@1234",
            "full_name": f"TEST Iter90 Admin {sfx}", "role": "admin", "category": "staff",
            "mobile": f"900077{sfx[:4]}"}
    r = super_client.post(f"{BASE_URL}/api/members", json=body, timeout=30)
    assert r.status_code == 200, r.text
    m = r.json()
    cli = _s(_login(body["email"], body["password"]))
    me = cli.get(f"{BASE_URL}/api/auth/me", timeout=30).json()
    assert me.get("role") == "admin"
    assert me.get("is_super_admin") in (False, None)
    yield {"member": m, "client": cli}
    mongo.users.delete_one({"id": m["id"]})


def _seed_pending_missed_checkin(super_client, admin2_client, mongo):
    """admin2 files a missed_checkin correction on behalf of a throwaway member."""
    sfx = uuid.uuid4().hex[:6]
    body = {"email": f"TEST_iter90_cm_{sfx}@example.com", "password": "Test@1234",
            "full_name": f"TEST Iter90 CM {sfx}", "role": "member", "category": "staff",
            "work_start": "09:00", "work_end": "18:00"}
    r = super_client.post(f"{BASE_URL}/api/members", json=body, timeout=30)
    assert r.status_code == 200, r.text
    mem = r.json()
    tdate = (date.today() - timedelta(days=3)).isoformat()
    cbody = {"entity_type": "attendance", "kind": "missed_checkin",
             "target_date": tdate, "on_behalf_of": mem["id"],
             "payload": {"check_in_time": "09:30"},
             "reason": "Iter90 race test"}
    rr = admin2_client.post(f"{BASE_URL}/api/corrections", json=cbody, timeout=30)
    assert rr.status_code == 200, rr.text
    j = rr.json()
    assert j["auto_approved"] is False
    assert j["needs_second_admin"] is True
    return {"mem": mem, "date": tdate, "cid": j["id"]}


def _cleanup_seed(seed, mongo):
    mongo.corrections.delete_many({"$or": [{"id": seed["cid"]}, {"requester_id": seed["mem"]["id"]}]})
    mongo.attendance.delete_many({"user_id": seed["mem"]["id"]})
    mongo.users.delete_one({"id": seed["mem"]["id"]})


def test_concurrent_approve_exactly_one_winner(super_client, admin2_client, throwaway_second_admin, mongo):
    seed = _seed_pending_missed_checkin(super_client, admin2_client, mongo)
    try:
        results = []
        lock = threading.Lock()

        def _approve(cli):
            try:
                r = cli.post(f"{BASE_URL}/api/admin/corrections/{seed['cid']}/decide",
                             json={"status": "approved"}, timeout=30)
                with lock:
                    results.append((r.status_code, r.text[:200]))
            except Exception as e:
                with lock:
                    results.append((None, str(e)))

        barrier = threading.Barrier(2)

        def _runner(cli):
            barrier.wait()
            _approve(cli)

        t1 = threading.Thread(target=_runner, args=(super_client,))
        t2 = threading.Thread(target=_runner, args=(throwaway_second_admin["client"],))
        t1.start(); t2.start(); t1.join(); t2.join()

        codes = sorted([r[0] for r in results])
        # Exactly one 200 and one 409
        assert codes.count(200) == 1, f"expected exactly 1 success; results={results}"
        assert codes.count(409) == 1, f"expected exactly 1 conflict; results={results}"

        # Exactly ONE attendance row for that date
        rows = list(mongo.attendance.find({"user_id": seed["mem"]["id"], "date": seed["date"]}))
        assert len(rows) == 1, f"expected 1 attendance row; got {len(rows)}: {rows}"

        # Correction final: status=approved, no deciding_by_id leftover
        c = mongo.corrections.find_one({"id": seed["cid"]}, {"_id": 0})
        assert c["status"] == "approved", c
        assert "deciding_by_id" not in c, f"deciding_by_id leaked: {c}"
        assert c.get("decided_by_id") is not None
    finally:
        _cleanup_seed(seed, mongo)


def test_approve_on_already_decided_returns_409(super_client, admin2_client, mongo):
    seed = _seed_pending_missed_checkin(super_client, admin2_client, mongo)
    try:
        r1 = super_client.post(f"{BASE_URL}/api/admin/corrections/{seed['cid']}/decide",
                               json={"status": "approved"}, timeout=30)
        assert r1.status_code == 200, r1.text
        r2 = super_client.post(f"{BASE_URL}/api/admin/corrections/{seed['cid']}/decide",
                               json={"status": "approved"}, timeout=30)
        assert r2.status_code == 409, f"Expected 409 on re-decide; got {r2.status_code} {r2.text}"
    finally:
        _cleanup_seed(seed, mongo)


def test_single_reject_still_works(super_client, admin2_client, mongo):
    seed = _seed_pending_missed_checkin(super_client, admin2_client, mongo)
    try:
        r = super_client.post(f"{BASE_URL}/api/admin/corrections/{seed['cid']}/decide",
                              json={"status": "rejected", "admin_note": "iter90 reject"}, timeout=30)
        assert r.status_code == 200, r.text
        c = mongo.corrections.find_one({"id": seed["cid"]}, {"_id": 0})
        assert c["status"] == "rejected"
        assert "deciding_by_id" not in c
        # No attendance row created
        assert mongo.attendance.count_documents({"user_id": seed["mem"]["id"], "date": seed["date"]}) == 0
    finally:
        _cleanup_seed(seed, mongo)


def test_single_approve_still_works(super_client, admin2_client, mongo):
    seed = _seed_pending_missed_checkin(super_client, admin2_client, mongo)
    try:
        r = super_client.post(f"{BASE_URL}/api/admin/corrections/{seed['cid']}/decide",
                              json={"status": "approved"}, timeout=30)
        assert r.status_code == 200, r.text
        c = mongo.corrections.find_one({"id": seed["cid"]}, {"_id": 0})
        assert c["status"] == "approved"
        assert "deciding_by_id" not in c
        assert mongo.attendance.count_documents({"user_id": seed["mem"]["id"], "date": seed["date"]}) == 1
    finally:
        _cleanup_seed(seed, mongo)
