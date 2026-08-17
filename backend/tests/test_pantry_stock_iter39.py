"""Pantry Stock (iteration 39) — end-to-end backend checks.

Covers:
  • GET /api/meals/items                (masters read + units payload)
  • POST /api/meals/items               (create item w/ opening_stock_as_of)
  • PUT/GET /api/meals/purchases/{date} (line-item entry)
  • PUT/GET /api/meals/issues/{date}    (consumption)
  • PUT/GET /api/meals/wastage/{date}   (loss w/ reason)
  • GET /api/meals/stock                (on-hand math; opening_as_of exclusion)

Uses TEST_ prefixed item names so cleanup is easy.
"""
from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest


def _today() -> str:
    return date.today().isoformat()


def _yesterday() -> str:
    return (date.today() - timedelta(days=1)).isoformat()


def _tomorrow() -> str:
    return (date.today() + timedelta(days=1)).isoformat()


@pytest.fixture(scope="module")
def pantry_item(admin_client, base_url):
    """Create a fresh TEST_ item with opening_stock=10 as-of today."""
    body = {
        "category_key": "grocery",
        "name": f"TEST_Rice_{uuid.uuid4().hex[:6]}",
        "unit": "kg",
        "opening_stock": 10,
        "opening_stock_as_of": _today(),
        "sort_order": 999,
    }
    r = admin_client.post(f"{base_url}/api/meals/items", json=body, timeout=30)
    assert r.status_code == 200, f"create item: {r.status_code} {r.text}"
    doc = r.json()
    assert doc["opening_stock"] == 10
    assert doc["opening_stock_as_of"] == _today()
    assert doc["unit"] == "kg"
    assert "id" in doc
    yield doc
    # cleanup (soft-delete OK since we may have history)
    admin_client.delete(f"{base_url}/api/meals/items/{doc['id']}", timeout=30)


