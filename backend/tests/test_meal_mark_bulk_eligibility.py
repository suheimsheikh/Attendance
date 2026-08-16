"""Regression tests for the Meal Muster mark-bulk eligibility guard.

Bug fix under test (24 Feb 2026 code review MEDIUM):
  POST /api/meals/mark-bulk now enforces the SAME eligibility gates as
  /api/meals/roster:
    (1) skip user with role='admin'
    (2) skip user where is_ex_member(u, today_iso=date)
    (3) skip user whose category is NOT meal_eligible/active in categories master
  Failures increment skipped_count; the rest still succeed.

Uses shared `base_url` / `admin_token` fixtures from conftest.py.
"""
from __future__ import annotations
import uuid
import datetime as dt
import requests
import pytest


TEST_MEAL = "lunch"


def _hdr(tok):
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


def _iso(days_offset: int) -> str:
    return (dt.date.today() + dt.timedelta(days=days_offset)).isoformat()


# ---------- helpers ---------- #

def _create_member(base_url, tok, category="staff", leaving_date=None, role="member"):
    body = {
        "email": f"testmarkbulk-{uuid.uuid4().hex[:8]}@example.com",
        "password": "Test@12345",
        "full_name": f"TEST MarkBulk {uuid.uuid4().hex[:5]}",
        "role": role,
        "category": category,
    }
    r = requests.post(f"{base_url}/api/members", headers=_hdr(tok), json=body, timeout=30)
    assert r.status_code == 200, r.text
    m = r.json()
    if leaving_date is not None:
        rp = requests.patch(f"{base_url}/api/members/{m['id']}",
                            headers=_hdr(tok),
                            json={"leaving_date": leaving_date},
                            timeout=30)
        assert rp.status_code == 200, rp.text
    return m


def _delete_member(base_url, tok, user_id):
    try:
        requests.delete(f"{base_url}/api/members/{user_id}", headers=_hdr(tok), timeout=30)
    except Exception:
        pass


def _get_category(base_url, tok, key):
    r = requests.get(f"{base_url}/api/masters/categories", headers=_hdr(tok), timeout=30)
    assert r.status_code == 200, r.text
    for c in r.json():
        if c.get("key") == key:
            return c
    return None


