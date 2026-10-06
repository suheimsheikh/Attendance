"""Iter89 — Approver-on-Grid tooltip, Correction Waiting Banner API, SSE live events.

Covers:
  * GET /api/reports/calendar-grid cell_meta[iso].correction = {kind, filed_by,
    approved_by, approved_at, auto} on corrected attendance days
  * GET /api/admin/corrections/pending-for-me — only decidable rows
    (excludes two-admin rows the admin filed; excludes super-only rows for non-supers)
  * GET /api/events — SSE first frame is {seq,...}; invalid token → 401
"""
import json
import os
import uuid
import time
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
def mongo():
    from pymongo import MongoClient
    url = os.environ.get("MONGO_URL")
    name = os.environ.get("DB_NAME")
    return MongoClient(url)[name]


@pytest.fixture(scope="module")
def super_token():
    return _login(SUPER_EMAIL, SUPER_PWD)


@pytest.fixture(scope="module")
def super_client(super_token):
    return _s(super_token)


@pytest.fixture(scope="module")
def admin2_client(super_client):
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": ADMIN2_EMAIL, "password": ADMIN2_PWD}, timeout=30)
    if r.status_code != 200:
        body = {"email": ADMIN2_EMAIL, "password": ADMIN2_PWD, "full_name": "Admin Two Test",
                "role": "admin", "category": "staff", "mobile": "9000000002"}
        rr = super_client.post(f"{BASE_URL}/api/members", json=body, timeout=30)
        assert rr.status_code == 200, rr.text
    return _s(_login(ADMIN2_EMAIL, ADMIN2_PWD))


@pytest.fixture(scope="module")
def me_admin2(admin2_client):
    return admin2_client.get(f"{BASE_URL}/api/auth/me", timeout=30).json()


@pytest.fixture(scope="module")
def me_super(super_client):
    return super_client.get(f"{BASE_URL}/api/auth/me", timeout=30).json()


@pytest.fixture(scope="module")
def throwaway_admin(super_client, mongo):
    """Second non-super admin for banner-visibility test."""
    sfx = uuid.uuid4().hex[:6]
    body = {"email": f"TEST_iter89_admin_{sfx}@example.com", "password": "Test@1234",
            "full_name": f"TEST Iter89 Admin {sfx}", "role": "admin", "category": "staff",
            "mobile": f"900055{sfx[:4]}"}
    r = super_client.post(f"{BASE_URL}/api/members", json=body, timeout=30)
    assert r.status_code == 200, r.text
    m = r.json()
    cli = _s(_login(body["email"], body["password"]))
    me = cli.get(f"{BASE_URL}/api/auth/me", timeout=30).json()
    assert me.get("role") == "admin"
    assert me.get("is_super_admin") in (False, None)
    yield {"member": m, "client": cli, "me": me}
    mongo.users.delete_one({"id": m["id"]})


@pytest.fixture(scope="module")
def seeded(super_client, admin2_client, mongo, me_admin2):
    """Create a throwaway member + one attendance row + one pending correction
    filed by admin2 against it. Returns context used across tests."""
    sfx = uuid.uuid4().hex[:6]
    body = {"email": f"TEST_iter89_mem_{sfx}@example.com", "password": "Test@1234",
            "full_name": f"TEST Iter89 Member {sfx}", "role": "member", "category": "staff",
            "work_start": "09:00", "work_end": "18:00"}
    r = super_client.post(f"{BASE_URL}/api/members", json=body, timeout=30)
    assert r.status_code == 200, r.text
    mem = r.json()
    # Seed one attendance row in Dec 2025 (far from current admin workflow)
    date = "2025-12-18"
    att_id = str(uuid.uuid4())
    mongo.attendance.insert_one({
        "id": att_id, "user_id": mem["id"], "user_name": mem["full_name"],
        "date": date, "check_in_at": f"{date}T09:30:00+05:30",
        "check_out_at": f"{date}T18:00:00+05:30", "method": "manual",
        "late": True, "late_minutes": 30,
    })
    # admin2 files a time_adjust → pending (two-admin)
    cbody = {"entity_type": "attendance", "kind": "time_adjust",
             "entity_id": att_id, "target_date": date,
             "on_behalf_of": mem["id"],
             "payload": {"check_in_time": "09:00"},
             "reason": "Iter89 banner test"}
    rr = admin2_client.post(f"{BASE_URL}/api/corrections", json=cbody, timeout=30)
    assert rr.status_code == 200, rr.text
    j = rr.json()
    assert j["auto_approved"] is False
    assert j["needs_second_admin"] is True
    yield {"mem": mem, "att_id": att_id, "date": date, "cid": j["id"]}
    # Cleanup
    mongo.corrections.delete_many({"$or": [{"id": j["id"]},
                                           {"requester_id": mem["id"]},
                                           {"entity_id": att_id}]})
    mongo.attendance.delete_many({"user_id": mem["id"]})
    mongo.users.delete_one({"id": mem["id"]})


