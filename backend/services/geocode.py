"""Reverse geocoding via OpenStreetMap Nominatim — turns a GPS fix into a
short human-readable AREA name (e.g. "Necklace Road, Hyderabad").

Only used for OFF-SITE check-ins/outs (a few per day), so we comfortably
stay inside Nominatim's usage policy:
  • a descriptive custom User-Agent (stock library UAs are banned),
  • an in-process cache keyed by coords rounded to ~11 m so the same spot
    is never looked up twice,
  • best-effort with a short timeout — a failure just yields None and the
    caller falls back to the plain "X m from <site> (OFF-SITE)" copy.
Data © OpenStreetMap contributors (ODbL).
"""
from __future__ import annotations

import asyncio
from typing import Optional

import httpx

_NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse"
# Descriptive UA per Nominatim policy — identifies the app + a contact host.
_USER_AGENT = "i-showed-up-attendance/1.0 (+https://i-showed-up.ychyderabad.com)"
_TIMEOUT_S = 4.0

# coord-rounded cache (4 dp ≈ 11 m). Bounded so it can't grow unbounded.
_cache: dict[tuple[float, float], Optional[str]] = {}
_CACHE_MAX = 5000


def _short_area(address: dict, display_name: str) -> Optional[str]:
    """Build a short "<locality>, <city>" label from Nominatim address parts,
    preferring the most human-recognisable neighbourhood/road, then city."""
    if not isinstance(address, dict):
        return (display_name.split(",")[0].strip() or None) if display_name else None
    specific = next(
        (address[k] for k in (
            "neighbourhood", "suburb", "quarter", "residential", "city_block",
            "road", "hamlet", "village", "town",
        ) if address.get(k)),
        None,
    )
    city = next(
        (address[k] for k in (
            "city", "town", "municipality", "county", "state_district", "state",
        ) if address.get(k)),
        None,
    )
    if specific and city and specific != city:
        return f"{specific}, {city}"
    if specific:
        return specific
    if city:
        return city
    return (display_name.split(",")[0].strip() or None) if display_name else None


async def reverse_geocode_area(lat: Optional[float], lng: Optional[float]) -> Optional[str]:
    """Return a short area name for (lat, lng), or None if unavailable.
    Never raises — geocoding is a nice-to-have, never a blocker."""
    if lat is None or lng is None:
        return None
    try:
        key = (round(float(lat), 4), round(float(lng), 4))
    except (TypeError, ValueError):
        return None
    if key in _cache:
        return _cache[key]
    result: Optional[str] = None
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S, headers={"User-Agent": _USER_AGENT}) as client:
            resp = await client.get(_NOMINATIM_URL, params={
                "format": "jsonv2",
                "lat": key[0],
                "lon": key[1],
                # zoom 16 ≈ suburb / major-street granularity — good for a
                # short recognisable area name without a full street address.
                "zoom": 16,
                "addressdetails": 1,
            })
        if resp.status_code == 200:
            data = resp.json()
            if isinstance(data, dict) and not data.get("error"):
                result = _short_area(data.get("address") or {}, data.get("display_name") or "")
    except (httpx.HTTPError, ValueError, asyncio.TimeoutError):
        result = None
    if len(_cache) < _CACHE_MAX:
        _cache[key] = result
    return result
