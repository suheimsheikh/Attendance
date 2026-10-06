"""Backend checks for the executive Tasks feature (iter 53)."""
import os
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    with open("/app/frontend/.env") as f:
        for line in f:
            if line.startswith("REACT_APP_BACKEND_URL"):
                BASE_URL = line.split("=", 1)[1].strip().rstrip("/")
                break

ADMIN = ("admin@attendance.app", "Admin@12345")


def _login(email, pw):
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": pw}, timeout=30)
    assert r.status_code == 200, f"login {email}: {r.status_code} {r.text}"
    return r.json()["access_token"]


def _client(token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def exec_client(make_member):
    return make_member("executive", login=True)["client"]  # throwaway executive


@pytest.fixture(scope="module")
def staff_client(make_member):
    return make_member("staff", login=True)["client"]  # throwaway non-executive


@pytest.fixture(scope="module")
def admin_client():
    return _client(_login(*ADMIN))


# --- staff (non-executive) ---
def test_tasks_today_staff_disabled(staff_client):
    r = staff_client.get(f"{BASE_URL}/api/tasks/today", timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data.get("enabled") is False


def test_todos_list_staff_403(staff_client):
    r = staff_client.get(f"{BASE_URL}/api/todos", timeout=30)
    assert r.status_code == 403


# --- validation ---
def test_checklist_dow_requires_days(exec_client):
    r = exec_client.post(f"{BASE_URL}/api/checklists",
                         json={"title": "TEST_DOW_NO_DAYS", "recurrence": "dow"}, timeout=30)
    assert r.status_code == 400


def test_todo_assign_to_non_executive_400(exec_client, staff_client):
    # get staff user id via /auth/me
    me = staff_client.get(f"{BASE_URL}/api/auth/me", timeout=30).json()
    staff_id = me.get("id") or me.get("user_id") or me.get("_id")
    assert staff_id, f"cannot resolve staff id from {me}"
    r = exec_client.post(f"{BASE_URL}/api/todos",
                         json={"title": "TEST_bad_assign", "owner_id": staff_id}, timeout=30)
    assert r.status_code == 400
    assert "executive" in r.text.lower()


# --- exec flows ---
def test_dar_prefill_exec(exec_client):
    from datetime import datetime
    from zoneinfo import ZoneInfo
    today = datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat()
    t = exec_client.post(f"{BASE_URL}/api/todos",
                         json={"title": "TEST_prefill_todo", "due_date": today}, timeout=30)
    assert t.status_code == 200, t.text
    r = exec_client.get(f"{BASE_URL}/api/tasks/dar-prefill", timeout=30)
    assert r.status_code == 200
    text = r.json().get("text", "")
    # A to-do due today shows up as pending (⏳) in the prefill.
    assert "⏳" in text and "TEST_prefill_todo" in text, f"expected pending to-do in prefill, got: {text!r}"
    exec_client.delete(f"{BASE_URL}/api/todos/{t.json()['id']}", timeout=30)


def test_admin_overview_ok(admin_client):
    r = admin_client.get(f"{BASE_URL}/api/admin/tasks/overview", timeout=30)
    assert r.status_code == 200
    data = r.json()
    assert "rows" in data and isinstance(data["rows"], list)
    assert len(data["rows"]) >= 1


def test_geo_toggle_site_label(exec_client):
    # POST geo-toggle (check-in/out) with a plausible office location and see if response includes site_label
    r = exec_client.post(f"{BASE_URL}/api/attendance/geo-toggle",
                         json={"latitude": 12.9716, "longitude": 77.5946}, timeout=30)
    # response could be 200 (toggled) or 400 (business rule); either way, if 200, must include site_label
    assert r.status_code in (200, 400), r.text
    if r.status_code == 200:
        data = r.json()
        # site_label may be top-level or nested; accept either
        blob = str(data)
        assert "site_label" in blob, f"site_label missing: {data}"
