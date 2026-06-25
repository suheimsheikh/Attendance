"""Unit tests for `services/geo.py` — pure math."""
from services.geo import haversine_m


def test_haversine_zero_distance():
    assert haversine_m(0, 0, 0, 0) == 0


def test_haversine_one_degree_at_equator_is_about_111km():
    # One degree of longitude at the equator ≈ 111 km
    d = haversine_m(0, 0, 0, 1)
    assert 110_000 < d < 112_000


def test_haversine_symmetric():
    # d(A,B) == d(B,A)
    a = haversine_m(19.0760, 72.8777, 17.3850, 78.4867)
    b = haversine_m(17.3850, 78.4867, 19.0760, 72.8777)
    assert abs(a - b) < 0.01


def test_haversine_mumbai_to_hyderabad_is_about_625km():
    # Mumbai → Hyderabad direct line ≈ 625 km (well-known)
    d = haversine_m(19.0760, 72.8777, 17.3850, 78.4867)
    assert 620_000 < d < 635_000


def test_haversine_short_distance_returns_metres():
    # ~100 m apart on the same campus
    d = haversine_m(19.0760, 72.8777, 19.0769, 72.8777)
    assert 90 < d < 110
