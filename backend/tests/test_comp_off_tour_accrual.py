"""
Unit tests for the Tour → comp-off accrual rule added 28 Jun 2026.

Policy: when a STAFF member's approved tour spans their weekly_off
day(s), each weekly_off date inside that tour window counts as +1
comp-off accrual. Athletes / coaches / executives keep the original
on-campus-only rule.

Each test creates its own Motor client+loop pair (Motor binds the client
to the loop it was created on; reusing a closed loop crashes) and drops
the test DB at the end.
"""
import asyncio
from datetime import date

import pytest
from motor.motor_asyncio import AsyncIOMotorClient

from holidays import compute_comp_off_balance


TEST_DB_NAME = "test_comp_off_tour_accrual"


async def _seed(db, user_id: str, tour_ranges: list,
                attendance_dates: list = None,
                tour_status: str = "approved"):
    await db.leaves.delete_many({})
    await db.attendance.delete_many({})
    rows = []
    for s, e in tour_ranges:
        rows.append({
            "id": f"tour-{s}-{e}",
            "user_id": user_id,
            "type": "tour",
            "status": tour_status,
            "start_date": s,
            "end_date": e,
        })
    if rows:
        await db.leaves.insert_many(rows)
    for d in (attendance_dates or []):
        await db.attendance.insert_one({
            "id": f"att-{d}",
            "user_id": user_id,
            "date": d,
            "check_in_at": f"{d}T09:00:00+00:00",
        })


def _run_case(seed_args, user, year="2026", office_default=None):
    """Spin a fresh client/loop, seed, compute, return balance dict."""
    async def go():
        client = AsyncIOMotorClient("mongodb://localhost:27017")
        try:
            db = client[TEST_DB_NAME]
            await db.leaves.delete_many({})
            await db.attendance.delete_many({})
            await db.config.delete_many({"id": "office"})
            if office_default:
                await db.config.insert_one({"id": "office", "default_weekly_off": office_default})
            await _seed(db, **seed_args)
            return await compute_comp_off_balance(db, user, year=year)
        finally:
            client.close()

    return asyncio.run(go())


@pytest.fixture(scope="module", autouse=True)
def _cleanup():
    """Drop the test DB once at the end of the module run."""
    yield
    async def drop():
        client = AsyncIOMotorClient("mongodb://localhost:27017")
        try:
            await client.drop_database(TEST_DB_NAME)
        finally:
            client.close()
    asyncio.run(drop())


# 2026-01-04 is a Sunday — used as the canonical "weekly off" anchor below.

def test_staff_tour_on_weekly_off_accrues():
    bal = _run_case(
        seed_args={"user_id": "u-staff", "tour_ranges": [("2026-01-03", "2026-01-05")]},
        user={"id": "u-staff", "category": "staff", "weekly_off": "sunday"},
    )
    assert bal["accrued"] == 1, f"expected 1, got {bal['accrued']}"
    kinds = [b["kind"] for b in bal["breakdown"]]
    assert "tour_weekly_off" in kinds


def test_staff_tour_only_weekly_off_days_count():
    bal = _run_case(
        seed_args={"user_id": "u-staff", "tour_ranges": [("2026-01-05", "2026-01-11")]},
        user={"id": "u-staff", "category": "staff", "weekly_off": "sunday"},
    )
    assert bal["accrued"] == 1


def test_athlete_tour_does_not_accrue():
    """Athletes are the only category excluded — they use the Breaks workflow."""
    bal = _run_case(
        seed_args={"user_id": "u-athlete", "tour_ranges": [("2026-01-03", "2026-01-05")]},
        user={"id": "u-athlete", "category": "athlete", "weekly_off": "sunday"},
    )
    assert bal["accrued"] == 0


def test_coach_tour_accrues():
    """Updated 28 Jun 2026 — coaches now accrue tour-day comp-off too."""
    bal = _run_case(
        seed_args={"user_id": "u-coach", "tour_ranges": [("2026-01-03", "2026-01-05")]},
        user={"id": "u-coach", "category": "coach", "weekly_off": "sunday"},
    )
    assert bal["accrued"] == 1
    assert any(b["kind"] == "tour_weekly_off" for b in bal["breakdown"])


