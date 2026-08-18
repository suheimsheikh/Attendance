"""Iter41 — Pantry Stock new features:
 * min_stock on items (create/update + validation)
 * GET /api/meals/stock rows include min_stock + low, top-level low_count
 * GET /api/meals/items/{id}/ledger — merged events + totals + on_hand
 * GET /api/meals/categories/{key}/summary — per-item totals + spend

Existing live items are NOT modified destructively — we snapshot Rice's
min_stock and restore at end of the module. TEST_ items are cleaned up.
"""
from __future__ import annotations
import uuid
import pytest
import requests
from datetime import date


# ---------- helpers ----------
@pytest.fixture(scope="module")
def rice_item(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/meals/items",
                         params={"category_key": "grocery"}, timeout=30)
    assert r.status_code == 200, r.text
    rice = next((it for it in r.json()["items"] if it["name"].lower() == "rice"), None)
    assert rice is not None, "Rice item missing from grocery — seed expected"
    return rice


@pytest.fixture(scope="module")
def chef_client(admin_client, base_url):
    email = f"chef-iter41-{uuid.uuid4().hex[:6]}@meals.example.com"
    body = {"email": email, "password": "Chef@12345",
            "full_name": "TEST Chef Iter41", "role": "chef", "category": "staff"}
    r = admin_client.post(f"{base_url}/api/members", json=body, timeout=30)
    assert r.status_code == 200, r.text
    lr = requests.post(f"{base_url}/api/auth/login",
                       json={"email": email, "password": "Chef@12345"}, timeout=30)
    assert lr.status_code == 200
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {lr.json()['access_token']}",
                      "Content-Type": "application/json"})
    yield s


# ---------- min_stock create/update/validation ----------
class TestMinStockField:
    def test_create_item_with_min_stock(self, admin_client, base_url):
        body = {"category_key": "grocery",
                "name": f"TEST_Min_{uuid.uuid4().hex[:6]}",
                "unit": "kg", "opening_stock": 5, "min_stock": 3}
        r = admin_client.post(f"{base_url}/api/meals/items", json=body, timeout=30)
        assert r.status_code == 200, r.text
        it = r.json()
        assert float(it["min_stock"]) == 3.0
        # cleanup
        admin_client.delete(f"{base_url}/api/meals/items/{it['id']}", timeout=30)

    def test_create_item_negative_min_stock_rejected(self, admin_client, base_url):
        body = {"category_key": "grocery",
                "name": f"TEST_NegMin_{uuid.uuid4().hex[:6]}",
                "unit": "kg", "opening_stock": 0, "min_stock": -1}
        r = admin_client.post(f"{base_url}/api/meals/items", json=body, timeout=30)
        assert r.status_code == 400, r.text

    def test_patch_min_stock(self, admin_client, base_url):
        body = {"category_key": "grocery",
                "name": f"TEST_PatchMin_{uuid.uuid4().hex[:6]}",
                "unit": "kg", "opening_stock": 0}
        it = admin_client.post(f"{base_url}/api/meals/items", json=body, timeout=30).json()
        try:
            r = admin_client.patch(f"{base_url}/api/meals/items/{it['id']}",
                                   json={"min_stock": 7.5}, timeout=30)
            assert r.status_code == 200, r.text
            assert float(r.json()["min_stock"]) == 7.5
            # negative rejection
            r2 = admin_client.patch(f"{base_url}/api/meals/items/{it['id']}",
                                    json={"min_stock": -0.1}, timeout=30)
            assert r2.status_code == 400
        finally:
            admin_client.delete(f"{base_url}/api/meals/items/{it['id']}", timeout=30)


