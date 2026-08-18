"""Iter43 — Consumption Cross-Check + Reorder Suggestions.

Uses conftest fixtures (base_url, admin_client) for auth.
"""
import pytest


# -------- norm_per_serving on items --------
class TestNormPerServing:
    def test_get_items_includes_norm(self, admin_client, base_url):
        r = admin_client.get(f"{base_url}/api/meals/items", timeout=15)
        assert r.status_code == 200
        items = r.json()["items"]
        rice = next((i for i in items if i["name"].lower() == "rice"), None)
        assert rice is not None, "Rice item must exist"
        assert "norm_per_serving" in rice
        assert rice["norm_per_serving"] == 0.15, \
            f"Rice norm expected 0.15, got {rice['norm_per_serving']}"

    def test_create_item_negative_norm_rejected(self, admin_client, base_url):
        r = admin_client.post(f"{base_url}/api/meals/items", json={
            "category_key": "grocery", "name": "TEST_negnorm_iter43",
            "unit": "kg", "norm_per_serving": -0.1,
        }, timeout=15)
        assert r.status_code == 400

    def test_create_and_patch_norm_persists(self, admin_client, base_url):
        r = admin_client.post(f"{base_url}/api/meals/items", json={
            "category_key": "grocery", "name": "TEST_norm_iter43",
            "unit": "kg", "norm_per_serving": 0.25,
        }, timeout=15)
        assert r.status_code == 200, r.text
        iid = r.json()["id"]
        assert r.json()["norm_per_serving"] == 0.25
        try:
            r2 = admin_client.patch(f"{base_url}/api/meals/items/{iid}",
                                    json={"norm_per_serving": 0.4}, timeout=15)
            assert r2.status_code == 200
            assert r2.json()["norm_per_serving"] == 0.4

            r3 = admin_client.patch(f"{base_url}/api/meals/items/{iid}",
                                    json={"norm_per_serving": -1}, timeout=15)
            assert r3.status_code == 400

            g = admin_client.get(f"{base_url}/api/meals/items", timeout=15)
            found = next((i for i in g.json()["items"] if i["id"] == iid), None)
            assert found and found["norm_per_serving"] == 0.4
        finally:
            admin_client.delete(f"{base_url}/api/meals/items/{iid}", timeout=15)


# -------- Consumption Cross-Check --------
class TestConsumptionCheck:
    def test_basic_shape(self, admin_client, base_url):
        r = admin_client.get(f"{base_url}/api/meals/consumption-check",
                             params={"start": "2026-08-10", "end": "2026-08-18"},
                             timeout=15)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["items_with_norm"] >= 1
        assert isinstance(j["rows"], list)
        assert "flagged" in j
        for row in j["rows"]:
            for k in ("date", "servings", "item_id", "name", "unit", "norm",
                      "expected", "issued", "diff", "pct", "flag"):
                assert k in row, f"missing key {k} in row"
            assert row["flag"] in ("over", "under", "ok")

    def test_known_flags(self, admin_client, base_url):
        r = admin_client.get(f"{base_url}/api/meals/consumption-check",
                             params={"start": "2026-08-10", "end": "2026-08-18",
                                     "tolerance": 0.2}, timeout=15)
        j = r.json()
        rice_rows = [x for x in j["rows"] if x["name"].lower() == "rice"]
        print("Rice rows:", rice_rows)
        # 2026-08-15: 8kg issued, 0 servings → 'over', pct null
        over_815 = [x for x in rice_rows if x["date"] == "2026-08-15"]
        assert over_815, "Expected a rice row on 2026-08-15"
        assert over_815[0]["flag"] == "over"
        assert over_815[0]["pct"] is None
        assert over_815[0]["servings"] == 0
        assert over_815[0]["issued"] == 8

        # 2026-08-14: servings=2, expected=0.3, issued=0 → 'under'
        under_814 = [x for x in rice_rows if x["date"] == "2026-08-14"]
        assert under_814, "Expected a rice row on 2026-08-14"
        assert under_814[0]["servings"] == 2
        assert under_814[0]["expected"] == 0.3
        assert under_814[0]["flag"] == "under"

    def test_tolerance_validation(self, admin_client, base_url):
        r_low = admin_client.get(f"{base_url}/api/meals/consumption-check",
                                 params={"tolerance": 0.001}, timeout=15)
        assert r_low.status_code == 422
        r_hi = admin_client.get(f"{base_url}/api/meals/consumption-check",
                                params={"tolerance": 1.5}, timeout=15)
        assert r_hi.status_code == 422


# -------- Reorder Suggestions --------
class TestReorderSuggestions:
    def test_shape_and_contents(self, admin_client, base_url):
        r = admin_client.get(f"{base_url}/api/meals/reorder-suggestions", timeout=15)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j.get("window_days") == 30
        assert j.get("horizon_days") == 14
        assert isinstance(j["items"], list)
        names = {i["name"].lower() for i in j["items"]}
        assert "chicken" in names, f"chicken missing: {names}"
        assert "apples" in names, f"apples missing: {names}"
        assert "rice" not in names, f"rice should not be suggested: {names}"

        for it in j["items"]:
            for k in ("item_id", "name", "unit", "on_hand", "min_stock",
                      "daily_rate", "days_left", "suggested_qty", "reasons", "low"):
                assert k in it
            assert it["suggested_qty"] > 0

        # low-first (low True before low False)
        lows = [1 if i["low"] else 0 for i in j["items"]]
        assert lows == sorted(lows, reverse=True), "not sorted low-first"

        # Chicken + Apples both currently Out of stock, suggested 1.0
        for name in ("chicken", "apples"):
            row = next(i for i in j["items"] if i["name"].lower() == name)
            assert row["on_hand"] == 0
            assert "Out of stock" in row["reasons"]


# -------- Regression: /meals/stock shape --------
class TestStockRegression:
    def test_stock_shape_unchanged(self, admin_client, base_url):
        r = admin_client.get(f"{base_url}/api/meals/stock", timeout=15)
        assert r.status_code == 200
        j = r.json()
        assert "as_of" in j and "rows" in j and "low_count" in j
        assert j["low_count"] == 2, f"expected low_count=2, got {j['low_count']}"
        assert len(j["rows"]) == 4, f"expected 4 rows, got {len(j['rows'])}"
        for row in j["rows"]:
            for k in ("item_id", "name", "unit", "on_hand", "min_stock", "low"):
                assert k in row
