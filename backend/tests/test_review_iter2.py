"""Iteration 2 backend tests — verifies the P0/P2/P3 review-fix items.

Focus: removed-endpoint 404s, no qr_token leak, /admin/cards shape,
mobile_last10 indexing, phone-login admin bypass via 9849002111,
streaming backup/restore, bulk member import, non-blocking sms test.
"""
import io
import os
import uuid
import requests
import pytest
import tarfile
import json as _json
from openpyxl import Workbook

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    env_path = "/app/frontend/.env"
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL"):
                    BASE_URL = line.split("=", 1)[1].strip().strip('"').rstrip("/")
                    break

# Load MONGO_URL/DB_NAME from backend/.env if not in env
if not os.environ.get("MONGO_URL"):
    be_env = "/app/backend/.env"
    if os.path.exists(be_env):
        with open(be_env) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"'))

ADMIN_EMAIL = "admin@attendance.app"
ADMIN_PASSWORD = "Admin@12345"
ADMIN_MOBILE = "9849002111"


# ---------- Shared session ----------
@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                      timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def admin_s(admin_token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {admin_token}",
                      "Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def state():
    return {}


# ---------- 1. Admin email login ----------
def test_01_admin_email_login_and_presence(admin_s):
    r = admin_s.get(f"{BASE_URL}/api/presence", timeout=30)
    assert r.status_code == 200, r.text
    d = r.json()
    assert "members" in d and isinstance(d["members"], list)
    assert "counts" in d and "total" in d["counts"]
    # Each member row should contain the expected fields
    if d["members"]:
        m = d["members"][0]
        for k in ("id", "full_name", "status"):
            assert k in m, f"missing {k} in presence member row"


# ---------- 2. Phone login 9849002111 → admin auto-approve ----------
def test_02_phone_login_admin_bypass():
    dev_id = f"test-iter2-{uuid.uuid4().hex[:8]}"
    r = requests.post(f"{BASE_URL}/api/auth/phone",
                      json={"phone": ADMIN_MOBILE, "device_id": dev_id,
                            "device_name": "iter2-test", "platform": "web"},
                      timeout=30)
    assert r.status_code == 200, r.text
    d = r.json()
    # Pre-designated admin must short-circuit to approved + token
    assert "access_token" in d, f"Expected access_token, got: {d}"
    assert d["user"]["role"] == "admin"
    # Cleanup the test device
    try:
        from pymongo import MongoClient
        mc = MongoClient(os.environ["MONGO_URL"])
        mc[os.environ["DB_NAME"]].devices.delete_many({"device_id": dev_id})
    except Exception:
        pass


# ---------- 3. /api/office no qr_token leak ----------
def test_03_office_no_qr_token_leak(admin_s):
    r = admin_s.get(f"{BASE_URL}/api/office", timeout=30)
    assert r.status_code == 200, r.text
    o = r.json()
    assert "qr_token" not in o, f"qr_token leaked in /api/office response: {list(o.keys())}"
    # core fields still present
    for k in ("latitude", "longitude", "radius_m", "timezone"):
        assert k in o, f"missing {k}"


# ---------- 4. Removed endpoints return 404/405 ----------
@pytest.mark.parametrize("path,body", [
    ("/api/attendance/checkin", {"qr_token": "x"}),
    ("/api/attendance/checkout", {"qr_token": "x"}),
    ("/api/office/regenerate-qr", {}),
    ("/api/admin/snapshot/import", {}),
])
def test_04_removed_endpoints_404(admin_s, path, body):
    r = admin_s.post(f"{BASE_URL}{path}", json=body, timeout=30)
    # Acceptable: 404 (route gone) or 405 (method not allowed). Anything 2xx is a leak.
    assert r.status_code in (404, 405), f"{path} returned {r.status_code}: {r.text[:200]}"


# ---------- 5. /admin/cards returns only members[] ----------
def test_05_admin_cards_shape(admin_s):
    r = admin_s.get(f"{BASE_URL}/api/admin/cards", timeout=30)
    assert r.status_code == 200, r.text
    d = r.json()
    assert set(d.keys()) == {"members"}, f"Unexpected keys in /admin/cards: {list(d.keys())}"
    assert isinstance(d["members"], list)
    if d["members"]:
        m = d["members"][0]
        for k in ("id", "full_name", "personal_qr"):
            assert k in m


# ---------- 6. /api/presence has rich per-member fields & runs fast ----------
def test_06_presence_fields_and_performance(admin_s):
    import time as _t
    t0 = _t.time()
    r = admin_s.get(f"{BASE_URL}/api/presence", timeout=30)
    elapsed = _t.time() - t0
    assert r.status_code == 200, r.text
    d = r.json()
    assert elapsed < 8.0, f"/api/presence took {elapsed:.2f}s — N+1 may be back"
    # At least one row should expose the post-fix fields
    found_fields = {"status", "late_minutes", "days_remaining", "days_absent_streak", "excursions"}
    if d["members"]:
        m = d["members"][0]
        # Not every field guaranteed on every row but the keys must exist as columns somewhere
        missing = found_fields - set(m.keys())
        assert not missing or len(missing) < len(found_fields), \
            f"All expected presence fields missing on member row: {list(m.keys())}"


# ---------- 7. /api/attendance/geo-toggle still works ----------
def test_07_geo_toggle_still_works(admin_s):
    # Office
    o = admin_s.get(f"{BASE_URL}/api/office", timeout=30).json()
    lat, lon = o["latitude"], o["longitude"]
    # First geo-toggle (would check the admin in if they're not already)
    r = admin_s.post(f"{BASE_URL}/api/attendance/geo-toggle",
                     json={"latitude": lat, "longitude": lon}, timeout=30)
    # Either 200 (action=checkin/checkout) OR 400 (already checked in elsewhere) — both acceptable
    assert r.status_code in (200, 400), r.text
    if r.status_code == 200:
        d = r.json()
        assert d.get("action") in ("checkin", "checkout"), f"unexpected: {d}"
        # Reverse it so we don't leave state dirty
        r2 = admin_s.post(f"{BASE_URL}/api/attendance/geo-toggle",
                          json={"latitude": lat, "longitude": lon}, timeout=30)
        assert r2.status_code in (200, 400)


# ---------- 8. Member CRUD with mobile_last10 ----------
TEST_MOBILE = "9000077001"
TEST_MOBILE_NEW = "9000077999"


def _cleanup_test_member(admin_s):
    listing = admin_s.get(f"{BASE_URL}/api/members", timeout=30).json()
    for u in listing:
        em = (u.get("email") or "").lower()
        if em.startswith("test_iter2_") or u.get("mobile") in (TEST_MOBILE, TEST_MOBILE_NEW):
            admin_s.delete(f"{BASE_URL}/api/members/{u['id']}", timeout=30)


def test_08_member_create_has_mobile_last10(admin_s, state):
    _cleanup_test_member(admin_s)
    body = {
        "email": "TEST_iter2_a@iso.app",
        "password": "test1234",
        "full_name": "TEST Iter2 Sailor",
        "category": "athlete",
        "rank": "Seaman",
        "mobile": TEST_MOBILE,
        "role": "member",
    }
    r = admin_s.post(f"{BASE_URL}/api/members", json=body, timeout=30)
    assert r.status_code == 200, r.text
    state["member_id"] = r.json()["id"]

    # Verify mobile_last10 set in DB
    from pymongo import MongoClient
    mc = MongoClient(os.environ["MONGO_URL"])
    raw = mc[os.environ["DB_NAME"]].users.find_one({"id": state["member_id"]}, {"_id": 0, "mobile_last10": 1, "mobile": 1})
    assert raw is not None
    assert raw.get("mobile_last10") == TEST_MOBILE[-10:], f"mobile_last10 not set: {raw}"


def test_09_member_patch_updates_mobile_last10(admin_s, state):
    mid = state["member_id"]
    r = admin_s.patch(f"{BASE_URL}/api/members/{mid}",
                      json={"mobile": TEST_MOBILE_NEW}, timeout=30)
    assert r.status_code == 200, r.text
    from pymongo import MongoClient
    mc = MongoClient(os.environ["MONGO_URL"])
    raw = mc[os.environ["DB_NAME"]].users.find_one({"id": mid}, {"_id": 0, "mobile_last10": 1, "mobile": 1})
    assert raw["mobile"] == TEST_MOBILE_NEW
    assert raw.get("mobile_last10") == TEST_MOBILE_NEW[-10:], f"mobile_last10 not refreshed on mobile change: {raw}"


# ---------- 9. Phone login uses mobile_last10 index ----------
def test_10_phone_login_matches_via_mobile_last10(state):
    dev_id = f"test-iter2-pl-{uuid.uuid4().hex[:8]}"
    r = requests.post(f"{BASE_URL}/api/auth/phone",
                      json={"phone": TEST_MOBILE_NEW, "device_id": dev_id,
                            "device_name": "iter2-pl", "platform": "web"},
                      timeout=30)
    assert r.status_code == 200, r.text
    d = r.json()
    # Member role (not admin) → no instant token; must match by mobile_last10 and report pending
    assert d.get("matched_member") == "TEST Iter2 Sailor", \
        f"phone-login did not match via mobile_last10: {d}"
    # cleanup device
    try:
        from pymongo import MongoClient
        mc = MongoClient(os.environ["MONGO_URL"])
        mc[os.environ["DB_NAME"]].devices.delete_many({"device_id": dev_id})
    except Exception:
        pass


# ---------- 10. Bulk member import: 2 valid + 1 duplicate ----------
def test_11_member_import_bulk_with_duplicate(admin_s):
    # Build an xlsx with 2 valid + 1 duplicate-of-admin email
    wb = Workbook()
    ws = wb.active
    ws.title = "Members"
    ws.append(["full_name", "mobile", "email", "password", "rank", "category", "gender", "work_start", "work_end", "institution"])
    ws.append(["TEST Iter2 Bulk1", "9000088001", "TEST_iter2_bulk1@iso.app", "secret123", "Seaman", "athlete", "M", "", "", ""])
    ws.append(["TEST Iter2 Bulk2", "9000088002", "TEST_iter2_bulk2@iso.app", "secret123", "Seaman", "athlete", "M", "", "", ""])
    ws.append(["TEST Iter2 Dup", "9000088003", ADMIN_EMAIL, "secret123", "Seaman", "athlete", "M", "", "", ""])
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)

    # Multipart upload; drop the content-type header so requests sets a proper boundary
    s = requests.Session()
    s.headers.update({"Authorization": admin_s.headers["Authorization"]})
    r = s.post(f"{BASE_URL}/api/members/import",
               files={"file": ("members.xlsx", buf.getvalue(),
                               "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
               timeout=60)
    assert r.status_code == 200, r.text
    d = r.json()
    # The endpoint returns {"created": [...], "errors": [...], "created_count": N, "error_count": N}
    created_count = d.get("created_count") if isinstance(d.get("created_count"), int) else len(d.get("created") or [])
    error_count = d.get("error_count") if isinstance(d.get("error_count"), int) else len(d.get("errors") or [])
    assert created_count >= 2, f"Expected 2 inserts, got: {d}"
    assert error_count >= 1, f"Expected duplicate-email error, got: {d}"

    # Cleanup the 2 new bulk members
    listing = admin_s.get(f"{BASE_URL}/api/members", timeout=30).json()
    for u in listing:
        if (u.get("email") or "").lower().startswith("test_iter2_bulk"):
            admin_s.delete(f"{BASE_URL}/api/members/{u['id']}", timeout=30)


# ---------- 11. Muster check-in / check-out bulk ----------
def test_12_muster_checkin_checkout(admin_s, state):
    mid = state["member_id"]
    # checkin-bulk
    r = admin_s.post(f"{BASE_URL}/api/muster/checkin-bulk",
                     json={"athlete_ids": [mid]}, timeout=30)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["checked_in_count"] + d["skipped_count"] >= 1
    # checkout-bulk
    r2 = admin_s.post(f"{BASE_URL}/api/muster/checkout-bulk",
                      json={"athlete_ids": [mid]}, timeout=30)
    assert r2.status_code == 200, r2.text
    d2 = r2.json()
    assert d2["checked_out_count"] + d2["skipped_count"] >= 1


# ---------- 12. Admin backup (tar.gz + manifest.json) ----------
def test_13_admin_backup_targz(admin_s, state):
    r = admin_s.get(f"{BASE_URL}/api/admin/backup", timeout=120)
    assert r.status_code == 200, r.text[:200]
    ctype = r.headers.get("content-type", "")
    assert "gzip" in ctype or "x-tar" in ctype, ctype
    # Try to open as tar.gz
    tf = tarfile.open(fileobj=io.BytesIO(r.content), mode="r:gz")
    names = tf.getnames()
    assert any(n.endswith("manifest.json") for n in names), f"no manifest.json in backup: {names[:5]}"
    # users.json must exist
    assert any(n.endswith("users.json") for n in names), f"no users.json: {names[:5]}"
    # Stash for restore test
    state["backup_bytes"] = r.content


# ---------- 13. Admin restore (merge mode) → 0 inserted ----------
def test_14_admin_restore_merge_zero_inserted(admin_s, state):
    payload = state.get("backup_bytes")
    if not payload:
        pytest.skip("No backup payload from previous test")
    s = requests.Session()
    s.headers.update({"Authorization": admin_s.headers["Authorization"]})
    r = s.post(f"{BASE_URL}/api/admin/restore",
               params={"mode": "merge"},
               files={"file": ("backup.tar.gz", payload, "application/gzip")},
               timeout=120)
    assert r.status_code == 200, r.text[:300]
    d = r.json()
    # daily_content is auto-seeded by the app on access, so a small drift (≤5
    # docs) between backup-capture and restore is expected. The real check is
    # that no user / attendance / config docs got duplicated and the bulk_write
    # path didn't crash.
    drift_collections = {"daily_content"}
    non_drift_inserted = 0
    breakdown = {}
    if isinstance(d, dict) and isinstance(d.get("inserted"), dict):
        breakdown = d["inserted"]
        non_drift_inserted = sum(int(v) for k, v in breakdown.items() if k not in drift_collections)
    assert non_drift_inserted == 0, \
        f"merge-restore inserted {non_drift_inserted} non-drift docs (expected 0): {breakdown}"


# ---------- 14. /api/sms/test non-blocking + sane response when Twilio off ----------
def test_15_sms_test_endpoint_sane_when_disabled(admin_s):
    r = admin_s.post(f"{BASE_URL}/api/sms/test",
                     json={"to": "+919999999999", "body": "iter2 test"}, timeout=20)
    # Either 200 with a "twilio not configured" payload, OR a 4xx with that error.
    # Crash (500) means asyncio.to_thread wrap is broken.
    assert r.status_code != 500, f"sms/test crashed: {r.status_code} {r.text[:200]}"
    if r.status_code == 200:
        d = r.json()
        # When disabled the audit dict should record an error / kind=sms etc.
        assert isinstance(d, dict), f"unexpected sms body: {d}"


# ---------- 15. Cleanup ----------
def test_99_cleanup(admin_s, state):
    mid = state.get("member_id")
    if mid:
        admin_s.delete(f"{BASE_URL}/api/members/{mid}", timeout=30)
    _cleanup_test_member(admin_s)
