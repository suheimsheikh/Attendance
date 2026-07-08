"""Iter 22 — Geo-aware check-in extensions

Verifies the two backend contract additions of iter22 that go beyond
the raw test_muster_gps.py coverage:

  A) POST /api/muster/checkin-bulk with a GPS fix INSIDE the office
     geofence stamps site_id/site_name on the created attendance row,
     and that stamp is visible on GET /api/presence for the mustered
     athlete (drives the frontend "Mustering at <site_name>" toast).

  B) POST /api/attendance/geo-toggle now honours an optional `reason`
     field on out-of-geofence check-ins, persisting it as geo_reason
     on the attendance row (drives the OutOfGeofenceModal → reason
     capture flow on /my-check-in).
"""
from __future__ import annotations

import os
import time
import requests


BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")


def _admin_headers(base_url) -> dict:
    r = requests.post(
        f"{base_url}/api/auth/login",
        json={"email": "admin@attendance.app",
              "password": os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345")},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def _pick_athlete_for_checkin(base_url, headers):
    r = requests.get(f"{base_url}/api/muster/athletes?mode=checkin",
                     headers=headers, timeout=30)
    assert r.status_code == 200
    for a in r.json().get("athletes", []):
        if not a.get("already_checked_in"):
            return a
    return None


def _cleanup(base_url, headers, aid):
    if aid:
        requests.post(f"{base_url}/api/muster/checkout-bulk",
                      headers=headers, json={"athlete_ids": [aid]}, timeout=30)


# --- (A) Muster GPS INSIDE office → site_name propagates to /presence -------

def test_muster_inside_satellite_site_stamps_site_on_presence(base_url):
    """Coach GPS inside a satellite training-location geofence -> the
    attendance row is stamped with the site_name, which then appears on
    the on_campus member's /api/presence entry. (The main office is
    deliberately left with site_name=None by services.geo.resolve_site
    for backward compatibility; only *satellite* sites get their name
    propagated. So this test creates a satellite site first.)"""
    headers = _admin_headers(base_url)

    site_body = {
        "name": "TEST_Iter22 Regatta Venue",
        "latitude": 41.0,
        "longitude": -76.0,
        "radius_m": 150,
        "active": True,
    }
    r = requests.post(f"{base_url}/api/sites", headers=headers,
                      json=site_body, timeout=30)
    assert r.status_code == 200, r.text
    site = r.json()
    site_id = site["id"]

    a = _pick_athlete_for_checkin(base_url, headers)
    if not a:
        # cleanup and bail
        requests.delete(f"{base_url}/api/sites/{site_id}", headers=headers, timeout=30)
        return
    aid = a["id"]
    try:
        r = requests.post(
            f"{base_url}/api/muster/checkin-bulk", headers=headers,
            json={"athlete_ids": [aid], "latitude": 41.0, "longitude": -76.0},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["checked_in_count"] == 1
        assert body["out_of_geofence"] is False, body
        assert body["site_name"] == site_body["name"], body
        assert body["site_id"] == site_id, body

        # Verify it lands on /presence for that member.
        time.sleep(0.3)
        pres = requests.get(f"{base_url}/api/presence", headers=headers, timeout=30).json()
        mine = next((m for m in pres.get("members", []) if m["id"] == aid), None)
        assert mine is not None, "athlete missing from /presence"
        assert mine.get("status") == "on_campus", mine
        assert mine.get("site_name") == site_body["name"], mine
        assert mine.get("site_id") == site_id, mine
    finally:
        _cleanup(base_url, headers, aid)
        # Delete the satellite site so we leave the DB clean.
        requests.delete(f"{base_url}/api/sites/{site_id}", headers=headers, timeout=30)


# --- (B) geo-toggle `reason` persists as geo_reason when out-of-geofence -----

def test_geo_toggle_reason_persisted_when_out(base_url, mongo_db):
    """When admin submits an out-of-geofence check-in via /attendance/geo-toggle
    with a `reason` field, that reason is persisted as `geo_reason` on the
    attendance row (verified directly via MongoDB since the API doesn't
    surface it back on the response)."""
    if mongo_db is None:
        import pytest
        pytest.skip("MONGO_URL/DB_NAME not set — cannot inspect attendance rows")

    headers = _admin_headers(base_url)
    admin_me = requests.get(f"{base_url}/api/auth/me", headers=headers, timeout=30).json()
    admin_id = admin_me["id"]

    # If admin already has an open session, close it first so we exercise the
    # check-IN branch (that's where geo_reason is unconditionally stamped).
    open_row = mongo_db.attendance.find_one({"user_id": admin_id, "check_out_at": None})
    if open_row:
        requests.post(
            f"{base_url}/api/attendance/geo-toggle", headers=headers,
            json={"latitude": 40.0, "longitude": -75.0}, timeout=30,
        )

    reason_text = "Iter22 review probe — off-site check-in reason"
    try:
        r = requests.post(
            f"{base_url}/api/attendance/geo-toggle", headers=headers,
            json={"latitude": 40.0, "longitude": -75.0, "reason": reason_text},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["action"] == "checkin"
        assert body["out_of_geofence"] is True

        # Inspect the freshly-inserted attendance row.
        row = mongo_db.attendance.find_one(
            {"user_id": admin_id, "check_out_at": None},
            sort=[("check_in_at", -1)],
        )
        assert row is not None
        assert row.get("geo_reason") == reason_text, row.get("geo_reason")
        assert row.get("out_of_geofence") is True
    finally:
        # Close the session we just opened so the state is clean.
        requests.post(
            f"{base_url}/api/attendance/geo-toggle", headers=headers,
            json={"latitude": 40.0, "longitude": -75.0}, timeout=30,
        )


# --- (C) geo-toggle omits geo_reason when INSIDE geofence -------------------

def test_geo_toggle_no_reason_stamped_when_inside(base_url, mongo_db):
    """The `reason` field must be dropped from the attendance row when the
    check-in lands inside a geofence — geo_reason is a per-anomaly field,
    not a general note."""
    if mongo_db is None:
        import pytest
        pytest.skip("MONGO_URL/DB_NAME not set")

    headers = _admin_headers(base_url)
    admin_me = requests.get(f"{base_url}/api/auth/me", headers=headers, timeout=30).json()
    admin_id = admin_me["id"]
    off = requests.get(f"{base_url}/api/office", headers=headers, timeout=30).json()
    olat = float(off.get("latitude", 0.0))
    olng = float(off.get("longitude", 0.0))
    inside_lat = olat + 0.00005 if olat == 0.0 else olat
    inside_lng = olng + 0.00005 if olng == 0.0 else olng

    # Close any open admin session first.
    if mongo_db.attendance.find_one({"user_id": admin_id, "check_out_at": None}):
        requests.post(
            f"{base_url}/api/attendance/geo-toggle", headers=headers,
            json={"latitude": inside_lat, "longitude": inside_lng}, timeout=30,
        )

    try:
        r = requests.post(
            f"{base_url}/api/attendance/geo-toggle", headers=headers,
            json={"latitude": inside_lat, "longitude": inside_lng,
                  "reason": "should be ignored — I'm on-site"},
            timeout=30,
        )
        assert r.status_code == 200
        body = r.json()
        assert body["out_of_geofence"] is False

        row = mongo_db.attendance.find_one(
            {"user_id": admin_id, "check_out_at": None},
            sort=[("check_in_at", -1)],
        )
        assert row is not None
        # geo_reason is stamped only when out=True.
        assert row.get("geo_reason") is None, row.get("geo_reason")
    finally:
        # Close the session.
        requests.post(
            f"{base_url}/api/attendance/geo-toggle", headers=headers,
            json={"latitude": inside_lat, "longitude": inside_lng}, timeout=30,
        )
