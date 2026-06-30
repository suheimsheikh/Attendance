"""R3 — 3-day notice rule for self-applied Leaves.

Rules (30 Jun 2026):
  * Applies to `type=leave` ONLY (tour / posting / late_coming exempt).
  * Member self-apply: start_date - today < notice_days → HTTP 400.
  * Admin filing on behalf (with target_user_id) is exempt — emergencies
    can still be recorded.
  * Threshold is `office.leave_notice_days` (default 3). 0 disables the gate.
"""
from __future__ import annotations

import uuid
import datetime as dt

import pytest
import requests


@pytest.fixture(scope="module")
def api(base_url):
    return f"{base_url}/api"


@pytest.fixture(scope="module")
def member_with_session(admin_client, api, base_url):
    """A non-admin staff member with a working access token. Created
    fresh so we don't disturb existing accounts. Cleaned up at teardown."""
    body = {
        "email": f"TEST_notice_{uuid.uuid4().hex[:6]}@ishowedup-test.example.com",
        "password": "Smoke@1234",
        "full_name": f"TEST_NoticeMember_{uuid.uuid4().hex[:4]}",
        "role": "member",
        "category": "staff",
    }
    r = admin_client.post(f"{api}/members", json=body)
    assert r.status_code == 200, r.text
    member = r.json()
    # Self-login to get a non-admin token.
    tok_r = requests.post(f"{base_url}/api/auth/login",
                          json={"email": body["email"], "password": body["password"]},
                          timeout=30)
    assert tok_r.status_code == 200, tok_r.text
    token = tok_r.json()["access_token"]
    yield {**member, "token": token, "email": body["email"]}
    try:
        admin_client.delete(f"{api}/members/{member['id']}")
    except Exception:
        pass


@pytest.fixture(scope="module")
def office_with_3day_notice(admin_client, api):
    """Ensure office.leave_notice_days == 3 for the duration of this module.
    Restores the original value at teardown."""
    before = admin_client.get(f"{api}/office").json() or {}
    original = before.get("leave_notice_days", 3)
    payload = {**before, "leave_notice_days": 3}
    # The PUT endpoint expects the full OfficeConfig shape; sending the
    # GET payload back (with masked twilio stripped) works because the
    # backend ignores `twilio` on this route.
    payload.pop("twilio", None)
    payload.pop("qr_token", None)
    r = admin_client.put(f"{api}/office", json=payload)
    assert r.status_code == 200, r.text
    yield 3
    # restore
    restore = {**(admin_client.get(f"{api}/office").json() or {}),
               "leave_notice_days": original}
    restore.pop("twilio", None)
    restore.pop("qr_token", None)
    admin_client.put(f"{api}/office", json=restore)


def _member_session(member):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {member['token']}",
                      "Content-Type": "application/json"})
    return s


class TestNoticeRuleBlocksSelfApply:
    def test_too_close_self_apply_leave_is_blocked(
            self, base_url, member_with_session, office_with_3day_notice):
        sess = _member_session(member_with_session)
        # 2 days from today — below the 3-day threshold.
        start = (dt.date.today() + dt.timedelta(days=2)).isoformat()
        end = (dt.date.today() + dt.timedelta(days=2)).isoformat()
        r = sess.post(f"{base_url}/api/leaves",
                      json={"type": "leave", "start_date": start,
                            "end_date": end, "reason": "Wedding"})
        assert r.status_code == 400, r.text
        msg = (r.json().get("detail") or "").lower()
        assert "notice" in msg or "advance" in msg
        assert "admin" in msg, "the error should tell the user to ask the admin"

    def test_past_start_date_self_apply_is_blocked(
            self, base_url, member_with_session, office_with_3day_notice):
        """A start date in the past has days_off < 0, which is also below
        the threshold — must be rejected."""
        sess = _member_session(member_with_session)
        past = (dt.date.today() - dt.timedelta(days=1)).isoformat()
        r = sess.post(f"{base_url}/api/leaves",
                      json={"type": "leave", "start_date": past,
                            "end_date": past, "reason": "Was sick yesterday"})
        assert r.status_code == 400, r.text

    def test_exactly_notice_days_allowed(
            self, base_url, member_with_session, office_with_3day_notice):
        """start_date - today == notice_days is the boundary — allowed."""
        sess = _member_session(member_with_session)
        start = (dt.date.today() + dt.timedelta(days=3)).isoformat()
        end = (dt.date.today() + dt.timedelta(days=3)).isoformat()
        r = sess.post(f"{base_url}/api/leaves",
                      json={"type": "leave", "start_date": start,
                            "end_date": end, "reason": "Exactly 3 days"})
        assert r.status_code == 200, r.text
        # Cleanup
        admin_creds_required = False  # noqa


class TestNoticeRuleExemptions:
    def test_admin_on_behalf_bypasses_notice_rule(
            self, admin_client, api, member_with_session, office_with_3day_notice):
        """An admin filing for the member tomorrow (1-day notice) MUST be
        allowed — the rule only blocks the self-apply path."""
        tomorrow = (dt.date.today() + dt.timedelta(days=1)).isoformat()
        r = admin_client.post(
            f"{api}/leaves?target_user_id={member_with_session['id']}",
            json={"type": "leave", "start_date": tomorrow,
                  "end_date": tomorrow,
                  "reason": "Family emergency — admin on behalf"})
        assert r.status_code == 200, r.text

    def test_tour_type_bypasses_notice_rule(
            self, base_url, member_with_session, office_with_3day_notice):
        sess = _member_session(member_with_session)
        tomorrow = (dt.date.today() + dt.timedelta(days=1)).isoformat()
        r = sess.post(f"{base_url}/api/leaves",
                      json={"type": "tour", "start_date": tomorrow,
                            "end_date": tomorrow, "reason": "Tour tomorrow",
                            "location": "Mumbai"})
        assert r.status_code == 200, r.text

    def test_late_coming_bypasses_notice_rule(
            self, base_url, member_with_session, office_with_3day_notice):
        sess = _member_session(member_with_session)
        today = dt.date.today().isoformat()
        r = sess.post(f"{base_url}/api/leaves",
                      json={"type": "late_coming", "start_date": today,
                            "end_date": today, "reason": "Traffic jam",
                            "expected_arrival": "10:30"})
        assert r.status_code == 200, r.text


class TestNoticeRuleConfigurable:
    def test_zero_disables_the_gate(self, base_url, admin_client, api, member_with_session):
        """Setting leave_notice_days=0 disables the rule entirely — even a
        past-dated self-apply should now succeed."""
        before = admin_client.get(f"{api}/office").json() or {}
        original = before.get("leave_notice_days", 3)
        payload = {**before, "leave_notice_days": 0}
        payload.pop("twilio", None); payload.pop("qr_token", None)
        admin_client.put(f"{api}/office", json=payload)
        try:
            sess = _member_session(member_with_session)
            tomorrow = (dt.date.today() + dt.timedelta(days=1)).isoformat()
            r = sess.post(f"{base_url}/api/leaves",
                          json={"type": "leave", "start_date": tomorrow,
                                "end_date": tomorrow,
                                "reason": "Allowed because notice is disabled"})
            assert r.status_code == 200, r.text
        finally:
            restore = {**(admin_client.get(f"{api}/office").json() or {}),
                       "leave_notice_days": original}
            restore.pop("twilio", None); restore.pop("qr_token", None)
            admin_client.put(f"{api}/office", json=restore)
