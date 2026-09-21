"""Profile attendance endpoints + grid parity checks (admin/non-admin/self scopes)."""

from __future__ import annotations

import calendar
import os
import uuid
from datetime import date
from pathlib import Path

from dotenv import load_dotenv

import pytest
import requests


def _month_days(yyyy_mm: str) -> int:
    y, m = [int(x) for x in yyyy_mm.split("-")]
    return calendar.monthrange(y, m)[1]


def _prev_month(yyyy_mm: str) -> str:
    y, m = [int(x) for x in yyyy_mm.split("-")]
    if m == 1:
        return f"{y-1:04d}-12"
    return f"{y:04d}-{m-1:02d}"


@pytest.fixture(scope="session")
def roster(admin_client: requests.Session, base_url: str) -> list[dict]:
    r = admin_client.get(f"{base_url}/api/members", timeout=40)
    assert r.status_code == 200, r.text
    rows = r.json()
    assert isinstance(rows, list) and rows
    return rows


@pytest.fixture(scope="session")
def sample_members(roster: list[dict]) -> dict:
    athlete = next(
        (m for m in roster if m.get("category") in {"athlete", "elite"} and m.get("status") != "left"),
        None,
    )
    employee = next((m for m in roster if m.get("category") in {"staff", "coach", "executive"}), None)
    former = next((m for m in roster if m.get("status") == "left"), None)
    assert athlete, "No athlete/elite member available"
    assert employee, "No staff/coach/executive member available"
    return {"athlete": athlete, "employee": employee, "former": former}


@pytest.fixture(scope="session")
def non_admin_client(base_url: str) -> requests.Session:
    load_dotenv(Path(__file__).resolve().parents[1] / ".env.profile-test")
    r = requests.post(f"{base_url}/api/auth/login", json={
        "email": os.environ["PROFILE_TEST_EMAIL"], "password": os.environ["PROFILE_TEST_PASSWORD"],
    }, timeout=30)
    assert r.status_code == 200, r.text
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {r.json()['access_token']}", "Content-Type": "application/json"})
    return s


# Modules/features: member discovery + category coverage for admin picker sources.
def test_members_contains_expected_categories(roster: list[dict]):
    cats = {m.get("category") for m in roster}
    for expected in {"staff", "coach", "executive", "athlete", "elite"}:
        assert expected in cats, f"Missing category in roster: {expected}"


# Modules/features: self attendance month endpoint (default month + spoof guard).
def test_me_attendance_month_default_and_member_spoof_ignored(
    admin_client: requests.Session,
    base_url: str,
    sample_members: dict,
):
    spoof_member = sample_members["employee"]["id"]
    own = admin_client.get(f"{base_url}/api/me/attendance-month", timeout=40)
    spoof = admin_client.get(f"{base_url}/api/me/attendance-month", params={"member_id": spoof_member}, timeout=40)
    assert own.status_code == 200, own.text
    assert spoof.status_code == 200, spoof.text
    own_data = own.json()
    spoof_data = spoof.json()
    assert own_data["member_id"] == spoof_data["member_id"]
    assert own_data["month"] == spoof_data["month"]
    assert own_data["days"] == spoof_data["days"]
    assert len(own_data["days"]) == _month_days(own_data["month"])


# Modules/features: admin scoped endpoint day-count coverage (28/29/30/31 months).
@pytest.mark.parametrize("month", ["2025-02", "2024-02", "2026-04", "2026-08"])
def test_admin_member_attendance_has_every_date(
    admin_client: requests.Session,
    base_url: str,
    sample_members: dict,
    month: str,
):
    member_id = sample_members["employee"]["id"]
    r = admin_client.get(
        f"{base_url}/api/admin/members/{member_id}/attendance-month",
        params={"month": month},
        timeout=50,
    )
    assert r.status_code == 200, r.text
    payload = r.json()
    assert payload["month"] == month
    assert len(payload["days"]) == _month_days(month)
    assert payload["days"][0]["date"] == f"{month}-01"
    assert payload["days"][-1]["date"].startswith(month)


# Modules/features: validation and authorization guards.
def test_invalid_month_returns_400(admin_client: requests.Session, base_url: str, sample_members: dict):
    member_id = sample_members["employee"]["id"]
    bad_months = ["2026-13", "2026-00", "2026-9", "abcd-ef"]
    for bad in bad_months:
        own = admin_client.get(f"{base_url}/api/me/attendance-month", params={"month": bad}, timeout=30)
        member = admin_client.get(
            f"{base_url}/api/admin/members/{member_id}/attendance-month",
            params={"month": bad},
            timeout=30,
        )
        assert own.status_code == 400, own.text
        assert member.status_code == 400, member.text


def test_missing_member_returns_404(admin_client: requests.Session, base_url: str):
    ghost = str(uuid.uuid4())
    r = admin_client.get(f"{base_url}/api/admin/members/{ghost}/attendance-month", params={"month": "2026-08"}, timeout=30)
    assert r.status_code == 404


