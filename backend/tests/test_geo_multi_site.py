"""
Unit tests for `services.geo.resolve_site` (multi-site geofence
resolution introduced 28 Jun 2026).

Pure-function tests — no DB, no async. The DB-backed integration
flow is exercised separately via the live /api/sites endpoints.
"""
from services.geo import resolve_site


OFFICE = {"latitude": 17.4000, "longitude": 78.5000, "radius_m": 150}

# Rowing Academy ~ 500m east of the office (well outside its 150m radius
# but well inside its own 200m radius).
ROWING = {
    "id": "site-rowing",
    "name": "Rowing Academy",
    "latitude": 17.4000,
    "longitude": 78.5047,   # ~500m east at this latitude
    "radius_m": 200,
    "active": True,
}


def test_inside_office_radius_returns_office_winner():
    """Point dead-on the office centre → main office wins, site_id None."""
    sid, sname, dist, out = resolve_site(OFFICE, 17.4000, 78.5000, [ROWING])
    assert sid is None
    assert sname is None
    assert dist < 1
    assert out is False


def test_inside_satellite_picks_satellite():
    """Point dead-on Rowing Academy → site_id set, on-site (not off-site)."""
    sid, sname, dist, out = resolve_site(OFFICE, ROWING["latitude"], ROWING["longitude"], [ROWING])
    assert sid == "site-rowing"
    assert sname == "Rowing Academy"
    assert dist < 1
    assert out is False


def test_between_office_and_satellite_picks_closest():
    """Point much closer to office than Rowing → office wins even though
    Rowing has a wider radius. Closest geofence is what we pick."""
    sid, sname, dist, out = resolve_site(OFFICE, 17.4000, 78.5001, [ROWING])
    assert sid is None      # office wins
    assert out is False


def test_far_from_everything_returns_off_site_with_nearest():
    """Way off in the middle of the city → out_of_geofence, but distance
    reported is to the CLOSEST geofence (so admin reports can still hint at
    where the member was relative to a known site)."""
    sid, sname, dist, out = resolve_site(OFFICE, 17.5000, 78.6000, [ROWING])
    # Closest of {office, rowing} should still be picked.
    assert out is True
    # >> 200m — both geofences out.
    assert dist > 1000


def test_inactive_satellite_ignored():
    inactive = {**ROWING, "active": False}
    sid, sname, dist, out = resolve_site(OFFICE, ROWING["latitude"], ROWING["longitude"], [inactive])
    # Inactive site is skipped → only office considered → off-site.
    assert sid is None
    assert out is True
    # Distance is now to the office, ~500m
    assert 400 < dist < 600


def test_no_office_geofence_and_no_sites():
    """Empty/zero office config + no sites → don't flag everyone as off-site."""
    no_geo = {"latitude": None, "longitude": None, "radius_m": 0}
    sid, sname, dist, out = resolve_site(no_geo, 17.0, 78.0, [])
    assert out is False
    assert sid is None
    assert dist == 0.0


def test_multiple_satellites_picks_closest():
    """With several configured satellites, the closest one wins."""
    near = {
        "id": "site-near",
        "name": "Near Site",
        "latitude": 17.4000, "longitude": 78.5046,  # very close to ROWING but slightly closer
        "radius_m": 100,
        "active": True,
    }
    sid, sname, dist, out = resolve_site(OFFICE, 17.4000, 78.5046, [ROWING, near])
    assert sid == "site-near"
    assert sname == "Near Site"
    assert out is False


def test_bad_lat_lng_satellite_skipped():
    """A satellite with non-numeric coords must be skipped, not crash."""
    broken = {"id": "x", "name": "Bad", "latitude": None, "longitude": "abc",
              "radius_m": 100, "active": True}
    sid, sname, dist, out = resolve_site(OFFICE, 17.4000, 78.5000, [broken, ROWING])
    # Office should win since point is on the office.
    assert sid is None
    assert out is False