# ================================================================ pending-for-me

def test_01_banner_api_super_sees(super_client, seeded):
    r = super_client.get(f"{BASE_URL}/api/admin/corrections/pending-for-me", timeout=30)
    assert r.status_code == 200, r.text
    j = r.json()
    assert "count" in j and "oldest_at" in j and "items" in j
    ids = [i["id"] for i in j["items"]]
    # Super admin DID NOT file it → it is decidable by super → must be included
    # (count may include other preview pending rows but ours must be present)
    assert seeded["cid"] in ids, f"super admin should see cid; items={j['items'][:5]}"
    row = next(i for i in j["items"] if i["id"] == seeded["cid"])
    assert row["kind"] == "time_adjust"
    assert row["target_date"] == seeded["date"]


def test_02_banner_api_admin2_excludes_own(admin2_client, seeded):
    r = admin2_client.get(f"{BASE_URL}/api/admin/corrections/pending-for-me", timeout=30)
    assert r.status_code == 200, r.text
    j = r.json()
    ids = [i["id"] for i in j["items"]]
    # Filer must not see it in decidable list
    assert seeded["cid"] not in ids, "admin2 is filer; must be excluded"


def test_03_banner_api_other_nonsuper_sees(throwaway_admin, seeded):
    r = throwaway_admin["client"].get(f"{BASE_URL}/api/admin/corrections/pending-for-me", timeout=30)
    assert r.status_code == 200, r.text
    j = r.json()
    ids = [i["id"] for i in j["items"]]
    # Different admin from filer and attendance (not super-admin-only) → should see
    assert seeded["cid"] in ids, f"other non-super admin should see cid; items={j['items'][:5]}"


# ================================================================ SSE /api/events

def test_04_events_rejects_bad_token():
    r = requests.get(f"{BASE_URL}/api/events?token=notavalidjwt", timeout=15, stream=True)
    # Starlette StreamingResponse with HTTPException returns 401 before stream starts
    assert r.status_code == 401, f"expected 401, got {r.status_code} {r.text[:200]}"


def test_05_events_first_frame_is_seq(super_token):
    r = requests.get(f"{BASE_URL}/api/events?token={super_token}", timeout=15, stream=True)
    assert r.status_code == 200, r.text
    assert "text/event-stream" in r.headers.get("content-type", "")
    # read bytes with a timeout
    buf = b""
    deadline = time.time() + 10
    try:
        for chunk in r.iter_content(chunk_size=512):
            if chunk:
                buf += chunk
                if b"data:" in buf and b"\n\n" in buf.split(b"data:", 1)[1]:
                    break
            if time.time() > deadline:
                break
    finally:
        r.close()
    assert b"data:" in buf, f"no data frame in {buf[:300]!r}"
    # extract first data: ... \n\n line
    s = buf.decode("utf-8", "ignore")
    data_part = s.split("data:", 1)[1].split("\n\n", 1)[0].strip()
    j = json.loads(data_part)
    assert isinstance(j.get("seq"), int), f"seq missing/non-int: {j}"


