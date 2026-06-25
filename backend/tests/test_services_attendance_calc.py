"""Unit tests for `services/attendance_calc.py`."""
from datetime import datetime, timezone

from services.attendance_calc import (
    OVERTIME_THRESHOLD_MIN,
    compute_late, compute_overtime_in, compute_overtime_out,
    hm_to_minutes, excursion_seconds, open_excursion, parse_expected_return,
)

OFFICE = {"timezone": "Asia/Kolkata", "default_work_start": "09:00", "late_grace_minutes": 0}


# A small helper — IST = UTC+5:30, so 03:35 UTC = 09:05 IST
def _ist(h_utc: int, m_utc: int = 0) -> datetime:
    return datetime(2026, 7, 1, h_utc, m_utc, tzinfo=timezone.utc)


# ---------- compute_late ----------
def test_compute_late_on_time_member_not_late():
    # 09:00 IST exactly, no grace → not late
    member = {"work_start": "09:00"}
    is_late, mins = compute_late(OFFICE, member, _ist(3, 30))
    assert is_late is False
    assert mins == 0


def test_compute_late_one_minute_past_is_late():
    member = {"work_start": "09:00"}
    is_late, mins = compute_late(OFFICE, member, _ist(3, 31))  # 09:01 IST
    assert is_late is True
    assert mins == 1


def test_compute_late_respects_grace_minutes():
    office = {**OFFICE, "late_grace_minutes": 15}
    member = {"work_start": "09:00"}
    is_late, _ = compute_late(office, member, _ist(3, 44))  # 09:14 IST
    assert is_late is False
    is_late, mins = compute_late(office, member, _ist(3, 46))  # 09:16 IST
    assert is_late is True
    assert mins == 1


def test_compute_late_falls_back_to_default_work_start():
    # Member has no work_start → use office.default_work_start
    member = {}
    is_late, _ = compute_late(OFFICE, member, _ist(3, 29))  # 08:59 IST
    assert is_late is False
    is_late, mins = compute_late(OFFICE, member, _ist(3, 31))  # 09:01 IST
    assert is_late is True
    assert mins == 1


def test_compute_late_camp_overrides_member_schedule():
    # Member's normal start is 09:00, but today's camp starts at 06:00.
    member = {"work_start": "09:00"}
    camp = {"start_time": "06:00"}
    # 00:35 UTC = 06:05 IST — late under camp schedule, not under member.
    is_late, mins = compute_late(OFFICE, member, _ist(0, 35), camp=camp)
    assert is_late is True
    assert mins == 5


def test_compute_late_camp_grace_overrides_office_grace():
    member = {"work_start": "09:00"}
    camp = {"start_time": "06:00", "late_grace_minutes": 30}
    # 06:25 IST is within the 30-min camp grace → not late.
    is_late, _ = compute_late(OFFICE, member, _ist(0, 55), camp=camp)
    assert is_late is False


def test_compute_late_bad_work_start_string_returns_not_late():
    # Malformed work_start must not crash the request handler.
    member = {"work_start": "garbage"}
    assert compute_late(OFFICE, member, _ist(10, 0)) == (False, 0)


# ---------- hm_to_minutes ----------
def test_hm_to_minutes_valid():
    assert hm_to_minutes("09:30") == 570
    assert hm_to_minutes("00:00") == 0
    assert hm_to_minutes("23:59") == 23 * 60 + 59


def test_hm_to_minutes_invalid():
    assert hm_to_minutes("9:30am") is None
    assert hm_to_minutes("9-30") is None
    assert hm_to_minutes("") is None
    assert hm_to_minutes(None) is None


# ---------- compute_overtime_in / _out ----------
def test_compute_overtime_non_staff_returns_zero():
    member = {"category": "athlete", "work_start": "09:00", "work_end": "18:00"}
    # 06:00 IST — 3h early. Athletes never accrue OT.
    assert compute_overtime_in(OFFICE, member, _ist(0, 30)) == (0, "")
    assert compute_overtime_out(OFFICE, member, _ist(13, 30)) == (0, "")  # 19:00 IST


def test_compute_overtime_in_staff_under_threshold():
    member = {"category": "staff", "work_start": "09:00"}
    # 08:45 IST is only 15 min early → below 30-min threshold
    early, ws = compute_overtime_in(OFFICE, member, _ist(3, 15))
    assert early == 0
    assert ws == "09:00"


def test_compute_overtime_in_staff_above_threshold():
    member = {"category": "staff", "work_start": "09:00"}
    # 08:00 IST = 60 min early
    early, ws = compute_overtime_in(OFFICE, member, _ist(2, 30))
    assert early == 60
    assert ws == "09:00"


def test_compute_overtime_out_staff_above_threshold():
    member = {"category": "staff", "work_end": "18:00"}
    # 19:00 IST = 60 min late
    late_min, we = compute_overtime_out(OFFICE, member, _ist(13, 30))
    assert late_min == 60
    assert we == "18:00"


