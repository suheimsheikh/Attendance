"""Time + timezone helpers. All `office` arguments are the Mongo `config` doc
with id='office' (or a partial dict containing at least `timezone`)."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
from zoneinfo import ZoneInfo

DEFAULT_TZ = "Asia/Kolkata"


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


def to_utc_iso(dt: datetime) -> str:
    """Serialize an aware datetime to a UTC ISO-8601 string."""
    return dt.astimezone(timezone.utc).isoformat()


def office_tz(office: Optional[dict]) -> ZoneInfo:
    name = (office or {}).get("timezone") or DEFAULT_TZ
    try:
        return ZoneInfo(name)
    except Exception:
        return ZoneInfo(DEFAULT_TZ)


def local_now(office: Optional[dict]) -> datetime:
    """Current time in the office's local timezone."""
    return now_utc().astimezone(office_tz(office))


def local_date_str(office: Optional[dict], dt: Optional[datetime] = None) -> str:
    """The calendar date (YYYY-MM-DD) in the office timezone for the given instant."""
    dt = dt or now_utc()
    return dt.astimezone(office_tz(office)).date().isoformat()


def local_hm(office: Optional[dict], iso_str: Optional[str]) -> str:
    """Format a stored UTC ISO timestamp as HH:MM in office local time."""
    if not iso_str:
        return ""
    return datetime.fromisoformat(iso_str).astimezone(office_tz(office)).strftime("%H:%M")


async def office_today_str(db) -> str:
    """Today's date (YYYY-MM-DD) in the configured office timezone."""
    office = await db.config.find_one({"id": "office"}, {"_id": 0, "timezone": 1})
    return local_date_str(office)


async def office_and_today(db) -> tuple[dict, str]:
    """Load the full office config and today's office-local date in one go.
    Consolidates the `office = find_one({'id':'office'}); today = local_date_str(office)`
    pattern repeated across many routes. Returns ({}, today) when unconfigured."""
    office = await db.config.find_one({"id": "office"}, {"_id": 0}) or {}
    return office, local_date_str(office)
