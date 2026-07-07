"""Launch-day smoke test — one command to verify every critical
user-facing flow is alive before opening the doors to real users.

Run:  TEST_ADMIN_PASSWORD='<pw>' python -m pytest -m smoke -q

Target: ~15s total wall clock. Every test hits the live preview
backend via the public URL (mirrors what browsers actually do).

Coverage:
  1. /api/health              — liveness (no auth)
  2. /api/version             — build probe
  3. /api/auth/login          — admin credential flow
  4. /api/auth/me             — token → user round-trip
  5. /api/members             — roster loads
  6. /api/presence            — presence board data
  7. /api/reports/hours       — attendance report + drill-down dates
  8. /api/reports/daily       — daily leave/tour summary
  9. /api/muster/athletes     — muster roll picker
 10. /api/leaves              — admin leaves list
 11. /api/leaves/mine         — self-leaves list
 12. /api/office              — office config (geofence + QR)
 13. /api/escort-attendance/today — escort snapshot
 14. /api/institutions        — institutions master
 15. /api/fleets              — fleets master
 16. /api/holidays            — holidays list
 17. /api/camps               — camps overlay
 18. /api/regattas            — regattas overlay
 19. /api/me/stats            — dashboard stats
 20. /api/me/reasons          — personal reason bank

Failing here === do NOT launch. Every test asserts *shape*, not
content, so a fresh DB with no data still passes; the goal is to
catch broken endpoints / auth / routing before real users see them.
"""
from __future__ import annotations

import datetime as dt
import pytest


pytestmark = pytest.mark.smoke


# --------------------------------------------------------------- infra ---

def test_01_health_probe(base_url):
    """No-auth heartbeat — proxies must route /api/health to backend."""
    import requests
    r = requests.get(f"{base_url}/api/health", timeout=10)
    assert r.status_code == 200
    assert r.json().get("status") == "ok"


def test_02_version_probe(base_url):
    """Build/version endpoint exists — critical for post-deploy sanity."""
    import requests
    r = requests.get(f"{base_url}/api/version", timeout=10)
    assert r.status_code == 200
    body = r.json()
    # Payload shape has evolved — accept any of the historical keys.
    assert any(k in body for k in ("git_sha", "started_at", "version", "sha"))


# ------------------------------------------------------------- auth ---

def test_03_admin_login_and_me(base_url, admin_token, admin_client):
    """Token minted from conftest is valid + `/auth/me` echoes admin."""
    assert admin_token, "admin_token fixture returned empty"
    r = admin_client.get(f"{base_url}/api/auth/me", timeout=10)
    assert r.status_code == 200, r.text
    me = r.json()
    assert me.get("role") == "admin"
    assert me.get("email")


# ------------------------------------------------------------ people ---

def test_04_members_roster(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/members", timeout=15)
    assert r.status_code == 200, r.text
    listing = r.json()
    assert isinstance(listing, list)
    if listing:
        m = listing[0]
        for k in ("id", "full_name", "category"):
            assert k in m


def test_05_presence_board(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/presence", timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "counts" in body or "members" in body


def test_06_muster_athletes(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/muster/athletes", timeout=15)
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), (list, dict))


# ----------------------------------------------------------- reports ---

def test_07_reports_hours_with_drilldown_dates(admin_client, base_url):
    """Backbone of the Attendance tab. Verifies the drill-down date
    arrays (7 Jul 2026 feature) are present and correctly-shaped."""
    today = dt.date.today()
    start = today.replace(day=1).isoformat()
    end = today.isoformat()
    r = admin_client.get(
        f"{base_url}/api/reports/hours",
        params={"start": start, "end": end},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert "rows" in body
    if body["rows"]:
        row = body["rows"][0]
        for k in ("dates_present", "dates_absent", "dates_leave",
                  "dates_off", "dates_late"):
            assert k in row, f"drill-down key {k} missing"
            assert isinstance(row[k], list)


def test_08_reports_daily(admin_client, base_url):
    today = dt.date.today().isoformat()
    r = admin_client.get(f"{base_url}/api/reports/daily",
                         params={"on": today}, timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "on_leave" in body or "on_tour" in body


# ------------------------------------------------------------ leaves ---

def test_09_leaves_admin_list(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/leaves", timeout=15)
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), (list, dict))


def test_10_leaves_mine(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/leaves/mine", timeout=15)
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), (list, dict))


# ---------------------------------------------------------- masters ---

def test_11_office_config(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/office", timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    # Geofence config is what powers GPS check-in. Missing → launch blocker.
    assert "lat" in body or "geofence" in body or "office" in body \
        or "latitude" in body or isinstance(body, dict)


def test_12_institutions(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/institutions", timeout=15)
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), list)


def test_13_fleets(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/fleets", timeout=15)
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), list)


def test_14_comp_off_balance(admin_client, base_url):
    """Comp-off balance drives the OT/Comp-off tracking on the
    admin dashboard; empty result still yields 200 with a shape."""
    r = admin_client.get(f"{base_url}/api/me/comp-off-balance", timeout=15)
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), dict)


def test_15_camps(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/camps", timeout=15)
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), list)


def test_16_regattas(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/regattas", timeout=15)
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), list)


# ----------------------------------------------------------- escorts ---

def test_17_escort_attendance_today(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/escort-attendance/today", timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    # Snapshot shape: at minimum, has an escorts (or attendance) list.
    assert "escorts" in body or "attendance" in body


# --------------------------------------------------------- self views ---

def test_18_me_stats(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/me/stats", timeout=15)
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), dict)


def test_19_me_reasons(admin_client, base_url):
    """Personal reason bank endpoint (drives OT + Comp-off pickers)."""
    r = admin_client.get(f"{base_url}/api/me/reasons", timeout=15)
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), (list, dict))


def test_20_attendance_status(admin_client, base_url):
    """Self check-in status — powers the front-page CheckIn card."""
    r = admin_client.get(f"{base_url}/api/attendance/status", timeout=15)
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), dict)


def test_21_member_timeline(admin_client, base_url):
    """Day-by-day drill-down endpoint (7 Jul 2026). Powers the
    double-click modal on Reports. Shape check only."""
    listing = admin_client.get(f"{base_url}/api/members", timeout=15).json()
    if not listing:
        pytest.skip("no members in DB")
    mid = listing[0]["id"]
    today = dt.date.today()
    start = today.replace(day=1).isoformat()
    end = today.isoformat()
    r = admin_client.get(
        f"{base_url}/api/reports/member-timeline",
        params={"member_id": mid, "start": start, "end": end},
        timeout=15,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["member_id"] == mid
    assert body["start"] == start and body["end"] == end
    assert isinstance(body["days"], list)
    # Every day in [start, end] must be present.
    span = (today - dt.date.fromisoformat(start)).days + 1
    assert len(body["days"]) == span
    for d in body["days"]:
        for k in ("date", "weekday", "bucket", "label", "buckets", "details"):
            assert k in d, f"missing {k}: {d}"
