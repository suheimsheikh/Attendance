"""
Regression: Masters tree delete/patch should be resilient to stale ids.

Reproduces the "Item not found" bug reported in the handoff summary:
two admins acting on the tree at once used to see a red 404 toast.
Fix has two parts:
  • DELETE /meals/items/{id} is now idempotent — a repeat call returns
    200 with `{already_deleted: True}` instead of 404.
  • PATCH still 404s (cannot update a non-existent row) but the frontend
    self-heals with a soft info toast and a silent list reload.

Feb 2026 user rule additionally: "Nobody can delete a master or a Daily
entry item if there is data in it." So DELETE now returns 409 when the
item has any purchases / issues / wastage — deactivation is the required
path for anything with history.

Runs with the same fixtures the other backend tests use.
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


def _create_disposable(hdr):
    name = f"PYTEST_STALE_{uuid.uuid4().hex[:8]}"
    r = httpx.post(f"{API_URL}/api/meals/items", headers=hdr, timeout=15,
                   json={"category_key": "grocery", "name": name, "unit": "kg",
                         "opening_stock": 0, "opening_rate": 0,
                         "min_stock": 0, "norm_per_serving": 0,
                         "sort_order": 999})
    r.raise_for_status()
    return r.json()["id"]


def test_delete_is_idempotent(hdr):
    item_id = _create_disposable(hdr)
    # First delete: real hard-delete (no history).
    r1 = httpx.delete(f"{API_URL}/api/meals/items/{item_id}", headers=hdr, timeout=15)
    assert r1.status_code == 200, r1.text
    body1 = r1.json()
    assert body1.get("ok") is True
    assert body1.get("soft_deleted") is False
    assert not body1.get("already_deleted")

    # Second delete: should succeed idempotently, NOT 404.
    r2 = httpx.delete(f"{API_URL}/api/meals/items/{item_id}", headers=hdr, timeout=15)
    assert r2.status_code == 200, r2.text
    body2 = r2.json()
    assert body2.get("ok") is True
    assert body2.get("already_deleted") is True


def test_patch_stale_id_is_404(hdr):
    """PATCH on a gone id STILL returns 404 — this is correct REST
    semantics. The frontend guards against the flash by pre-checking
    local state and, if the server does 404, self-healing via reload."""
    item_id = _create_disposable(hdr)
    httpx.delete(f"{API_URL}/api/meals/items/{item_id}", headers=hdr, timeout=15)
    r = httpx.patch(f"{API_URL}/api/meals/items/{item_id}", headers=hdr, timeout=15,
                    json={"category_key": "vegetables"})
    assert r.status_code == 404, r.text


def test_daily_entry_reconciles_with_masters_stock(hdr):
    """The two views agree by construction:
      • /meals/daily-totals sums every purchase line by date
      • /meals/stock sums purchases FROM each item's opening_stock_as_of
        onwards (because anything before is already baked into the
        item's opening balance)
    So daily_grand_purchase ≥ stock_grand_purchase, and the diff equals
    the value of purchases dated BEFORE the item's as-of date.
    """
    # 90-day window is comfortably wider than any item's as-of horizon.
    r_daily = httpx.get(f"{API_URL}/api/meals/daily-totals",
                        params={"start": "2026-05-22", "end": "2026-08-20"},
                        headers=hdr, timeout=15)
    r_daily.raise_for_status()
    daily = r_daily.json()

    r_stock = httpx.get(f"{API_URL}/api/meals/stock", headers=hdr, timeout=15)
    r_stock.raise_for_status()
    stock = r_stock.json()

    stock_purch = round(sum(float(x.get("purchased_amount") or 0)
                            for x in stock.get("rows") or []), 2)
    daily_purch = float(daily.get("grand_purchase_amt") or 0)

    # Non-negative: masters can only be ≤ daily total (never more).
    assert stock_purch <= daily_purch + 0.01, \
        f"masters purch {stock_purch} > daily {daily_purch} — should never exceed"

    # Sanity: the on-hand identity from the masters snapshot itself
    # must be consistent (opening + purch - issue - waste == on-hand).
    grand_op = round(sum(float(x.get("opening_value") or 0) for x in stock["rows"]), 2)
    grand_pu = stock_purch
    grand_is = round(sum(float(x.get("issued_value") or 0) for x in stock["rows"]), 2)
    grand_wa = round(sum(float(x.get("wasted_value") or 0) for x in stock["rows"]), 2)
    grand_oh = round(sum(float(x.get("on_hand_value") or 0) for x in stock["rows"]), 2)
    computed = round(grand_op + grand_pu - grand_is - grand_wa, 2)
    assert abs(computed - grand_oh) < 0.02, \
        f"stock identity broken: {computed} vs on_hand {grand_oh}"
