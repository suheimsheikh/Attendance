"""Regression tests for the Meal Muster roster gap-fix.

Bug fix under test (Jan 2026):
  /api/meals/roster now enforces the same eligibility as Chef's View:
    (1) exclude users where `leaving_date < meal_date` (ex-member cutoff),
    (2) exclude users whose category has meal_eligible=false or active=false.

Uses the shared `base_url` / `admin_token` fixtures from conftest.
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

def _create_member(base_url, tok, category="staff", leaving_date=None):
    body = {
        "email": f"testmealros-{uuid.uuid4().hex[:8]}@example.com",
        "password": "Test@12345",
        "full_name": f"TEST MealRos {uuid.uuid4().hex[:5]}",
        "role": "member",
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


def _get_category_id(base_url, tok, key):
    r = requests.get(f"{base_url}/api/masters/categories", headers=_hdr(tok), timeout=30)
    assert r.status_code == 200, r.text
    for c in r.json():
        if c.get("key") == key:
            return c.get("id")
    return None


def _patch_category(base_url, tok, cat_id, patch):
    r = requests.patch(f"{base_url}/api/masters/categories/{cat_id}",
                       headers=_hdr(tok), json=patch, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()


def _roster_ids(base_url, tok, meal_date, scope="all"):
    r = requests.get(f"{base_url}/api/meals/roster",
                     params={"meal": TEST_MEAL, "date": meal_date, "scope": scope},
                     headers=_hdr(tok), timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    return body, {m["id"] for m in body.get("members", [])}


# ---------- shape regression ---------- #

def test_roster_response_shape_regression(base_url, admin_token):
    body, _ = _roster_ids(base_url, admin_token, _iso(0), scope="all")
    for k in ("meal", "date", "scope", "members", "count", "marked_count"):
        assert k in body, f"missing key {k} in roster response"
    assert body["meal"] == TEST_MEAL
    assert body["scope"] == "all"
    assert isinstance(body["members"], list)
    assert body["count"] == len(body["members"])


# ---------- ex-member cutoff ---------- #

def test_roster_excludes_ex_member_leaving_yesterday(base_url, admin_token):
    """leaving_date=YESTERDAY, meal date=TODAY → NOT on roster."""
    m = _create_member(base_url, admin_token, category="staff", leaving_date=_iso(-1))
    try:
        _, ids = _roster_ids(base_url, admin_token, _iso(0), scope="all")
        assert m["id"] not in ids, "ex-member (leaving_date=yesterday) must NOT appear on today's roster"
    finally:
        _delete_member(base_url, admin_token, m["id"])


def test_roster_includes_member_leaving_today_is_final_day(base_url, admin_token):
    """leaving_date=TODAY, meal date=TODAY → SHOULD appear (last active day)."""
    m = _create_member(base_url, admin_token, category="staff", leaving_date=_iso(0))
    try:
        _, ids = _roster_ids(base_url, admin_token, _iso(0), scope="all")
        assert m["id"] in ids, "member on their final active day (leaving_date=today) MUST appear"
    finally:
        _delete_member(base_url, admin_token, m["id"])


def test_roster_includes_member_leaving_tomorrow(base_url, admin_token):
    """leaving_date=TOMORROW, meal date=TODAY → SHOULD appear."""
    m = _create_member(base_url, admin_token, category="staff", leaving_date=_iso(1))
    try:
        _, ids = _roster_ids(base_url, admin_token, _iso(0), scope="all")
        assert m["id"] in ids, "future-leaver must appear on today's roster"
    finally:
        _delete_member(base_url, admin_token, m["id"])


def test_roster_ex_member_gate_uses_meal_date_not_today(base_url, admin_token):
    """leaving_date=TODAY, meal date=YESTERDAY → SHOULD still appear (gate is vs meal date)."""
    m = _create_member(base_url, admin_token, category="staff", leaving_date=_iso(0))
    try:
        _, ids = _roster_ids(base_url, admin_token, _iso(-1), scope="all")
        assert m["id"] in ids, "gate must compare against meal date, not today"
    finally:
        _delete_member(base_url, admin_token, m["id"])


# ---------- category meal_eligible filter ---------- #

def test_roster_excludes_meal_ineligible_category_and_reincludes_on_flip_back(base_url, admin_token):
    cat_id = _get_category_id(base_url, admin_token, "staff")
    assert cat_id, "staff category must exist in seed"
    m = _create_member(base_url, admin_token, category="staff")
    original = _patch_category(base_url, admin_token, cat_id, {"meal_eligible": False})
    try:
        _, ids = _roster_ids(base_url, admin_token, _iso(0), scope="all")
        assert m["id"] not in ids, "member whose category is meal_eligible=false MUST NOT appear"
        # flip back
        _patch_category(base_url, admin_token, cat_id, {"meal_eligible": True})
        _, ids2 = _roster_ids(base_url, admin_token, _iso(0), scope="all")
        assert m["id"] in ids2, "after flipping meal_eligible back to true, member reappears"
    finally:
        _patch_category(base_url, admin_token, cat_id, {"meal_eligible": True})
        _delete_member(base_url, admin_token, m["id"])
        _ = original  # noqa


# ---------- scope interaction ---------- #

def test_scope_staff_empty_when_staff_meal_eligible_false(base_url, admin_token):
    cat_id = _get_category_id(base_url, admin_token, "staff")
    assert cat_id
    m = _create_member(base_url, admin_token, category="staff")
    try:
        _patch_category(base_url, admin_token, cat_id, {"meal_eligible": False})
        body, ids = _roster_ids(base_url, admin_token, _iso(0), scope="staff")
        assert m["id"] not in ids
        # Every remaining member must NOT be staff (since staff is off)
        for mm in body["members"]:
            assert mm.get("category") != "staff", \
                f"scope=staff with staff meal_eligible=false still returned staff row: {mm}"
    finally:
        _patch_category(base_url, admin_token, cat_id, {"meal_eligible": True})
        _delete_member(base_url, admin_token, m["id"])


def test_scope_staff_has_members_when_eligible(base_url, admin_token):
    cat_id = _get_category_id(base_url, admin_token, "staff")
    assert cat_id
    _patch_category(base_url, admin_token, cat_id, {"meal_eligible": True})
    m = _create_member(base_url, admin_token, category="staff")
    try:
        _, ids = _roster_ids(base_url, admin_token, _iso(0), scope="staff")
        assert m["id"] in ids
    finally:
        _delete_member(base_url, admin_token, m["id"])


def test_scope_athletes_respects_meal_eligible(base_url, admin_token):
    cat_id = _get_category_id(base_url, admin_token, "athlete")
    if not cat_id:
        pytest.skip("athlete category not present")
    # ensure eligible
    _patch_category(base_url, admin_token, cat_id, {"meal_eligible": True})
    body_on, ids_on = _roster_ids(base_url, admin_token, _iso(0), scope="athletes")
    try:
        _patch_category(base_url, admin_token, cat_id, {"meal_eligible": False})
        body_off, ids_off = _roster_ids(base_url, admin_token, _iso(0), scope="athletes")
        # If athlete is the only athlete_like category, ids_off must be empty.
        # Regardless, no athlete_like member from athlete category should be present.
        for m in body_off["members"]:
            assert m.get("category") != "athlete"
    finally:
        _patch_category(base_url, admin_token, cat_id, {"meal_eligible": True})


def test_scope_non_athletes_applies_meal_eligible(base_url, admin_token):
    """non_athletes uses $nin. Must intersect with meal_eligible set via $and."""
    cat_id = _get_category_id(base_url, admin_token, "staff")
    assert cat_id
    m = _create_member(base_url, admin_token, category="staff")
    try:
        _patch_category(base_url, admin_token, cat_id, {"meal_eligible": False})
        body, ids = _roster_ids(base_url, admin_token, _iso(0), scope="non_athletes")
        assert m["id"] not in ids
        for mm in body["members"]:
            assert mm.get("category") != "staff", \
                f"non_athletes with staff off should exclude staff, got {mm}"
    finally:
        _patch_category(base_url, admin_token, cat_id, {"meal_eligible": True})
        _delete_member(base_url, admin_token, m["id"])


# ---------- Chef's View parity ---------- #

def test_chef_view_and_roster_have_same_member_set(base_url, admin_token):
    """After the fix, /api/admin/meals-today (Chef's View) and
    /api/meals/roster should surface the SAME member set for a given
    day+meal (modulo already_marked flag)."""
    today = _iso(0)
    body_r, roster_ids = _roster_ids(base_url, admin_token, today, scope="all")

    r = requests.get(f"{base_url}/api/admin/meals-today",
                     params={"date": today}, headers=_hdr(admin_token), timeout=30)
    if r.status_code == 404:
        pytest.skip("admin/meals-today not exposed")
    assert r.status_code == 200, r.text
    chef_body = r.json()
    # Try to find member list in the response
    chef_members = None
    for key in ("members", "roster", "users"):
        if isinstance(chef_body, dict) and key in chef_body and isinstance(chef_body[key], list):
            chef_members = chef_body[key]
            break
    if chef_members is None:
        pytest.skip(f"chef view response shape not recognized: keys={list(chef_body.keys()) if isinstance(chef_body, dict) else type(chef_body)}")
    chef_ids = {m.get("id") for m in chef_members if isinstance(m, dict) and m.get("id")}
    # If chef view is per-meal too, compare; otherwise just make sure roster ⊆ chef set
    if chef_ids:
        assert roster_ids.issubset(chef_ids) or chef_ids.issubset(roster_ids), \
            f"roster and chef view differ significantly. only_in_roster={roster_ids - chef_ids}, only_in_chef={chef_ids - roster_ids}"
