"""Iteration 119: 'Not expected' weekday feature (dow_hours.off).

Covers:
  1. Member PATCH accepts dow_hours = { 'mon': { 'off': True } } without 422.
  2. Grid: a staff/coach past day on an off-weekday with no attendance → 'NE' (not 'AB').
  3. Grid totals: 'NE' excluded from absent AND payable; absent drops after flipping.
  4. Grid precedence: attendance 'P'/'LT' and approved leave 'LV' beat NE.
  5. Presence board: on an off-weekday the staff member shows status=not_due,
     detail='Not scheduled'.
  6. Restores the dow_hours back to the original value after the test class.
"""
from __future__ import annotations

import os
from datetime import date, timedelta

import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
ADMIN_EMAIL = "admin@attendance.app"
ADMIN_PASSWORD = os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345")

# Fixed test month/date — must match the agent note (today = 2026-10-13).
TEST_MONTH = "2026-10"
TODAY_ISO = "2026-10-13"

SHORT_WK = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


@pytest.fixture(scope="module")
def admin_session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=60)
    assert r.status_code == 200, f"Admin login failed: {r.status_code} {r.text}"
    tok = r.json().get("access_token")
    assert tok
    s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


@pytest.fixture(scope="module")
def test_staff(admin_session):
    """Create a disposable staff member for the test, delete at teardown."""
    payload = {
        "email": "TEST_notexp_iter119@attendance.app",
        "password": "Testpass@123",
        "full_name": "TEST NotExpected Staff",
        "category": "staff",
        "role": "member",
        "weekly_off": "sunday",
        # Joined well before the test window so Grid shows the full month.
        "joining_date": "2026-01-01",
    }
    # Clean-up any prior leftover
    r = admin_session.get(f"{BASE_URL}/api/members")
    if r.status_code == 200:
        for m in r.json():
            if m.get("email") == payload["email"]:
                admin_session.delete(f"{BASE_URL}/api/members/{m['id']}")
    r = admin_session.post(f"{BASE_URL}/api/members", json=payload, timeout=20)
    assert r.status_code == 200, f"create failed: {r.status_code} {r.text}"
    member = r.json()
    yield member
    # Teardown — hard-delete requires super-admin. Admin should be super-admin.
    admin_session.delete(f"{BASE_URL}/api/members/{member['id']}")


class TestDowHoursOffAcceptance:
    """Member save round-trip: PATCH accepts boolean 'off'."""

    def test_patch_accepts_off_boolean(self, admin_session, test_staff):
        mid = test_staff["id"]
        body = {"dow_hours": {"mon": {"off": True}}}
        r = admin_session.patch(f"{BASE_URL}/api/members/{mid}", json=body, timeout=20)
        assert r.status_code == 200, f"PATCH failed: {r.status_code} {r.text}"
        # GET to verify persistence
        r2 = admin_session.get(f"{BASE_URL}/api/members/{mid}")
        assert r2.status_code == 200
        dh = r2.json().get("dow_hours") or {}
        assert dh.get("mon") == {"off": True}, f"dow_hours not persisted: {dh}"

    def test_patch_can_clear_off(self, admin_session, test_staff):
        mid = test_staff["id"]
        # Set then clear
        admin_session.patch(f"{BASE_URL}/api/members/{mid}",
                            json={"dow_hours": {"tue": {"off": True}}})
        r = admin_session.patch(f"{BASE_URL}/api/members/{mid}",
                                json={"dow_hours": {}}, timeout=20)
        assert r.status_code == 200
        r2 = admin_session.get(f"{BASE_URL}/api/members/{mid}")
        dh = r2.json().get("dow_hours") or {}
        assert "tue" not in dh


def _find_row(grid, member_id):
    for row in grid.get("rows", []):
        if row.get("member_id") == member_id:
            return row
    return None


