#!/usr/bin/env python3
"""Focused API check: /presence must emit leaving_date for ex-member UI filtering."""
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
    token = None
    member = None
    orig_lv = None
    try:
        login = req("POST", "/auth/login", json={"email": "admin@attendance.app", "password": "Admin@12345"})
        assert login.status_code == 200, f"admin login failed {login.status_code}: {login.text[:200]}"
        token = login.json()["access_token"]
        member = await db.users.find_one({"role": "member"}, {"_id": 0, "id": 1, "full_name": 1, "leaving_date": 1})
        assert member, "no member found"
        orig_lv = member.get("leaving_date")
        patch = req("PATCH", f"/members/{member['id']}", token, json={"leaving_date": "2020-01-01"})
        assert patch.status_code == 200, f"patch failed {patch.status_code}: {patch.text[:200]}"
        pres = req("GET", "/presence", token)
        assert pres.status_code == 200, f"presence failed {pres.status_code}: {pres.text[:200]}"
        row = next((m for m in pres.json().get("members", []) if m.get("id") == member["id"]), None)
        ok = bool(row and row.get("leaving_date") == "2020-01-01")
        print(json.dumps({
            "ok": ok,
            "member_id": member["id"],
            "member_name": member.get("full_name"),
            "expected_leaving_date": "2020-01-01",
            "presence_row_found": row is not None,
            "presence_row_leaving_date": row.get("leaving_date") if row else None,
            "presence_row_keys": sorted(row.keys()) if row else [],
        }, indent=2))
        return 0 if ok else 2
    finally:
        if token and member:
            req("PATCH", f"/members/{member['id']}", token, json={"leaving_date": orig_lv})
        client.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))