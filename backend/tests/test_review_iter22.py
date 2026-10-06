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


def _cleanup(base_url, headers, aid):
    if aid:
        requests.post(f"{base_url}/api/muster/checkout-bulk",
                      headers=headers, json={"athlete_ids": [aid]}, timeout=30)


# --- (A) Muster GPS INSIDE office → site_name propagates to /presence -------

def test_muster_inside_satellite_site_stamps_site_on_presence(base_url, make_member):
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

    aid = make_member("athlete")["id"]  # throwaway — never a real athlete
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

def test_geo_toggle_reason_persisted_when_out(base_url, mongo_db, make_member):
    """An out-of-geofence self check-in persists the submitted `reason`
    as geo_reason on the attendance row (throwaway member, not the admin)."""
    if mongo_db is None:
        import pytest
        pytest.skip("MONGO_URL/DB_NAME not set")
    m = make_member("athlete", login=True)
    reason_text = "Iter22 review probe — off-site check-in reason"
    r = m["client"].post(f"{base_url}/api/attendance/geo-toggle",
                         json={"latitude": 40.0, "longitude": -75.0, "reason": reason_text,
                               # off-site self check-in needs a proof selfie
                               "check_in_photo": "data:image/jpeg;base64,/9j/4AAQSkZJRg=="},
                         timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["action"] == "checkin"
    assert body["out_of_geofence"] is True
    row = mongo_db.attendance.find_one({"user_id": m["id"], "check_out_at": None})
    assert row is not None
    assert row.get("geo_reason") == reason_text, row.get("geo_reason")
    assert row.get("out_of_geofence") is True


# --- (C) geo-toggle omits geo_reason when INSIDE geofence -------------------

def test_geo_toggle_no_reason_stamped_when_inside(base_url, mongo_db, make_member):
    """The `reason` field must be dropped from the attendance row when the
    check-in lands inside a geofence — geo_reason is a per-anomaly field,
    not a general note."""
    if mongo_db is None:
        import pytest
        pytest.skip("MONGO_URL/DB_NAME not set")
    m = make_member("athlete", login=True)
    off = requests.get(f"{base_url}/api/office", headers=_admin_headers(base_url), timeout=30).json()
    lat, lng = float(off.get("latitude", 0.0)), float(off.get("longitude", 0.0))
    r = m["client"].post(f"{base_url}/api/attendance/geo-toggle",
                         json={"latitude": lat, "longitude": lng,
                               "reason": "should be ignored — I'm on-site"}, timeout=30)
    assert r.status_code == 200, r.text
    assert r.json()["out_of_geofence"] is False
    row = mongo_db.attendance.find_one({"user_id": m["id"], "check_out_at": None})
    assert row is not None
    # geo_reason is stamped only when out=True.
    assert row.get("geo_reason") is None, row.get("geo_reason")
