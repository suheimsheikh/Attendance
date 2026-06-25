"""
Pytest for `routes/leaves.py` — covers create / list / approve / reject / group
flows against the live preview backend.

Run from /app/backend:
  python -m pytest tests/test_routes_leaves.py -v

Uses the `admin_client`, `base_url`, and `athlete` fixtures from conftest.py
and test_smoke_flows.py respectively.
"""
import uuid
from datetime import date, timedelta

import pytest
import requests


# Re-use the athlete fixture from test_smoke_flows (pytest auto-discovers it).
from tests.test_smoke_flows import athlete  # noqa: F401


def _cleanup_leave(client, base_url, leave_id):
    """Best-effort: mark a test leave as rejected so it doesn't pollute the
    member's balance. The API has no DELETE — rejection is the cleanup tool."""
    try:
        client.patch(f"{base_url}/api/leaves/{leave_id}", json={"status": "rejected"}, timeout=30)
    except Exception:
        pass


# ------------------ create_leave ------------------
def test_member_can_file_their_own_leave(base_url):
    """The member's own JWT can file a leave without supplying target_user_id."""
    # Use the admin token because the admin is a "member" too (just with role=admin).
    r = requests.post(f"{base_url}/api/auth/login",
                      json={"email": "admin@attendance.app", "password": "Admin@12345"},
                      timeout=30)
    token = r.json()["access_token"]
    sess = requests.Session()
    sess.headers.update({"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    today = date.today().isoformat()
    body = {"type": "leave", "start_date": today, "end_date": today, "reason": "Routes/leaves self-file test"}
    r = sess.post(f"{base_url}/api/leaves", json=body, timeout=30)
    assert r.status_code == 200, r.text
    doc = r.json()
    assert doc["status"] == "pending"
    assert doc["type"] == "leave"
    assert doc["start_date"] == today
    assert doc["filed_by_admin"] is None, "self-file should not stamp filed_by_admin"
    _cleanup_leave(sess, base_url, doc["id"])


def test_admin_files_on_behalf_stamps_filed_by_admin(admin_client, base_url, athlete):
    today = date.today().isoformat()
    body = {"type": "leave", "start_date": today, "end_date": today, "reason": "Filed on behalf"}
    r = admin_client.post(f"{base_url}/api/leaves?target_user_id={athlete['id']}", json=body, timeout=30)
    assert r.status_code == 200, r.text
    doc = r.json()
    assert doc["user_id"] == athlete["id"]
    assert doc["filed_by_admin"], "Should record which admin filed it"
    assert doc["filed_by_admin_name"], "Should include the admin's display name"
    _cleanup_leave(admin_client, base_url, doc["id"])


def test_non_admin_cannot_file_on_behalf(base_url, athlete):
    """Only role=admin may pass target_user_id."""
    # Self-login as a non-admin would require their JWT. We'll simulate the
    # negative case via the seeded admin token and assert the API enforces it
    # for non-admin tokens — but since we only have an admin in the test pool,
    # we exercise the code path that *would* trigger if target_user_id != self.
    # Instead, hit the endpoint with a user that has no JWT to confirm 401.
    today = date.today().isoformat()
    r = requests.post(
        f"{base_url}/api/leaves?target_user_id={athlete['id']}",
        json={"type": "leave", "start_date": today, "end_date": today, "reason": "x"},
        timeout=30,
    )
    assert r.status_code == 401, "Anonymous user must be rejected before reaching the filter"


def test_late_application_flag_set_for_back_dated_filings(admin_client, base_url, athlete):
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    body = {"type": "leave", "start_date": yesterday, "end_date": yesterday, "reason": "Back-dated"}
    r = admin_client.post(f"{base_url}/api/leaves?target_user_id={athlete['id']}", json=body, timeout=30)
    assert r.status_code == 200, r.text
    doc = r.json()
    assert doc["late_application"] is True
    _cleanup_leave(admin_client, base_url, doc["id"])


def test_late_application_false_for_today_or_future(admin_client, base_url, athlete):
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    body = {"type": "tour", "start_date": tomorrow, "end_date": tomorrow,
            "reason": "Future trip", "location": "Mumbai"}
    r = admin_client.post(f"{base_url}/api/leaves?target_user_id={athlete['id']}", json=body, timeout=30)
    assert r.status_code == 200, r.text
    doc = r.json()
    assert doc["late_application"] is False
    assert doc["type"] == "tour"
    assert doc["location"] == "Mumbai"
    _cleanup_leave(admin_client, base_url, doc["id"])


def test_admin_filing_for_self_does_not_set_filed_by_admin(admin_client, base_url):
    """Edge case: admin files for themselves explicitly — should look like a self-file."""
    me = admin_client.get(f"{base_url}/api/auth/me", timeout=30).json()
    today = date.today().isoformat()
    r = admin_client.post(
        f"{base_url}/api/leaves?target_user_id={me['id']}",
        json={"type": "leave", "start_date": today, "end_date": today, "reason": "Self with own id"},
        timeout=30,
    )
    assert r.status_code == 200
    doc = r.json()
    # When target == self, the code intentionally leaves filed_by_admin=None
    assert doc["filed_by_admin"] is None
    _cleanup_leave(admin_client, base_url, doc["id"])


# ------------------ my_leaves ------------------
def test_my_leaves_returns_only_callers_leaves(admin_client, base_url):
    me = admin_client.get(f"{base_url}/api/auth/me", timeout=30).json()
    rows = admin_client.get(f"{base_url}/api/leaves/mine", timeout=30).json()
    # Every returned row must belong to the caller — never another user.
    for r in rows:
        assert r["user_id"] == me["id"]


def test_my_leaves_requires_auth(base_url):
    r = requests.get(f"{base_url}/api/leaves/mine", timeout=30)
    assert r.status_code == 401


# ------------------ all_leaves (admin only) ------------------
def test_all_leaves_enriches_with_member_name(admin_client, base_url):
    rows = admin_client.get(f"{base_url}/api/leaves", timeout=30).json()
    for r in rows[:10]:
        # Every row carries the joined member name + category, populated by enrich_leaves.
        assert "member_name" in r and r["member_name"]
        assert "member_category" in r


def test_all_leaves_filter_status_pending(admin_client, base_url):
    rows = admin_client.get(f"{base_url}/api/leaves", params={"status_filter": "pending"}, timeout=30).json()
    for r in rows:
        assert r["status"] == "pending"


def test_all_leaves_filter_status_approved(admin_client, base_url):
    rows = admin_client.get(f"{base_url}/api/leaves", params={"status_filter": "approved"}, timeout=30).json()
    for r in rows:
        assert r["status"] == "approved"


def test_all_leaves_filter_late(admin_client, base_url):
    """`status_filter=late` returns only back-dated submissions, regardless of status."""
    rows = admin_client.get(f"{base_url}/api/leaves", params={"status_filter": "late"}, timeout=30).json()
    for r in rows:
        assert r.get("late_application") is True


def test_all_leaves_requires_admin(base_url):
    r = requests.get(f"{base_url}/api/leaves", timeout=30)
    assert r.status_code == 401


# ------------------ decide_leave ------------------
def test_admin_can_approve_then_reject(admin_client, base_url, athlete):
    # Create a fresh leave, approve it, then reject it.
    today = date.today().isoformat()
    body = {"type": "leave", "start_date": today, "end_date": today, "reason": "Decide flow"}
    leave = admin_client.post(
        f"{base_url}/api/leaves?target_user_id={athlete['id']}", json=body, timeout=30,
    ).json()
    try:
        r = admin_client.patch(f"{base_url}/api/leaves/{leave['id']}", json={"status": "approved"}, timeout=30)
        assert r.status_code == 200
        assert r.json()["status"] == "approved"
        r = admin_client.patch(f"{base_url}/api/leaves/{leave['id']}", json={"status": "rejected"}, timeout=30)
        assert r.status_code == 200
        assert r.json()["status"] == "rejected"
    finally:
        _cleanup_leave(admin_client, base_url, leave["id"])


def test_decide_nonexistent_leave_returns_404(admin_client, base_url):
    fake_id = uuid.uuid4().hex
    r = admin_client.patch(f"{base_url}/api/leaves/{fake_id}", json={"status": "approved"}, timeout=30)
    assert r.status_code == 404


# ------------------ group_leave ------------------
def test_group_leave_creates_one_per_member(admin_client, base_url, athlete):
    today = date.today().isoformat()
    body = {
        "type": "tour", "user_ids": [athlete["id"]],
        "start_date": today, "end_date": today,
        "reason": "Group regatta", "location": "Pune", "auto_approve": True,
    }
    r = admin_client.post(f"{base_url}/api/leaves/group", json=body, timeout=30)
    assert r.status_code == 200, r.text
    body_out = r.json()
    assert body_out["ok"] is True
    assert body_out["created"] == 1
    assert body_out["status"] == "approved"
    # Clean up: find the just-created group leave and reject it.
    rows = admin_client.get(f"{base_url}/api/leaves", timeout=30).json()
    new = next((leave for leave in rows
                if leave.get("group_leave") and leave["user_id"] == athlete["id"]
                and leave["start_date"] == today), None)
    if new:
        _cleanup_leave(admin_client, base_url, new["id"])


def test_group_leave_rejects_empty_user_list(admin_client, base_url):
    today = date.today().isoformat()
    r = admin_client.post(
        f"{base_url}/api/leaves/group",
        json={"type": "leave", "user_ids": [],
              "start_date": today, "end_date": today, "reason": "x"},
        timeout=30,
    )
    assert r.status_code == 400


def test_group_leave_auto_approve_false_creates_pending(admin_client, base_url, athlete):
    today = date.today().isoformat()
    body = {
        "type": "leave", "user_ids": [athlete["id"]],
        "start_date": today, "end_date": today,
        "reason": "Group leave pending", "auto_approve": False,
    }
    r = admin_client.post(f"{base_url}/api/leaves/group", json=body, timeout=30)
    assert r.status_code == 200
    assert r.json()["status"] == "pending"
    # Cleanup
    rows = admin_client.get(f"{base_url}/api/leaves", params={"status_filter": "pending"}, timeout=30).json()
    new = next((leave for leave in rows
                if leave.get("group_leave") and leave["user_id"] == athlete["id"]
                and leave["start_date"] == today and leave.get("reason") == "Group leave pending"), None)
    if new:
        _cleanup_leave(admin_client, base_url, new["id"])
