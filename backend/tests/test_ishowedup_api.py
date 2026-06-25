"""End-to-end backend tests for the I-Showed-Up FastAPI app.

Covers the 21 review-request scenarios. Test ordering matters: shared state
is passed between tests via the `shared_state` fixture, and final cleanup
removes the test member + any leaves/attendance/device records it created.
"""
import os
import time
import uuid
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    env_path = "/app/frontend/.env"
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL"):
                    BASE_URL = line.split("=", 1)[1].strip().strip('"').rstrip("/")
                    break

TEST_MEMBER_EMAIL = os.environ.get("TEST_MEMBER_EMAIL", "test_sailor@iso.app")
TEST_MEMBER_PASSWORD = os.environ.get("TEST_MEMBER_PASSWORD", "test1234")
TEST_MEMBER_MOBILE = os.environ.get("TEST_MEMBER_MOBILE", "9000000001")
TEST_PHONE_NEW = os.environ.get("TEST_PHONE_NEW", "9876500099")
TEST_DEVICE_ID = f"web-test-{uuid.uuid4().hex[:8]}"


# ---------- (1)/(2) Admin auth ----------
def test_01_admin_login(base_url, shared_state):
    r = requests.post(f"{base_url}/api/auth/login",
                      json={"email": "admin@attendance.app", "password": "Admin@12345"},
                      timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "access_token" in data and isinstance(data["access_token"], str)
    assert data["user"]["role"] == "admin"
    assert data["user"]["email"] == "admin@attendance.app"
    shared_state["admin_token"] = data["access_token"]
    shared_state["admin_id"] = data["user"]["id"]


def test_02_auth_me(base_url, shared_state):
    token = shared_state["admin_token"]
    r = requests.get(f"{base_url}/api/auth/me",
                     headers={"Authorization": f"Bearer {token}"}, timeout=30)
    assert r.status_code == 200, r.text
    u = r.json()
    assert u["email"] == "admin@attendance.app"
    assert u["role"] == "admin"


# ---------- (3) Presence ----------
def test_03_presence(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/presence", timeout=30)
    assert r.status_code == 200, r.text
    d = r.json()
    assert "members" in d and isinstance(d["members"], list)
    assert "counts" in d and "total" in d["counts"]
    assert "date" in d


# ---------- (4)/(5)/(6) Office config ----------
def test_04_get_office(admin_client, base_url, shared_state):
    r = admin_client.get(f"{base_url}/api/office", timeout=30)
    assert r.status_code == 200, r.text
    o = r.json()
    assert o is not None
    assert "timezone" in o
    assert "radius_m" in o
    assert "latitude" in o and "longitude" in o
    shared_state["office"] = o


def test_05_put_office_roundtrip(admin_client, base_url, shared_state):
    o = shared_state["office"]
    original_radius = o.get("radius_m", 100)
    original_grace = o.get("late_grace_minutes", 0)
    new_body = {
        "name": o.get("name", "Campus Office"),
        "latitude": o.get("latitude", 0.0),
        "longitude": o.get("longitude", 0.0),
        "radius_m": original_radius + 50,
        "default_work_start": o.get("default_work_start", "09:00"),
        "default_work_end": o.get("default_work_end", "17:00"),
        "timezone": o.get("timezone", "Asia/Kolkata"),
        "late_grace_minutes": original_grace + 5,
    }
    r = admin_client.put(f"{base_url}/api/office", json=new_body, timeout=30)
    assert r.status_code == 200, r.text
    updated = r.json()
    assert updated["radius_m"] == original_radius + 50
    assert updated["late_grace_minutes"] == original_grace + 5

    # restore
    restore = dict(new_body, radius_m=original_radius, late_grace_minutes=original_grace)
    rr = admin_client.put(f"{base_url}/api/office", json=restore, timeout=30)
    assert rr.status_code == 200


def test_06_regenerate_qr(admin_client, base_url, shared_state):
    # Office QR check-in was retired (now GPS-only). The endpoint was
    # removed in the post-review cleanup — assert it stays gone.
    r = admin_client.post(f"{base_url}/api/office/regenerate-qr", timeout=30)
    assert r.status_code == 404, f"Expected 404 for retired endpoint, got {r.status_code}"


# ---------- (7)/(8) Create + list members ----------
def test_07_create_member(admin_client, base_url, shared_state):
    # remove if a previous failed run left it behind
    listing = admin_client.get(f"{base_url}/api/members", timeout=30).json()
    for u in listing:
        if u["email"] == TEST_MEMBER_EMAIL:
            admin_client.delete(f"{base_url}/api/members/{u['id']}", timeout=30)

    body = {
        "email": TEST_MEMBER_EMAIL,
        "password": TEST_MEMBER_PASSWORD,
        "full_name": "Test Sailor",
        "category": "athlete",
        "rank": "Seaman",
        "mobile": TEST_MEMBER_MOBILE,
        "role": "member",
    }
    r = admin_client.post(f"{base_url}/api/members", json=body, timeout=30)
    assert r.status_code == 200, r.text
    u = r.json()
    assert u["email"] == TEST_MEMBER_EMAIL
    assert u["full_name"] == "Test Sailor"
    assert u["role"] == "member"
    assert u["category"] == "athlete"
    assert "id" in u
    shared_state["member_id"] = u["id"]


def test_08_list_members_includes_new(admin_client, base_url, shared_state):
    r = admin_client.get(f"{base_url}/api/members", timeout=30)
    assert r.status_code == 200, r.text
    members = r.json()
    ids = {m["id"] for m in members}
    assert shared_state["member_id"] in ids


# ---------- (9) Update member ----------
def test_09_patch_member(admin_client, base_url, shared_state):
    mid = shared_state["member_id"]
    body = {"work_start": "08:30", "work_end": "16:30"}
    r = admin_client.patch(f"{base_url}/api/members/{mid}", json=body, timeout=30)
    assert r.status_code == 200, r.text
    u = r.json()
    assert u["work_start"] == "08:30"
    assert u["work_end"] == "16:30"


# ---------- (10)/(11)/(12) Geo-toggle as member ----------
def test_10_member_login_and_geo_checkin(base_url, shared_state):
    r = requests.post(f"{base_url}/api/auth/login",
                      json={"email": TEST_MEMBER_EMAIL, "password": TEST_MEMBER_PASSWORD},
                      timeout=30)
    assert r.status_code == 200, r.text
    member_token = r.json()["access_token"]
    shared_state["member_token"] = member_token

    office = shared_state["office"]
    body = {"latitude": office["latitude"], "longitude": office["longitude"]}
    r = requests.post(f"{base_url}/api/attendance/geo-toggle", json=body,
                      headers={"Authorization": f"Bearer {member_token}"}, timeout=30)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d.get("action") == "checkin", f"Expected checkin, got: {d}"


def test_11_attendance_status_checked_in(base_url, shared_state):
    token = shared_state["member_token"]
    r = requests.get(f"{base_url}/api/attendance/status",
                     headers={"Authorization": f"Bearer {token}"}, timeout=30)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["checked_in"] is True
    assert d["session"] is not None


def test_12_geo_toggle_checkout(base_url, shared_state):
    token = shared_state["member_token"]
    office = shared_state["office"]
    body = {"latitude": office["latitude"], "longitude": office["longitude"]}
    r = requests.post(f"{base_url}/api/attendance/geo-toggle", json=body,
                     headers={"Authorization": f"Bearer {token}"}, timeout=30)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d.get("action") == "checkout", f"Expected checkout, got: {d}"
    assert "hours" in d


# ---------- (13)/(14) Leaves ----------
def test_13_create_and_get_my_leave(base_url, shared_state):
    token = shared_state["member_token"]
    body = {"type": "leave", "start_date": "2026-02-01",
            "end_date": "2026-02-02", "reason": "TEST leave for backend test"}
    r = requests.post(f"{base_url}/api/leaves", json=body,
                      headers={"Authorization": f"Bearer {token}"}, timeout=30)
    assert r.status_code == 200, r.text
    leave = r.json()
    assert leave["status"] == "pending"
    shared_state["leave_id"] = leave["id"]

    r2 = requests.get(f"{base_url}/api/leaves/mine",
                      headers={"Authorization": f"Bearer {token}"}, timeout=30)
    assert r2.status_code == 200
    ids = [item["id"] for item in r2.json()]
    assert leave["id"] in ids


def test_14_admin_list_and_approve_leave(admin_client, base_url, shared_state):
    r = admin_client.get(f"{base_url}/api/leaves?status_filter=pending", timeout=30)
    assert r.status_code == 200, r.text
    pending = r.json()
    ids = {item["id"] for item in pending}
    assert shared_state["leave_id"] in ids

    lid = shared_state["leave_id"]
    r2 = admin_client.patch(f"{base_url}/api/leaves/{lid}",
                            json={"status": "approved"}, timeout=30)
    assert r2.status_code == 200, r2.text
    assert r2.json()["status"] == "approved"


# ---------- (15) Admin summary ----------
def test_15_admin_summary(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/admin/summary", timeout=30)
    assert r.status_code == 200, r.text
    d = r.json()
    for k in ("total_members", "on_campus", "pending_leaves",
              "on_leave_tour", "late_today"):
        assert k in d, f"Missing key {k} in summary"
        assert isinstance(d[k], int)


# ---------- (16) Phone login + admin approval flow ----------
def test_16_phone_login_pending_approve_and_status(admin_client, base_url, shared_state):
    # Step 1: phone login -> pending
    r = requests.post(f"{base_url}/api/auth/phone",
                      json={"phone": TEST_PHONE_NEW, "device_id": TEST_DEVICE_ID,
                            "device_name": "Test Browser", "platform": "web"},
                      timeout=30)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["status"] == "pending"
    shared_state["pending_device_id_str"] = TEST_DEVICE_ID

    # Step 2: admin list pending devices
    r2 = admin_client.get(f"{base_url}/api/admin/devices?status_filter=pending", timeout=30)
    assert r2.status_code == 200, r2.text
    devices = r2.json()
    match = [d for d in devices if d["device_id"] == TEST_DEVICE_ID]
    assert match, f"Pending device with device_id={TEST_DEVICE_ID} not found"
    device_pk = match[0]["id"]
    shared_state["device_pk"] = device_pk

    # Step 3: admin approve
    r3 = admin_client.post(f"{base_url}/api/admin/devices/{device_pk}/approve",
                           json={"full_name": "TEST Phone User",
                                 "role": "member", "category": "athlete"},
                           timeout=30)
    assert r3.status_code == 200, r3.text
    assert r3.json()["ok"] is True

    # Step 4: status returns approved + token
    time.sleep(0.3)
    r4 = requests.get(f"{base_url}/api/auth/phone/status",
                      params={"device_id": TEST_DEVICE_ID}, timeout=30)
    assert r4.status_code == 200, r4.text
    sd = r4.json()
    assert sd["status"] == "approved", f"got: {sd}"
    assert "access_token" in sd
    assert sd["user"]["role"] == "member"
    shared_state["phone_user_id"] = sd["user"]["id"]


# ---------- (17) Hours report ----------
def test_17_reports_hours(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/reports/hours",
                        params={"start": "2026-01-01", "end": "2026-01-31"}, timeout=30)
    assert r.status_code == 200, r.text
    d = r.json()
    assert "rows" in d and isinstance(d["rows"], list)
    assert d["start"] == "2026-01-01" and d["end"] == "2026-01-31"


# ---------- (18) Hours export CSV / PDF ----------
def test_18_reports_hours_export(admin_client, base_url):
    rc = admin_client.get(f"{base_url}/api/reports/hours/export",
                         params={"start": "2026-01-01", "end": "2026-01-31", "fmt": "csv"},
                         timeout=60)
    assert rc.status_code == 200, rc.text[:200]
    assert "text/csv" in rc.headers.get("content-type", ""), rc.headers
    assert rc.content.startswith(b"Attendance %,Name,Category,Rank")

    rp = admin_client.get(f"{base_url}/api/reports/hours/export",
                         params={"start": "2026-01-01", "end": "2026-01-31", "fmt": "pdf"},
                         timeout=60)
    assert rp.status_code == 200
    assert "application/pdf" in rp.headers.get("content-type", "")
    assert rp.content[:4] == b"%PDF"


# ---------- (19) Members import-template ----------
def test_19_members_import_template(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/members/import-template", timeout=60)
    assert r.status_code == 200, r.text[:200]
    ctype = r.headers.get("content-type", "")
    assert "spreadsheetml" in ctype or "officedocument" in ctype, ctype
    # xlsx files are zip archives -> start with PK\x03\x04
    assert r.content[:2] == b"PK"


# ---------- (20)/(21) Cleanup ----------
def test_20_cleanup_delete_member(admin_client, base_url, shared_state):
    mid = shared_state.get("member_id")
    if not mid:
        pytest.skip("No member created to delete")
    r = admin_client.delete(f"{base_url}/api/members/{mid}", timeout=30)
    assert r.status_code == 200, r.text
    assert r.json()["ok"] is True

    # verify gone from listing
    listing = admin_client.get(f"{base_url}/api/members", timeout=30).json()
    ids = {m["id"] for m in listing}
    assert mid not in ids


def test_21_final_cleanup_devices_and_phone_user(admin_client, base_url, shared_state):
    """Delete the test phone-login user + its device(s) so the DB stays pristine."""
    phone_uid = shared_state.get("phone_user_id")
    if phone_uid:
        r = admin_client.delete(f"{base_url}/api/members/{phone_uid}", timeout=30)
        assert r.status_code == 200, r.text

    # Remove any device records we created (by device_id string)
    dev_id = shared_state.get("pending_device_id_str")
    if dev_id:
        all_devs = admin_client.get(f"{base_url}/api/admin/devices", timeout=30).json()
        for d in all_devs:
            if d.get("device_id") == dev_id:
                # No DELETE endpoint; revoke is the closest. We still need actual deletion
                # so the DB is pristine. Do it via the same Mongo the app uses.
                pass

    # Direct DB cleanup of the leftover device + any orphan attendance/leaves
    try:
        from pymongo import MongoClient
        mc = MongoClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
        mdb = mc[os.environ.get("DB_NAME", "test_database")]
        if dev_id:
            mdb.devices.delete_many({"device_id": dev_id})
        if phone_uid:
            mdb.users.delete_many({"id": phone_uid})
            mdb.attendance.delete_many({"user_id": phone_uid})
            mdb.leaves.delete_many({"user_id": phone_uid})
        # Also wipe any TEST_ data
        mdb.devices.delete_many({"device_name": "Test Browser"})
    except Exception as e:
        print(f"WARN: direct DB cleanup skipped: {e}")