def test_06_events_bump_on_correction_create(admin2_client, super_client, mongo):
    """Verify that creating a correction bumps the Mongo-backed seq that drives
    SSE. We inspect the signal directly (SSE delivery itself is covered by
    test_05 — ingress buffering makes an end-to-end seq-watch flaky)."""
    doc0 = mongo.config.find_one({"id": "app_signal"}, {"_id": 0}) or {}
    seq0 = int(doc0.get("seq") or 0)

    # Create throwaway seed to trigger a bump
    sfx = uuid.uuid4().hex[:6]
    mem = super_client.post(f"{BASE_URL}/api/members", json={
        "email": f"TEST_sse_{sfx}@example.com", "password": "Test@1234",
        "full_name": f"TEST SSE Mem {sfx}", "role": "member", "category": "staff",
        "work_start": "09:00", "work_end": "18:00"}, timeout=30).json()
    att_id = str(uuid.uuid4())
    d = "2025-12-19"
    mongo.attendance.insert_one({"id": att_id, "user_id": mem["id"],
                                 "user_name": mem["full_name"], "date": d,
                                 "check_in_at": f"{d}T09:30:00+05:30",
                                 "check_out_at": f"{d}T18:00:00+05:30", "method": "manual"})
    cid = None
    try:
        cr = admin2_client.post(f"{BASE_URL}/api/corrections", json={
            "entity_type": "attendance", "kind": "time_adjust",
            "entity_id": att_id, "target_date": d,
            "on_behalf_of": mem["id"],
            "payload": {"check_in_time": "09:00"},
            "reason": "iter89 sse bump"}, timeout=30)
        assert cr.status_code == 200, cr.text
        cid = cr.json()["id"]
        # Give the backend a tick for the bump
        time.sleep(0.5)
        doc1 = mongo.config.find_one({"id": "app_signal"}, {"_id": 0}) or {}
        seq1 = int(doc1.get("seq") or 0)
        assert seq1 > seq0, f"app_signal.seq did not bump: {seq0} -> {seq1}"
        assert doc1.get("scope") == "corrections"

        # Decide to also exercise the decide-path bump
        dr = super_client.post(f"{BASE_URL}/api/admin/corrections/{cid}/decide",
                               json={"status": "approved"}, timeout=30)
        assert dr.status_code == 200
        time.sleep(0.5)
        doc2 = mongo.config.find_one({"id": "app_signal"}, {"_id": 0}) or {}
        seq2 = int(doc2.get("seq") or 0)
        assert seq2 > seq1, f"seq did not bump on decide: {seq1} -> {seq2}"
    finally:
        if cid:
            mongo.corrections.delete_many({"id": cid})
        mongo.attendance.delete_many({"user_id": mem["id"]})
        mongo.users.delete_one({"id": mem["id"]})


# ================================================================ Grid correction meta

def test_07_grid_cell_meta_correction_fields(super_client, seeded, mongo):
    """After we APPROVE the pending correction, the attendance row's
    corrected_via lines up with corr_by_id and cell_meta[iso].correction is populated."""
    # Approve via super admin (admin2 is filer → 403)
    cid = seeded["cid"]
    r = super_client.post(f"{BASE_URL}/api/admin/corrections/{cid}/decide",
                          json={"status": "approved"}, timeout=30)
    assert r.status_code == 200, r.text

    # fetch calendar-grid for Dec 2025 — the only row in scope is our throwaway
    gr = super_client.get(f"{BASE_URL}/api/reports/calendar-grid",
                          params={"month": "2025-12"}, timeout=60)
    assert gr.status_code == 200, gr.text
    gj = gr.json()
    row = next((r for r in gj.get("rows", []) if r.get("member_id") == seeded["mem"]["id"]), None)
    assert row is not None, "seeded member not in grid rows"
    cm = row.get("cell_meta") or {}
    corr_meta = (cm.get(seeded["date"]) or {}).get("correction")
    assert corr_meta is not None, f"no correction meta in {cm.get(seeded['date'])!r}"
    assert corr_meta.get("kind") == "time_adjust"
    assert corr_meta.get("filed_by"), "filed_by should be populated"
    assert corr_meta.get("approved_by"), "approved_by should be populated"
    assert corr_meta.get("approved_at"), "approved_at should be populated"
    # Not auto (super admin manually approved admin2's filed row via two-admin rule)
    assert corr_meta.get("auto") in (False, None)


def test_08_grid_sep_2026_has_corrected_cells(super_client):
    """Sanity: review request says 132 corrected cells exist in Sep 2026 real data.
    We just assert >= 1 to not depend on fluctuating counts."""
    r = super_client.get(f"{BASE_URL}/api/reports/calendar-grid",
                         params={"month": "2026-09"}, timeout=120)
    assert r.status_code == 200, r.text
    j = r.json()
    corrected = 0
    for row in j.get("rows", []):
        for iso, m in (row.get("cell_meta") or {}).items():
            if m.get("correction"):
                corrected += 1
    assert corrected >= 1, "Expected at least one corrected cell in Sep 2026 (review req says ~132)"
    print(f"iter89 grid sep2026 corrected cell count: {corrected}")
