"""Meal Masters (iteration 40) — new /api/meals/items/reorder endpoint,
category `active` flag round-trip, and role gating.

Non-destructive:
  * Category writes preserve the existing list; we PUT the original list back
    at the end of the run.
  * We add and then reactivate a TEST_ category we created ourselves.
  * All items created are TEST_ prefixed and cleaned up.
"""
from __future__ import annotations

import os
import uuid
import time
import pytest
import requests


# ---------------------------------------------------------------------------
# Non-admin (chef) client used for the 403 role-gate test.
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def chef_client(admin_client, base_url):
    email = f"chef-masters-{uuid.uuid4().hex[:6]}@meals.example.com"
    body = {
        "email": email,
        "password": "Chef@12345",
        "full_name": "TEST Chef Masters",
        "role": "chef",
        "category": "staff",
    }
    r = admin_client.post(f"{base_url}/api/members", json=body, timeout=30)
    assert r.status_code == 200, f"chef create: {r.status_code} {r.text}"

    lr = requests.post(f"{base_url}/api/auth/login",
                       json={"email": email, "password": "Chef@12345"},
                       timeout=30)
    assert lr.status_code == 200, f"chef login: {lr.status_code} {lr.text}"
    tok = lr.json()["access_token"]
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
    yield s


@pytest.fixture(scope="module")
def existing_categories(admin_client, base_url):
    """Snapshot the current purchase categories so we can restore later."""
    r = admin_client.get(f"{base_url}/api/meals/purchase-categories", timeout=30)
    assert r.status_code == 200
    cats = r.json()["categories"]
    yield cats
    # restore
    payload = {"categories": [
        {"key": c.get("key"), "label": c["label"],
         "active": c.get("active") is not False}
        for c in cats
    ]}
    admin_client.put(f"{base_url}/api/meals/purchase-categories",
                     json=payload, timeout=30)


class TestPurchaseCategoriesActive:
    def test_active_flag_round_trip(self, admin_client, base_url, existing_categories):
        """PUT a category with active=false, GET should return active=false."""
        cats = [dict(c) for c in existing_categories]
        # append a TEST_ category flagged inactive
        test_key = f"test_inactive_{uuid.uuid4().hex[:6]}"
        cats.append({"key": test_key, "label": "TEST Inactive Cat", "active": False})
        payload = {"categories": [
            {"key": c.get("key"), "label": c["label"],
             "active": c.get("active") is not False}
            for c in cats
        ]}
        r = admin_client.put(f"{base_url}/api/meals/purchase-categories",
                             json=payload, timeout=30)
        assert r.status_code == 200, r.text
        # verify persistence
        g = admin_client.get(f"{base_url}/api/meals/purchase-categories", timeout=30)
        assert g.status_code == 200
        by_key = {c["key"]: c for c in g.json()["categories"]}
        assert test_key in by_key
        assert by_key[test_key]["active"] is False
        # Also verify existing categories all still carry active:true
        for c in existing_categories:
            k = c.get("key")
            if k:
                assert by_key.get(k, {}).get("active") is True

    def test_duplicate_key_rejected(self, admin_client, base_url, existing_categories):
        cats = [
            {"key": "dupe", "label": "A", "active": True},
            {"key": "dupe", "label": "B", "active": True},
        ]
        r = admin_client.put(f"{base_url}/api/meals/purchase-categories",
                             json={"categories": cats}, timeout=30)
        assert r.status_code == 400


