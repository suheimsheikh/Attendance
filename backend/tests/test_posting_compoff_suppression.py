"""R2 — Posting suppresses weekly-off comp-off accrual.

Unit-level companion to tests/test_posting_r2.py (which exercises the
HTTP layer). This file pokes holidays.compute_comp_off_balance directly
so we can assert the suppression rule on a fully-controlled DB state.

Spec: when a member is on an approved `posting` row, any attendance
record on a weekly_off date that falls inside the posting window MUST
NOT accrue a comp-off credit. Weekly-off attendance OUTSIDE the
posting window still accrues normally.
"""
import asyncio

import pytest
from motor.motor_asyncio import AsyncIOMotorClient

from holidays import compute_comp_off_balance


TEST_DB_NAME = "test_posting_suppresses_compoff"


async def _seed(db, user_id, attendance_dates, postings):
    await db.leaves.delete_many({})
    await db.attendance.delete_many({})
    for d in attendance_dates:
        await db.attendance.insert_one({
            "id": f"att-{d}", "user_id": user_id, "date": d,
            "check_in_at": f"{d}T09:00:00+00:00",
        })
    for i, (s, e) in enumerate(postings):
        await db.leaves.insert_one({
            "id": f"posting-{i}", "user_id": user_id,
            "type": "posting", "status": "approved",
            "start_date": s, "end_date": e,
        })


def _run(attendance_dates, postings, user, year="2026"):
    async def go():
        client = AsyncIOMotorClient("mongodb://localhost:27017")
        try:
            db = client[TEST_DB_NAME]
            await _seed(db, user["id"], attendance_dates, postings)
            return await compute_comp_off_balance(db, user, year=year)
        finally:
            client.close()
    return asyncio.run(go())


@pytest.fixture(scope="module", autouse=True)
def _cleanup():
    yield
    async def drop():
        client = AsyncIOMotorClient("mongodb://localhost:27017")
        try:
            await client.drop_database(TEST_DB_NAME)
        finally:
            client.close()
    asyncio.run(drop())


# 2026-01-04, -11, -18 are all Sundays. Anchor weekly_off=sunday.

def test_no_posting_baseline_accrues_normally():
    bal = _run(
        attendance_dates=["2026-01-04", "2026-01-11"],  # 2 Sundays
        postings=[],
        user={"id": "u-staff", "category": "staff", "weekly_off": "sunday"},
    )
    assert bal["accrued"] == 2


def test_posting_window_suppresses_weekly_off_accrual():
    """Posting covers Jan 04 (Sun). That date must NOT accrue, even though
    the member checked in. Jan 11 (Sun) is OUTSIDE the posting window
    and still earns a credit."""
    bal = _run(
        attendance_dates=["2026-01-04", "2026-01-11"],
        postings=[("2026-01-01", "2026-01-08")],
        user={"id": "u-staff", "category": "staff", "weekly_off": "sunday"},
    )
    assert bal["accrued"] == 1, \
        f"only the Sunday OUTSIDE the posting should accrue; got {bal['accrued']}"


def test_posting_window_suppresses_all_weekly_offs_inside():
    """Two Sundays both fall inside a long posting → zero accrual."""
    bal = _run(
        attendance_dates=["2026-01-04", "2026-01-11"],
        postings=[("2026-01-01", "2026-01-31")],
        user={"id": "u-staff", "category": "staff", "weekly_off": "sunday"},
    )
    assert bal["accrued"] == 0


def test_posting_does_not_block_unrelated_weekly_off():
    """A short posting in March must not retroactively suppress a Sunday
    in January."""
    bal = _run(
        attendance_dates=["2026-01-04"],
        postings=[("2026-03-01", "2026-03-15")],
        user={"id": "u-staff", "category": "staff", "weekly_off": "sunday"},
    )
    assert bal["accrued"] == 1


def test_posting_must_be_approved_to_suppress():
    """A pending/rejected posting row MUST NOT suppress accrual — only an
    approved deputation flips the rule."""
    import asyncio
    async def go():
        client = AsyncIOMotorClient("mongodb://localhost:27017")
        try:
            db = client[TEST_DB_NAME]
            await db.leaves.delete_many({})
            await db.attendance.delete_many({})
            user_id = "u-staff"
            await db.attendance.insert_one({
                "id": "att-x", "user_id": user_id, "date": "2026-01-04",
                "check_in_at": "2026-01-04T09:00:00+00:00",
            })
            await db.leaves.insert_one({
                "id": "p-pending", "user_id": user_id,
                "type": "posting", "status": "pending",
                "start_date": "2026-01-01", "end_date": "2026-01-08",
            })
            return await compute_comp_off_balance(
                db,
                {"id": user_id, "category": "staff", "weekly_off": "sunday"},
                year="2026",
            )
        finally:
            client.close()
    bal = asyncio.run(go())
    assert bal["accrued"] == 1, \
        f"pending posting must not suppress accrual; got {bal['accrued']}"
