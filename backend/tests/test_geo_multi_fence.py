from services.geo import resolve_site

OFFICE = {"latitude": 17.4000, "longitude": 78.5000, "radius_m": 30}
BIG = {"id": "big", "name": "Big", "latitude": 17.4020, "longitude": 78.5000, "radius_m": 400, "active": True}


def test_inside_large_fence_but_nearer_small_centre_is_on_site():
    # ~90 m north of office (outside its 30 m) but well inside BIG (400 m).
    sid, name, dist, out = resolve_site(OFFICE, 17.4008, 78.5000, [BIG])
    assert out is False
    assert sid == "big" and name == "Big"


def test_outside_every_fence_reports_nearest_centre():
    sid, name, dist, out = resolve_site(OFFICE, 17.4000, 78.5100, [BIG])
    assert out is True
    assert sid is None  # office centre is nearest
    assert dist > 30


def test_inside_two_fences_picks_closest_centre():
    near = {"id": "n", "name": "Near", "latitude": 17.4001, "longitude": 78.5000, "radius_m": 100, "active": True}
    sid, _, _, out = resolve_site(OFFICE, 17.40012, 78.5000, [BIG, near])
    assert out is False and sid == "n"


def test_inactive_site_ignored():
    sid, _, _, out = resolve_site(OFFICE, 17.4008, 78.5000, [{**BIG, "active": False}])
    assert out is True and sid is None
