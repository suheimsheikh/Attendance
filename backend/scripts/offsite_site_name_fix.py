"""One-off: attendance rows checked in/out OUTSIDE every geofence used to be
stamped with the NEAREST site's name (e.g. "Rowing Academy" for a check-in
4.5 km away). Re-stamp them as the "Off-site" bucket and keep the nearest
name in `nearest_site_name` so "X m from …" copy still works.

Run once on production after deploying (idempotent):
    cd /app/backend && python scripts/offsite_site_name_fix.py
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from dotenv import load_dotenv  # noqa: E402
from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))


async def main():
    db = AsyncIOMotorClient(os.environ["MONGO_URL"])[os.environ["DB_NAME"]]
    q_in = {"out_of_geofence": True, "site_name": {"$nin": [None, "Off-site"]}}
    n_in = 0
    async for r in db.attendance.find(q_in, {"_id": 0, "id": 1, "site_name": 1}):
        await db.attendance.update_one({"id": r["id"]}, {"$set": {
            "nearest_site_name": r["site_name"], "site_name": "Off-site", "site_id": "offsite"}})
        n_in += 1
    q_out = {"exit_out_of_geofence": True, "exit_site_name": {"$nin": [None, "Off-site"]}}
    n_out = 0
    async for r in db.attendance.find(q_out, {"_id": 0, "id": 1, "exit_site_name": 1}):
        await db.attendance.update_one({"id": r["id"]}, {"$set": {
            "exit_nearest_site_name": r["exit_site_name"], "exit_site_name": "Off-site", "exit_site_id": "offsite"}})
        n_out += 1
    print(f"re-stamped {n_in} off-site check-ins and {n_out} off-site check-outs")


if __name__ == "__main__":
    asyncio.run(main())
