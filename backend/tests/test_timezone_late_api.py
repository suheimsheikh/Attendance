"""End-to-end API tests for Timezone + Late-arrival feature.

Covers:
  - GET/PUT /api/office persists `timezone` + `late_grace_minutes`
  - POST /api/admin/attendance/toggle/{member_id} produces late=true (server time is well past 08:30 IST)
  - GET /api/presence returns `late` boolean for on_campus members + IST 'Since HH:MM'
  - GET /api/admin/summary returns `late_today`
  - GET /api/reports/hours has per-member `late_days`
  - GET /api/reports/hours/export CSV has a 'Late Days' column
  - GET /api/me/stats returns `late_days_this_week`
"""
import csv
import io
import os
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://attendance-app-220.preview.emergentagent.com").rstrip("/")

ADMIN_EMAIL = "admin@attendance.app"
ADMIN_PASSWORD = "Admin@12345"


# ---------------- Fixtures ----------------
@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=20)
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    body = r.json()
    tok = body.get("access_token") or body.get("token")
    assert tok, f"No access_token in login response: {body}"
    return tok


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def office(admin_headers):
    r = requests.get(f"{BASE_URL}/api/office", headers=admin_headers, timeout=20)
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def test_member(admin_headers):
    """Create a disposable TEST_ member to use as the late check-in subject."""
    suffix = str(int(time.time()))[-6:]
    payload = {
        "full_name": f"TEST_Late_{suffix}",
        "email": f"test_late_{suffix}@example.com",
        "password": "Pass@12345",
        "role": "member",
        "category": "sailor",
        "rank": "AB",
    }
    r = requests.post(f"{BASE_URL}/api/members", headers=admin_headers, json=payload, timeout=20)
    assert r.status_code in (200, 201), r.text
    member = r.json()
    yield member
    # cleanup
    try:
        requests.delete(f"{BASE_URL}/api/members/{member['id']}", headers=admin_headers, timeout=20)
    except Exception:
        pass


# ---------------- /api/office ----------------
class TestOfficeTimezone:
    def test_office_returns_timezone_and_grace(self, office):
        assert "timezone" in office, "GET /api/office missing 'timezone' field"
        assert "late_grace_minutes" in office, "GET /api/office missing 'late_grace_minutes'"
        assert isinstance(office["late_grace_minutes"], int)

    def test_put_office_persists_timezone_and_grace(self, admin_headers, office):
        # Toggle to UTC + 25, then restore
        original_tz = office.get("timezone") or "Asia/Kolkata"
        original_grace = int(office.get("late_grace_minutes") or 0)

        new_payload = dict(office)
        new_payload.pop("_id", None)
        new_payload["timezone"] = "UTC"
        new_payload["late_grace_minutes"] = 25

        r = requests.put(f"{BASE_URL}/api/office", headers=admin_headers, json=new_payload, timeout=20)
        assert r.status_code == 200, r.text

        rv = requests.get(f"{BASE_URL}/api/office", headers=admin_headers, timeout=20).json()
        assert rv["timezone"] == "UTC"
        assert rv["late_grace_minutes"] == 25

        # restore
        restore = dict(rv)
        restore["timezone"] = original_tz
        restore["late_grace_minutes"] = original_grace
        rr = requests.put(f"{BASE_URL}/api/office", headers=admin_headers, json=restore, timeout=20)
        assert rr.status_code == 200, rr.text
        final = requests.get(f"{BASE_URL}/api/office", headers=admin_headers, timeout=20).json()
        assert final["timezone"] == original_tz
        assert final["late_grace_minutes"] == original_grace


