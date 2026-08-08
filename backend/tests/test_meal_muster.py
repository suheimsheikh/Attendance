"""Backend tests for the new Meal Muster (explicit paper-trail) endpoints.

Endpoints under test:
  • GET  /api/meals/config
  • GET  /api/meals/roster
  • POST /api/meals/mark-bulk         (idempotent — unique index on user_id,date,meal)
  • POST /api/meals/unmark-bulk
  • GET  /api/meals/daily-counts
  • GET  /api/meals/monthly-grid

Uses the shared `base_url` / `admin_token` fixtures from conftest.
"""
from __future__ import annotations

import os
import requests
from datetime import date

MEAL_KEYS = {"breakfast", "lunch", "snacks", "dinner"}
# Fixed test date well in the past to avoid clashing with real usage.
TEST_DATE = "2025-01-15"
TEST_MONTH = "2025-01"


def _hdr(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _cleanup(base_url, token, user_ids):
    """Best-effort delete of any TEST meal records we created."""
    for meal in MEAL_KEYS:
        try:
            requests.post(
                f"{base_url}/api/meals/unmark-bulk",
                headers=_hdr(token),
                json={"meal": meal, "date": TEST_DATE, "user_ids": user_ids},
                timeout=30,
            )
        except Exception:
            pass


# -------------------- config --------------------
def test_meal_config_shape(base_url, admin_token):
    r = requests.get(f"{base_url}/api/meals/config", headers=_hdr(admin_token), timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "meals" in body
    keys = {m["key"] for m in body["meals"]}
    assert keys == MEAL_KEYS
    for m in body["meals"]:
        assert m["label"] and m["short"]


def test_meal_config_requires_auth(base_url):
    r = requests.get(f"{base_url}/api/meals/config", timeout=30)
    assert r.status_code in (401, 403)


# -------------------- roster --------------------
def test_meals_roster_shape_and_scope_all(base_url, admin_token):
    r = requests.get(
        f"{base_url}/api/meals/roster",
        params={"meal": "breakfast", "date": TEST_DATE, "scope": "all"},
        headers=_hdr(admin_token), timeout=30,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["meal"] == "breakfast"
    assert body["date"] == TEST_DATE
    assert body["scope"] == "all"
    assert isinstance(body["members"], list)
    assert body["count"] == len(body["members"])
    for m in body["members"]:
        assert "id" in m and "full_name" in m and "already_marked" in m
        assert isinstance(m["already_marked"], bool)


def test_meals_roster_requires_auth(base_url):
    r = requests.get(f"{base_url}/api/meals/roster?meal=breakfast&date={TEST_DATE}", timeout=30)
    assert r.status_code in (401, 403)


def test_meals_roster_scope_athletes_only(base_url, admin_token):
    r = requests.get(
        f"{base_url}/api/meals/roster",
        params={"meal": "lunch", "date": TEST_DATE, "scope": "athletes"},
        headers=_hdr(admin_token), timeout=30,
    )
    assert r.status_code == 200
    for m in r.json()["members"]:
        assert m["category"] in ("athlete", "elite"), m


def test_meals_roster_scope_staff_only(base_url, admin_token):
    r = requests.get(
        f"{base_url}/api/meals/roster",
        params={"meal": "lunch", "date": TEST_DATE, "scope": "staff"},
        headers=_hdr(admin_token), timeout=30,
    )
    assert r.status_code == 200
    for m in r.json()["members"]:
        assert m["category"] == "staff", m


def test_meals_roster_scope_non_athletes_excludes_athletes(base_url, admin_token):
    r = requests.get(
        f"{base_url}/api/meals/roster",
        params={"meal": "dinner", "date": TEST_DATE, "scope": "non_athletes"},
        headers=_hdr(admin_token), timeout=30,
    )
    assert r.status_code == 200
    for m in r.json()["members"]:
        assert m["category"] not in ("athlete", "elite"), m


def test_meals_roster_bad_meal(base_url, admin_token):
    r = requests.get(
        f"{base_url}/api/meals/roster",
        params={"meal": "brunch", "date": TEST_DATE},
        headers=_hdr(admin_token), timeout=30,
    )
    assert r.status_code == 400
    assert "meal" in r.json().get("detail", "").lower()


def test_meals_roster_bad_date(base_url, admin_token):
    r = requests.get(
        f"{base_url}/api/meals/roster",
        params={"meal": "breakfast", "date": "not-a-date"},
        headers=_hdr(admin_token), timeout=30,
    )
    assert r.status_code == 400
    assert "date" in r.json().get("detail", "").lower()


# -------------------- mark / unmark / idempotency --------------------
def _pick_test_user_ids(base_url, admin_token, n=2):
    r = requests.get(
        f"{base_url}/api/meals/roster",
        params={"meal": "breakfast", "date": TEST_DATE, "scope": "all"},
        headers=_hdr(admin_token), timeout=30,
    )
    assert r.status_code == 200
    ids = [m["id"] for m in r.json()["members"][:n]]
    assert len(ids) >= 1, "no members available for testing"
    return ids


def test_mark_bulk_and_idempotency(base_url, admin_token):
    ids = _pick_test_user_ids(base_url, admin_token, 2)
    try:
        # First mark
        r1 = requests.post(
            f"{base_url}/api/meals/mark-bulk",
            headers=_hdr(admin_token),
            json={"meal": "breakfast", "date": TEST_DATE, "user_ids": ids},
            timeout=30,
        )
        assert r1.status_code == 200, r1.text
        b1 = r1.json()
        assert b1["marked_count"] == len(ids)
        assert b1["skipped_count"] == 0

        # Second mark — must be idempotent → skipped_count = len(ids)
        r2 = requests.post(
            f"{base_url}/api/meals/mark-bulk",
            headers=_hdr(admin_token),
            json={"meal": "breakfast", "date": TEST_DATE, "user_ids": ids},
            timeout=30,
        )
        assert r2.status_code == 200, r2.text
        b2 = r2.json()
        assert b2["marked_count"] == 0
        assert b2["skipped_count"] == len(ids)

        # Verify roster reflects already_marked
        r3 = requests.get(
            f"{base_url}/api/meals/roster",
            params={"meal": "breakfast", "date": TEST_DATE, "scope": "all"},
            headers=_hdr(admin_token), timeout=30,
        )
        members = {m["id"]: m for m in r3.json()["members"]}
        for uid in ids:
            assert members[uid]["already_marked"] is True, f"user {uid} not marked"
    finally:
        _cleanup(base_url, admin_token, ids)


def test_unmark_bulk_removes_records(base_url, admin_token):
    ids = _pick_test_user_ids(base_url, admin_token, 2)
    try:
        requests.post(
            f"{base_url}/api/meals/mark-bulk",
            headers=_hdr(admin_token),
            json={"meal": "lunch", "date": TEST_DATE, "user_ids": ids},
            timeout=30,
        )
        r = requests.post(
            f"{base_url}/api/meals/unmark-bulk",
            headers=_hdr(admin_token),
            json={"meal": "lunch", "date": TEST_DATE, "user_ids": ids},
            timeout=30,
        )
        assert r.status_code == 200, r.text
        assert r.json()["unmarked_count"] == len(ids)

        # roster now shows already_marked=False
        r2 = requests.get(
            f"{base_url}/api/meals/roster",
            params={"meal": "lunch", "date": TEST_DATE, "scope": "all"},
            headers=_hdr(admin_token), timeout=30,
        )
        members = {m["id"]: m for m in r2.json()["members"]}
        for uid in ids:
            if uid in members:
                assert members[uid]["already_marked"] is False
    finally:
        _cleanup(base_url, admin_token, ids)


def test_mark_bulk_requires_auth(base_url):
    r = requests.post(
        f"{base_url}/api/meals/mark-bulk",
        json={"meal": "breakfast", "date": TEST_DATE, "user_ids": []},
        timeout=30,
    )
    assert r.status_code in (401, 403)


# -------------------- daily-counts / monthly-grid --------------------
def test_daily_counts_shape_and_totals(base_url, admin_token):
    ids = _pick_test_user_ids(base_url, admin_token, 2)
    try:
        # Mark them for breakfast + lunch
        for meal in ("breakfast", "lunch"):
            requests.post(
                f"{base_url}/api/meals/mark-bulk",
                headers=_hdr(admin_token),
                json={"meal": meal, "date": TEST_DATE, "user_ids": ids},
                timeout=30,
            )
        r = requests.get(
            f"{base_url}/api/meals/daily-counts",
            params={"date": TEST_DATE},
            headers=_hdr(admin_token), timeout=30,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["date"] == TEST_DATE
        by_key = {m["key"]: m for m in body["meals"]}
        assert set(by_key.keys()) == MEAL_KEYS
        assert by_key["breakfast"]["total"] >= len(ids)
        assert by_key["lunch"]["total"] >= len(ids)
        assert by_key["dinner"]["total"] == 0
        assert isinstance(by_key["breakfast"]["by_category"], dict)
        # by_category must sum to total
        assert sum(by_key["breakfast"]["by_category"].values()) == by_key["breakfast"]["total"]
    finally:
        _cleanup(base_url, admin_token, ids)


def test_daily_counts_bad_date(base_url, admin_token):
    r = requests.get(
        f"{base_url}/api/meals/daily-counts?date=xxx",
        headers=_hdr(admin_token), timeout=30,
    )
    assert r.status_code == 400


def test_monthly_grid_shape_and_totals(base_url, admin_token):
    ids = _pick_test_user_ids(base_url, admin_token, 1)
    try:
        requests.post(
            f"{base_url}/api/meals/mark-bulk",
            headers=_hdr(admin_token),
            json={"meal": "dinner", "date": TEST_DATE, "user_ids": ids},
            timeout=30,
        )
        r = requests.get(
            f"{base_url}/api/meals/monthly-grid",
            params={"month": TEST_MONTH, "scope": "all"},
            headers=_hdr(admin_token), timeout=30,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["month"] == TEST_MONTH
        assert isinstance(body["days"], list) and len(body["days"]) == 31
        assert {m["key"] for m in body["meals"]} == MEAL_KEYS
        # Our TEST_DATE user must be in rows
        row_ids = {r["id"] for r in body["rows"]}
        assert ids[0] in row_ids, "marked member missing from monthly grid"
        row = next(r for r in body["rows"] if r["id"] == ids[0])
        assert row["totals"]["dinner"] >= 1
        assert TEST_DATE in row["days"]
        assert "dinner" in row["days"][TEST_DATE]
    finally:
        _cleanup(base_url, admin_token, ids)


def test_monthly_grid_bad_month(base_url, admin_token):
    r = requests.get(
        f"{base_url}/api/meals/monthly-grid?month=bad",
        headers=_hdr(admin_token), timeout=30,
    )
    assert r.status_code == 400


def test_daily_counts_requires_auth(base_url):
    r = requests.get(f"{base_url}/api/meals/daily-counts?date={TEST_DATE}", timeout=30)
    assert r.status_code in (401, 403)


def test_monthly_grid_requires_auth(base_url):
    r = requests.get(f"{base_url}/api/meals/monthly-grid?month={TEST_MONTH}", timeout=30)
    assert r.status_code in (401, 403)
