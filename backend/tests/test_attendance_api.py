"""End-to-end backend API tests for the Attendance app.

Covers: auth, office config, members CRUD/role enforcement, attendance
check-in/out (QR + geofence), presence board, leaves/tour approvals,
stats/summary, reports + CSV/PDF exports.
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://attendance-app-220.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "admin@attendance.app"
ADMIN_PW = "Admin@12345"
MEMBER_EMAIL = "arjun@attendance.app"
MEMBER_PW = "pass123"

OFFICE_LAT = 19.0760
OFFICE_LNG = 72.8777
FAR_LAT = 19.2000
FAR_LNG = 72.9500


# ---------------- fixtures ----------------
@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PW}, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="session")
def member_token():
    r = requests.post(f"{API}/auth/login", json={"email": MEMBER_EMAIL, "password": MEMBER_PW}, timeout=15)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def H(t):
    return {"Authorization": f"Bearer {t}"}


# ---------------- AUTH ----------------
class TestAuth:
    def test_login_admin(self):
        r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PW})
        assert r.status_code == 200
        d = r.json()
        assert "access_token" in d and d["user"]["role"] == "admin"

    def test_login_member(self):
        r = requests.post(f"{API}/auth/login", json={"email": MEMBER_EMAIL, "password": MEMBER_PW})
        assert r.status_code == 200
        assert r.json()["user"]["role"] == "member"

    def test_login_invalid(self):
        r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": "wrong"})
        assert r.status_code == 401

    def test_me(self, admin_token):
        r = requests.get(f"{API}/auth/me", headers=H(admin_token))
        assert r.status_code == 200 and r.json()["email"] == ADMIN_EMAIL

    def test_me_no_token(self):
        r = requests.get(f"{API}/auth/me")
        assert r.status_code == 401


# ---------------- OFFICE ----------------
class TestOffice:
    def test_get_office_member(self, member_token):
        r = requests.get(f"{API}/office", headers=H(member_token))
        assert r.status_code == 200
        d = r.json()
        assert "qr_token" in d and "latitude" in d

    def test_put_office_member_forbidden(self, member_token):
        r = requests.put(f"{API}/office", headers=H(member_token),
                         json={"name": "X", "latitude": 1.0, "longitude": 1.0, "radius_m": 100})
        assert r.status_code == 403

    def test_put_office_admin(self, admin_token):
        r = requests.put(f"{API}/office", headers=H(admin_token),
                         json={"name": "Campus Office", "latitude": OFFICE_LAT,
                               "longitude": OFFICE_LNG, "radius_m": 100})
        assert r.status_code == 200
        assert r.json()["latitude"] == OFFICE_LAT

    def test_regenerate_qr_member_forbidden(self, member_token):
        r = requests.post(f"{API}/office/regenerate-qr", headers=H(member_token))
        assert r.status_code == 403


# ---------------- MEMBERS ----------------
class TestMembers:
    created_id = None

    def test_list_members_member_role(self, member_token):
        r = requests.get(f"{API}/members", headers=H(member_token))
        # both admin & member can list (any auth user)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_create_member_member_forbidden(self, member_token):
        r = requests.post(f"{API}/members", headers=H(member_token),
                         json={"email": "x@x.com", "password": "test123",
                               "full_name": "X", "category": "sailor", "role": "member"})
        assert r.status_code == 403

    def test_create_member_admin(self, admin_token):
        email = f"TEST_{uuid.uuid4().hex[:8]}@attendance.app"
        r = requests.post(f"{API}/members", headers=H(admin_token),
                         json={"email": email, "password": "test1234",
                               "full_name": "TEST User", "category": "sailor", "role": "member"})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["email"] == email and d["role"] == "member"
        TestMembers.created_id = d["id"]

    def test_update_member(self, admin_token):
        assert TestMembers.created_id
        r = requests.patch(f"{API}/members/{TestMembers.created_id}", headers=H(admin_token),
                           json={"full_name": "TEST Updated", "rank": "Trainee"})
        assert r.status_code == 200
        assert r.json()["full_name"] == "TEST Updated"

    def test_delete_member(self, admin_token):
        assert TestMembers.created_id
        r = requests.delete(f"{API}/members/{TestMembers.created_id}", headers=H(admin_token))
        assert r.status_code == 200 and r.json()["ok"] is True

    def test_delete_member_member_forbidden(self, member_token):
        r = requests.delete(f"{API}/members/nonexistent", headers=H(member_token))
        assert r.status_code == 403


# ---------------- ATTENDANCE ----------------
class TestAttendance:
    @pytest.fixture(scope="class")
    def fresh_member(self, admin_token):
        """Create a fresh member so check-in/out tests have a clean state."""
        email = f"TEST_att_{uuid.uuid4().hex[:6]}@attendance.app"
        r = requests.post(f"{API}/members", headers=H(admin_token),
                         json={"email": email, "password": "pass1234",
                               "full_name": "TEST Att", "category": "sailor", "role": "member"})
        assert r.status_code == 200
        member_id = r.json()["id"]
        lr = requests.post(f"{API}/auth/login", json={"email": email, "password": "pass1234"})
        token = lr.json()["access_token"]
        yield token
        requests.delete(f"{API}/members/{member_id}", headers=H(admin_token))

    def _qr(self, t):
        return requests.get(f"{API}/office", headers=H(t)).json()["qr_token"]

    def test_status_initial(self, fresh_member):
        r = requests.get(f"{API}/attendance/status", headers=H(fresh_member))
        assert r.status_code == 200 and r.json()["checked_in"] is False

    def test_checkin_invalid_qr(self, fresh_member):
        r = requests.post(f"{API}/attendance/checkin", headers=H(fresh_member),
                         json={"qr_token": "BAD", "latitude": OFFICE_LAT, "longitude": OFFICE_LNG})
        assert r.status_code == 400 and "Invalid" in r.json()["detail"]

    def test_checkin_far_location(self, fresh_member):
        qr = self._qr(fresh_member)
        r = requests.post(f"{API}/attendance/checkin", headers=H(fresh_member),
                         json={"qr_token": qr, "latitude": FAR_LAT, "longitude": FAR_LNG})
        assert r.status_code == 400 and "from campus" in r.json()["detail"]

    def test_checkin_success(self, fresh_member):
        qr = self._qr(fresh_member)
        r = requests.post(f"{API}/attendance/checkin", headers=H(fresh_member),
                         json={"qr_token": qr, "latitude": OFFICE_LAT, "longitude": OFFICE_LNG})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["ok"] is True and d["session"]["check_out_at"] is None
        # verify status
        st = requests.get(f"{API}/attendance/status", headers=H(fresh_member)).json()
        assert st["checked_in"] is True

    def test_checkin_duplicate(self, fresh_member):
        qr = self._qr(fresh_member)
        r = requests.post(f"{API}/attendance/checkin", headers=H(fresh_member),
                         json={"qr_token": qr, "latitude": OFFICE_LAT, "longitude": OFFICE_LNG})
        assert r.status_code == 400 and "already" in r.json()["detail"].lower()

    def test_checkout_success(self, fresh_member):
        qr = self._qr(fresh_member)
        r = requests.post(f"{API}/attendance/checkout", headers=H(fresh_member),
                         json={"qr_token": qr, "latitude": OFFICE_LAT, "longitude": OFFICE_LNG})
        assert r.status_code == 200
        assert "hours" in r.json() and isinstance(r.json()["hours"], (int, float))

    def test_checkout_when_not_checked_in(self, fresh_member):
        r = requests.post(f"{API}/attendance/checkout", headers=H(fresh_member),
                         json={"qr_token": "X", "latitude": 0, "longitude": 0})
        assert r.status_code == 400


# ---------------- PRESENCE ----------------
class TestPresence:
    def test_presence_board(self, member_token):
        r = requests.get(f"{API}/presence", headers=H(member_token))
        assert r.status_code == 200
        d = r.json()
        assert "members" in d and "counts" in d
        statuses = {m["status"] for m in d["members"]}
        # all statuses should be from valid set
        assert statuses <= {"on_campus", "exited", "on_tour", "on_leave"}


# ---------------- LEAVES ----------------
class TestLeaves:
    leave_id = None
    test_member_id = None
    test_member_token = None

    @pytest.fixture(scope="class", autouse=True)
    def setup_member(self, admin_token):
        email = f"TEST_lv_{uuid.uuid4().hex[:6]}@attendance.app"
        r = requests.post(f"{API}/members", headers=H(admin_token),
                         json={"email": email, "password": "pass1234",
                               "full_name": "TEST Leave", "category": "sailor", "role": "member"})
        TestLeaves.test_member_id = r.json()["id"]
        lr = requests.post(f"{API}/auth/login", json={"email": email, "password": "pass1234"})
        TestLeaves.test_member_token = lr.json()["access_token"]
        yield
        requests.delete(f"{API}/members/{TestLeaves.test_member_id}", headers=H(admin_token))

    def test_create_tour(self):
        from datetime import date, timedelta
        today = date.today().isoformat()
        end = (date.today() + timedelta(days=2)).isoformat()
        r = requests.post(f"{API}/leaves", headers=H(TestLeaves.test_member_token),
                         json={"type": "tour", "start_date": today, "end_date": end,
                               "reason": "Regatta", "location": "Mumbai"})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["status"] == "pending" and d["type"] == "tour"
        TestLeaves.leave_id = d["id"]

    def test_my_leaves(self):
        r = requests.get(f"{API}/leaves/mine", headers=H(TestLeaves.test_member_token))
        assert r.status_code == 200
        assert any(l["id"] == TestLeaves.leave_id for l in r.json())

    def test_admin_list_pending(self, admin_token):
        r = requests.get(f"{API}/leaves?status_filter=pending", headers=H(admin_token))
        assert r.status_code == 200
        assert any(l["id"] == TestLeaves.leave_id for l in r.json())

    def test_member_cant_list_all(self):
        r = requests.get(f"{API}/leaves", headers=H(TestLeaves.test_member_token))
        assert r.status_code == 403

    def test_approve_leave(self, admin_token):
        r = requests.patch(f"{API}/leaves/{TestLeaves.leave_id}", headers=H(admin_token),
                           json={"status": "approved"})
        assert r.status_code == 200 and r.json()["status"] == "approved"

    def test_presence_reflects_tour(self, admin_token):
        r = requests.get(f"{API}/presence", headers=H(admin_token))
        members = r.json()["members"]
        target = next((m for m in members if m["id"] == TestLeaves.test_member_id), None)
        assert target and target["status"] == "on_tour"


# ---------------- STATS / SUMMARY ----------------
class TestStats:
    def test_me_stats(self, member_token):
        r = requests.get(f"{API}/me/stats", headers=H(member_token))
        assert r.status_code == 200
        for k in ("week_hours", "month_hours", "days_this_week", "checked_in", "pending_leaves"):
            assert k in r.json()

    def test_admin_summary(self, admin_token):
        r = requests.get(f"{API}/admin/summary", headers=H(admin_token))
        assert r.status_code == 200
        for k in ("total_members", "on_campus", "pending_leaves", "on_leave_tour"):
            assert k in r.json()

    def test_admin_summary_member_forbidden(self, member_token):
        r = requests.get(f"{API}/admin/summary", headers=H(member_token))
        assert r.status_code == 403


# ---------------- REPORTS ----------------
class TestReports:
    def test_hours_report(self, admin_token):
        from datetime import date, timedelta
        start = (date.today() - timedelta(days=7)).isoformat()
        end = date.today().isoformat()
        r = requests.get(f"{API}/reports/hours?start={start}&end={end}", headers=H(admin_token))
        assert r.status_code == 200
        assert "rows" in r.json()

    def test_hours_report_member_forbidden(self, member_token):
        from datetime import date
        d = date.today().isoformat()
        r = requests.get(f"{API}/reports/hours?start={d}&end={d}", headers=H(member_token))
        assert r.status_code == 403

    def test_daily_report(self, member_token):
        r = requests.get(f"{API}/reports/daily", headers=H(member_token))
        assert r.status_code == 200
        d = r.json()
        assert "on_leave" in d and "on_tour" in d

    def test_export_hours_csv(self, admin_token):
        from datetime import date, timedelta
        s = (date.today() - timedelta(days=7)).isoformat()
        e = date.today().isoformat()
        r = requests.get(f"{API}/reports/hours/export?start={s}&end={e}&fmt=csv", headers=H(admin_token))
        assert r.status_code == 200
        assert "text/csv" in r.headers.get("content-type", "")

    def test_export_hours_pdf(self, admin_token):
        from datetime import date, timedelta
        s = (date.today() - timedelta(days=7)).isoformat()
        e = date.today().isoformat()
        r = requests.get(f"{API}/reports/hours/export?start={s}&end={e}&fmt=pdf", headers=H(admin_token))
        assert r.status_code == 200
        assert "application/pdf" in r.headers.get("content-type", "")
        assert r.content[:4] == b"%PDF"

    def test_export_daily_csv(self, member_token):
        r = requests.get(f"{API}/reports/daily/export?fmt=csv", headers=H(member_token))
        assert r.status_code == 200
        assert "text/csv" in r.headers.get("content-type", "")

    def test_export_daily_pdf(self, member_token):
        r = requests.get(f"{API}/reports/daily/export?fmt=pdf", headers=H(member_token))
        assert r.status_code == 200
        assert "application/pdf" in r.headers.get("content-type", "")
