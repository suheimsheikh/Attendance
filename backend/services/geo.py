"""Pure geo math — no DB, no I/O."""
from __future__ import annotations

import math
from typing import Iterable, Optional, Tuple


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance between two (lat, lon) pairs in metres."""
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * R * math.asin(min(1.0, math.sqrt(a)))


def resolve_site(office: dict, lat: float, lng: float,
                 sites: Iterable[dict]) -> Tuple[Optional[str], Optional[str], float, bool]:
    """Pick the geofence (main office OR a configured satellite site) the
    member is closest to and decide whether they're inside its radius.

    Returns: (site_id, site_name, distance_m, out_of_geofence)
      • site_id / site_name = None  →  the main office is the closest match
        (kept None so the attendance row stays backward-compatible with the
        pre-multi-site shape — only satellite sites get stamped).
      • distance_m = distance to the chosen geofence in metres (rounded 0.1).
      • out_of_geofence = True only if the member is outside the radius of
        EVERY active geofence (office + all satellites). Off-site is still
        purely informational — we never block a check-in.
    """
    office_lat = office.get("latitude")
    office_lng = office.get("longitude")
    office_radius = int(office.get("radius_m") or 0)

    candidates = []
    if office_lat is not None and office_lng is not None:
        candidates.append({
            "site_id": None,
            "site_name": None,
            "lat": float(office_lat),
            "lng": float(office_lng),
            "radius_m": office_radius,
        })
    for s in sites or []:
        if not s.get("active"):
            continue
        try:
            slat = float(s["latitude"])
            slng = float(s["longitude"])
        except (KeyError, TypeError, ValueError):
            continue
        candidates.append({
            "site_id": s.get("id"),
            "site_name": s.get("name"),
            "lat": slat,
            "lng": slng,
            "radius_m": int(s.get("radius_m") or 0),
        })

    if not candidates:
        # No geofence configured at all — treat as on-site to avoid every
        # check-in being flagged off-site during initial setup.
        return None, None, 0.0, False

    best = min(
        candidates,
        key=lambda c: haversine_m(lat, lng, c["lat"], c["lng"]),
    )
    dist = round(haversine_m(lat, lng, best["lat"], best["lng"]), 1)
    out = dist > best["radius_m"]
    return best["site_id"], best["site_name"], dist, out