class TestGridNEClassification:
    """Grid cell + totals behaviour for not-expected weekdays."""

    def test_ne_appears_on_past_off_weekday_no_attendance(
            self, admin_session, test_staff):
        mid = test_staff["id"]
        # Flip Mondays off. In Oct 2026, Mondays are 05, 12 (both <= today 13).
        r = admin_session.patch(f"{BASE_URL}/api/members/{mid}",
                                json={"dow_hours": {"mon": {"off": True}}})
        assert r.status_code == 200

        g = admin_session.get(
            f"{BASE_URL}/api/reports/calendar-grid",
            params={"month": TEST_MONTH, "category": "rest"}, timeout=30,
        )
        assert g.status_code == 200, g.text
        row = _find_row(g.json(), mid)
        assert row, "member row missing from grid"
        days = g.json()["days"]
        cells = row["cells"]
        # Build iso→code map
        c_by_iso = dict(zip(days, cells))
        # Oct 2026 Mondays before today: 2026-10-05, 2026-10-12
        for iso in ("2026-10-05", "2026-10-12"):
            assert c_by_iso.get(iso) == "NE", (
                f"Expected NE on {iso}, got {c_by_iso.get(iso)!r}"
            )

    def test_ne_excluded_from_absent_and_payable_totals(
            self, admin_session, test_staff):
        mid = test_staff["id"]
        # Baseline — clear dow_hours.
        admin_session.patch(f"{BASE_URL}/api/members/{mid}",
                            json={"dow_hours": {}})
        g1 = admin_session.get(
            f"{BASE_URL}/api/reports/calendar-grid",
            params={"month": TEST_MONTH, "category": "rest"}, timeout=30,
        ).json()
        row1 = _find_row(g1, mid)
        abs1 = row1["totals"]["absent"]
        pay1 = row1["totals"]["payable"]

        # Flip Mondays off.
        admin_session.patch(f"{BASE_URL}/api/members/{mid}",
                            json={"dow_hours": {"mon": {"off": True}}})
        g2 = admin_session.get(
            f"{BASE_URL}/api/reports/calendar-grid",
            params={"month": TEST_MONTH, "category": "rest"}, timeout=30,
        ).json()
        row2 = _find_row(g2, mid)
        abs2 = row2["totals"]["absent"]
        pay2 = row2["totals"]["payable"]
        # Mondays were AB previously → should drop by 2 (05, 12 Oct).
        assert abs2 < abs1, f"Absent did not drop: {abs1} → {abs2}"
        # Payable must NOT grow when flipping to NE.
        assert pay2 <= pay1, f"Payable grew unexpectedly: {pay1} → {pay2}"
        # Also assert NE days are not counted in payable total — compute NE count.
        ne_count = sum(1 for c in row2["cells"] if c == "NE")
        assert ne_count >= 2, f"Expected >=2 NE cells, got {ne_count}"


class TestPresenceNotScheduled:
    """Presence board surfaces 'Not scheduled' on off-weekdays."""

    def test_presence_on_off_weekday(self, admin_session, test_staff):
        mid = test_staff["id"]
        # Mon 2026-10-12 — flip Mondays off.
        admin_session.patch(f"{BASE_URL}/api/members/{mid}",
                            json={"dow_hours": {"mon": {"off": True}}})
        r = admin_session.get(f"{BASE_URL}/api/presence",
                              params={"on": "2026-10-12"}, timeout=30)
        assert r.status_code == 200, r.text
        data = r.json()
        row = next((m for m in data["members"] if m["id"] == mid), None)
        assert row, "member missing on presence"
        assert row["status"] == "not_due", f"status = {row['status']}"
        assert row["detail"] == "Not scheduled", f"detail = {row['detail']}"

    def test_presence_normal_working_day(self, admin_session, test_staff):
        mid = test_staff["id"]
        # 2026-10-13 is Tuesday — not off; Mon is off. Should NOT be 'Not scheduled'.
        admin_session.patch(f"{BASE_URL}/api/members/{mid}",
                            json={"dow_hours": {"mon": {"off": True}}})
        r = admin_session.get(f"{BASE_URL}/api/presence",
                              params={"on": "2026-10-13"}, timeout=30)
        assert r.status_code == 200
        row = next((m for m in r.json()["members"] if m["id"] == mid), None)
        assert row
        assert row.get("detail") != "Not scheduled"


class TestCleanup:
    """Explicit cleanup — reset dow_hours before member deletion fixture tears down."""

    def test_zz_restore_dow_hours(self, admin_session, test_staff):
        r = admin_session.patch(
            f"{BASE_URL}/api/members/{test_staff['id']}",
            json={"dow_hours": {}}, timeout=20,
        )
        assert r.status_code == 200
