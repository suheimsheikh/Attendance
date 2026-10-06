"""Iter43 — Consumption Cross-Check + Reorder Suggestions.

Uses conftest fixtures (base_url, admin_client) for auth.
"""
import pytest


# -------- norm_per_serving on items --------

def _last_30_days():
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo
    today = datetime.now(ZoneInfo("Asia/Kolkata")).date()
    return {"start": (today - timedelta(days=29)).isoformat(), "end": today.isoformat()}

class TestNormPerServing:
    def test_get_items_includes_norm(self, admin_client, base_url):
        r = admin_client.get(f"{base_url}/api/meals/items", timeout=15)
        assert r.status_code == 200
        items = r.json()["items"]
        # Every item carries a numeric, non-negative norm (no seed-data assumptions).
        assert items
        for it in items:
            assert "norm_per_serving" in it
            assert float(it["norm_per_serving"] or 0) >= 0

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
                             params=_last_30_days(), timeout=15)
        assert r.status_code == 200, r.text
        j = r.json()
        assert isinstance(j["items_with_norm"], int)
        assert isinstance(j["rows"], list)
        assert "flagged" in j
        for row in j["rows"]:
            for k in ("date", "servings", "item_id", "name", "unit", "norm",
                      "expected", "issued", "diff", "pct", "flag"):
                assert k in row, f"missing key {k} in row"
            assert row["flag"] in ("over", "under", "ok")

    def test_flags_follow_tolerance_rule(self, admin_client, base_url):
        """Whatever the live data, each row's flag must follow the rule:
        no servings + issued → over (pct None); else ±tolerance around expected."""
        tol = 0.2
        r = admin_client.get(f"{base_url}/api/meals/consumption-check",
                             params={**_last_30_days(), "tolerance": tol}, timeout=15)
        j = r.json()
        for x in j["rows"]:
            if x["expected"] > 0:
                want = ("over" if x["issued"] > x["expected"] * (1 + tol) else
                        "under" if x["issued"] < x["expected"] * (1 - tol) else "ok")
                assert x["pct"] is not None
            else:
                want = "over"
                assert x["pct"] is None
            assert x["flag"] == want, x
        assert j["flagged"] == sum(1 for x in j["rows"] if x["flag"] != "ok")

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

        for it in j["items"]:
            for k in ("item_id", "name", "unit", "on_hand", "min_stock",
                      "daily_rate", "days_left", "suggested_qty", "reasons", "low"):
                assert k in it
            assert it["suggested_qty"] > 0

        # low-first (low True before low False)
        lows = [1 if i["low"] else 0 for i in j["items"]]
        assert lows == sorted(lows, reverse=True), "not sorted low-first"

        # Out-of-stock items with no min level say so in their reasons.
        for row in j["items"]:
            if row["on_hand"] <= 0 and not row["min_stock"]:
                assert "Out of stock" in row["reasons"], row


# -------- Regression: /meals/stock shape --------
class TestStockRegression:
    def test_stock_shape_unchanged(self, admin_client, base_url):
        r = admin_client.get(f"{base_url}/api/meals/stock", timeout=15)
        assert r.status_code == 200
        j = r.json()
        assert "as_of" in j and "rows" in j and "low_count" in j
        assert j["low_count"] == sum(1 for r in j["rows"] if r["low"])
        for row in j["rows"]:
            for k in ("item_id", "name", "unit", "on_hand", "min_stock", "low"):
                assert k in row