def test_executive_tour_accrues():
    """Updated 28 Jun 2026 — executives now accrue tour-day comp-off too."""
    bal = _run_case(
        seed_args={"user_id": "u-exec", "tour_ranges": [("2026-01-03", "2026-01-05")]},
        user={"id": "u-exec", "category": "executive", "weekly_off": "sunday"},
    )
    assert bal["accrued"] == 1
    assert any(b["kind"] == "tour_weekly_off" for b in bal["breakdown"])


def test_staff_tour_and_attendance_no_double_count():
    bal = _run_case(
        seed_args={
            "user_id": "u-staff",
            "tour_ranges": [("2026-01-04", "2026-01-04")],
            "attendance_dates": ["2026-01-04"],
        },
        user={"id": "u-staff", "category": "staff", "weekly_off": "sunday"},
    )
    # 1 from attendance branch; tour branch must skip the same date.
    assert bal["accrued"] == 1


def test_staff_overlapping_tours_dedup_dates():
    bal = _run_case(
        seed_args={"user_id": "u-staff", "tour_ranges": [
            ("2026-01-03", "2026-01-05"),
            ("2026-01-04", "2026-01-06"),
        ]},
        user={"id": "u-staff", "category": "staff", "weekly_off": "sunday"},
    )
    assert bal["accrued"] == 1


def test_staff_tour_uses_office_default_weekly_off():
    bal = _run_case(
        seed_args={"user_id": "u-staff-no-off", "tour_ranges": [("2026-01-04", "2026-01-04")]},
        user={"id": "u-staff-no-off", "category": "staff"},
        office_default="sunday",
    )
    assert bal["accrued"] == 1
    assert bal["weekly_off"] == "sunday"
    assert bal["weekly_off_source"] == "office_default"


def test_staff_pending_tour_does_not_accrue():
    bal = _run_case(
        seed_args={"user_id": "u-staff", "tour_ranges": [("2026-01-04", "2026-01-04")],
                   "tour_status": "pending"},
        user={"id": "u-staff", "category": "staff", "weekly_off": "sunday"},
    )
    assert bal["accrued"] == 0


def test_future_tour_sunday_does_not_accrue_yet():
    """Updated 28 Jun 2026 — a tour Sunday in the future must NOT pre-
    accrue. Only past-or-today weekly_off dates inside an approved tour
    contribute. Prevents members from drawing against credits they
    haven't yet earned."""
    future_year = str(date.today().year + 10)
    bal = _run_case(
        seed_args={"user_id": "u-staff",
                   "tour_ranges": [(f"{future_year}-01-04", f"{future_year}-01-04")]},
        user={"id": "u-staff", "category": "staff", "weekly_off": "sunday"},
        year=future_year,
    )
    assert bal["accrued"] == 0, f"future tour should NOT accrue, got {bal['accrued']}"


def test_admin_seeded_opening_accrues_immediately():
    """Updated 28 Jun 2026 — `comp_off_opening` on the user doc is added
    to the accrued total as a third source. Used by admins on Day-1 of
    a fresh deployment to carry forward last-year's unused credits."""
    bal = _run_case(
        seed_args={"user_id": "u-staff", "tour_ranges": []},
        user={"id": "u-staff", "category": "staff", "weekly_off": "sunday",
              "comp_off_opening": 3},
    )
    assert bal["accrued"] == 3
    kinds = [b["kind"] for b in bal["breakdown"]]
    assert "opening" in kinds


def test_opening_plus_tour_combine():
    """Opening + past tour Sunday combine cleanly into a single accrued total."""
    bal = _run_case(
        seed_args={"user_id": "u-staff",
                   "tour_ranges": [("2026-01-04", "2026-01-04")]},
        user={"id": "u-staff", "category": "staff", "weekly_off": "sunday",
              "comp_off_opening": 2},
    )
    # 2 opening + 1 from past tour Sunday = 3
    assert bal["accrued"] == 3


def test_opening_for_athlete_also_accrues():
    """Opening bypasses the athlete-excluded gate. If an admin grants
    an athlete a starting pool, the system honours it."""
    bal = _run_case(
        seed_args={"user_id": "u-ath", "tour_ranges": []},
        user={"id": "u-ath", "category": "athlete", "weekly_off": "sunday",
              "comp_off_opening": 4},
    )
    assert bal["accrued"] == 4
