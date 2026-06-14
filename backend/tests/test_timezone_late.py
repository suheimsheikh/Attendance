"""Regression tests for office-timezone day boundaries and late-arrival flagging."""
from datetime import datetime, timezone

import server


def test_local_date_str_ist_rollover():
    # 2026-06-14 20:30 UTC == 2026-06-15 02:00 IST -> IST date is the 15th
    office = {"timezone": "Asia/Kolkata"}
    dt = datetime(2026, 6, 14, 20, 30, tzinfo=timezone.utc)
    assert server.local_date_str(office, dt) == "2026-06-15"


def test_local_date_str_utc():
    office = {"timezone": "UTC"}
    dt = datetime(2026, 6, 14, 20, 30, tzinfo=timezone.utc)
    assert server.local_date_str(office, dt) == "2026-06-14"


def test_local_date_str_defaults_to_ist_when_missing():
    dt = datetime(2026, 6, 14, 20, 30, tzinfo=timezone.utc)
    assert server.local_date_str({}, dt) == "2026-06-15"


def test_local_hm_converts_to_office_tz():
    office = {"timezone": "Asia/Kolkata"}
    # 17:00 UTC -> 22:30 IST
    iso = datetime(2026, 6, 14, 17, 0, tzinfo=timezone.utc).isoformat()
    assert server.local_hm(office, iso) == "22:30"


def test_compute_late_true_after_start_plus_grace():
    office = {"timezone": "Asia/Kolkata", "default_work_start": "09:00", "late_grace_minutes": 10}
    # 04:30 UTC == 10:00 IST -> after 09:10 threshold -> late by 50 min
    ts = datetime(2026, 6, 14, 4, 30, tzinfo=timezone.utc)
    late, mins = server.compute_late(office, {}, ts)
    assert late is True
    assert mins == 50


def test_compute_late_false_within_grace():
    office = {"timezone": "Asia/Kolkata", "default_work_start": "09:00", "late_grace_minutes": 15}
    # 03:40 UTC == 09:10 IST -> within 09:15 grace -> not late
    ts = datetime(2026, 6, 14, 3, 40, tzinfo=timezone.utc)
    late, mins = server.compute_late(office, {}, ts)
    assert late is False
    assert mins == 0


def test_compute_late_uses_member_work_start_override():
    office = {"timezone": "Asia/Kolkata", "default_work_start": "09:00", "late_grace_minutes": 0}
    member = {"work_start": "11:00"}
    # 04:30 UTC == 10:00 IST -> before member's 11:00 start -> not late
    ts = datetime(2026, 6, 14, 4, 30, tzinfo=timezone.utc)
    late, mins = server.compute_late(office, member, ts)
    assert late is False
