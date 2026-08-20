"""
Regression: purchase-category reorder endpoints (Feb 2026 user request:
"Move Dairy Products above Cleaning Items. Also allow up/down reorder
for both items and categories, plus a one-tap 'sort by consumption'").
"""
import os
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


def _keys(hdr):
    r = httpx.get(f"{API_URL}/api/meals/purchase-categories", headers=hdr, timeout=10)
    r.raise_for_status()
    return [c["key"] for c in r.json().get("categories") or []]


def test_reorder_moves_dairy_above_cleaning(hdr):
    initial = _keys(hdr)
    assert "dairy_products" in initial and "cleaning_items" in initial

    # Build the target order — same as `initial` but with dairy immediately
    # before cleaning (fulfills the exact user request).
    ordered = [k for k in initial if k not in ("dairy_products", "cleaning_items")]
    idx = ordered.index("cleaning_items") if "cleaning_items" in ordered else len(ordered)
    ordered.insert(idx, "cleaning_items")
    ordered.insert(ordered.index("cleaning_items"), "dairy_products")

    r = httpx.put(f"{API_URL}/api/meals/purchase-categories/reorder",
                  headers=hdr, json={"keys": ordered}, timeout=15)
    assert r.status_code == 200, r.text
    got = [c["key"] for c in r.json()["categories"]]
    assert got.index("dairy_products") < got.index("cleaning_items"), got


def test_reorder_rejects_unknown_key(hdr):
    r = httpx.put(f"{API_URL}/api/meals/purchase-categories/reorder",
                  headers=hdr, json={"keys": ["totally_made_up_key"]},
                  timeout=10)
    assert r.status_code == 400
    assert "unknown" in r.json()["detail"].lower()


def test_reorder_preserves_forgotten_keys_at_tail(hdr):
    """Sending a subset of keys must not drop the missing ones — they
    slide to the bottom so nothing disappears from Daily Entry."""
    initial = _keys(hdr)
    assert len(initial) >= 2
    subset = [initial[0]]   # just the first
    r = httpx.put(f"{API_URL}/api/meals/purchase-categories/reorder",
                  headers=hdr, json={"keys": subset}, timeout=15)
    assert r.status_code == 200
    got = [c["key"] for c in r.json()["categories"]]
    # First is what we asked; rest survive at tail in original order.
    assert got[0] == initial[0]
    assert set(got) == set(initial)


def test_sort_items_by_consumption_only_touches_items(hdr):
    """Feb 20 clarification: categories keep their manual order — ONLY
    items get renumbered inside each category. The new endpoint returns
    per-category touched counts and never emits a `categories` array."""
    before = _keys(hdr)
    r = httpx.post(f"{API_URL}/api/meals/items/sort-within-categories",
                   params={"by": "consumption", "days": 30},
                   headers=hdr, timeout=20)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["by"] == "consumption"
    assert body["categories_touched"] >= 1
    assert body["items_renumbered"] >= 0   # zero in a fresh DB
    # Categories must NOT have been reordered.
    after = _keys(hdr)
    assert after == before, f"categories moved: before {before} → after {after}"


def test_sort_items_alphabetically(hdr):
    r = httpx.post(f"{API_URL}/api/meals/items/sort-within-categories",
                   params={"by": "alpha"},
                   headers=hdr, timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["by"] == "alpha"
    # Verify the items inside at least one populated category are now
    # alphabetically ordered.
    it_r = httpx.get(f"{API_URL}/api/meals/items",
                     headers=hdr, timeout=15)
    it_r.raise_for_status()
    items = it_r.json().get("items", [])
    from collections import defaultdict
    grouped = defaultdict(list)
    for it in items:
        grouped[it.get("category_key")].append(it)
    for ck, arr in grouped.items():
        if len(arr) < 2:
            continue
        # API returns items already sorted by (category_key, sort_order,
        # name) — after the alpha pass sort_order == alpha rank.
        names = [i["name"].lower() for i in arr]
        assert names == sorted(names), f"'{ck}' not sorted alphabetically: {names[:5]}"
        break   # one populated category is enough


def test_sort_only_one_category(hdr):
    """Feb 20 request: per-category sort button on Daily Entry rows.
    Passing category_key limits the renumber to that ONE category and
    reports it in the response — other categories keep their order."""
    r = httpx.post(f"{API_URL}/api/meals/items/sort-within-categories",
                   params={"by": "consumption", "category_key": "chicken_mutton"},
                   headers=hdr, timeout=15)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["category_key"] == "chicken_mutton"
    assert body["categories_touched"] in (0, 1), body
