"""Attendance one-row-per-day invariant + concurrent-check-in guard
(12 Oct 2026, review finding #1).

All check-in paths (self geo, console/card, muster, correction) reject a
second attendance row for the same (user_id, date). A unique index
`uniq_user_date` makes that race-proof. These tests verify the DB enforces
the invariant once the index is present, and that a sequential second
check-in is rejected at the API.

The index only builds on a DB with no pre-existing duplicate (user_id, date)
rows. If duplicates still exist (legacy / old races), the index-level test
SKIPS with a clear message pointing at scripts/dedupe_attendance.py.
"""
from __future__ import annotations

import os

import pytest


def _db():
    url, name = os.environ.get("MONGO_URL"), os.environ.get("DB_NAME")
    if not (url and name):
        return None
    from pymongo import MongoClient
    return MongoClient(url)[name]


def _has_uniq_index(db) -> bool:
    for ix in db.attendance.list_indexes():
        key = list(ix.get("key", {}).items())
        if ix.get("unique") and key == [("user_id", 1), ("date", 1)]:
            return True
    return False


def test_attendance_uniq_index_enforced_or_pending():
    """If the unique index is built, a duplicate (user_id, date) insert must
    raise DuplicateKeyError. If it's not built yet, say why (duplicates
    pending cleanup) instead of silently passing."""
    db = _db()
    if db is None:
        pytest.skip("MONGO_URL / DB_NAME not configured")
    if not _has_uniq_index(db):
        # Count the blockers so the skip message is actionable.
        dups = list(db.attendance.aggregate([
            {"$group": {"_id": {"u": "$user_id", "d": "$date"}, "n": {"$sum": 1}}},
            {"$match": {"n": {"$gt": 1}}},
        ]))
        pytest.skip(
            f"uniq_user_date index not built yet — {len(dups)} duplicate "
            "(user_id,date) group(s) remain. Run scripts/dedupe_attendance.py "
            "--apply then redeploy."
        )
    from pymongo.errors import DuplicateKeyError
    import uuid
    uid = f"pytest-dup-{uuid.uuid4().hex}"
    day = "2000-01-01"  # far-past throwaway date, never in real data
    db.attendance.insert_one({"id": str(uuid.uuid4()), "user_id": uid, "date": day})
    try:
        with pytest.raises(DuplicateKeyError):
            db.attendance.insert_one({"id": str(uuid.uuid4()), "user_id": uid, "date": day})
    finally:
        db.attendance.delete_many({"user_id": uid})


def test_second_checkin_same_day_rejected(base_url, make_member):
    """API-level: a member who already has an attendance row for today cannot
    create a second one via the console/card proxy path — it returns the
    ALREADY_CHECKED_IN_TODAY error. This is the user-visible invariant the
    unique index backstops."""
    import requests
    db = _db()
    if db is None:
        pytest.skip("MONGO_URL / DB_NAME not configured")
    # Throwaway staff member + an existing attendance row for today.
    m = make_member("staff")
    from datetime import datetime, timezone
    office = db.config.find_one({"id": "office"}) or {}
    # Compute office-local 'today' the same way the app does (Asia/Kolkata).
    import zoneinfo
    tz = zoneinfo.ZoneInfo(office.get("timezone") or "Asia/Kolkata")
    today = datetime.now(tz).date().isoformat()
    import uuid
    db.attendance.insert_one({
        "id": str(uuid.uuid4()), "user_id": m["id"], "date": today,
        "check_in_at": datetime.now(timezone.utc).isoformat(),
        "check_out_at": datetime.now(timezone.utc).isoformat(),  # completed
        "method": "test-seed",
    })
    try:
        admin = requests.post(f"{base_url}/api/auth/login",
                              json={"email": os.environ.get("TEST_ADMIN_EMAIL", "admin@attendance.app"),
                                    "password": os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345")},
                              timeout=30).json()["access_token"]
        r = requests.post(
            f"{base_url}/api/attendance/mark-member",
            headers={"Authorization": f"Bearer {admin}"},
            json={"member_id": m["id"],
                  "latitude": float(office.get("latitude") or 0),
                  "longitude": float(office.get("longitude") or 0)},
            timeout=30,
        )
        # The pre-check rejects a second same-day check-in (400
        # ALREADY_CHECKED_IN_TODAY). Whatever happens, there must still be
        # exactly one row for the day.
        assert r.status_code == 400 and "ALREADY_CHECKED_IN" in r.text, r.text
        rows = db.attendance.count_documents({"user_id": m["id"], "date": today})
        assert rows == 1, f"expected exactly 1 attendance row, found {rows}"
    finally:
        db.attendance.delete_many({"user_id": m["id"]})
