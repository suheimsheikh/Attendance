#!/usr/bin/env python3
"""Seed/cleanup rows for the focused Data Quality frontend check."""
from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

from pymongo import MongoClient


def load_env(path: Path) -> dict[str, str]:
    env = {}
    for line in path.read_text().splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.split("=", 1)
            env[k] = v.strip().strip('"').strip("'")
    return env


env = load_env(Path("/app/backend/.env"))
db = MongoClient(env["MONGO_URL"])[env["DB_NAME"]]
RUN_ID = "dq_frontend_marker"
USER_ID = f"{RUN_ID}_user"
MISSING_ID = f"{RUN_ID}_missing_member"
ZERO_ID = f"{RUN_ID}_zero_session"


def cleanup() -> None:
    db.attendance.delete_many({"id": ZERO_ID})
    db.users.delete_many({"id": {"$in": [USER_ID, MISSING_ID]}})


def seed() -> None:
    cleanup()
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    db.users.insert_one({
        "id": USER_ID,
        "email": f"{USER_ID}@example.test",
        "full_name": "DQ Frontend Test User",
        "role": "member",
        "category": "staff",
        "rank": "QA",
        "mobile": "9111111111",
        "joining_date": "2026-01-01",
        "weekly_off": "sunday",
        "institution": "QA",
        "fleet": "QA",
    })
    db.users.insert_one({
        "id": MISSING_ID,
        "email": f"{MISSING_ID}@example.test",
        "full_name": "DQ Frontend Missing Joining Date",
        "role": "member",
        "category": "staff",
        "rank": "QA",
        "mobile": "9222222222",
        "joining_date": "",
        "weekly_off": "sunday",
        "institution": "QA",
        "fleet": "QA",
    })
    db.attendance.insert_one({
        "id": ZERO_ID,
        "user_id": USER_ID,
        "user_name": "DQ Frontend Test User",
        "date": now[:10],
        "check_in_at": now,
        "check_out_at": now,
        "source": "dq_frontend_test",
    })


if __name__ == "__main__":
    if os.environ.get("DQ_CLEANUP") == "1":
        cleanup()
        print("cleaned")
    else:
        seed()
        print("seeded")