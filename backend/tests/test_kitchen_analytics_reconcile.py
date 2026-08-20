"""Regression: Kitchen Analytics + Item-wise Expense-Report must reconcile
with bulk-uploaded (legacy) `amounts`-only purchase docs.

Before the 26 Feb 2026 fix, `GET /api/meals/kitchen-analytics` and the new
`item_purchases_total` on `GET /api/meals/expense-report` only summed
per-item `lines`. Any purchase doc entered via CSV/XLSX bulk-upload (or
the legacy category-totals `amounts` map) was silently invisible on the
Analytics dashboard, so the "Purchases total" there did not agree with
the Expense-report's grand total on the same window.

This test seeds two purchase docs on adjacent dates:
  • an item-lined doc (modern per-item entry)
  • an amounts-only doc (legacy bulk-upload)
and asserts:
  • kitchen-analytics `total_amount` == expense-report `totals.expenses`
  • kitchen-analytics `itemised_amount + unitemised_amount == total_amount`
  • expense-report `item_purchases_total + unitemised_purchases_amount
    == totals.expenses`
"""
from __future__ import annotations

import asyncio
import os
import sys
import uuid

import httpx
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture
def base_url():
    return os.environ.get("API_BASE_URL") or "http://localhost:8001"


@pytest.fixture
def admin_token(base_url):
    r = httpx.post(
        f"{base_url}/api/auth/login",
        json={
            "email": "admin@attendance.app",
            "password": os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345"),
        },
        timeout=15,
    )
    r.raise_for_status()
    tok = r.json().get("access_token") or r.json().get("token")
    assert tok, "no admin token"
    return tok


@pytest.fixture
def seeded_docs(base_url):
    """Insert one lined + one amounts-only purchase doc on two unused dates.
    Yields (lined_date, unlined_date, item_id, item_rate, item_qty,
    unlined_amounts_total) and deletes both docs on teardown."""
    from motor.motor_asyncio import AsyncIOMotorClient  # local import
    from dotenv import load_dotenv
    load_dotenv("/app/backend/.env")

    async def _seed():
        c = AsyncIOMotorClient(os.environ["MONGO_URL"])
        db = c[os.environ["DB_NAME"]]
        # Pick a far-future window that shouldn't collide with real data.
        lined_date = "2030-01-15"
        unlined_date = "2030-01-16"
        await db.meal_purchases.delete_many(
            {"date": {"$in": [lined_date, unlined_date]}}
        )
        # Grab any active item to attach a line to.
        item = await db.meal_items.find_one({"active": True}, {"_id": 0})
        assert item, "need at least one meal item in the db"
        line_qty, line_rate = 2.0, 100.0
        line_amt = line_qty * line_rate
        await db.meal_purchases.insert_one({
            "id": str(uuid.uuid4()),
            "date": lined_date,
            "lines": [{
                "id": str(uuid.uuid4()),
                "item_id": item["id"],
                "item_name": item.get("name"),
                "category_key": item.get("category_key"),
                "qty": line_qty,
                "unit": item.get("unit"),
                "rate": line_rate,
                "amount": line_amt,
            }],
            "amounts": {item.get("category_key") or "grocery": line_amt},
        })
        # Amounts-only doc mimicking a bulk-upload.
        unlined_amounts = {"grocery": 500.0, "vegetables": 250.0}
        await db.meal_purchases.insert_one({
            "id": str(uuid.uuid4()),
            "date": unlined_date,
            "amounts": unlined_amounts,
            # no `lines` key — matches the legacy upsert_purchase path
        })
        return lined_date, unlined_date, item["id"], line_amt, sum(unlined_amounts.values())

    lined_date, unlined_date, item_id, itemised, unlined_amt = asyncio.run(_seed())
    yield lined_date, unlined_date, item_id, itemised, unlined_amt

    async def _teardown():
        c = AsyncIOMotorClient(os.environ["MONGO_URL"])
        db = c[os.environ["DB_NAME"]]
        await db.meal_purchases.delete_many(
            {"date": {"$in": [lined_date, unlined_date]}}
        )
    asyncio.run(_teardown())


def test_analytics_reconciles_with_bulk_upload(base_url, admin_token, seeded_docs):
    lined_date, unlined_date, _iid, itemised, unlined_amt = seeded_docs
    headers = {"Authorization": f"Bearer {admin_token}"}

    r = httpx.get(
        f"{base_url}/api/meals/kitchen-analytics",
        params={"start": lined_date, "end": unlined_date},
        headers=headers,
        timeout=10,
    )
    assert r.status_code == 200, r.text
    p = r.json()["purchases"]
    # Truth == sum of both docs.
    expected_total = round(itemised + unlined_amt, 2)
    assert p["total_amount"] == expected_total, (p["total_amount"], expected_total)
    assert p["itemised_amount"] == round(itemised, 2)
    assert p["unitemised_amount"] == round(unlined_amt, 2)
    # Daily trend matches truth.
    daily_sum = round(sum(d["amount"] for d in p["daily"]), 2)
    assert daily_sum == expected_total, (daily_sum, expected_total)
    # Category share drawn from `amounts` so bulk-uploaded rupees show up.
    cats_sum = round(sum(c["amount"] for c in p["category_totals"]), 2)
    assert cats_sum == expected_total, (cats_sum, expected_total)


def test_expense_report_item_breakdown_reconciles(base_url, admin_token, seeded_docs):
    lined_date, unlined_date, _iid, itemised, unlined_amt = seeded_docs
    headers = {"Authorization": f"Bearer {admin_token}"}

    r = httpx.get(
        f"{base_url}/api/meals/expense-report",
        params={"start": lined_date, "end": unlined_date},
        headers=headers,
        timeout=10,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    expected_total = round(itemised + unlined_amt, 2)
    assert body["totals"]["expenses"] == expected_total
    assert body["item_purchases_total"] == round(itemised, 2)
    assert body["unitemised_purchases_amount"] == round(unlined_amt, 2)
    # Sum reconciles.
    assert (
        round(body["item_purchases_total"] + body["unitemised_purchases_amount"], 2)
        == expected_total
    )
    # And item_purchases has the seeded item.
    assert any(r["amount"] == round(itemised, 2) for r in body["item_purchases"])
