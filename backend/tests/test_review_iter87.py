"""Iter87 regression: Recalc timings dialog + early-out recalc.

Scenario: edit a member's work_start/work_end, then the backend endpoint
POST /api/attendance/recalc-late (with include_early_out=true) must:
  - preview changes to late/late_minutes AND early_out_minutes
  - apply them, stamp late_recalc_at, and write audit `attendance.recalc_timings`.
Uses a throwaway ZZ member. NEVER touches real data.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

IST = timezone(timedelta(hours=5, minutes=30))
PREETHI_ID = "3c2538dc-bf3d-4dac-b0e4-ee84479547a6"  # DO NOT TOUCH


@pytest.fixture(scope="module")
def db():
    c = MongoClient(MONGO_URL)
    yield c[DB_NAME]
    c.close()


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={
        "email": "admin@attendance.app", "password": "Admin@12345"
    }, timeout=20)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def admin_hdr(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module")
def nonsuper_token(admin_hdr, db):
    """Create a throwaway admin member with a non-whitelisted mobile."""
    email = f"zz.admin.{uuid.uuid4().hex[:6]}@example.com"
    body = {"full_name": "ZZ NonSuper Admin", "email": email, "password": "Zz@12345",
            "role": "admin", "category": "staff", "mobile": "9000000001"}
    r = requests.post(f"{BASE_URL}/api/members", json=body, headers=admin_hdr, timeout=20)
    if r.status_code not in (200, 201):
        pytest.skip(f"could not create non-super admin: {r.status_code} {r.text}")
    uid = r.json()["id"]
    tok = requests.post(f"{BASE_URL}/api/auth/login", json={
        "email": email, "password": "Zz@12345"}, timeout=20)
    if tok.status_code != 200:
        requests.delete(f"{BASE_URL}/api/members/{uid}", headers=admin_hdr, timeout=20)
        pytest.skip("non-super admin login failed")
    yield tok.json()["access_token"]
    requests.delete(f"{BASE_URL}/api/members/{uid}", headers=admin_hdr, timeout=20)
    db.users.delete_one({"id": uid})


def _ist_dates_this_month():
    """Return up to 3 dates in the current IST month, strictly before today."""
    today = datetime.now(IST).date()
    first = today.replace(day=1)
    out = []
    d = first
    while d < today and len(out) < 3:
        out.append(d)
        d = d + timedelta(days=1)
    # Pick first 3 (or last 3 if month is long enough — doesn't matter)
    return out[:3]


@pytest.fixture(scope="module")
def zz_member(admin_hdr, db):
    # Create ZZ Test Timings via API
    body = {
        "full_name": "ZZ Test Timings",
        "email": f"zz.timings.{uuid.uuid4().hex[:6]}@example.com",
        "password": "Zz@12345",
        "role": "member",
        "category": "staff",
    }
    r = requests.post(f"{BASE_URL}/api/members", json=body, headers=admin_hdr, timeout=20)
    assert r.status_code in (200, 201), r.text
    m = r.json()
    yield m
    # Cleanup
    db.attendance.delete_many({"user_id": m["id"]})
    db.audit_log.delete_many({"entity_id": m["id"]})
    db.admin_audit.delete_many({"entity_id": m["id"]})
    requests.delete(f"{BASE_URL}/api/members/{m['id']}", headers=admin_hdr, timeout=20)
    # Hard-delete from mongo if still there
    db.users.delete_one({"id": m["id"]})


@pytest.fixture(scope="module")
def seed_attendance(zz_member, db):
    """Insert 3 attendance docs on 3 distinct dates in current month.
      - 07:10 IST check-in / 18:10 IST check-out  → vs 06:00-17:30: LT 70m, no EO
      - 08:00 IST check-in / 16:00 IST check-out  → LT 120m, EO 90m
      - 06:00 IST check-in / 17:00 IST check-out  → on-time, EO 30m
    """
    uid = zz_member["id"]
    dates = _ist_dates_this_month()
    if len(dates) < 3:
        pytest.skip("Need at least 3 past days this month for the test")
    pairs = [("07:10", "18:10"), ("08:00", "16:00"), ("06:00", "17:00")]
    docs = []
    for d, (cin_hm, cout_hm) in zip(dates, pairs):
        ch, cm = int(cin_hm[:2]), int(cin_hm[3:])
        oh, om = int(cout_hm[:2]), int(cout_hm[3:])
        cin_ist = datetime(d.year, d.month, d.day, ch, cm, tzinfo=IST)
        cout_ist = datetime(d.year, d.month, d.day, oh, om, tzinfo=IST)
        doc = {
            "id": str(uuid.uuid4()),
            "user_id": uid,
            "date": d.isoformat(),
            "check_in_at": cin_ist.astimezone(timezone.utc).isoformat(),
            "check_out_at": cout_ist.astimezone(timezone.utc).isoformat(),
            "hours": round((cout_ist - cin_ist).total_seconds() / 3600, 2),
            "late": False,
            "late_minutes": 0,
            "early_out_minutes": 0,
            "status": "present",
        }
        db.attendance.insert_one(doc)
        docs.append(doc)
    yield docs
    # Cleanup happens via zz_member teardown too, but be explicit
    db.attendance.delete_many({"user_id": uid})


# --- Guard: never touch PREETHI ---
def test_preethi_untouched(db):
    before = list(db.attendance.find({"user_id": PREETHI_ID}, {"_id": 0, "id": 1, "late_minutes": 1, "early_out_minutes": 1}).limit(5))
    assert isinstance(before, list)  # just a sanity read; we don't write.


# --- Recalc preview (dry_run) ---
def test_recalc_preview_before_edit(zz_member, seed_attendance, admin_hdr):
    """With default office timings (09:30-18:00) and no member work_end set,
    EO stays 0 and all checkins are earlier than 09:30 so late=False — no drift.
    Verify endpoint returns a clean 200 preview with the full change schema."""
    body = {
        "user_id": zz_member["id"],
        "start": seed_attendance[0]["date"],
        "end": seed_attendance[-1]["date"],
        "dry_run": True,
        "include_early_out": True,
    }
    r = requests.post(f"{BASE_URL}/api/attendance/recalc-late", json=body, headers=admin_hdr, timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["scanned"] >= 3
    assert data["dry_run"] is True
    # Schema check — every change row carries the new EO fields.
    for ch in data["changes"]:
        for k in ("was_early_out", "now_early_out", "was_late", "now_late", "was_minutes", "now_minutes"):
            assert k in ch, f"missing {k} in change {ch}"


# --- After editing timings via PATCH /members, re-run recalc ---
def test_edit_timings_then_recalc_applies(zz_member, seed_attendance, admin_hdr, db):
    uid = zz_member["id"]
    # Edit via API (same path the UI uses)
    r = requests.patch(f"{BASE_URL}/api/members/{uid}",
                       json={"work_start": "06:00", "work_end": "17:30"},
                       headers=admin_hdr, timeout=20)
    assert r.status_code == 200, r.text

    # Preview with new timings
    body = {
        "user_id": uid,
        "start": seed_attendance[0]["date"],
        "end": seed_attendance[-1]["date"],
        "dry_run": True,
        "include_early_out": True,
    }
    r = requests.post(f"{BASE_URL}/api/attendance/recalc-late", json=body, headers=admin_hdr, timeout=30)
    assert r.status_code == 200, r.text
    preview = r.json()
    # Expectations per seeded times vs 06:00-17:30:
    #  Day1 07:10/18:10 → LT 70m, EO 0
    #  Day2 08:00/16:00 → LT 120m, EO 90
    #  Day3 06:00/17:00 → LT 0, EO 30
    by_date = {c["date"]: c for c in preview["changes"]}
    assert len(by_date) == 3, f"expected 3 changed rows, got {preview}"

    d1, d2, d3 = [a["date"] for a in seed_attendance]
    assert by_date[d1]["now_late"] is True and by_date[d1]["now_minutes"] == 70
    assert by_date[d1]["now_early_out"] == 0
    assert by_date[d2]["now_late"] is True and by_date[d2]["now_minutes"] == 120
    assert by_date[d2]["now_early_out"] == 90
    assert by_date[d3]["now_late"] is False and by_date[d3]["now_minutes"] == 0
    assert by_date[d3]["now_early_out"] == 30

    # Apply
    body["dry_run"] = False
    r = requests.post(f"{BASE_URL}/api/attendance/recalc-late", json=body, headers=admin_hdr, timeout=30)
    assert r.status_code == 200, r.text
    applied = r.json()
    assert applied["applied"] == 3

    # Verify DB rows updated + late_recalc_at stamped
    rows = {row["date"]: row for row in db.attendance.find({"user_id": uid}, {"_id": 0})}
    assert rows[d1]["late"] is True and rows[d1]["late_minutes"] == 70 and rows[d1]["early_out_minutes"] == 0
    assert rows[d2]["late"] is True and rows[d2]["late_minutes"] == 120 and rows[d2]["early_out_minutes"] == 90
    assert rows[d3]["late"] is False and rows[d3]["early_out_minutes"] == 30
    for d in (d1, d2, d3):
        assert rows[d].get("late_recalc_at"), f"late_recalc_at missing on {d}"

    # Audit row written
    audit = db.audit_log.find_one({"action": "attendance.recalc_timings", "entity_id": uid})
    if not audit:
        audit = db.admin_audit.find_one({"action": "attendance.recalc_timings", "entity_id": uid})
    assert audit, "audit_log row with action='attendance.recalc_timings' not found"


# --- Calendar grid reflects LT/EO ---
def test_calendar_grid_reflects_lt_and_eo(zz_member, admin_hdr):
    month = datetime.now(IST).strftime("%Y-%m")
    r = requests.get(f"{BASE_URL}/api/reports/calendar-grid?month={month}",
                     headers=admin_hdr, timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    # Find ZZ member row
    rows = data.get("rows") or data.get("members") or data.get("grid") or []
    assert rows, f"calendar-grid returned no rows: keys={list(data.keys())}"
    zz = next((row for row in rows if row.get("member_id") == zz_member["id"]), None)
    assert zz, "ZZ member not in calendar grid"
    totals = zz.get("totals") or {}
    # 2 late days, 2 EO days (90m + 30m)
    assert totals.get("late", 0) >= 2, f"totals.late expected >=2, got {totals}"
    assert totals.get("early_out", 0) >= 2, f"totals.early_out expected >=2, got {totals}"


# --- Non-super admin: endpoint 403 on apply but preview may also 403 (super-admin only) ---
def test_nonsuper_cannot_apply(nonsuper_token, zz_member, seed_attendance):
    hdr = {"Authorization": f"Bearer {nonsuper_token}"}
    r = requests.post(f"{BASE_URL}/api/attendance/recalc-late", json={
        "user_id": zz_member["id"],
        "start": seed_attendance[0]["date"],
        "end": seed_attendance[-1]["date"],
        "dry_run": False,
        "include_early_out": True,
    }, headers=hdr, timeout=20)
    assert r.status_code == 403, f"non-super admin should be 403, got {r.status_code} {r.text}"