# ---------------------------------------------------------------------------
# Items master
# ---------------------------------------------------------------------------
class TestItemsMaster:
    def test_list_items_shape(self, admin_client, base_url):
        r = admin_client.get(f"{base_url}/api/meals/items", timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert "items" in data and "units" in data
        assert isinstance(data["units"], list) and "kg" in data["units"]

    def test_create_requires_valid_unit(self, admin_client, base_url):
        r = admin_client.post(f"{base_url}/api/meals/items", json={
            "category_key": "grocery",
            "name": f"TEST_bogus_{uuid.uuid4().hex[:4]}",
            "unit": "quintal",  # invalid
            "opening_stock": 0,
        }, timeout=30)
        assert r.status_code == 400

    def test_create_requires_known_category(self, admin_client, base_url):
        r = admin_client.post(f"{base_url}/api/meals/items", json={
            "category_key": "no_such_cat",
            "name": f"TEST_x_{uuid.uuid4().hex[:4]}",
            "unit": "kg",
        }, timeout=30)
        assert r.status_code == 400


# ---------------------------------------------------------------------------
# Purchases + Issues + Wastage + Stock math
# ---------------------------------------------------------------------------
class TestPantryFlow:
    def test_purchase_upsert_and_get(self, admin_client, base_url, pantry_item):
        d = _today()
        body = {"lines": [{"item_id": pantry_item["id"], "qty": 5, "rate": 40}]}
        r = admin_client.put(f"{base_url}/api/meals/purchases/{d}", json=body, timeout=30)
        assert r.status_code == 200, r.text
        payload = r.json()
        line = next(l for l in payload["lines"] if l["item_id"] == pantry_item["id"])
        assert line["qty"] == 5 and line["rate"] == 40 and line["amount"] == 200

        # GET verify persistence
        g = admin_client.get(f"{base_url}/api/meals/purchases",
                             params={"start": d, "end": d}, timeout=30)
        assert g.status_code == 200
        rows = g.json()["purchases"]
        found = False
        for doc in rows:
            for ln in doc.get("lines") or []:
                if ln["item_id"] == pantry_item["id"]:
                    assert ln["qty"] == 5
                    assert ln["amount"] == 200
                    found = True
        assert found, "purchase line did not persist"

    def test_issues_upsert_and_get(self, admin_client, base_url, pantry_item):
        d = _today()
        body = {"lines": [{"item_id": pantry_item["id"], "qty": 2}]}
        r = admin_client.put(f"{base_url}/api/meals/issues/{d}", json=body, timeout=30)
        assert r.status_code == 200, r.text
        line = next(l for l in r.json()["lines"] if l["item_id"] == pantry_item["id"])
        assert line["qty"] == 2 and line["unit"] == "kg"

        g = admin_client.get(f"{base_url}/api/meals/issues",
                             params={"start": d, "end": d}, timeout=30)
        assert g.status_code == 200
        found = any(ln["item_id"] == pantry_item["id"] and ln["qty"] == 2
                    for doc in g.json()["issues"] for ln in (doc.get("lines") or []))
        assert found

    def test_wastage_upsert_and_get(self, admin_client, base_url, pantry_item):
        d = _today()
        body = {"lines": [{"item_id": pantry_item["id"], "qty": 1,
                           "reason": "rotten", "notes": "TEST_note left in sun"}]}
        r = admin_client.put(f"{base_url}/api/meals/wastage/{d}", json=body, timeout=30)
        assert r.status_code == 200, r.text
        line = next(l for l in r.json()["lines"] if l["item_id"] == pantry_item["id"])
        assert line["qty"] == 1
        assert line["reason"] == "rotten"
        assert "TEST_note" in line["notes"]

        g = admin_client.get(f"{base_url}/api/meals/wastage",
                             params={"start": d, "end": d}, timeout=30)
        assert g.status_code == 200
        assert "wasted" in g.json().get("reasons", [])

    def test_wastage_rejects_bad_reason(self, admin_client, base_url, pantry_item):
        d = _today()
        r = admin_client.put(f"{base_url}/api/meals/wastage/{d}", json={
            "lines": [{"item_id": pantry_item["id"], "qty": 1, "reason": "nuked"}],
        }, timeout=30)
        assert r.status_code == 400

    def test_stock_math_reflects_purchase_issue_wastage(self, admin_client, base_url, pantry_item):
        """After opening=10 + purchase 5 − issue 2 − wastage 1 = 12."""
        r = admin_client.get(f"{base_url}/api/meals/stock",
                             params={"as_of": _today()}, timeout=30)
        assert r.status_code == 200
        row = next((x for x in r.json()["rows"] if x["item_id"] == pantry_item["id"]), None)
        assert row, "item missing from stock rows"
        assert row["opening_stock"] == 10
        assert row["purchased"] == 5
        assert row["issued"] == 2
        assert row["wasted"] == 1
        assert row["on_hand"] == 12

    def test_stock_ignores_entries_before_opening_as_of(self, admin_client, base_url):
        """Create item with opening_as_of=today, backdate a purchase to
        yesterday. That purchase MUST be excluded from stock math."""
        item_body = {
            "category_key": "vegetables",
            "name": f"TEST_Onion_{uuid.uuid4().hex[:6]}",
            "unit": "kg",
            "opening_stock": 3,
            "opening_stock_as_of": _today(),
        }
        r = admin_client.post(f"{base_url}/api/meals/items", json=item_body, timeout=30)
        assert r.status_code == 200
        item = r.json()
        try:
            # Backdated purchase (before opening_as_of) — should be IGNORED.
            r2 = admin_client.put(
                f"{base_url}/api/meals/purchases/{_yesterday()}",
                json={"lines": [{"item_id": item["id"], "qty": 99, "rate": 10}]},
                timeout=30)
            assert r2.status_code == 200
            # Stock as-of today must still equal 3 (opening), NOT 102.
            s = admin_client.get(f"{base_url}/api/meals/stock",
                                 params={"as_of": _today()}, timeout=30)
            assert s.status_code == 200
            row = next(x for x in s.json()["rows"] if x["item_id"] == item["id"])
            assert row["purchased"] == 0, f"backdated purchase leaked: {row}"
            assert row["on_hand"] == 3
        finally:
            admin_client.delete(f"{base_url}/api/meals/items/{item['id']}", timeout=30)
