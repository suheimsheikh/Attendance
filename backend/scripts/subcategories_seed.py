"""One-time sub-category migration helpers.

Workflow to carry your PREVIEW sub-category setup into PRODUCTION:

  1. In preview, configure sub-categories + assign items (Stock Master UI).
  2. Export the current setup to a committed JSON file:
         python backend/scripts/subcategories_seed.py export
  3. Commit backend/data/subcategories_seed.json and deploy.
  4. On production (or any env), apply it idempotently:
         python backend/scripts/subcategories_seed.py seed

`seed` is safe to run repeatedly: it creates only missing sub-categories and
assigns an item to a sub-category only when the item currently has none.
Matching is by (category_key, sub-category name) and (category_key, item name),
so it works across databases that don't share IDs.
"""
import asyncio
import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

BASE = Path(__file__).resolve().parent.parent
load_dotenv(BASE / ".env")
SEED_FILE = BASE / "data" / "subcategories_seed.json"


def _norm(s: str) -> str:
    import re
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def _slug(s: str) -> str:
    import re
    return re.sub(r"[^a-z0-9]+", "-", (s or "").strip().lower()).strip("-") or "grp"


def _db():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    return client[os.environ["DB_NAME"]]


async def export_setup() -> dict:
    db = _db()
    subs = await db.meal_subcategories.find({"active": {"$ne": False}}, {"_id": 0}).to_list(1000)
    id_to_name = {}
    items = await db.meal_items.find({}, {"_id": 0, "name": 1, "category_key": 1, "subcategory_key": 1}).to_list(5000)
    groups = []
    by_key = {}
    for s in subs:
        entry = {"category_key": s["category_key"], "name": s["name"], "items": []}
        by_key[(s["category_key"], s["key"])] = entry
        groups.append(entry)
    for it in items:
        sk = it.get("subcategory_key")
        if sk and (it["category_key"], sk) in by_key:
            by_key[(it["category_key"], sk)]["items"].append(it["name"])
    payload = {"exported_at": datetime.now(timezone.utc).isoformat(), "groups": groups}
    SEED_FILE.parent.mkdir(parents=True, exist_ok=True)
    SEED_FILE.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    print(f"Exported {len(groups)} sub-categories to {SEED_FILE}")
    return payload


async def seed_setup() -> None:
    if not SEED_FILE.exists():
        print(f"No seed file at {SEED_FILE} — nothing to do.")
        return
    payload = json.loads(SEED_FILE.read_text())
    db = _db()
    created, assigned = 0, 0
    for g in payload.get("groups", []):
        ck, name = g["category_key"], g["name"]
        key = _slug(name)
        existing = await db.meal_subcategories.find_one({"category_key": ck, "key": key})
        if not existing:
            n = await db.meal_subcategories.count_documents({"category_key": ck})
            await db.meal_subcategories.insert_one({
                "id": str(uuid.uuid4()), "category_key": ck, "key": key, "name": name,
                "order": n, "active": True, "created_at": datetime.now(timezone.utc).isoformat()})
            created += 1
        elif existing.get("active") is False:
            await db.meal_subcategories.update_one({"id": existing["id"]}, {"$set": {"active": True}})
        for item_name in g.get("items", []):
            res = await db.meal_items.update_one(
                {"category_key": ck, "name_norm": _norm(item_name),
                 "$or": [{"subcategory_key": None}, {"subcategory_key": {"$exists": False}}]},
                {"$set": {"subcategory_key": key}})
            assigned += res.modified_count
    print(f"Seed complete: {created} sub-categories created, {assigned} items assigned.")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "seed"
    if cmd == "export":
        asyncio.run(export_setup())
    elif cmd == "seed":
        asyncio.run(seed_setup())
    else:
        print("Usage: python backend/scripts/subcategories_seed.py [export|seed]")


if __name__ == "__main__":
    main()
