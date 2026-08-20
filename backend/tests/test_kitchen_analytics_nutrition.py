"""Regression: Kitchen Analytics nutrition rollup (Feb 2026).

Ensures:
  • Built-in nutrition lookup fires for well-known items (rice, oil).
  • Per-item `nutrition` override on `meal_items` wins over the lookup.
  • Coverage % reports items without any nutrition data.
  • Kcal / macro / kcal-pie totals reconcile.
"""
import os
import uuid
import asyncio
import pytest
import httpx


API_URL = os.environ.get("API_BASE_URL") or "http://localhost:8001"


@pytest.fixture
def admin_token():
    r = httpx.post(
        f"{API_URL}/api/auth/login",
        json={
            "email": "admin@attendance.app",
            "password": os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345"),
        },
        timeout=15,
    )
    r.raise_for_status()
    return r.json()["access_token"]


@pytest.fixture
def hdr(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture
def seeded():
    """Seed three items + purchase docs on a far-future date so the
    nutrition roll-up numbers are entirely under our control."""
    from motor.motor_asyncio import AsyncIOMotorClient
    from dotenv import load_dotenv
    load_dotenv("/app/backend/.env")

    async def _seed():
        c = AsyncIOMotorClient(os.environ["MONGO_URL"])
        db = c[os.environ["DB_NAME"]]
        # A unique category to avoid clashing with production data.
        cat_key = f"pytest_nut_{uuid.uuid4().hex[:6]}"
        # Ensure category exists.
        cfg = await db.config.find_one({"id": "meal_purchase_categories"}, {"_id": 0}) or {}
        existing = cfg.get("categories") or []
        if not any(c["key"] == cat_key for c in existing):
            existing.append({"key": cat_key, "label": "Pytest Nutrition", "active": True})
            await db.config.update_one(
                {"id": "meal_purchase_categories"},
                {"$set": {"id": "meal_purchase_categories", "categories": existing}},
                upsert=True,
            )
        # 3 items: rice (seed-lookup), oil (seed-lookup), gizmo (custom
        # override in kg with explicit macros).
        items = [
            {"id": str(uuid.uuid4()), "name": f"PYTEST Rice {uuid.uuid4().hex[:4]}",
             "category_key": cat_key, "unit": "kg", "active": True, "sort_order": 100},
            {"id": str(uuid.uuid4()), "name": f"PYTEST Oil {uuid.uuid4().hex[:4]}",
             "category_key": cat_key, "unit": "L", "active": True, "sort_order": 101},
            {"id": str(uuid.uuid4()), "name": f"PYTEST Gizmo {uuid.uuid4().hex[:4]}",
             "category_key": cat_key, "unit": "kg", "active": True, "sort_order": 102,
             "nutrition": {"kcal": 500, "protein_g": 10, "carbs_g": 60, "fat_g": 20, "fibre_g": 5}},
        ]
        await db.meal_items.insert_many(items)
        # Purchase doc: 2 kg rice + 1 L oil + 0.5 kg gizmo
        d = "2030-02-01"
        await db.meal_purchases.delete_many({"date": d})
        await db.meal_purchases.insert_one({
            "id": str(uuid.uuid4()),
            "date": d,
            "lines": [
                {"id": str(uuid.uuid4()), "item_id": items[0]["id"], "qty": 2.0, "rate": 50, "amount": 100,
                 "unit": "kg", "category_key": cat_key, "item_name": items[0]["name"]},
                {"id": str(uuid.uuid4()), "item_id": items[1]["id"], "qty": 1.0, "rate": 150, "amount": 150,
                 "unit": "L", "category_key": cat_key, "item_name": items[1]["name"]},
                {"id": str(uuid.uuid4()), "item_id": items[2]["id"], "qty": 0.5, "rate": 200, "amount": 100,
                 "unit": "kg", "category_key": cat_key, "item_name": items[2]["name"]},
            ],
            "amounts": {cat_key: 350.0},
        })
        return d, cat_key, items

    d, cat_key, items = asyncio.run(_seed())
    yield d, cat_key, items

    async def _teardown():
        c = AsyncIOMotorClient(os.environ["MONGO_URL"])
        db = c[os.environ["DB_NAME"]]
        await db.meal_purchases.delete_many({"date": d})
        await db.meal_items.delete_many({"id": {"$in": [i["id"] for i in items]}})
        # Remove the pytest category we added.
        cfg = await db.config.find_one({"id": "meal_purchase_categories"}, {"_id": 0}) or {}
        cats = [c for c in (cfg.get("categories") or []) if c.get("key") != cat_key]
        await db.config.update_one(
            {"id": "meal_purchase_categories"},
            {"$set": {"categories": cats}},
        )
    asyncio.run(_teardown())


def test_nutrition_rollup_seed_and_override(hdr, seeded):
    d, _cat, items = seeded
    r = httpx.get(
        f"{API_URL}/api/meals/kitchen-analytics",
        params={"start": d, "end": d}, headers=hdr, timeout=15,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    nut = body["purchases"]["nutrition"]

    # 2 kg rice = 2000 g → per-100g scaling factor = 20
    # rice per 100 g in seed: kcal=355, protein=7, carbs=78, fat=1, fibre=1
    # oil (1 L = 1000 g at density 1): kcal=884, fat=100 per 100 g → 8840 kcal, 1000 g fat
    # gizmo override (0.5 kg = 500 g → factor=5): kcal=2500, protein=50, carbs=300, fat=100, fibre=25
    expected_kcal = round(355 * 20 + 884 * 10 + 500 * 5, 0)
    assert nut["kcal_total"] == expected_kcal, (nut["kcal_total"], expected_kcal)

    # top by kcal should have all 3 seeded items
    kcal_by_name = {r["name"]: r["kcal"] for r in nut["top_by_kcal"]}
    assert kcal_by_name.get(items[1]["name"]) == 8840, kcal_by_name   # oil
    assert kcal_by_name.get(items[2]["name"]) == 2500, kcal_by_name   # gizmo override
    assert kcal_by_name.get(items[0]["name"]) == 7100, kcal_by_name   # rice

    # Coverage: 3/3 items had nutrition
    assert nut["coverage"]["items_covered"] == 3
    assert nut["coverage"]["items_total"] == 3
    assert nut["coverage"]["qty_pct"] == 100.0

    # Macro pie percentages sum to ~100
    total_pct = sum(m["pct"] for m in nut["macro_grams"])
    assert abs(total_pct - 100.0) < 0.5


def test_analytics_still_reconciles_with_nutrition(hdr, seeded):
    d, _cat, _items = seeded
    r = httpx.get(
        f"{API_URL}/api/meals/kitchen-analytics",
        params={"start": d, "end": d}, headers=hdr, timeout=15,
    )
    p = r.json()["purchases"]
    # Item-level itemised + unitemised still equals total_amount from
    # amounts map (350 in the seed).
    assert p["itemised_amount"] == 350.0
    assert p["unitemised_amount"] == 0.0
    assert p["total_amount"] == 350.0
