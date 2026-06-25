"""Unit tests for `services/time_utils.py` — pure helpers, no DB."""
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from services.time_utils import (
    DEFAULT_TZ, now_utc, iso, office_tz, local_now, local_date_str, local_hm,
)


def test_now_utc_is_timezone_aware():
    n = now_utc()
    assert n.tzinfo is not None
    assert n.tzinfo == timezone.utc


def test_iso_handles_none():
    assert iso(None) is None


def test_iso_serializes_aware_datetime():
    dt = datetime(2026, 7, 1, 12, 30, tzinfo=timezone.utc)
    s = iso(dt)
    assert s.startswith("2026-07-01T12:30:00")
    # round-trips
    assert datetime.fromisoformat(s) == dt


def test_office_tz_defaults_to_kolkata():
    assert office_tz(None) == ZoneInfo(DEFAULT_TZ)
    assert office_tz({}) == ZoneInfo(DEFAULT_TZ)


def test_office_tz_uses_configured_zone():
    assert office_tz({"timezone": "America/New_York"}) == ZoneInfo("America/New_York")


def test_office_tz_falls_back_on_bad_zone():
    # Malformed config doesn't crash the server — falls back to the default.
    assert office_tz({"timezone": "Mars/Olympus_Mons"}) == ZoneInfo(DEFAULT_TZ)


def test_local_date_str_respects_office_timezone():
    # 1 Jan 2026 at 19:30 UTC = 2 Jan 2026 at 01:00 IST. The office calendar
    # should report Jan 2, not Jan 1.
    dt = datetime(2026, 1, 1, 19, 30, tzinfo=timezone.utc)
    assert local_date_str({"timezone": "Asia/Kolkata"}, dt) == "2026-01-02"
    # Same instant on the US East coast is still Jan 1.
    assert local_date_str({"timezone": "America/New_York"}, dt) == "2026-01-01"


def test_local_now_returns_office_local_time():
    n = local_now({"timezone": "Asia/Kolkata"})
    assert str(n.tzinfo) == "Asia/Kolkata"


def test_local_hm_formats_office_local_time():
    # 1 Jan 2026 at 03:30 UTC = 09:00 IST
    dt = datetime(2026, 1, 1, 3, 30, tzinfo=timezone.utc).isoformat()
    assert local_hm({"timezone": "Asia/Kolkata"}, dt) == "09:00"


def test_local_hm_handles_empty_input():
    assert local_hm({}, None) == ""
    assert local_hm({}, "") == ""
