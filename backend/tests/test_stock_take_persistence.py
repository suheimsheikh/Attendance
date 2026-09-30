"""
Regression tests for the Sep–Oct 2026 Stock-Take + purchase-guard fixes.

Locks in behaviours that previously regressed:
  1. A physical count that equals system on-hand (ZERO variance) must still
     persist as a recorded line (qty 0) — it used to be silently dropped.
  2. A first-count with a ₹/unit rate (OPENING path) must persist a recorded
     marker line (qty 0) in meal_adjustments AND set the item's opening_stock
     — the marker used to be missing so the count vanished on reload.
  3. /meals/stock-take/report excludes qty==0 lines from the ranked
     losses/extras rows + totals, but still lists them in `history`.
  4. /meals/stock-take/list summarises every saved take.
  5. Purchases reject a qty with ₹0 rate (PUT), accept a priced line.
  6. Concurrent saves of the SAME item/date leave exactly ONE line (the
     atomic $set / $ne-push dedup + unique `date` index).

All writes use throwaway PAST dates + freshly created test items and are
cleaned up via the mongo_db fixture, so live pantry data is untouched.
"""
import os
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
import requests

DZ_ZERO = "2019-03-01"
DZ_OPEN = "2019-03-02"
DZ_CONC = "2019-03-03"
DZ_PURCH = "2019-03-05"
_THROWAWAY_DATES = [DZ_ZERO, DZ_OPEN, DZ_CONC, DZ_PURCH]


@pytest.fixture()
def stock_item(admin_client, base_url):
    """A fresh active pantry item (no cost history) for one test."""
    cats = admin_client.get(f"{base_url}/api/meals/purchase-categories", timeout=30).json().get("categories", [])
    if cats:
        cat_key = cats[0]["key"]
    else:
        rc = admin_client.post(f"{base_url}/api/meals/purchase-categories",
                               json={"label": f"STK-Cat-{uuid.uuid4().hex[:6]}"}, timeout=30)
        rc.raise_for_status()
        cat_key = rc.json()["key"]
    ri = admin_client.post(f"{base_url}/api/meals/items",
                           json={"name": f"STK-Item-{uuid.uuid4().hex[:6]}",
                                 "unit": "kg", "category_key": cat_key}, timeout=30)
    ri.raise_for_status()
    item = ri.json()
    yield item


@pytest.fixture(autouse=True)
def _cleanup(mongo_db):
    """Drop throwaway-date docs + STK test items before and after each test."""
    def wipe():
        if mongo_db is None:
            return
        for coll in ("meal_adjustments", "meal_purchases", "meal_issues", "meal_wastage"):
            mongo_db[coll].delete_many({"date": {"$in": _THROWAWAY_DATES}})
        mongo_db.meal_items.delete_many({"name": {"$regex": "^STK-Item-"}})
    wipe()
    yield
    wipe()


def _row(admin_client, base_url, date, item_id):
    r = admin_client.get(f"{base_url}/api/meals/stock-take?date={date}", timeout=30)
    r.raise_for_status()
    for row in r.json().get("rows", []):
        if row["item_id"] == item_id:
            return row
    return None


def test_zero_variance_count_persists(admin_client, base_url, stock_item):
    iid = stock_item["id"]
    # New item → system on-hand is 0; counting 0 is a zero-variance count.
    r = admin_client.post(f"{base_url}/api/meals/stock-take",
                          json={"date": DZ_ZERO, "lines": [{"item_id": iid, "physical_qty": 0}]},
                          timeout=30)
    assert r.status_code == 200, r.text
    assert r.json()["counted"] == 1
    row = _row(admin_client, base_url, DZ_ZERO, iid)
    assert row is not None and row["recorded"] is True, "zero-variance count must persist"
    assert row["physical_qty"] == 0 or row["physical_qty"] == pytest.approx(0.0)


def test_opening_count_with_rate_persists(admin_client, base_url, stock_item):
    iid = stock_item["id"]
    r = admin_client.post(f"{base_url}/api/meals/stock-take",
                          json={"date": DZ_OPEN, "lines": [{"item_id": iid, "physical_qty": 10, "rate": 25}]},
                          timeout=30)
    assert r.status_code == 200, r.text
    assert r.json()["opening_set"] == 1
    row = _row(admin_client, base_url, DZ_OPEN, iid)
    assert row is not None and row["recorded"] is True, "opening count must be recorded (not vanish)"
    assert row["physical_qty"] == pytest.approx(10.0)


def test_report_excludes_zero_but_lists_history(admin_client, base_url, stock_item):
    iid = stock_item["id"]
    admin_client.post(f"{base_url}/api/meals/stock-take",
                      json={"date": DZ_ZERO, "lines": [{"item_id": iid, "physical_qty": 0}]},
                      timeout=30).raise_for_status()
    r = admin_client.get(f"{base_url}/api/meals/stock-take/report?start={DZ_ZERO}&end={DZ_ZERO}", timeout=30)
    r.raise_for_status()
    data = r.json()
    assert not any(row["item_id"] == iid for row in data["rows"]), "qty=0 must not be a ranked variance row"
    assert any(h["item_id"] == iid for h in data["history"]), "qty=0 must still appear in history"


def test_stock_take_list_summarises(admin_client, base_url, stock_item):
    iid = stock_item["id"]
    admin_client.post(f"{base_url}/api/meals/stock-take",
                      json={"date": DZ_OPEN, "lines": [{"item_id": iid, "physical_qty": 10, "rate": 25}]},
                      timeout=30).raise_for_status()
    r = admin_client.get(f"{base_url}/api/meals/stock-take/list", timeout=30)
    r.raise_for_status()
    entry = next((t for t in r.json()["takes"] if t["date"] == DZ_OPEN), None)
    assert entry is not None, "saved take must appear in the list"
    assert entry["counted"] >= 1


def test_purchase_rejects_zero_rate(admin_client, base_url, stock_item):
    iid = stock_item["id"]
    bad = admin_client.put(f"{base_url}/api/meals/purchases/{DZ_PURCH}",
                           json={"lines": [{"item_id": iid, "qty": 5, "rate": 0}]}, timeout=30)
    assert bad.status_code == 400, bad.text
    good = admin_client.put(f"{base_url}/api/meals/purchases/{DZ_PURCH}",
                            json={"lines": [{"item_id": iid, "qty": 5, "rate": 12.5}]}, timeout=30)
    assert good.status_code == 200, good.text


def test_concurrent_same_item_saves_dedupe(admin_client, base_url, stock_item, admin_token, mongo_db):
    if mongo_db is None:
        pytest.skip("mongo_db fixture unavailable")
    iid = stock_item["id"]
    headers = {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}

    def save(p):
        return requests.post(f"{base_url}/api/meals/stock-take",
                             json={"date": DZ_CONC, "lines": [{"item_id": iid, "physical_qty": p}]},
                             headers=headers, timeout=30).status_code

    with ThreadPoolExecutor(max_workers=8) as ex:
        list(ex.map(save, [1, 2, 3, 4, 5, 6, 7, 8]))

    doc = mongo_db.meal_adjustments.find_one({"date": DZ_CONC})
    lines = [l for l in (doc or {}).get("lines", []) if l["item_id"] == iid]
    assert len(lines) == 1, f"concurrent same-item saves must leave exactly 1 line, got {len(lines)}"


def test_stock_take_requires_auth(base_url):
    r = requests.post(f"{base_url}/api/meals/stock-take",
                      json={"date": DZ_ZERO, "lines": []}, timeout=30)
    assert r.status_code in (401, 403)
