"""
Feb 2026 rule: "Nobody can delete a master or a Daily entry item if
there is data in it. Can move though in the tree and up and down."

Locks in three behaviours:
  1. Items with any purchase/issue/wastage rows return 409 on DELETE
  2. Items with zero data still hard-delete cleanly (400 nothing changed)
  3. Purchase-categories can't be dropped from the config while any
     item still references them (frontend PUT is the only path)

Move (PATCH category_key) and up/down reorder are UNTOUCHED — they
stay open so admins can still restructure the tree freely.
"""
import os
import uuid
import pytest
import httpx


API_URL = os.environ.get("API_BASE_URL") or "http://localhost:8001"
ADMIN_EMAIL = "admin@attendance.app"
ADMIN_PASSWORD = "Admin@12345"


@pytest.fixture(scope="module")
def admin_token():
    r = httpx.post(f"{API_URL}/api/auth/login",
                   json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                   timeout=15)
    r.raise_for_status()
    return r.json()["access_token"]


@pytest.fixture
def hdr(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


def _mk_item(hdr):
    r = httpx.post(f"{API_URL}/api/meals/items", headers=hdr, timeout=15,
                   json={"category_key": "grocery",
                         "name": f"PYTEST_PROTECT_{uuid.uuid4().hex[:8]}",
                         "unit": "kg", "opening_stock": 0, "opening_rate": 0,
                         "min_stock": 0, "norm_per_serving": 0,
                         "sort_order": 999})
    r.raise_for_status()
    return r.json()


def test_item_with_purchases_cannot_be_deleted(hdr):
    """Locks the rule: DELETE on a data-bearing item is a 409, not a
    silent soft-delete like it used to be."""
    it = _mk_item(hdr)
    today = "2026-08-20"
    # Seed one purchase for this item.
    r = httpx.patch(f"{API_URL}/api/meals/purchases/{today}",
                    headers=hdr, timeout=15,
                    json={"upserts": [{"item_id": it["id"], "qty": 1, "rate": 10}],
                          "removes": []})
    r.raise_for_status()
    # DELETE must refuse.
    r = httpx.delete(f"{API_URL}/api/meals/items/{it['id']}",
                     headers=hdr, timeout=15)
    assert r.status_code == 409, r.text
    detail = r.json()["detail"].lower()
    assert "purchase" in detail
    assert "deactivate" in detail
    # But PATCH (deactivate) should succeed — the rule allows hiding.
    r = httpx.patch(f"{API_URL}/api/meals/items/{it['id']}",
                    headers=hdr, timeout=15, json={"active": False})
    assert r.status_code == 200
    assert r.json().get("active") is False
    # Cleanup: purge the seeded purchase then the deactivated item.
    r = httpx.patch(f"{API_URL}/api/meals/purchases/{today}",
                    headers=hdr, timeout=15,
                    json={"upserts": [], "removes": [it["id"]]})
    r.raise_for_status()
    httpx.delete(f"{API_URL}/api/meals/items/{it['id']}",
                 headers=hdr, timeout=15)


def test_item_with_no_data_still_deletes(hdr):
    """The rule ONLY blocks when there's data. Zero-history items still
    hard-delete cleanly (otherwise the tree would fill up with cruft)."""
    it = _mk_item(hdr)
    r = httpx.delete(f"{API_URL}/api/meals/items/{it['id']}",
                     headers=hdr, timeout=15)
    assert r.status_code == 200
    body = r.json()
    assert body.get("ok") is True
    assert not body.get("already_deleted")


def test_category_with_items_cannot_be_dropped(hdr):
    """PUT /purchase-categories must refuse to omit a category that
    still has items — otherwise Daily Entry would show orphaned rows."""
    r = httpx.get(f"{API_URL}/api/meals/purchase-categories",
                  headers=hdr, timeout=10)
    r.raise_for_status()
    all_cats = r.json()["categories"]
    # Pick any category that has items.
    victim = None
    for c in all_cats:
        cnt = httpx.get(f"{API_URL}/api/meals/items",
                        params={"include_inactive": "true"},
                        headers=hdr, timeout=15).json().get("items", [])
        if any(i.get("category_key") == c["key"] for i in cnt):
            victim = c["key"]
            break
    assert victim, "no populated category found in preview data"
    # Send a PUT that OMITS the victim category.
    trimmed = [{"key": c["key"], "label": c["label"], "active": True}
               for c in all_cats if c["key"] != victim]
    r = httpx.put(f"{API_URL}/api/meals/purchase-categories",
                  headers=hdr, timeout=15,
                  json={"categories": trimmed})
    assert r.status_code == 409, r.text
    assert "still have items" in r.json()["detail"].lower()
