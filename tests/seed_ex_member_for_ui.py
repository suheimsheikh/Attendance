#!/usr/bin/env python3
"""Seed one ex-member for focused UI verification. Run with 'restore' to undo."""
import os
import sys
import json
import asyncio
from pathlib import Path

import requests
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

BACKEND_URL = os.environ.get("TEST_BACKEND_URL", "https://attendance-portal-56.preview.emergentagent.com").rstrip("/")
API = f"{BACKEND_URL}/api"
STATE_PATH = Path("/app/test_reports/ex_member_ui_seed_state.json")
ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / "backend" / ".env")
MONGO_URL = os.environ["MONGO_URL"].strip('"')
DB_NAME = os.environ.get("DB_NAME", "test_database").strip('"')


def req(method, path, token=None, **kwargs):
    headers = kwargs.pop("headers", {})
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return requests.request(method, f"{API}{path}", headers=headers, timeout=25, **kwargs)


async def main():
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    login = req("POST", "/auth/login", json={"email": "admin@attendance.app", "password": "Admin@12345"})
    assert login.status_code == 200, login.text[:200]
    token = login.json()["access_token"]
    try:
        if len(sys.argv) > 1 and sys.argv[1] == "restore":
            state = json.loads(STATE_PATH.read_text())
            resp = req("PATCH", f"/members/{state['member_id']}", token, json={"leaving_date": state.get("orig_leaving_date")})
            print(json.dumps({"restored": resp.status_code == 200, **state}))
            return 0 if resp.status_code == 200 else 2

        member = await db.users.find_one({"role": "member"}, {"_id": 0, "id": 1, "full_name": 1, "leaving_date": 1})
        assert member, "no member found"
        state = {"member_id": member["id"], "full_name": member["full_name"], "orig_leaving_date": member.get("leaving_date")}
        STATE_PATH.write_text(json.dumps(state, indent=2))
        resp = req("PATCH", f"/members/{member['id']}", token, json={"leaving_date": "2020-01-01"})
        print(json.dumps({"seeded": resp.status_code == 200, "patch_status": resp.status_code, **state}, indent=2))
        return 0 if resp.status_code == 200 else 2
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))