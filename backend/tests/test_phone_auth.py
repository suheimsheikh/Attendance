"""Backend tests for passwordless phone-based login + admin device approval (iteration 4).

Covers:
- Email login fallback (bootstrap admin).
- POST /api/auth/phone for: predesignated admin (instant approve), unknown number (pending).
- Phone matching is digit-tolerant (last-10-digits, ignores country code + formatting).
- GET /api/auth/phone/status polling: pending until approved.
- Admin device endpoints: list (status_filter), approve (creates user when unknown), reject, revoke.
- Revoked device's previously issued token returns 401 on /api/auth/me.
"""
import os
import time
import uuid
import requests
import pytest

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/")
ADMIN_EMAIL = "admin@attendance.app"
ADMIN_PASSWORD = "Admin@12345"

API = f"{BASE_URL}/api"


# ---------------- fixtures ----------------
@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=20)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


# Track resources to clean up
@pytest.fixture
def cleanup(admin_headers):
    created_user_ids = []
    created_device_ids = []
    yield {"users": created_user_ids, "devices": created_device_ids}
    # remove users
    for uid in created_user_ids:
        try:
            requests.delete(f"{API}/members/{uid}", headers=admin_headers, timeout=15)
        except Exception:
            pass


# ---------------- email login fallback ----------------
class TestEmailLoginFallback:
    def test_admin_email_login_ok(self):
        r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=20)
        assert r.status_code == 200
        data = r.json()
        assert "access_token" in data
        assert data["user"]["role"] == "admin"
        # /auth/me with bootstrap token (no device_id)
        me = requests.get(f"{API}/auth/me",
                          headers={"Authorization": f"Bearer {data['access_token']}"}, timeout=15)
        assert me.status_code == 200
        assert me.json()["email"] == ADMIN_EMAIL


# ---------------- predesignated admin instant login ----------------
class TestPhoneAdminInstant:
    """Pre-designated admin (admin user with a mobile) -> instant approve + login."""

    def test_admin_with_mobile_instant_login(self, admin_headers, cleanup):
        # Create a fresh admin with a mobile
        digits = "9991110001"
        email = f"TEST_admin_{uuid.uuid4().hex[:6]}@attendance.app"
        r = requests.post(f"{API}/members", headers=admin_headers, json={
            "email": email, "password": "Test@1234", "full_name": "TEST Admin Phone",
            "role": "admin", "category": "staff", "mobile": digits,
        }, timeout=20)
        assert r.status_code == 200, r.text
        cleanup["users"].append(r.json()["id"])

        device_id = f"test-dev-{uuid.uuid4().hex[:10]}"
        # Phone login with country code + formatting -> should be normalized & matched
        body = {"phone": "+91 99911-10001", "device_id": device_id,
                "device_name": "TestBrowser", "model": "Chromium", "platform": "web"}
        resp = requests.post(f"{API}/auth/phone", json=body, timeout=20)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "approved", data
        assert "access_token" in data
        assert data["user"]["mobile"] == digits
        assert data["user"]["role"] == "admin"

        # token should work on /auth/me
        me = requests.get(f"{API}/auth/me",
                          headers={"Authorization": f"Bearer {data['access_token']}"}, timeout=15)
        assert me.status_code == 200
        assert me.json()["mobile"] == digits


# ---------------- unknown phone pending flow ----------------
class TestUnknownPhonePending:
    def test_unknown_phone_returns_pending(self):
        device_id = f"test-dev-{uuid.uuid4().hex[:10]}"
        # Unique, almost-certainly-unknown number
        unique_phone = "55" + uuid.uuid4().int.__str__()[:8]
        resp = requests.post(f"{API}/auth/phone", json={
            "phone": unique_phone, "device_id": device_id,
            "device_name": "UnknownDev", "model": "Pixel", "platform": "android",
        }, timeout=20)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["status"] == "pending"
        assert data["device_id"] == device_id

        # status poll while pending
        s = requests.get(f"{API}/auth/phone/status", params={"device_id": device_id}, timeout=15)
        assert s.status_code == 200
        assert s.json()["status"] == "pending"

    def test_short_phone_rejected(self):
        device_id = f"test-dev-{uuid.uuid4().hex[:10]}"
        r = requests.post(f"{API}/auth/phone", json={
            "phone": "123", "device_id": device_id,
        }, timeout=15)
        assert r.status_code == 400


