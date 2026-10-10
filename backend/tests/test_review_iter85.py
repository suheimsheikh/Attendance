"""Backend regression for iteration 85:
(1) Attendance phase 2 split (routes/attendance_actions.py): geo-toggle check-in/out,
    temp-exit/return, scan-card, mark-member, admin toggle, delete open session,
    recalc-late, resolve-stale, status, stale-session, one-check-in-per-day,
    off-geofence proof.
(2) Unit conversions: PATCH /api/meals/items/{id} grams_per_unit (set/clear/negative),
    POST /api/meals/issues/suggest returns conversion {grams_per_unit, source} for
    Oil (density, 1000 g/L) and Banana (seed, 1440 g/dozen).
(3) Headcount prefill: muster | prev_day | manual source logic.

All resources prefixed 'ZZ Test ' and cleaned up after each class.

Run:
  TEST_ADMIN_PASSWORD=Admin@12345 \
  REACT_APP_BACKEND_URL=https://youth-regatta-app.preview.emergentagent.com \
  python -m pytest backend/tests/test_review_iter85.py -v
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get(
    "REACT_APP_BACKEND_URL", "https://youth-regatta-app.preview.emergentagent.com"
).rstrip("/")
ADMIN_EMAIL = "admin@attendance.app"
ADMIN_PASS = os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345")

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

# ---------- shared helpers ----------


@pytest.fixture(scope="module")
def mongo():
    cli = MongoClient(MONGO_URL)
    yield cli[DB_NAME]
    cli.close()


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASS},
        timeout=15,
    )
    assert r.status_code == 200, r.text[:300]
    return r.json().get("access_token") or r.json().get("token")


@pytest.fixture(scope="module")
def admin_h(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module")
def office(admin_h):
    r = requests.get(f"{BASE_URL}/api/office", headers=admin_h, timeout=10)
    assert r.status_code == 200, r.text[:200]
    o = r.json()
    assert "latitude" in o and "longitude" in o
    return o


# ---------- (1) Attendance phase 2 regression ----------


@pytest.fixture(scope="module")
def zz_member(admin_h, mongo):
    """Create a ZZ Test staff member; delete at end of module."""
    email = f"zz.test.{uuid.uuid4().hex[:8]}@example.com"
    body = {
        "email": email,
        "full_name": "ZZ Test Staff",
        "role": "member",
        "category": "staff",
        "password": "ZzTest@123",
        "mobile": f"9{uuid.uuid4().int % 10**9:09d}",
        # work_end far in the future so plain check-out does NOT trigger early-out
        "work_start": "09:30",
        "work_end": "23:00",
        "dar_exempt": True,
    }
    r = requests.post(f"{BASE_URL}/api/members", json=body, headers=admin_h, timeout=15)
    assert r.status_code in (200, 201), r.text[:300]
    data = r.json()
    yield {"id": data["id"], "email": email, "password": "ZzTest@123", "full_name": "ZZ Test Staff"}
    # Cleanup
    mid = data["id"]
    try:
        mongo.attendance.delete_many({"user_id": mid})
        mongo.temp_exits.delete_many({"user_id": mid})
        mongo.dars.delete_many({"user_id": mid})
        mongo.admin_audit.delete_many({"entity_id": mid})
        requests.delete(f"{BASE_URL}/api/members/{mid}", headers=admin_h, timeout=10)
        mongo.users.delete_one({"id": mid})
    except Exception as e:
        print(f"cleanup error: {e}")


@pytest.fixture(scope="module")
def zz_token(zz_member):
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": zz_member["email"], "password": zz_member["password"]},
        timeout=15,
    )
    assert r.status_code == 200, r.text[:300]
    return r.json().get("access_token") or r.json().get("token")


@pytest.fixture(scope="module")
def zz_h(zz_token):
    return {"Authorization": f"Bearer {zz_token}"}


class TestAttendancePhase2:
    """Full regression for backend/routes/attendance_actions.py."""

    def test_a_geo_toggle_checkin(self, zz_h, office, zz_member, mongo):
        # Clean any prior attendance for today to make test idempotent

        mongo.attendance.delete_many({"user_id": zz_member["id"]})
        r = requests.post(
            f"{BASE_URL}/api/attendance/geo-toggle",
            json={"latitude": office["latitude"], "longitude": office["longitude"]},
            headers=zz_h, timeout=15,
        )
        assert r.status_code == 200, r.text[:400]
        d = r.json()
        assert d["action"] == "checkin"
        assert d["out_of_geofence"] is False

    def test_b_status_checked_in(self, zz_h):
        r = requests.get(f"{BASE_URL}/api/attendance/status", headers=zz_h, timeout=10)
        assert r.status_code == 200, r.text[:300]
        s = r.json()
        assert s.get("checked_in") is True

    def test_c_temp_exit_and_return(self, zz_h):
        r = requests.post(
            f"{BASE_URL}/api/attendance/temp-exit",
            json={"reason": "ZZ Test errand", "expected_return": "23:30"},
            headers=zz_h, timeout=10,
        )
        assert r.status_code == 200, r.text[:300]
        ex = r.json()["excursion"]
        assert ex["out_at"] and ex["in_at"] is None
        # temp-return
        r2 = requests.post(
            f"{BASE_URL}/api/attendance/temp-return", json={}, headers=zz_h, timeout=10
        )
        assert r2.status_code == 200, r2.text[:300]
        assert r2.json()["excursion"]["in_at"]

    def test_d_second_temp_exit_blocked_when_already_out(self, zz_h):
        # First open one
        requests.post(
            f"{BASE_URL}/api/attendance/temp-exit",
            json={"reason": "ZZ Test again"},
            headers=zz_h, timeout=10,
        )
        # Second should fail
        r = requests.post(
            f"{BASE_URL}/api/attendance/temp-exit",
            json={"reason": "ZZ Test again2"},
            headers=zz_h, timeout=10,
        )
        assert r.status_code == 400
        # close it so later tests are deterministic
        requests.post(f"{BASE_URL}/api/attendance/temp-return", json={}, headers=zz_h, timeout=10)

    def test_e_offsite_requires_proof(self, zz_h, zz_member, mongo):
        # Clear today's rows so we're not already checked-in from test_a
        mongo.attendance.delete_many({"user_id": zz_member["id"]})
        # Send an off-site coordinate without reason/photo
        r = requests.post(
            f"{BASE_URL}/api/attendance/geo-toggle",
            json={"latitude": 0.1, "longitude": 0.1},
            headers=zz_h, timeout=10,
        )
        assert r.status_code == 400, r.text[:300]
        assert "OFFSITE_PROOF_REQUIRED" in r.text

    def test_f_geo_toggle_checkout(self, zz_h, office, zz_member, mongo):
        # Fresh check-in then check-out
        mongo.attendance.delete_many({"user_id": zz_member["id"]})
        r = requests.post(
            f"{BASE_URL}/api/attendance/geo-toggle",
            json={"latitude": office["latitude"], "longitude": office["longitude"]},
            headers=zz_h, timeout=10,
        )
        assert r.status_code == 200
        r2 = requests.post(
            f"{BASE_URL}/api/attendance/geo-toggle",
            json={"latitude": office["latitude"], "longitude": office["longitude"]},
            headers=zz_h, timeout=10,
        )
        assert r2.status_code == 200, r2.text[:300]
        d = r2.json()
        assert d["action"] == "checkout"
        assert "hours" in d

    def test_g_second_checkin_same_day_blocked(self, zz_h, office):
        r = requests.post(
            f"{BASE_URL}/api/attendance/geo-toggle",
            json={"latitude": office["latitude"], "longitude": office["longitude"]},
            headers=zz_h, timeout=10,
        )
        assert r.status_code == 400
        assert "ALREADY_CHECKED_IN_TODAY" in r.text

    def test_h_admin_mark_member(self, admin_h, zz_member, office, mongo):
        mongo.attendance.delete_many({"user_id": zz_member["id"]})
        r = requests.post(
            f"{BASE_URL}/api/attendance/mark-member",
            json={
                "member_id": zz_member["id"],
                "latitude": office["latitude"],
                "longitude": office["longitude"],
            },
            headers=admin_h, timeout=10,
        )
        assert r.status_code == 200, r.text[:300]
        assert r.json()["action"] == "checkin"

    def test_i_admin_toggle_route(self, admin_h, zz_member, mongo):
        # Should check-out now (session open from previous test)
        r = requests.post(
            f"{BASE_URL}/api/admin/attendance/toggle/{zz_member['id']}",
            json={"reason": "ZZ Test admin toggle"},
            headers=admin_h, timeout=10,
        )
        assert r.status_code == 200, r.text[:300]
        d = r.json()
        assert d["action"] == "checkout"
        assert d.get("override") is True

    def test_j_delete_open_session(self, admin_h, zz_member, office, mongo):
        mongo.attendance.delete_many({"user_id": zz_member["id"]})
        # Create open session
        requests.post(
            f"{BASE_URL}/api/attendance/mark-member",
            json={
                "member_id": zz_member["id"],
                "latitude": office["latitude"],
                "longitude": office["longitude"],
            },
            headers=admin_h, timeout=10,
        )
        r = requests.delete(
            f"{BASE_URL}/api/admin/attendance/open-session/{zz_member['id']}",
            headers=admin_h, timeout=10,
        )
        assert r.status_code == 200, r.text[:300]
        assert r.json()["removed"] == 1
        # Second delete → 404
        r2 = requests.delete(
            f"{BASE_URL}/api/admin/attendance/open-session/{zz_member['id']}",
            headers=admin_h, timeout=10,
        )
        assert r2.status_code == 404

    def test_k_recalc_late_admin(self, admin_h, zz_member, office, mongo):
        # Create a check-in row first
        mongo.attendance.delete_many({"user_id": zz_member["id"]})
        requests.post(
            f"{BASE_URL}/api/attendance/mark-member",
            json={
                "member_id": zz_member["id"],
                "latitude": office["latitude"],
                "longitude": office["longitude"],
            },
            headers=admin_h, timeout=10,
        )
        today = datetime.now().date().isoformat()
        r = requests.post(
            f"{BASE_URL}/api/attendance/recalc-late",
            json={"user_id": zz_member["id"], "start": today, "end": today, "dry_run": True},
            headers=admin_h, timeout=15,
        )
        assert r.status_code == 200, r.text[:300]
        body = r.json()
        assert "scanned" in body and "changes" in body
        assert body["dry_run"] is True

    def test_l_scan_card(self, admin_h, zz_member, office, mongo):
        # Fetch personal_qr
        r = requests.get(
            f"{BASE_URL}/api/members/{zz_member['id']}/card",
            headers=admin_h, timeout=10,
        )
        assert r.status_code == 200, r.text[:200]
        qr = r.json().get("personal_qr")
        assert qr
        # Current state: session open from recalc test; scan should check-out
        r2 = requests.post(
            f"{BASE_URL}/api/attendance/scan-card",
            json={
                "personal_qr": qr,
                "latitude": office["latitude"],
                "longitude": office["longitude"],
            },
            headers=admin_h, timeout=10,
        )
        assert r2.status_code == 200, r2.text[:300]
        assert r2.json().get("proxy") is True

    def test_m_resolve_stale_yesterday(self, zz_h, zz_member, mongo):
        # Insert a stale session dated yesterday directly in mongo.
        # First clear ANY existing attendance rows so stale-session detects ours.
        from datetime import date

        mongo.attendance.delete_many({"user_id": zz_member["id"]})
        ymd = (date.today() - timedelta(days=1)).isoformat()
        cin = (datetime.now(timezone.utc) - timedelta(days=1, hours=4)).isoformat()
        sid = str(uuid.uuid4())
        mongo.attendance.insert_one({
            "id": sid, "user_id": zz_member["id"], "date": ymd,
            "check_in_at": cin, "check_out_at": None, "method": "geo",
        })
        # GET stale-session
        r = requests.get(f"{BASE_URL}/api/attendance/stale-session", headers=zz_h, timeout=10)
        assert r.status_code == 200, r.text[:300]
        data = r.json()
        sess = data.get("stale") or {}
        assert sess.get("session_id") == sid, f"stale not returned: {data}"
        # Resolve with work_end
        r2 = requests.post(
            f"{BASE_URL}/api/attendance/resolve-stale",
            json={"session_id": sid, "action": "work_end"},
            headers=zz_h, timeout=15,
        )
        assert r2.status_code == 200, r2.text[:300]
        assert r2.json().get("action") == "closed"
        # Verify closed in db
        row = mongo.attendance.find_one({"id": sid})
        assert row.get("check_out_at")


# ---------- (2) Unit conversions ----------


@pytest.fixture(scope="module")
def zz_oil_item(admin_h, mongo):
    """Create a throwaway 'ZZ Test Oil' item (unit L); delete at end."""
    # Find any valid category
    # Pull any valid category from an existing item
    r = requests.get(f"{BASE_URL}/api/meals/items", headers=admin_h, timeout=10)
    assert r.status_code == 200, r.text[:200]
    items = r.json().get("items") or []
    assert items, "no existing meal_items to borrow category from"
    cat_key = items[0]["category_key"]
    body = {
        "name": f"ZZ Test Oil {uuid.uuid4().hex[:6]}",
        "unit": "L",
        "category_key": cat_key,
        "opening_stock": 0,
        "sort_order": 999,
    }
    r = requests.post(f"{BASE_URL}/api/meals/items", json=body, headers=admin_h, timeout=10)
    assert r.status_code in (200, 201), r.text[:400]
    doc = r.json()
    yield doc
    try:
        requests.delete(
            f"{BASE_URL}/api/meals/items/{doc['id']}", headers=admin_h, timeout=10
        )
        mongo.meal_items.delete_one({"id": doc["id"]})
    except Exception as e:
        print(f"zz_oil cleanup error: {e}")


class TestUnitConversions:
    def test_patch_grams_per_unit_set(self, admin_h, zz_oil_item, mongo):
        r = requests.patch(
            f"{BASE_URL}/api/meals/items/{zz_oil_item['id']}",
            json={"grams_per_unit": 920},
            headers=admin_h, timeout=10,
        )
        assert r.status_code == 200, r.text[:400]
        row = mongo.meal_items.find_one({"id": zz_oil_item["id"]})
        assert row.get("grams_per_unit") == 920.0, row

    def test_patch_grams_per_unit_clear(self, admin_h, zz_oil_item, mongo):
        r = requests.patch(
            f"{BASE_URL}/api/meals/items/{zz_oil_item['id']}",
            json={"grams_per_unit": 0},
            headers=admin_h, timeout=10,
        )
        assert r.status_code == 200, r.text[:400]
        row = mongo.meal_items.find_one({"id": zz_oil_item["id"]})
        # 0 should clear to None (per `round(...) or None`)
        assert row.get("grams_per_unit") in (None, 0, 0.0), row.get("grams_per_unit")
        # The spec says "clears it to null" — accept None as truth, warn if 0
        assert row.get("grams_per_unit") is None, f"expected None, got {row.get('grams_per_unit')!r}"

    def test_patch_grams_per_unit_negative(self, admin_h, zz_oil_item):
        r = requests.patch(
            f"{BASE_URL}/api/meals/items/{zz_oil_item['id']}",
            json={"grams_per_unit": -5},
            headers=admin_h, timeout=10,
        )
        assert r.status_code == 400, r.text[:300]

    def test_suggest_conversions_oil_banana(self, admin_h):
        r = requests.post(
            f"{BASE_URL}/api/meals/issues/suggest",
            json={"date": "2026-10-02"},
            headers=admin_h, timeout=30,
        )
        assert r.status_code == 200, r.text[:400]
        data = r.json()
        lines = data.get("lines") or []
        unit_mm = data.get("unit_mismatches") or []
        oil = next((ln for ln in lines if "oil" in (ln.get("item_name") or "").lower()), None)
        banana = next((ln for ln in lines if "banana" in (ln.get("item_name") or "").lower()), None)
        # Oil (L) via density
        if oil:
            conv = oil.get("conversion")
            assert conv, f"Oil conversion missing: {oil}"
            assert conv.get("source") == "density"
            assert abs(float(conv.get("grams_per_unit")) - 1000.0) < 1e-3
            assert not any(mm.get("item_id") == oil["item_id"] for mm in unit_mm)
        # Banana (dozen) via seed
        if banana:
            conv = banana.get("conversion")
            assert conv, f"Banana conversion missing: {banana}"
            assert conv.get("source") == "seed"
            assert abs(float(conv.get("grams_per_unit")) - 1440.0) < 1e-3
            assert not any(mm.get("item_id") == banana["item_id"] for mm in unit_mm)
        # If both absent (no menu for that day), at least record the fact
        if not oil and not banana:
            pytest.skip("Oil/Banana not referenced in 2026-10-02 menu — can't assert conversions")


# ---------- (3) Headcount prefill ----------


class TestHeadcountPrefill:
    def test_prev_day_source_when_no_muster(self, admin_h):
        r = requests.post(
            f"{BASE_URL}/api/meals/issues/suggest",
            json={"date": "2026-10-02"},
            headers=admin_h, timeout=20,
        )
        assert r.status_code == 200, r.text[:300]
        hc = r.json().get("headcounts") or {}
        for meal in ("breakfast", "lunch"):
            assert meal in hc, hc
            assert "source" in hc[meal] and "used" in hc[meal]
            # Should be prev_day since 2026-10-02 has no muster
            if hc[meal].get("muster", 0) == 0:
                assert hc[meal]["source"] == "prev_day", hc[meal]
                assert hc[meal]["used"] == hc[meal]["prev_day"]

    def test_manual_override(self, admin_h):
        r = requests.post(
            f"{BASE_URL}/api/meals/issues/suggest",
            json={"date": "2026-10-02", "counts": {"lunch": 30}},
            headers=admin_h, timeout=20,
        )
        assert r.status_code == 200, r.text[:300]
        hc = r.json().get("headcounts") or {}
        assert hc["lunch"]["source"] == "manual"
        assert hc["lunch"]["used"] == 30

    def test_muster_source_when_marks_exist(self, admin_h):
        r = requests.post(
            f"{BASE_URL}/api/meals/issues/suggest",
            json={"date": "2026-10-01"},
            headers=admin_h, timeout=20,
        )
        assert r.status_code == 200, r.text[:300]
        hc = r.json().get("headcounts") or {}
        any_muster = False
        for meal, info in hc.items():
            if info.get("muster", 0) > 0:
                any_muster = True
                assert info["source"] == "muster", (meal, info)
        if not any_muster:
            pytest.skip("No muster marks for 2026-10-01 in current DB")
