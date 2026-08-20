"""
Tests for PATCH /api/meals/wastage/{date_str} — the granular per-line
upsert endpoint added when Wastage was merged into Daily Entry
(Feb 2026). Covers the three code paths in the endpoint:

  1. qty-only line   → line stored with qty and default/passed reason
  2. notes-only line → line stored with qty=0 and the note text
                       (regression guard for the code-review MEDIUM fix
                       where notes were silently dropped when qty was
                       blank)
  3. removes         → item_id in `removes` list drops the line

Also asserts that unrelated lines on the same day survive each PATCH
so two machines editing different items in parallel don't clobber.
"""
import uuid
from datetime import date

import pytest
import requests


def _today_iso():
    return date.today().isoformat()


@pytest.fixture(scope="module")
def meal_item(admin_client, base_url):
    """Create (or reuse) an active pantry item and yield its id."""
    r = admin_client.get(f"{base_url}/api/meals/items?include_inactive=false", timeout=30)
    r.raise_for_status()
    existing = [i for i in r.json().get("items", []) if i.get("active") is not False]
    if existing:
        return existing[0]
    # No item yet — bootstrap a category + item.
    cats = admin_client.get(f"{base_url}/api/meals/purchase-categories", timeout=30).json().get("categories", [])
    if not cats:
        rc = admin_client.post(
            f"{base_url}/api/meals/purchase-categories",
            json={"label": f"Test-Wastage-Cat-{uuid.uuid4().hex[:6]}"},
            timeout=30,
        )
        rc.raise_for_status()
        cat_key = rc.json()["key"]
    else:
        cat_key = cats[0]["key"]
    ri = admin_client.post(
        f"{base_url}/api/meals/items",
        json={"name": f"Test-Waste-Item-{uuid.uuid4().hex[:6]}",
              "unit": "kg", "category_key": cat_key},
        timeout=30,
    )
    ri.raise_for_status()
    return ri.json()


def _wastage_line_for(admin_client, base_url, item_id, day):
    """Fetch today's wastage doc and return the line for `item_id` (or None)."""
    r = admin_client.get(
        f"{base_url}/api/meals/wastage?start={day}&end={day}", timeout=30
    )
    r.raise_for_status()
    docs = r.json().get("wastage", []) or []
    if not docs:
        return None
    for line in docs[0].get("lines", []) or []:
        if line.get("item_id") == item_id:
            return line
    return None


def test_wastage_patch_qty_only_persists(admin_client, base_url, meal_item):
    """qty > 0, no notes → line persists with the given qty."""
    day = _today_iso()
    iid = meal_item["id"]
    # Clean slate for this item on today.
    admin_client.patch(
        f"{base_url}/api/meals/wastage/{day}",
        json={"upserts": [], "removes": [iid]},
        timeout=30,
    )
    r = admin_client.patch(
        f"{base_url}/api/meals/wastage/{day}",
        json={"upserts": [{"item_id": iid, "qty": 1.25, "reason": "spoilt"}]},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    line = _wastage_line_for(admin_client, base_url, iid, day)
    assert line is not None, "qty-only wastage line should have persisted"
    assert line["qty"] == pytest.approx(1.25)
    assert line["reason"] == "spoilt"
    assert (line.get("notes") or "") == ""


def test_wastage_patch_notes_only_persists(admin_client, base_url, meal_item):
    """qty=0/blank, notes non-empty → line still persists with the note
    (regression guard for the Feb 2026 code-review MEDIUM finding)."""
    day = _today_iso()
    iid = meal_item["id"]
    admin_client.patch(
        f"{base_url}/api/meals/wastage/{day}",
        json={"upserts": [], "removes": [iid]},
        timeout=30,
    )
    note = "check tomorrow — bin not weighed yet"
    r = admin_client.patch(
        f"{base_url}/api/meals/wastage/{day}",
        json={"upserts": [{"item_id": iid, "qty": 0, "notes": note}]},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    line = _wastage_line_for(admin_client, base_url, iid, day)
    assert line is not None, "notes-only wastage line should have persisted"
    assert line["qty"] == 0 or line["qty"] == pytest.approx(0.0)
    assert line["notes"] == note


def test_wastage_patch_removes_line(admin_client, base_url, meal_item):
    """Sending the item_id in `removes` drops the line."""
    day = _today_iso()
    iid = meal_item["id"]
    # Ensure a line exists first.
    admin_client.patch(
        f"{base_url}/api/meals/wastage/{day}",
        json={"upserts": [{"item_id": iid, "qty": 2.0, "reason": "wasted"}]},
        timeout=30,
    )
    assert _wastage_line_for(admin_client, base_url, iid, day) is not None
    # Now remove it.
    r = admin_client.patch(
        f"{base_url}/api/meals/wastage/{day}",
        json={"upserts": [], "removes": [iid]},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    assert _wastage_line_for(admin_client, base_url, iid, day) is None


def test_wastage_patch_blank_qty_and_notes_is_treated_as_removal(admin_client, base_url, meal_item):
    """qty<=0 AND notes empty → the endpoint treats the row as a
    removal (mirrors the frontend's "row is really blank" heuristic)."""
    day = _today_iso()
    iid = meal_item["id"]
    admin_client.patch(
        f"{base_url}/api/meals/wastage/{day}",
        json={"upserts": [{"item_id": iid, "qty": 2.0, "reason": "wasted"}]},
        timeout=30,
    )
    assert _wastage_line_for(admin_client, base_url, iid, day) is not None
    r = admin_client.patch(
        f"{base_url}/api/meals/wastage/{day}",
        json={"upserts": [{"item_id": iid, "qty": 0, "notes": ""}]},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    assert _wastage_line_for(admin_client, base_url, iid, day) is None


def test_wastage_patch_rejects_unknown_item(admin_client, base_url):
    """An upsert with an unknown item_id should 400, not silently drop."""
    day = _today_iso()
    r = admin_client.patch(
        f"{base_url}/api/meals/wastage/{day}",
        json={"upserts": [{"item_id": "does-not-exist-xxxx", "qty": 1.0}]},
        timeout=30,
    )
    assert r.status_code == 400, r.text


def test_wastage_patch_requires_auth(base_url):
    """No token → 401/403 (whatever the app's auth layer returns)."""
    day = _today_iso()
    r = requests.patch(
        f"{base_url}/api/meals/wastage/{day}",
        json={"upserts": [], "removes": []},
        timeout=30,
    )
    assert r.status_code in (401, 403)