class TestItemsReorder:
    @pytest.fixture(scope="class")
    def two_items(self, admin_client, base_url):
        made = []
        for i in range(2):
            body = {
                "category_key": "grocery",
                "name": f"TEST_Reorder_{i}_{uuid.uuid4().hex[:6]}",
                "unit": "kg",
                "opening_stock": 0,
                "sort_order": 500 + i,
            }
            r = admin_client.post(f"{base_url}/api/meals/items", json=body, timeout=30)
            assert r.status_code == 200, r.text
            made.append(r.json())
        yield made
        for it in made:
            admin_client.delete(f"{base_url}/api/meals/items/{it['id']}", timeout=30)

    def test_reorder_sets_sort_order(self, admin_client, base_url, two_items):
        a, b = two_items
        # Reorder: b before a
        r = admin_client.put(f"{base_url}/api/meals/items/reorder",
                             json={"category_key": "grocery",
                                   "item_ids": [b["id"], a["id"]]}, timeout=30)
        assert r.status_code == 200, r.text
        assert r.json()["ok"] is True
        assert r.json()["ordered"] == 2

        # GET items and confirm order among our two
        g = admin_client.get(f"{base_url}/api/meals/items",
                             params={"category_key": "grocery"}, timeout=30)
        assert g.status_code == 200
        ids_in_order = [it["id"] for it in g.json()["items"] if it["id"] in {a["id"], b["id"]}]
        assert ids_in_order == [b["id"], a["id"]], f"unexpected order: {ids_in_order}"

    def test_reorder_rejects_unknown_item_ids(self, admin_client, base_url):
        r = admin_client.put(f"{base_url}/api/meals/items/reorder",
                             json={"category_key": "grocery",
                                   "item_ids": ["not-a-real-id-xxx"]}, timeout=30)
        assert r.status_code == 400

    def test_reorder_forbidden_for_chef(self, chef_client, base_url, two_items):
        a, b = two_items
        r = chef_client.put(f"{base_url}/api/meals/items/reorder",
                            json={"category_key": "grocery",
                                  "item_ids": [a["id"], b["id"]]}, timeout=30)
        assert r.status_code == 403


class TestItemLifecycle:
    def test_soft_delete_when_history_exists(self, admin_client, base_url):
        """An item with a purchase line must be soft-deleted (active=false)
        rather than hard-deleted."""
        item = admin_client.post(f"{base_url}/api/meals/items", json={
            "category_key": "grocery",
            "name": f"TEST_SoftDel_{uuid.uuid4().hex[:6]}",
            "unit": "kg",
            "opening_stock": 0,
        }, timeout=30).json()

        from datetime import date
        d = date.today().isoformat()
        pr = admin_client.put(f"{base_url}/api/meals/purchases/{d}",
                              json={"lines": [{"item_id": item["id"], "qty": 1, "rate": 5}]},
                              timeout=30)
        assert pr.status_code == 200, pr.text

        dr = admin_client.delete(f"{base_url}/api/meals/items/{item['id']}", timeout=30)
        assert dr.status_code == 200
        assert dr.json().get("soft_deleted") is True

        # Item should still exist in include_inactive listing, active=false
        g = admin_client.get(f"{base_url}/api/meals/items",
                             params={"include_inactive": "true"}, timeout=30)
        assert g.status_code == 200
        row = next((it for it in g.json()["items"] if it["id"] == item["id"]), None)
        assert row is not None
        assert row["active"] is False

    def test_hard_delete_when_no_history(self, admin_client, base_url):
        item = admin_client.post(f"{base_url}/api/meals/items", json={
            "category_key": "grocery",
            "name": f"TEST_HardDel_{uuid.uuid4().hex[:6]}",
            "unit": "kg",
            "opening_stock": 0,
        }, timeout=30).json()
        dr = admin_client.delete(f"{base_url}/api/meals/items/{item['id']}", timeout=30)
        assert dr.status_code == 200
        assert dr.json().get("soft_deleted") is False

    def test_move_item_between_categories(self, admin_client, base_url):
        item = admin_client.post(f"{base_url}/api/meals/items", json={
            "category_key": "grocery",
            "name": f"TEST_Move_{uuid.uuid4().hex[:6]}",
            "unit": "kg",
            "opening_stock": 0,
        }, timeout=30).json()
        try:
            r = admin_client.patch(f"{base_url}/api/meals/items/{item['id']}",
                                   json={"category_key": "vegetables"}, timeout=30)
            assert r.status_code == 200
            assert r.json()["category_key"] == "vegetables"
        finally:
            admin_client.delete(f"{base_url}/api/meals/items/{item['id']}", timeout=30)