# ---------- /meals/stock low_count + min-aware low flag ----------
class TestStockLowCount:
    def test_stock_returns_min_and_low_flag(self, admin_client, base_url, rice_item):
        r = admin_client.get(f"{base_url}/api/meals/stock", timeout=30)
        assert r.status_code == 200, r.text
        j = r.json()
        assert "low_count" in j and isinstance(j["low_count"], int)
        assert j["low_count"] >= 1
        rice_row = next(x for x in j["rows"] if x["item_id"] == rice_item["id"])
        assert "min_stock" in rice_row and "low" in rice_row
        # Rice on_hand should be 62 (opening 50 + 20 - 8) with min_stock 70 → low
        assert rice_row["on_hand"] == 62
        if rice_row["min_stock"] > rice_row["on_hand"]:
            assert rice_row["low"] is True

    def test_low_when_no_min_and_zero_stock(self, admin_client, base_url):
        # find Apples or Chicken (on_hand 0, no min) — should be low
        r = admin_client.get(f"{base_url}/api/meals/stock", timeout=30).json()
        zero_rows = [x for x in r["rows"] if x["on_hand"] <= 0]
        assert any(x["low"] for x in zero_rows), "zero-stock items must be flagged low"


# ---------- item ledger ----------
class TestItemLedger:
    def test_ledger_totals_and_on_hand_rice(self, admin_client, base_url, rice_item):
        r = admin_client.get(f"{base_url}/api/meals/items/{rice_item['id']}/ledger",
                             params={"start": "2026-08-01", "end": "2026-08-31"},
                             timeout=30)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["item"]["id"] == rice_item["id"]
        assert isinstance(j["events"], list) and len(j["events"]) >= 2
        # Expected: purchase 20@60 = 1200; issued 8
        assert j["totals"]["purchased_qty"] == 20
        assert j["totals"]["purchased_amount"] == 1200
        assert j["totals"]["issued_qty"] == 8
        assert j["on_hand"] == 62
        # events carry type + qty
        types = {e["type"] for e in j["events"]}
        assert {"purchase", "issue"}.issubset(types)
        # purchase carries rate + amount
        pev = next(e for e in j["events"] if e["type"] == "purchase")
        assert pev["rate"] == 60 and pev["amount"] == 1200

    def test_ledger_default_range_30d(self, admin_client, base_url, rice_item):
        r = admin_client.get(f"{base_url}/api/meals/items/{rice_item['id']}/ledger",
                             timeout=30)
        assert r.status_code == 200
        j = r.json()
        assert "start" in j and "end" in j
        from datetime import date as _d
        s = _d.fromisoformat(j["start"]); e = _d.fromisoformat(j["end"])
        assert (e - s).days == 29

    def test_ledger_unknown_item_404(self, admin_client, base_url):
        r = admin_client.get(f"{base_url}/api/meals/items/does-not-exist/ledger",
                             timeout=30)
        assert r.status_code == 404

    def test_ledger_chef_can_read(self, chef_client, base_url, rice_item):
        r = chef_client.get(f"{base_url}/api/meals/items/{rice_item['id']}/ledger",
                            timeout=30)
        assert r.status_code == 200


# ---------- category summary ----------
class TestCategorySummary:
    def test_grocery_summary_range(self, admin_client, base_url, rice_item):
        r = admin_client.get(f"{base_url}/api/meals/categories/grocery/summary",
                             params={"start": "2026-08-01", "end": "2026-08-31"},
                             timeout=30)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["category"]["key"] == "grocery"
        assert "spend" in j
        rice_row = next((i for i in j["items"] if i["item_id"] == rice_item["id"]), None)
        assert rice_row is not None
        assert rice_row["purchased_qty"] == 20
        assert rice_row["purchased_amount"] == 1200
        assert rice_row["issued_qty"] == 8
        # spend >= rice's 1200 (legacy amounts map summed too)
        assert j["spend"] >= 1200

    def test_summary_unknown_category_404(self, admin_client, base_url):
        r = admin_client.get(f"{base_url}/api/meals/categories/no_such_cat/summary",
                             timeout=30)
        assert r.status_code == 404

    def test_summary_chef_can_read(self, chef_client, base_url):
        r = chef_client.get(f"{base_url}/api/meals/categories/grocery/summary",
                            timeout=30)
        assert r.status_code == 200