def _patch_category(base_url, tok, cat_id, patch):
    r = requests.patch(f"{base_url}/api/masters/categories/{cat_id}",
                       headers=_hdr(tok), json=patch, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


def _mark_bulk(base_url, tok, user_ids, date_iso, meal=TEST_MEAL):
    r = requests.post(f"{base_url}/api/meals/mark-bulk",
                      headers=_hdr(tok),
                      json={"meal": meal, "date": date_iso, "user_ids": user_ids},
                      timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


def _unmark_bulk(base_url, tok, user_ids, date_iso, meal=TEST_MEAL):
    try:
        requests.post(f"{base_url}/api/meals/unmark-bulk",
                      headers=_hdr(tok),
                      json={"meal": meal, "date": date_iso, "user_ids": user_ids},
                      timeout=30)
    except Exception:
        pass


def _daily_details_ids(base_url, tok, date_iso, meal=TEST_MEAL):
    r = requests.get(f"{base_url}/api/meals/daily-details",
                     params={"date": date_iso, "meal": meal},
                     headers=_hdr(tok), timeout=30)
    assert r.status_code == 200, r.text
    return {m["user_id"] for m in r.json().get("members", [])}


# ---------- Tests ---------- #

def test_mark_bulk_skips_meal_ineligible_category(base_url, admin_token):
    """Category meal_eligible=false → skipped, no record inserted."""
    today = _iso(0)
    orig = _get_category(base_url, admin_token, "staff")
    assert orig, "staff category missing"
    cat_id = orig["id"]
    orig_eligible = bool(orig.get("meal_eligible", True))
    m = _create_member(base_url, admin_token, category="staff")
    try:
        _patch_category(base_url, admin_token, cat_id, {"meal_eligible": False})
        resp = _mark_bulk(base_url, admin_token, [m["id"]], today)
        assert resp["marked_count"] == 0, resp
        assert resp["skipped_count"] == 1, resp
        # Ensure NO row was inserted
        details_ids = _daily_details_ids(base_url, admin_token, today)
        assert m["id"] not in details_ids
    finally:
        _patch_category(base_url, admin_token, cat_id, {"meal_eligible": orig_eligible})
        _unmark_bulk(base_url, admin_token, [m["id"]], today)
        _delete_member(base_url, admin_token, m["id"])


def test_mark_bulk_skips_ex_member_leaving_yesterday(base_url, admin_token):
    """leaving_date < meal_date → skipped."""
    today = _iso(0)
    m = _create_member(base_url, admin_token, category="staff", leaving_date=_iso(-1))
    try:
        resp = _mark_bulk(base_url, admin_token, [m["id"]], today)
        assert resp["marked_count"] == 0, resp
        assert resp["skipped_count"] == 1, resp
        details_ids = _daily_details_ids(base_url, admin_token, today)
        assert m["id"] not in details_ids
    finally:
        _unmark_bulk(base_url, admin_token, [m["id"]], today)
        _delete_member(base_url, admin_token, m["id"])


def test_mark_bulk_allows_leaving_date_equals_meal_date(base_url, admin_token):
    """leaving_date == meal_date → marked (final active day)."""
    today = _iso(0)
    m = _create_member(base_url, admin_token, category="staff", leaving_date=today)
    try:
        resp = _mark_bulk(base_url, admin_token, [m["id"]], today)
        assert resp["marked_count"] == 1, resp
        assert resp["skipped_count"] == 0, resp
        details_ids = _daily_details_ids(base_url, admin_token, today)
        assert m["id"] in details_ids
    finally:
        _unmark_bulk(base_url, admin_token, [m["id"]], today)
        _delete_member(base_url, admin_token, m["id"])


def test_mark_bulk_mixed_batch(base_url, admin_token):
    """3 users: 1 ex-member, 1 meal-ineligible-category, 1 normal → 1 marked, 2 skipped."""
    today = _iso(0)
    orig = _get_category(base_url, admin_token, "staff")
    assert orig
    cat_id = orig["id"]
    orig_eligible = bool(orig.get("meal_eligible", True))

    # Use a different seeded category (executive) as the "meal-ineligible"
    # subject. /api/members restricts category to a Literal of seeded keys,
    # so we can't spin up a bespoke throwaway category via that endpoint.
    exec_orig = _get_category(base_url, admin_token, "executive")
    if not exec_orig:
        pytest.skip("executive category not present")
    exec_cat_id = exec_orig["id"]
    exec_orig_eligible = bool(exec_orig.get("meal_eligible", True))

    m_normal = _create_member(base_url, admin_token, category="staff")
    m_ex = _create_member(base_url, admin_token, category="staff", leaving_date=_iso(-2))
    m_ineligible = _create_member(base_url, admin_token, category="executive")

    try:
        # staff must be meal_eligible for the normal one; executive flipped off
        _patch_category(base_url, admin_token, cat_id, {"meal_eligible": True})
        _patch_category(base_url, admin_token, exec_cat_id, {"meal_eligible": False})
        resp = _mark_bulk(base_url, admin_token,
                          [m_normal["id"], m_ex["id"], m_ineligible["id"]], today)
        assert resp["marked_count"] == 1, resp
        assert resp["skipped_count"] == 2, resp
        details_ids = _daily_details_ids(base_url, admin_token, today)
        assert m_normal["id"] in details_ids
        assert m_ex["id"] not in details_ids
        assert m_ineligible["id"] not in details_ids
    finally:
        _unmark_bulk(base_url, admin_token,
                     [m_normal["id"], m_ex["id"], m_ineligible["id"]], today)
        _delete_member(base_url, admin_token, m_normal["id"])
        _delete_member(base_url, admin_token, m_ex["id"])
        _delete_member(base_url, admin_token, m_ineligible["id"])
        _patch_category(base_url, admin_token, cat_id, {"meal_eligible": orig_eligible})
        _patch_category(base_url, admin_token, exec_cat_id, {"meal_eligible": exec_orig_eligible})


def test_mark_bulk_skips_admin_role(base_url, admin_token):
    """role=admin skipped (regression)."""
    today = _iso(0)
    m = _create_member(base_url, admin_token, category="staff", role="admin")
    try:
        resp = _mark_bulk(base_url, admin_token, [m["id"]], today)
        assert resp["marked_count"] == 0, resp
        assert resp["skipped_count"] == 1, resp
        details_ids = _daily_details_ids(base_url, admin_token, today)
        assert m["id"] not in details_ids
    finally:
        _delete_member(base_url, admin_token, m["id"])


def test_mark_bulk_duplicate_key_second_call_all_skipped(base_url, admin_token):
    """Second call with same ids/date/meal → skipped_count == len(user_ids)."""
    today = _iso(0)
    m = _create_member(base_url, admin_token, category="staff")
    try:
        r1 = _mark_bulk(base_url, admin_token, [m["id"]], today)
        assert r1["marked_count"] == 1
        r2 = _mark_bulk(base_url, admin_token, [m["id"]], today)
        assert r2["marked_count"] == 0
        assert r2["skipped_count"] == 1
    finally:
        _unmark_bulk(base_url, admin_token, [m["id"]], today)
        _delete_member(base_url, admin_token, m["id"])


def test_mark_bulk_empty_user_ids(base_url, admin_token):
    """Empty user_ids → both counters 0 (regression)."""
    today = _iso(0)
    resp = _mark_bulk(base_url, admin_token, [], today)
    assert resp["marked_count"] == 0
    assert resp["skipped_count"] == 0


# ---------- Perf: unique index guard still exists ---------- #

def test_meal_records_unique_index_present(mongo_db):
    """Index `uniq_user_date_meal` created at startup must still exist —
    per the perf pass the per-request `_ensure_meal_index()` calls were
    removed, so startup is now the single source of the invariant."""
    if mongo_db is None:
        pytest.skip("mongo_db fixture unavailable")
    idx_info = mongo_db.meal_records.index_information()
    assert "uniq_user_date_meal" in idx_info, \
        f"missing uniq_user_date_meal index; have {list(idx_info.keys())}"
    idx = idx_info["uniq_user_date_meal"]
    assert idx.get("unique") is True, f"index is not unique: {idx}"
    keys = [k[0] for k in idx.get("key", [])]
    for expected in ("user_id", "date", "meal"):
        assert expected in keys, f"index missing key {expected}, got {keys}"