# ---------------- Late check-in flow ----------------
class TestLateCheckin:
    """We rely on the wall-clock IST time being past `default_work_start + late_grace_minutes`.
    Per problem statement: default_work_start=08:30, late_grace_minutes=15 -> threshold 08:45 IST.
    If the test happens to run before 08:46 IST, skip the late-true assertion."""

    def test_admin_toggle_creates_late_session(self, admin_headers, test_member, office):
        # Ensure no open session before we start
        requests.post(f"{BASE_URL}/api/admin/attendance/toggle/{test_member['id']}",
                      headers=admin_headers, json={"reason": "test cleanup"}, timeout=20)
        # call again to ensure final state is "checked-out"; then do a fresh check-in
        # We'll loop to converge: read presence and ensure exited
        for _ in range(2):
            pres = requests.get(f"{BASE_URL}/api/presence", headers=admin_headers, timeout=20).json()
            me = next((m for m in pres["members"] if m["id"] == test_member["id"]), None)
            if me and me["status"] != "on_campus":
                break
            requests.post(f"{BASE_URL}/api/admin/attendance/toggle/{test_member['id']}",
                          headers=admin_headers, json={"reason": "reset"}, timeout=20)

        # Fresh check-in
        r = requests.post(f"{BASE_URL}/api/admin/attendance/toggle/{test_member['id']}",
                          headers=admin_headers, json={"reason": "TEST late check-in"}, timeout=20)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data.get("action") == "checkin", f"Expected check-in, got: {data}"

    def test_presence_marks_member_late(self, admin_headers, test_member, office):
        # Decide if we should expect late=true (after 08:45 IST + grace)
        tz_name = office.get("timezone") or "Asia/Kolkata"
        now_local = datetime.now(ZoneInfo(tz_name))
        ws = (office.get("default_work_start") or "08:30").split(":")
        threshold_min = int(ws[0]) * 60 + int(ws[1]) + int(office.get("late_grace_minutes") or 0)
        cur_min = now_local.hour * 60 + now_local.minute
        expect_late = cur_min > threshold_min

        r = requests.get(f"{BASE_URL}/api/presence", headers=admin_headers, timeout=20)
        assert r.status_code == 200, r.text
        data = r.json()
        # `date` must be office-local IST date
        local_today = now_local.strftime("%Y-%m-%d")
        assert data["date"] == local_today, f"presence.date {data['date']} != office-local today {local_today}"

        me = next((m for m in data["members"] if m["id"] == test_member["id"]), None)
        assert me is not None, "test member not found in presence list"
        assert me["status"] == "on_campus", f"expected on_campus, got: {me}"
        assert "late" in me, "presence member missing 'late' field"
        assert isinstance(me["late"], bool)
        assert me["detail"].startswith("Since "), f"detail should be 'Since HH:MM', got '{me['detail']}'"

        # Validate HH:MM looks like local time (close to now within 5 minutes)
        hm = me["detail"][len("Since "):]
        h, m_ = map(int, hm.split(":"))
        delta = abs((h * 60 + m_) - cur_min)
        assert delta < 5 or delta > 1435, f"Since {hm} not close to now {now_local.strftime('%H:%M')}"

        if expect_late:
            assert me["late"] is True, f"Expected late=true after {threshold_min//60:02d}:{threshold_min%60:02d} IST, got false. member={me}"

    def test_admin_summary_has_late_today(self, admin_headers, test_member):
        r = requests.get(f"{BASE_URL}/api/admin/summary", headers=admin_headers, timeout=20)
        assert r.status_code == 200, r.text
        s = r.json()
        assert "late_today" in s, f"summary missing late_today: {s}"
        assert isinstance(s["late_today"], int)
        # Member just checked-in late should count
        assert s["late_today"] >= 1, f"expected late_today >= 1, got {s['late_today']}"

    def test_reports_hours_includes_late_days(self, admin_headers, test_member):
        # Close the open session so hours are recorded (compute_hours_report filters hours != None)
        requests.post(f"{BASE_URL}/api/admin/attendance/toggle/{test_member['id']}",
                      headers=admin_headers, json={"reason": "TEST close late session"}, timeout=20)

        today = datetime.now(ZoneInfo("Asia/Kolkata")).strftime("%Y-%m-%d")
        params = {"start": today, "end": today}
        r = requests.get(f"{BASE_URL}/api/reports/hours", headers=admin_headers, params=params, timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        rows = body.get("rows") if isinstance(body, dict) else body
        assert rows is not None and len(rows) > 0, f"no report rows: {body}"
        for row in rows:
            assert "late_days" in row, f"row missing late_days: {row}"
            assert isinstance(row["late_days"], int)
        me = next((r for r in rows if r.get("member_id") == test_member["id"]
                   or r.get("member_name") == test_member["full_name"]), None)
        assert me is not None, f"test member not in hours report; rows={[r.get('member_name') for r in rows]}"
        # If the wall clock was past grace, the closed session should be flagged late
        tz_name = "Asia/Kolkata"
        now_local = datetime.now(ZoneInfo(tz_name))
        if (now_local.hour * 60 + now_local.minute) > (8 * 60 + 30 + 15):
            assert me["late_days"] >= 1, f"expected late_days>=1 for test member, got {me}"

    def test_reports_hours_export_csv_has_late_days_column(self, admin_headers):
        today = datetime.now(ZoneInfo("Asia/Kolkata")).strftime("%Y-%m-%d")
        r = requests.get(f"{BASE_URL}/api/reports/hours/export",
                         headers={"Authorization": admin_headers["Authorization"]},
                         params={"start": today, "end": today}, timeout=30)
        assert r.status_code == 200, r.text
        text = r.text
        reader = csv.reader(io.StringIO(text))
        header = next(reader)
        # 'Late Days' column expected (case-insensitive contains check)
        assert any("late" in h.lower() and "day" in h.lower() for h in header), \
            f"CSV header missing Late Days column: {header}"

    def test_me_stats_returns_late_days_this_week(self, admin_token):
        # Use admin's own token on /api/me/stats — but admin may not have attendance. Use test member token instead.
        # Reuse member credentials we created
        # admin's late_days_this_week may be 0, just check field exists & is int
        r = requests.get(f"{BASE_URL}/api/me/stats",
                         headers={"Authorization": f"Bearer {admin_token}"}, timeout=20)
        assert r.status_code == 200, r.text
        s = r.json()
        assert "late_days_this_week" in s, f"missing late_days_this_week: {s}"
        assert isinstance(s["late_days_this_week"], int)

    def test_me_stats_test_member_late_days(self, test_member):
        # Login as the test member
        r = requests.post(f"{BASE_URL}/api/auth/login",
                          json={"email": test_member["email"], "password": "Pass@12345"}, timeout=20)
        assert r.status_code == 200, r.text
        tok = r.json().get("access_token") or r.json().get("token")
        assert tok
        rs = requests.get(f"{BASE_URL}/api/me/stats",
                          headers={"Authorization": f"Bearer {tok}"}, timeout=20)
        assert rs.status_code == 200, rs.text
        body = rs.json()
        assert "late_days_this_week" in body
        # this week should include today (the late check-in we just made)
        tz_name = "Asia/Kolkata"
        now_local = datetime.now(ZoneInfo(tz_name))
        # If we determined the check-in actually flagged late earlier (after grace), expect >=1
        if (now_local.hour * 60 + now_local.minute) > (8 * 60 + 30 + 15):
            assert body["late_days_this_week"] >= 1, f"expected >=1 late day this week, got {body}"