# ---------------- admin device endpoints (list / approve / reject / revoke) ----------------
class TestAdminDeviceFlow:
    def test_list_pending_then_approve_creates_user(self, admin_headers, cleanup):
        device_id = f"test-dev-{uuid.uuid4().hex[:10]}"
        unique_phone = "77" + uuid.uuid4().int.__str__()[:8]
        # Create pending request as unknown user
        r = requests.post(f"{API}/auth/phone", json={
            "phone": unique_phone, "device_id": device_id,
            "device_name": "PendingDev", "model": "iPhone 15", "platform": "ios",
        }, timeout=20)
        assert r.status_code == 200 and r.json()["status"] == "pending"

        # List pending requests as admin
        lst = requests.get(f"{API}/admin/devices", params={"status_filter": "pending"},
                           headers=admin_headers, timeout=15)
        assert lst.status_code == 200
        devices = lst.json()
        match = next((d for d in devices if d.get("device_id") == device_id), None)
        assert match is not None, f"Pending device {device_id} not found in admin list"
        assert match["status"] == "pending"
        assert match.get("phone", "").endswith(unique_phone[-10:])

        device_pk = match["id"]

        # Approve with full_name + role + category (creates user)
        full_name = f"TEST New Member {uuid.uuid4().hex[:4]}"
        ap = requests.post(f"{API}/admin/devices/{device_pk}/approve",
                           headers=admin_headers, json={
                               "full_name": full_name, "role": "member",
                               "category": "sailor", "rank": "Cadet",
                           }, timeout=20)
        assert ap.status_code == 200, ap.text
        assert ap.json()["ok"] is True

        # Polling now returns approved with token + user
        s = requests.get(f"{API}/auth/phone/status", params={"device_id": device_id}, timeout=15)
        assert s.status_code == 200
        sd = s.json()
        assert sd["status"] == "approved", sd
        assert "access_token" in sd
        assert sd["user"]["full_name"] == full_name
        assert sd["user"]["role"] == "member"
        assert sd["user"]["category"] == "sailor"

        # New user created -> cleanup
        cleanup["users"].append(sd["user"]["id"])

        # The device token works on /auth/me
        token = sd["access_token"]
        me = requests.get(f"{API}/auth/me",
                          headers={"Authorization": f"Bearer {token}"}, timeout=15)
        assert me.status_code == 200
        assert me.json()["id"] == sd["user"]["id"]

        # ---- Now revoke -> token must be 401 ----
        rv = requests.post(f"{API}/admin/devices/{device_pk}/revoke",
                           headers=admin_headers, timeout=15)
        assert rv.status_code == 200
        me2 = requests.get(f"{API}/auth/me",
                           headers={"Authorization": f"Bearer {token}"}, timeout=15)
        assert me2.status_code == 401, me2.text

    def test_reject_request(self, admin_headers):
        device_id = f"test-dev-{uuid.uuid4().hex[:10]}"
        unique_phone = "66" + uuid.uuid4().int.__str__()[:8]
        r = requests.post(f"{API}/auth/phone", json={
            "phone": unique_phone, "device_id": device_id, "platform": "web",
        }, timeout=20)
        assert r.status_code == 200

        lst = requests.get(f"{API}/admin/devices", params={"status_filter": "pending"},
                           headers=admin_headers, timeout=15)
        match = next((d for d in lst.json() if d.get("device_id") == device_id), None)
        assert match is not None
        rej = requests.post(f"{API}/admin/devices/{match['id']}/reject",
                            headers=admin_headers, timeout=15)
        assert rej.status_code == 200
        # status endpoint should now return pending (not approved) — we just confirm not approved
        s = requests.get(f"{API}/auth/phone/status", params={"device_id": device_id}, timeout=15)
        assert s.json()["status"] != "approved"

    def test_admin_devices_requires_admin(self):
        # No auth -> 401
        r = requests.get(f"{API}/admin/devices", timeout=15)
        assert r.status_code == 401


# ---------------- phone matching for known member (last-10 digits) ----------------
class TestPhoneMatchKnownMember:
    def test_known_member_marks_request_with_user_id(self, admin_headers, cleanup):
        digits = "9000" + uuid.uuid4().int.__str__()[:6]
        email = f"TEST_member_{uuid.uuid4().hex[:6]}@attendance.app"
        r = requests.post(f"{API}/members", headers=admin_headers, json={
            "email": email, "password": "Test@1234",
            "full_name": "TEST Known Member", "role": "member",
            "category": "sailor", "mobile": digits,
        }, timeout=20)
        assert r.status_code == 200, r.text
        member_id = r.json()["id"]
        cleanup["users"].append(member_id)

        device_id = f"test-dev-{uuid.uuid4().hex[:10]}"
        # Use country-code formatted variant
        formatted = f"+91 {digits[:5]}-{digits[5:]}"
        resp = requests.post(f"{API}/auth/phone", json={
            "phone": formatted, "device_id": device_id,
            "device_name": "KnownDev", "model": "Galaxy", "platform": "android",
        }, timeout=20)
        assert resp.status_code == 200, resp.text
        data = resp.json()
        # Member is matched but not auto-approved -> pending with matched_member name
        assert data["status"] == "pending"
        assert data["matched_member"] == "TEST Known Member"

        # In admin list, the device should already be linked to user_id
        lst = requests.get(f"{API}/admin/devices", params={"status_filter": "pending"},
                           headers=admin_headers, timeout=15)
        match = next((d for d in lst.json() if d.get("device_id") == device_id), None)
        assert match is not None
        assert match.get("user_id") == member_id
        assert match.get("member_name") == "TEST Known Member"

        # Approve (no name needed) -> token works
        ap = requests.post(f"{API}/admin/devices/{match['id']}/approve",
                           headers=admin_headers, json={
                               "role": "member", "category": "sailor",
                           }, timeout=20)
        assert ap.status_code == 200

        s = requests.get(f"{API}/auth/phone/status", params={"device_id": device_id}, timeout=15)
        sd = s.json()
        assert sd["status"] == "approved"
        assert sd["user"]["id"] == member_id


# ---------------- member token cannot call admin endpoints ----------------
class TestMemberCannotListDevices:
    def test_member_token_forbidden(self, admin_headers, cleanup):
        email = f"TEST_m_{uuid.uuid4().hex[:6]}@attendance.app"
        r = requests.post(f"{API}/members", headers=admin_headers, json={
            "email": email, "password": "Test@1234",
            "full_name": "TEST Plain Member", "role": "member", "category": "staff",
        }, timeout=20)
        assert r.status_code == 200
        cleanup["users"].append(r.json()["id"])
        lg = requests.post(f"{API}/auth/login", json={"email": email, "password": "Test@1234"}, timeout=15)
        assert lg.status_code == 200
        member_token = lg.json()["access_token"]
        r2 = requests.get(f"{API}/admin/devices",
                          headers={"Authorization": f"Bearer {member_token}"}, timeout=15)
        assert r2.status_code == 403
