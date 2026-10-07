"""Hourly wagers (Oct 2026 user rules): paid on hours only, max 8 h/day
(half-hour rounding, then capped); no Late / Early-out / Absent; PayCraft
gets hours only; not in absentee lists; switching a member to hourly clears
Late / Early-out marks in the open month. Throwaway members only."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from services.attendance_calc import session_ot_minutes

DAR = "Automated test — daily activity report text."


def _today():
    return datetime.now(ZoneInfo("Asia/Kolkata")).date()


def test_hours_rounded_then_capped_at_8():
    h = {"hourly_wager": True}
    assert session_ot_minutes(h, {"hours": 5 + 44 / 60}) == 330      # 5h44 → 5.5h
    assert session_ot_minutes(h, {"hours": 7 + 50 / 60}) == 480      # 7h50 → 8h
    assert session_ot_minutes(h, {"hours": 9 + 40 / 60}) == 480      # 9h40 → capped 8h
    assert session_ot_minutes(h, {"hours": 14}) == 480
    assert session_ot_minutes({}, {"hours": 14, "overtime_total_min": 75}) == 75  # salaried unchanged


def test_hourly_never_late_or_early_out(base_url, mongo_db, make_member):
    if mongo_db is None:
        pytest.skip("mongo_db fixture unavailable")
    # Tiny window that has always passed / not yet come → would be late AND early-out.
    m = make_member("staff", login=True, hourly_wager=True, work_start="00:00", work_end="23:59")
    r = m["client"].post(f"{base_url}/api/attendance/geo-toggle", json={"latitude": 0, "longitude": 0}, timeout=30)
    assert r.status_code == 200, r.text
    r = m["client"].post(f"{base_url}/api/attendance/geo-toggle",
                         json={"latitude": 0, "longitude": 0, "dar_text": DAR}, timeout=30)
    assert r.status_code == 200 and r.json()["action"] == "checkout", r.text
    row = mongo_db.attendance.find_one({"user_id": m["id"]}, sort=[("check_in_at", -1)])
    assert row["late"] is False and not row.get("late_minutes")
    assert row.get("early_out_minutes") == 0


def test_grid_hourly_no_absent_hours_only(admin_client, base_url, mongo_db, make_member):
    if mongo_db is None:
        pytest.skip("mongo_db fixture unavailable")
    today = _today()
    if today.day < 3:
        pytest.skip("needs at least two elapsed days in the month")
    hourly = make_member("staff", hourly_wager=True)
    salaried = make_member("staff")
    day = (today - timedelta(days=1)).isoformat()
    mongo_db.attendance.insert_one({
        "id": str(uuid.uuid4()), "user_id": hourly["id"], "date": day,
        "check_in_at": f"{day}T01:00:00+00:00", "check_out_at": f"{day}T10:40:00+00:00",
        "hours": 9 + 40 / 60, "late": False, "early_out_minutes": 0})
    g = admin_client.get(f"{base_url}/api/reports/calendar-grid",
                         params={"month": today.isoformat()[:7], "with_meta": "false"}, timeout=60).json()
    rows = {r["member_id"]: r for r in g["rows"]}
    h, s = rows[hourly["id"]], rows[salaried["id"]]
    assert "AB" not in h["cells"], h["cells"]
    assert "AB" in s["cells"]                     # control: salaried misses are AB
    assert h["totals"]["ot_minutes"] == 480        # 9h40 → capped at 8 h
    for k in ("payable", "absent", "lop", "late", "early_out", "dar_missed"):
        assert h["totals"][k] == 0, (k, h["totals"])


def test_hourly_not_in_absentee_lists(admin_client, base_url, make_member):
    hourly = make_member("coach", hourly_wager=True)
    roster = admin_client.get(f"{base_url}/api/muster/daily-roster", timeout=30).json()
    assert hourly["full_name"] not in [a["name"] for a in roster["absent"]]
    rep = admin_client.get(f"{base_url}/api/muster/absent-report", timeout=30).json()
    assert hourly["full_name"] not in rep["coaches"]


def test_switch_to_hourly_clears_open_month_marks(admin_client, base_url, mongo_db, make_member):
    if mongo_db is None:
        pytest.skip("mongo_db fixture unavailable")
    m = make_member("staff")
    day = _today().isoformat()
    rid = str(uuid.uuid4())
    mongo_db.attendance.insert_one({"id": rid, "user_id": m["id"], "date": day,
                                    "check_in_at": f"{day}T05:00:00+00:00", "late": True,
                                    "late_minutes": 40, "early_out_minutes": 30})
    r = admin_client.patch(f"{base_url}/api/members/{m['id']}", json={"hourly_wager": True}, timeout=30)
    assert r.status_code == 200, r.text
    row = mongo_db.attendance.find_one({"id": rid})
    assert row["late"] is False and row["late_minutes"] == 0 and row["early_out_minutes"] == 0


def test_paycraft_feed_hourly_balances_zero(base_url, make_member):
    import os
    import requests
    key = os.environ.get("GRID_API_KEY")
    if not key:
        pytest.skip("GRID_API_KEY not set")
    m = make_member("staff", hourly_wager=True)
    r = requests.get(f"{base_url}/api/leave-balances", params={"key": key}, timeout=60)
    if r.status_code == 404:
        pytest.skip("leave-balances feed path differs")
    row = next(x for x in r.json()["rows"] if x["member_id"] == m["id"])
    assert row["pay_basis"] == "hourly"
    assert row["balances"] == {"leave": 0, "comp_off": 0}