def test_anonymous_rejected_for_profile_attendance(base_url: str, sample_members: dict):
    member_id = sample_members["employee"]["id"]
    own = requests.get(f"{base_url}/api/me/attendance-month", timeout=30)
    member = requests.get(f"{base_url}/api/admin/members/{member_id}/attendance-month", timeout=30)
    assert own.status_code in {401, 403}
    assert member.status_code in {401, 403}


def test_non_admin_rejected_for_admin_member_endpoint(
    non_admin_client: requests.Session,
    base_url: str,
    sample_members: dict,
):
    member_id = sample_members["employee"]["id"]
    r = non_admin_client.get(f"{base_url}/api/admin/members/{member_id}/attendance-month", timeout=30)
    assert r.status_code == 403


def _assert_grid_parity(admin_client: requests.Session, base_url: str, month: str, member: dict):
    member_id = member["id"]
    pr = admin_client.get(
        f"{base_url}/api/admin/members/{member_id}/attendance-month",
        params={"month": month},
        timeout=60,
    )
    assert pr.status_code == 200, pr.text
    profile = pr.json()

    gr = admin_client.get(
        f"{base_url}/api/reports/calendar-grid",
        params={"month": month},
        timeout=60,
    )
    assert gr.status_code == 200, gr.text
    grid = gr.json()

    row = next((r for r in grid["rows"] if r.get("member_id") == member_id), None)
    assert row is not None, f"Grid row missing for {member_id} @ {month}"
    assert profile["totals"] == row["totals"]
    assert [d["date"] for d in profile["days"]] == grid["days"]
    assert [d["code"] for d in profile["days"]] == row["cells"]


# Modules/features: parity with calendar grid for real employee + athlete in current/historical months.
def test_grid_parity_employee_current_and_historical(
    admin_client: requests.Session,
    base_url: str,
    sample_members: dict,
):
    today_month = date.today().strftime("%Y-%m")
    hist_month = _prev_month(today_month)
    _assert_grid_parity(admin_client, base_url, today_month, sample_members["employee"])
    _assert_grid_parity(admin_client, base_url, hist_month, sample_members["employee"])


def test_grid_parity_athlete_current_and_historical(
    admin_client: requests.Session,
    base_url: str,
):
    today_month = date.today().strftime("%Y-%m")
    hist_month = _prev_month(today_month)

    current_grid = admin_client.get(
        f"{base_url}/api/reports/calendar-grid", params={"month": today_month}, timeout=60
    )
    assert current_grid.status_code == 200, current_grid.text
    athlete_row = next(
        (r for r in current_grid.json().get("rows", []) if r.get("category") in {"athlete", "elite"}),
        None,
    )
    assert athlete_row is not None, "No athlete/elite row found in current month calendar grid"
    athlete_member = {"id": athlete_row["member_id"]}

    _assert_grid_parity(admin_client, base_url, today_month, athlete_member)
    _assert_grid_parity(admin_client, base_url, hist_month, athlete_member)


# Modules/features: former-member scoped profile still available when excluded from main grid.
def test_former_member_scoped_profile_supported(
    admin_client: requests.Session,
    base_url: str,
    non_admin_client: requests.Session,
    mongo_db,
):
    # Only alter the isolated QA fixture, never a real academy member.
    member = non_admin_client.get(f"{base_url}/api/auth/me", timeout=30).json()
    uid = member["id"]
    original = mongo_db.users.find_one({"id": uid}, {"_id": 0})
    assert original["email"] == os.environ["PROFILE_TEST_EMAIL"]
    month = date.today().strftime("%Y-%m")
    try:
        mongo_db.users.update_one({"id": uid}, {"$set": {"status": "left", "leaving_date": "2026-01-01"}})
        profile = admin_client.get(f"{base_url}/api/admin/members/{uid}/attendance-month", params={"month": month}, timeout=60)
        assert profile.status_code == 200, profile.text
        pdata = profile.json()
        assert pdata["member_id"] == uid
        assert len(pdata["days"]) == _month_days(month)
        assert all(d["code"] == "LF" for d in pdata["days"])
        grid = admin_client.get(f"{base_url}/api/reports/calendar-grid", params={"month": month}, timeout=60)
        assert grid.status_code == 200, grid.text
        assert all(r.get("member_id") != uid for r in grid.json().get("rows", []))
    finally:
        mongo_db.users.replace_one({"id": uid}, original)


def test_non_admin_self_spoof_ignored(non_admin_client, admin_client, base_url):
    admin_id = admin_client.get(f"{base_url}/api/auth/me", timeout=30).json()["id"]
    me = non_admin_client.get(f"{base_url}/api/auth/me", timeout=30).json()
    r = non_admin_client.get(f"{base_url}/api/me/attendance-month", params={"member_id": admin_id}, timeout=30)
    assert r.status_code == 200
    assert r.json()["member_id"] == me["id"] != admin_id


