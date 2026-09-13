"""Tests for parent-notify feature: POST /notify/parent, GET /notify/today,
GET /notify/log (admin+coach), GET/PUT /notify/templates, GET /muster/late-report."""
import os
import uuid
import pytest
import requests

COACH_EMAIL = "coach.test@example.com"
COACH_PASSWORD = "Exec@12345"


# ---------- helpers ----------

def _login(base_url, email, password):
    r = requests.post(f"{base_url}/api/auth/login",
                      json={"email": email, "password": password}, timeout=30)
    return r


@pytest.fixture(scope="module")
def coach_token(base_url, admin_client):
    """Try to log in coach; if it doesn't exist, create it as a coach category member."""
    r = _login(base_url, COACH_EMAIL, COACH_PASSWORD)
    if r.status_code == 200:
        return r.json().get("access_token")
    # Try create
    body = {
        "email": COACH_EMAIL,
        "password": COACH_PASSWORD,
        "full_name": "Coach Test",
        "role": "member",
        "category": "coach",
    }
    c = admin_client.post(f"{base_url}/api/members", json=body, timeout=30)
    if c.status_code not in (200, 201):
        pytest.skip(f"Could not create coach user: {c.status_code} {c.text}")
    r = _login(base_url, COACH_EMAIL, COACH_PASSWORD)
    if r.status_code != 200:
        pytest.skip(f"Coach login failed after create: {r.status_code} {r.text}")
    return r.json().get("access_token")


@pytest.fixture(scope="module")
def coach_client(base_url, coach_token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {coach_token}",
                      "Content-Type": "application/json"})
    return s


# ---------- muster/late-report ----------

class TestLateReport:
    def test_late_report_returns_list(self, admin_client, base_url):
        r = admin_client.get(f"{base_url}/api/muster/late-report", timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        # Could be dict or list. Accept either
        rows = data if isinstance(data, list) else data.get("rows") or data.get("late") or []
        assert isinstance(rows, list)
        # Each row should have relevant fields when present
        if rows:
            row = rows[0]
            # Expected keys per spec
            assert any(k in row for k in ("check_in_at", "checked_in_at"))
            assert any(k in row for k in ("late_minutes", "minutes_late"))


# ---------- POST /notify/parent ----------

class TestNotifyParent:
    def test_notify_parent_bad_reason(self, admin_client, base_url):
        r = admin_client.post(f"{base_url}/api/notify/parent",
                              json={"member_id": "x", "parent_role": "father", "reason": "wat"},
                              timeout=30)
        assert r.status_code == 400

    def test_notify_parent_bad_role(self, admin_client, base_url):
        r = admin_client.post(f"{base_url}/api/notify/parent",
                              json={"member_id": "x", "parent_role": "uncle", "reason": "absent"},
                              timeout=30)
        assert r.status_code == 400

    def test_notify_parent_unknown_member(self, admin_client, base_url):
        r = admin_client.post(f"{base_url}/api/notify/parent",
                              json={"member_id": "does-not-exist-xyz",
                                    "parent_role": "father", "reason": "absent"},
                              timeout=30)
        assert r.status_code == 404

    def _find_member_with_father_number(self, admin_client, base_url):
        listing = admin_client.get(f"{base_url}/api/members", timeout=30).json()
        for m in listing:
            if (m.get("father_mobile") or "").strip() and m.get("category") == "athlete":
                return m
        return None

    def _find_member_missing_father(self, admin_client, base_url):
        listing = admin_client.get(f"{base_url}/api/members", timeout=30).json()
        for m in listing:
            if not (m.get("father_mobile") or "").strip():
                return m
        return None

    def test_notify_parent_no_number(self, admin_client, base_url):
        m = self._find_member_missing_father(admin_client, base_url)
        if not m:
            pytest.skip("No member without father_mobile found")
        r = admin_client.post(f"{base_url}/api/notify/parent",
                              json={"member_id": m["id"], "parent_role": "father",
                                    "reason": "absent"}, timeout=30)
        assert r.status_code == 400, r.text

    def test_notify_parent_success_and_shows_in_today(self, admin_client, base_url):
        m = self._find_member_with_father_number(admin_client, base_url)
        if not m:
            pytest.skip("No athlete with father_mobile found")
        r = admin_client.post(f"{base_url}/api/notify/parent",
                              json={"member_id": m["id"], "parent_role": "father",
                                    "reason": "absent"}, timeout=30)
        assert r.status_code == 200, r.text
        doc = r.json()
        assert doc["member_id"] == m["id"]
        assert doc["parent_role"] == "father"
        assert doc["reason"] == "absent"
        assert doc["parent_number"], "parent_number should be set from DB"
        assert "_id" not in doc
        # GET /notify/today should include this key
        t = admin_client.get(f"{base_url}/api/notify/today?reason=absent", timeout=30)
        assert t.status_code == 200
        keys = t.json().get("keys", [])
        assert f"{m['id']}:father_mobile" in keys


# ---------- GET /notify/log role gating ----------

class TestNotifyLog:
    def test_log_admin_ok(self, admin_client, base_url):
        r = admin_client.get(f"{base_url}/api/notify/log?reason=all&limit=50", timeout=30)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_log_filter_absent(self, admin_client, base_url):
        r = admin_client.get(f"{base_url}/api/notify/log?reason=absent", timeout=30)
        assert r.status_code == 200
        for row in r.json():
            assert row["reason"] == "absent"

    def test_log_coach_ok(self, coach_client, base_url):
        r = coach_client.get(f"{base_url}/api/notify/log?reason=all&limit=10", timeout=30)
        assert r.status_code == 200, f"Coach should NOT be 403: {r.status_code} {r.text}"

    def test_log_sorted_newest_first(self, admin_client, base_url):
        rows = admin_client.get(f"{base_url}/api/notify/log?reason=all&limit=20",
                                timeout=30).json()
        if len(rows) >= 2:
            assert rows[0]["created_at"] >= rows[1]["created_at"]


# ---------- templates ----------

class TestTemplates:
    def test_get_templates_defaults(self, admin_client, base_url):
        r = admin_client.get(f"{base_url}/api/notify/templates", timeout=30)
        assert r.status_code == 200
        data = r.json()
        for k in ("absent_te", "absent_en", "late_te", "late_en"):
            assert k in data
            assert isinstance(data[k], str) and len(data[k]) > 10

    def test_put_templates_admin_persists(self, admin_client, base_url):
        marker = f"TEST_TPL_{uuid.uuid4().hex[:6]}"
        orig = admin_client.get(f"{base_url}/api/notify/templates", timeout=30).json()
        new_val = orig["absent_en"] + f"\n{marker}"
        r = admin_client.put(f"{base_url}/api/notify/templates",
                             json={"absent_en": new_val}, timeout=30)
        assert r.status_code == 200, r.text
        assert marker in r.json()["absent_en"]
        # Reload
        again = admin_client.get(f"{base_url}/api/notify/templates", timeout=30).json()
        assert marker in again["absent_en"]
        # Restore original
        admin_client.put(f"{base_url}/api/notify/templates",
                         json={"absent_en": orig["absent_en"]}, timeout=30)

    def test_put_templates_coach_forbidden(self, coach_client, base_url):
        r = coach_client.put(f"{base_url}/api/notify/templates",
                             json={"absent_en": "hack"}, timeout=30)
        assert r.status_code == 403, f"Non-admin PUT should be 403: {r.status_code}"
