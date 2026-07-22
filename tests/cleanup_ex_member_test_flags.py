#!/usr/bin/env python3
"""Cleanup helper for QA rows touched by verify_ex_member_backend.py."""
import os
import asyncio
import json
from pathlib import Path

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / "backend" / ".env")


async def main():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"].strip('"'))
    db = client[os.environ.get("DB_NAME", "test_database").strip('"')]
    flagged = await db.attendance.count_documents({"qa_closed_for_ex_test": True})
    if flagged:
        res = await db.attendance.update_many(
            {"qa_closed_for_ex_test": True},
            {"$set": {"check_out_at": None}, "$unset": {"qa_closed_for_ex_test": ""}},
        )
    else:
        res = None
    remaining_devices = await db.devices.count_documents({"device_id": {"$regex": "^qa-device-"}})
    remaining_seed_rows = await db.attendance.count_documents({"id": {"$regex": "^qa-ex-preserve-att-"}})
    remaining_seed_leaves = await db.leaves.count_documents({"id": {"$regex": "^qa-ex-preserve-leave-"}})
    print(json.dumps({
        "flagged_open_sessions_restored": flagged,
        "modified": getattr(res, "modified_count", 0) if res else 0,
        "remaining_qa_devices": remaining_devices,
        "remaining_qa_attendance_rows": remaining_seed_rows,
        "remaining_qa_leave_rows": remaining_seed_leaves,
    }, indent=2))
    client.close()


if __name__ == "__main__":
    asyncio.run(main())