def test_detailed_fixture_sessions_leaves_and_overrides(non_admin_client, admin_client, base_url, mongo_db):
    uid = non_admin_client.get(f"{base_url}/api/auth/me", timeout=30).json()["id"]
    assert mongo_db.users.find_one({"id": uid})["email"] == os.environ["PROFILE_TEST_EMAIL"]
    prefix = "profile-qa-" + uuid.uuid4().hex
    sessions = [
        {"id": prefix + "-closed", "user_id": uid, "date": "2026-08-03", "check_in_at": "2026-08-03T04:30:00+00:00", "check_out_at": "2026-08-03T10:30:00+00:00", "hours": 6, "late": True, "late_minutes": 30, "early_out_minutes": 120, "early_out_reason": "QA appointment", "overtime_total_min": 45, "overtime_reason": "QA early setup", "site_name": "QA Site", "method": "geo", "excursions": [{"out_at": "2026-08-03T06:00:00+00:00", "in_at": "2026-08-03T06:30:00+00:00", "reason": "QA step out"}]},
        {"id": prefix + "-missing", "user_id": uid, "date": "2026-08-04", "check_in_at": "2026-08-04T04:30:00+00:00", "check_out_at": "2026-08-04T18:29:00+00:00", "hours": 99, "missing_checkout": True, "needs_correction": True},
        {"id": prefix + "-zero", "user_id": uid, "date": "2026-08-05", "check_in_at": "2026-08-05T04:30:00+00:00", "check_out_at": "2026-08-05T04:30:00+00:00", "hours": 0},
    ]
    leaves = [{"id": prefix + "-" + typ, "user_id": uid, "type": typ, "status": status, "start_date": dt, "end_date": dt, "reason": "QA " + typ, "half_day": half, "decided_by": "QA Approver"}
              for typ, status, dt, half in [("tour", "approved", "2026-08-06", None), ("leave", "approved", "2026-08-07", "FN"), ("posting", "pending", "2026-08-10", None)]]
    try:
        mongo_db.attendance.insert_many(sessions)
        mongo_db.leaves.insert_many(leaves)
        mongo_db.grid_overrides.insert_one({"id": prefix + "-override", "user_id": uid, "date": "2026-08-11", "code": "HD"})
        r = non_admin_client.get(f"{base_url}/api/me/attendance-month", params={"month": "2026-08"}, timeout=40)
        assert r.status_code == 200, r.text
        days = {d["date"]: d for d in r.json()["days"]}
        closed = days["2026-08-03"]["sessions"][0]
        assert days["2026-08-03"]["code"] == "LT"
        assert (closed["hours"], closed["late_minutes"], closed["early_out_minutes"], closed["overtime_total_min"]) == (6, 30, 120, 45)
        assert closed["site_name"] == "QA Site" and closed["excursions"][0]["reason"] == "QA step out"
        assert days["2026-08-04"]["sessions"][0]["hours"] is None
        assert days["2026-08-05"]["sessions"][0]["hours"] == 0
        assert days["2026-08-06"]["code"] == "TR"
        assert days["2026-08-07"]["code"] == "LV"
        assert days["2026-08-07"]["leaves"][0]["half_day"] == "FN"
        assert days["2026-08-10"]["leaves"][0]["status"] == "pending"
        assert days["2026-08-10"]["code"] != "PS"
        assert days["2026-08-11"]["manual_override"] and days["2026-08-11"]["code"] == "HD"
        _assert_grid_parity(admin_client, base_url, "2026-08", {"id": uid})
    finally:
        for collection in (mongo_db.attendance, mongo_db.leaves, mongo_db.grid_overrides):
            collection.delete_many({"user_id": uid, "id": {"$regex": "^" + prefix}})


# Modules/features: sensitive-field and missing-checkout integrity checks.
def test_attendance_payload_hides_sensitive_fields_and_respects_missing_checkout(
    admin_client: requests.Session,
    base_url: str,
    sample_members: dict,
):
    month = date.today().strftime("%Y-%m")
    member_id = sample_members["employee"]["id"]
    r = admin_client.get(
        f"{base_url}/api/admin/members/{member_id}/attendance-month",
        params={"month": month},
        timeout=60,
    )
    assert r.status_code == 200, r.text
    payload = r.json()

    # Top-level sensitive keys should never leak.
    for banned in ["hashed_password", "password", "photo", "photo_thumb", "sessions_of_other_members"]:
        assert banned not in payload

    future_absent = [d for d in payload["days"] if d.get("is_future") and d.get("code") == "AB"]
    assert not future_absent, "Future days should not be marked absent"

    for day in payload["days"]:
        for s in day.get("sessions", []):
            assert "user_id" not in s
            if s.get("missing_checkout"):
                assert s.get("hours") is None

    # DAR total should match per-day missing statuses.
    dar_missing_days = sum(1 for d in payload["days"] if d.get("dar_status") == "missing")
    assert payload["totals"]["dar_missed"] == dar_missing_days