def test_compute_overtime_in_no_work_start_returns_zero():
    member = {"category": "staff"}  # missing work_start
    assert compute_overtime_in(OFFICE, member, _ist(2, 30)) == (0, "")


def test_compute_overtime_threshold_constant_is_30():
    # If this constant changes, the policy doc must too. Lock it in a test.
    assert OVERTIME_THRESHOLD_MIN == 30


# ---------- excursion_seconds ----------
def test_excursion_seconds_no_excursions():
    assert excursion_seconds([]) == 0.0
    assert excursion_seconds(None) == 0.0


def test_excursion_seconds_closed_excursions():
    exc = [
        {"out_at": "2026-07-01T05:00:00+00:00", "in_at": "2026-07-01T05:30:00+00:00"},  # 30 min
        {"out_at": "2026-07-01T07:00:00+00:00", "in_at": "2026-07-01T08:00:00+00:00"},  # 60 min
    ]
    assert excursion_seconds(exc) == 90 * 60


def test_excursion_seconds_open_excursion_with_up_to():
    exc = [{"out_at": "2026-07-01T05:00:00+00:00"}]  # still away
    up_to = datetime(2026, 7, 1, 5, 45, tzinfo=timezone.utc)
    assert excursion_seconds(exc, up_to=up_to) == 45 * 60


def test_excursion_seconds_open_excursion_without_up_to_ignored():
    # Open excursion + no `up_to` → counts nothing (it'll be closed later).
    exc = [{"out_at": "2026-07-01T05:00:00+00:00"}]
    assert excursion_seconds(exc) == 0.0


def test_excursion_seconds_ignores_garbage_isoformat():
    exc = [{"out_at": "yesterday", "in_at": "tomorrow"}]
    assert excursion_seconds(exc) == 0.0


# ---------- open_excursion ----------
def test_open_excursion_returns_last_open():
    sess = {
        "excursions": [
            {"id": "a", "out_at": "...", "in_at": "..."},  # closed
            {"id": "b", "out_at": "..."},                   # open ← returned
        ]
    }
    assert open_excursion(sess)["id"] == "b"


def test_open_excursion_returns_none_when_all_closed():
    sess = {"excursions": [{"id": "a", "out_at": "...", "in_at": "..."}]}
    assert open_excursion(sess) is None


def test_open_excursion_returns_none_for_empty():
    assert open_excursion({}) is None
    assert open_excursion({"excursions": []}) is None


# ---------- parse_expected_return ----------
def test_parse_expected_return_hm_today():
    # 12:00 IST today → ISO-UTC string (06:30 UTC)
    now = datetime(2026, 7, 1, 5, 0, tzinfo=timezone.utc)  # 10:30 IST
    s = parse_expected_return("12:00", OFFICE, now)
    assert s is not None
    dt = datetime.fromisoformat(s)
    assert dt.hour == 6 and dt.minute == 30  # UTC


def test_parse_expected_return_hm_rolls_to_next_day_if_past():
    # 09:00 IST when it's already 11:00 IST → should roll to tomorrow.
    now = datetime(2026, 7, 1, 5, 30, tzinfo=timezone.utc)  # 11:00 IST
    s = parse_expected_return("09:00", OFFICE, now)
    dt = datetime.fromisoformat(s)
    assert dt.date().isoformat() == "2026-07-02"
    assert dt.hour == 3 and dt.minute == 30  # 09:00 IST = 03:30 UTC


def test_parse_expected_return_full_iso_with_z():
    now = datetime(2026, 7, 1, tzinfo=timezone.utc)
    s = parse_expected_return("2026-07-02T15:30:00Z", OFFICE, now)
    assert s.startswith("2026-07-02T15:30:00")


def test_parse_expected_return_naive_iso_treated_as_office_local():
    # "2026-07-02 18:00" naïve = 18:00 IST = 12:30 UTC
    now = datetime(2026, 7, 1, tzinfo=timezone.utc)
    s = parse_expected_return("2026-07-02T18:00:00", OFFICE, now)
    dt = datetime.fromisoformat(s)
    assert dt.hour == 12 and dt.minute == 30


def test_parse_expected_return_empty_returns_none():
    now = datetime(2026, 7, 1, tzinfo=timezone.utc)
    assert parse_expected_return(None, OFFICE, now) is None
    assert parse_expected_return("", OFFICE, now) is None
    assert parse_expected_return("   ", OFFICE, now) is None


def test_parse_expected_return_garbage_returns_none():
    now = datetime(2026, 7, 1, tzinfo=timezone.utc)
    assert parse_expected_return("not a time", OFFICE, now) is None
    assert parse_expected_return("25:99", OFFICE, now) is None
