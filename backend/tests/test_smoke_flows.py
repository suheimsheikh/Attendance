"""
Critical-flow smoke test — exercises every must-work user journey end-to-end
against the live preview backend.

If this suite is green, the admin and coaches can confidently use the app:
  1. Admin email login → token + /auth/me
  2. Presence Board → live roster with counts
  3. Muster Roll → list athletes + bulk check-in + bulk check-out
  4. Leave filing → submit, approve, listing reflects it
  5. Reports → daily report + hours-CSV download

Run:  cd /app/backend && python -m pytest tests/test_smoke_flows.py -v
"""
import csv
import io
import os
import re
import uuid
from datetime import date, timedelta

import pytest
import requests


# ---------- session-scoped helpers ----------
@pytest.fixture(scope="module")
def athlete(admin_client, base_url):
    """Pick an existing athlete (or create one) to drive muster + leave tests.
    Re-used across all flows in this module so we don't litter the DB."""
    listing = admin_client.get(f"{base_url}/api/members", timeout=30).json()
    target = next((m for m in listing if m.get("category") == "athlete"), None)
    if target:
        return target

    # No athletes — create one
    body = {
        "email": f"smoke-{uuid.uuid4().hex[:6]}@athletes.local",
        "password": "Smoke@1234",
        "full_name": "Smoke Test Athlete",
        "role": "member",
        "category": "athlete",
    }
    r = admin_client.post(f"{base_url}/api/members", json=body, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


# ---------- 1. Admin login ----------
def test_admin_login_returns_token_and_role(base_url):
    r = requests.post(
        f"{base_url}/api/auth/login",
        json={"email": "admin@attendance.app", "password": "Admin@12345"},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["access_token"]
    # /auth/me with the token must return role=admin
    me = requests.get(
        f"{base_url}/api/auth/me",
        headers={"Authorization": f"Bearer {body['access_token']}"},
        timeout=30,
    )
    assert me.status_code == 200
    assert me.json()["role"] == "admin"


# ---------- 2. Presence Board ----------
def test_presence_board_returns_roster_with_counts(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/presence", timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "members" in body and isinstance(body["members"], list)
    assert "counts" in body
    # Every roster row must have a status from the canonical set.
    valid = {"on_campus", "exited", "temp_out", "on_tour", "on_leave", "absent", "not_due"}
    for m in body["members"]:
        assert m["status"] in valid, m
    # Counts should sum to total.
    counts = body["counts"]
    total = sum(counts[k] for k in valid if k in counts)
    assert total == counts["total"], counts


def test_presence_does_not_leak_qr_token(admin_client, base_url):
    # The office endpoint used to leak qr_token — code review p0 fix.
    office = admin_client.get(f"{base_url}/api/office", timeout=30).json()
    assert "qr_token" not in office, "qr_token should NOT be exposed to clients"


# ---------- 3. Muster Roll ----------
def test_muster_athletes_listing(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/muster/athletes", timeout=30)
    assert r.status_code == 200, r.text
    # Either list (no leaves today) or dict with athletes key — both shapes used by frontend.
    body = r.json()
    if isinstance(body, dict):
        assert "athletes" in body or "members" in body
    else:
        assert isinstance(body, list)


def test_muster_bulk_checkin_then_checkout(admin_client, base_url, athlete):
    # Bulk check-in: this also tests the multi-member toggle code path.
    # NOTE: muster expects {athlete_ids, latitude, longitude, by}
    payload = {
        "athlete_ids": [athlete["id"]],
        "latitude": 17.4400,  # Hyderabad-ish
        "longitude": 78.3489,
        "by": "Smoke Test",
    }
    r = admin_client.post(f"{base_url}/api/muster/checkin-bulk", json=payload, timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    # Either {checked_in: [...]} or {results: [...]} — accept both shapes.
    assert any(k in body for k in ("checked_in", "results", "ok"))

    # Bulk check-out (idempotent — even if already on a different session).
    r = admin_client.post(f"{base_url}/api/muster/checkout-bulk", json=payload, timeout=30)
    assert r.status_code == 200, r.text


# ---------- 4. Leave filing ----------
def test_admin_can_file_and_approve_leave_on_behalf(admin_client, base_url, athlete):
    today = date.today().isoformat()
    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    body = {
        "type": "leave",
        "start_date": today,
        "end_date": tomorrow,
        "reason": "Smoke test leave",
    }
    # File on behalf of athlete
    r = admin_client.post(
        f"{base_url}/api/leaves?target_user_id={athlete['id']}",
        json=body, timeout=30,
    )
    assert r.status_code == 200, r.text
    leave_id = r.json()["id"]
    try:
        # Admin sees it under /api/leaves with member_name attached (enrich_leaves).
        listing = admin_client.get(f"{base_url}/api/leaves", timeout=30).json()
        found = next((leave for leave in listing if leave["id"] == leave_id), None)
        assert found is not None, "Filed leave missing from /api/leaves listing"
        assert found["member_name"]  # populated by enrich_leaves
        assert found["status"] == "pending"

        # Approve it.
        r = admin_client.patch(
            f"{base_url}/api/leaves/{leave_id}",
            json={"status": "approved"}, timeout=30,
        )
        assert r.status_code == 200
        assert r.json()["status"] == "approved"
    finally:
        # Clean up so we don't pollute the user's leave balance.
        # No delete-leave endpoint, so we mark it rejected to be visually quiet.
        admin_client.patch(
            f"{base_url}/api/leaves/{leave_id}",
            json={"status": "rejected"}, timeout=30,
        )


# ---------- 5. Reports ----------
def test_daily_report_returns_shape(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/reports/daily", timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "date" in body
    assert "on_leave" in body
    assert "on_tour" in body


def test_hours_csv_export_returns_csv_with_headers(admin_client, base_url):
    today = date.today()
    first = today.replace(day=1).isoformat()
    end = today.isoformat()
    r = admin_client.get(
        f"{base_url}/api/reports/hours/export?start={first}&end={end}&fmt=csv",
        timeout=30,
    )
    assert r.status_code == 200, r.text
    assert "text/csv" in r.headers.get("content-type", "")
    # First row must contain the well-known column names.
    text = r.text
    reader = csv.reader(io.StringIO(text))
    headers = next(reader)
    assert "Name" in headers
    assert "Category" in headers
    assert "Total hrs" in headers


def test_changelog_is_public(base_url):
    # Frontend's /whats-new page reads this without an auth header.
    r = requests.get(f"{base_url}/api/changelog", timeout=30)
    assert r.status_code == 200
    body = r.json()
    assert "markdown" in body or "html" in body or "content" in body
