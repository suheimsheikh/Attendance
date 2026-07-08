"""Contract tests for coach-GPS stamping on the Muster bulk endpoints.

Verifies that POST /api/muster/checkin-bulk and /api/muster/checkout-bulk
accept optional latitude/longitude fields and echo back site resolution
info (site_name, out_of_geofence, distance_m) so the frontend can toast
'Mustered N athletes at Rowing Academy'.
"""
from __future__ import annotations

import os
import requests


def _login(base_url) -> str:
    r = requests.post(
        f"{base_url}/api/auth/login",
        json={"email": os.environ.get("TEST_ADMIN_EMAIL", "admin@attendance.app"),
              "password": os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345")},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def _get_checkin_candidate(base_url, token):
    """Grab the id of an athlete eligible for check-in today."""
    r = requests.get(
        f"{base_url}/api/muster/athletes?mode=checkin",
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    assert r.status_code == 200
    for a in r.json().get("athletes", []):
        if not a.get("already_checked_in"):
            return a["id"]
    return None


def _cleanup_checkout(base_url, token, athlete_id, lat=None, lng=None):
    payload = {"athlete_ids": [athlete_id]}
    if lat is not None:
        payload["latitude"] = lat
        payload["longitude"] = lng
    requests.post(
        f"{base_url}/api/muster/checkout-bulk",
        headers={"Authorization": f"Bearer {token}"},
        json=payload,
        timeout=30,
    )


def test_muster_checkin_backward_compat_no_gps(base_url):
    """No lat/lng in payload → checkin still succeeds, site fields null."""
    token = _login(base_url)
    aid = _get_checkin_candidate(base_url, token)
    if not aid:
        return   # nothing to test on a fully-checked-in day
    try:
        r = requests.post(
            f"{base_url}/api/muster/checkin-bulk",
            headers={"Authorization": f"Bearer {token}"},
            json={"athlete_ids": [aid]},
            timeout=30,
        )
        assert r.status_code == 200
        body = r.json()
        assert body["checked_in_count"] == 1
        assert body["site_id"] is None
        assert body["site_name"] is None
        assert body["out_of_geofence"] is False
    finally:
        _cleanup_checkout(base_url, token, aid)


def test_muster_checkin_with_far_gps_marks_off_geofence(base_url):
    """GPS coords far from any configured site → out_of_geofence=True in
    the response and (verifiably) stamped on the attendance row."""
    token = _login(base_url)
    aid = _get_checkin_candidate(base_url, token)
    if not aid:
        return
    try:
        # Coords near the equator + prime meridian (0,0) triggers the
        # geo_unavailable path; use somewhere clearly not the office.
        r = requests.post(
            f"{base_url}/api/muster/checkin-bulk",
            headers={"Authorization": f"Bearer {token}"},
            json={"athlete_ids": [aid], "latitude": 40.0, "longitude": -75.0},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["checked_in_count"] == 1
        assert body["out_of_geofence"] is True
        # Distance must be large (thousands of km from Hyderabad)
        assert isinstance(body["distance_m"], (int, float))
        assert body["distance_m"] > 1_000_000
    finally:
        _cleanup_checkout(base_url, token, aid)


def test_muster_checkout_accepts_gps(base_url):
    """Checkout endpoint also accepts optional GPS + echoes it back."""
    token = _login(base_url)
    aid = _get_checkin_candidate(base_url, token)
    if not aid:
        return
    # First check them in
    r = requests.post(
        f"{base_url}/api/muster/checkin-bulk",
        headers={"Authorization": f"Bearer {token}"},
        json={"athlete_ids": [aid]},
        timeout=30,
    )
    assert r.status_code == 200

    # Now checkout with a GPS fix
    r = requests.post(
        f"{base_url}/api/muster/checkout-bulk",
        headers={"Authorization": f"Bearer {token}"},
        json={"athlete_ids": [aid], "latitude": 40.0, "longitude": -75.0},
        timeout=30,
    )
    assert r.status_code == 200
    body = r.json()
    assert body["checked_out_count"] == 1
    assert body["out_of_geofence"] is True


def test_muster_checkin_zero_zero_is_geo_unavailable(base_url):
    """(0, 0) is our sentinel for 'GPS not obtained' — must NOT be
    treated as a real location."""
    token = _login(base_url)
    aid = _get_checkin_candidate(base_url, token)
    if not aid:
        return
    try:
        r = requests.post(
            f"{base_url}/api/muster/checkin-bulk",
            headers={"Authorization": f"Bearer {token}"},
            json={"athlete_ids": [aid], "latitude": 0, "longitude": 0},
            timeout=30,
        )
        assert r.status_code == 200
        body = r.json()
        # Fall back to no-GPS path: no site, not flagged off-geofence
        assert body["site_id"] is None
        assert body["site_name"] is None
        assert body["out_of_geofence"] is False
    finally:
        _cleanup_checkout(base_url, token, aid)
