"""Backend regression for iteration 86:
Follow-up to iter85 forward-ref fix. Verifies the two additional
Pydantic-request-body bugs are fixed:
  (1) PUT /api/meals/meal-calendar (DailyCountsIn moved to module scope)
  (2) POST /api/escort-attendance/photos/purge-bulk (PurgeBulkIn moved
      to module scope)
Also re-exercises iter85-fixed endpoints (recalc-late, resolve-stale GET
form) and basic meals endpoints as a regression sweep.

Run:
  TEST_ADMIN_PASSWORD=Admin@12345 \
  python -m pytest backend/tests/test_review_iter86.py -v
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime

import pytest
import requests
from pymongo import MongoClient

BASE_URL = os.environ.get(
    "REACT_APP_BACKEND_URL",
).rstrip("/")
ADMIN_EMAIL = "admin@attendance.app"
ADMIN_PASS = os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345")
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

THROWAWAY_DATE = "2020-01-06"  # far-past throwaway


@pytest.fixture(scope="module")
def mongo():
    cli = MongoClient(MONGO_URL)
    yield cli[DB_NAME]
    cli.close()


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASS},
        timeout=15,
    )
    assert r.status_code == 200, r.text[:300]
    return r.json().get("access_token") or r.json().get("token")


@pytest.fixture(scope="module")
def admin_h(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module")
def member_token():
    # Create a throwaway member and login
    import uuid as _u
    email = f"zz.iter86.{_u.uuid4().hex[:8]}@example.com"
    pwd = "ZzTest@123"
    # Login admin to create member
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASS},
        timeout=15,
    )
    tok = r.json().get("access_token") or r.json().get("token")
    h = {"Authorization": f"Bearer {tok}"}
    body = {
        "email": email,
        "full_name": "ZZ Iter86 Member",
        "role": "member",
        "category": "staff",
        "password": pwd,
        "mobile": f"9{uuid.uuid4().int % 10**9:09d}",
        "work_start": "09:30",
        "work_end": "23:00",
        "dar_exempt": True,
    }
    r2 = requests.post(f"{BASE_URL}/api/members", json=body, headers=h, timeout=15)
    if r2.status_code not in (200, 201):
        pytest.skip(f"could not create throwaway member: {r2.status_code} {r2.text[:200]}")
    mid = r2.json()["id"]
    r3 = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": email, "password": pwd},
        timeout=15,
    )
    if r3.status_code != 200:
        requests.delete(f"{BASE_URL}/api/members/{mid}", headers=h, timeout=10)
        pytest.skip("could not login throwaway member")
    mem_tok = r3.json().get("access_token") or r3.json().get("token")
    yield {"token": mem_tok, "id": mid}
    try:
        requests.delete(f"{BASE_URL}/api/members/{mid}", headers=h, timeout=10)
    except Exception:
        pass


# ---------- (1) PUT /api/meals/meal-calendar — the primary fix ----------


class TestMealCalendarUpsert:
    def test_a_upsert_200_not_422(self, admin_h, mongo):
        """Previously this returned 422 'query.body Field required'."""
        # Ensure no pre-existing row for the throwaway date
        mongo.meal_daily_counts.delete_many({"date": THROWAWAY_DATE})
        payload = {
            "date": THROWAWAY_DATE,
            "breakfast": 10, "midmorning": 2, "lunch": 15,
            "snacks": 3, "dinner": 12,
        }
        r = requests.put(
            f"{BASE_URL}/api/meals/meal-calendar",
            json=payload, headers=admin_h, timeout=15,
        )
        assert r.status_code == 200, f"expected 200, got {r.status_code}: {r.text[:400]}"
        data = r.json()
        assert data.get("ok") is True
        assert data.get("date") == THROWAWAY_DATE
        assert data.get("total") == 10 + 2 + 15 + 3 + 12

    def test_b_get_verifies_persistence(self, admin_h):
        r = requests.get(
            f"{BASE_URL}/api/meals/meal-calendar",
            params={"start": THROWAWAY_DATE, "end": THROWAWAY_DATE},
            headers=admin_h, timeout=10,
        )
        assert r.status_code == 200, r.text[:300]
        days = r.json().get("days") or []
        # The handler returns a row for every day in the range
        day = next((d for d in days if d.get("date") == THROWAWAY_DATE), None)
        assert day, f"throwaway date missing in response: {r.json()}"
        assert day.get("breakfast") == 10
        assert day.get("lunch") == 15
        assert day.get("dinner") == 12

    def test_c_invalid_date_400(self, admin_h):
        r = requests.put(
            f"{BASE_URL}/api/meals/meal-calendar",
            json={"date": "not-a-date", "breakfast": 1, "midmorning": 0,
                  "lunch": 0, "snacks": 0, "dinner": 0},
            headers=admin_h, timeout=10,
        )
        assert r.status_code == 400, r.text[:300]
        assert "date" in r.text.lower()

    def test_d_non_admin_403(self, member_token):
        h = {"Authorization": f"Bearer {member_token['token']}"}
        r = requests.put(
            f"{BASE_URL}/api/meals/meal-calendar",
            json={"date": THROWAWAY_DATE, "breakfast": 1, "midmorning": 0,
                  "lunch": 0, "snacks": 0, "dinner": 0},
            headers=h, timeout=10,
        )
        assert r.status_code == 403, r.text[:300]

    def test_z_cleanup_throwaway(self, mongo):
        res = mongo.meal_daily_counts.delete_many({"date": THROWAWAY_DATE})
        assert res.deleted_count >= 1


# ---------- (2) POST /api/escort-attendance/photos/purge-bulk ----------


class TestEscortPurgeBulk:
    def test_a_empty_list_200(self, admin_h):
        r = requests.post(
            f"{BASE_URL}/api/escort-attendance/photos/purge-bulk",
            json={"att_ids": []}, headers=admin_h, timeout=15,
        )
        assert r.status_code == 200, f"expected 200, got {r.status_code}: {r.text[:400]}"
        data = r.json()
        assert data.get("ok") is True
        assert data.get("purged") == 0

    def test_b_non_admin_blocked(self, member_token):
        h = {"Authorization": f"Bearer {member_token['token']}"}
        r = requests.post(
            f"{BASE_URL}/api/escort-attendance/photos/purge-bulk",
            json={"att_ids": []}, headers=h, timeout=10,
        )
        assert r.status_code in (401, 403), r.text[:300]


# ---------- (3) Regression — iter85 body-parsing fixes ----------


class TestIter85Regression:
    def test_recalc_late_dry_run_parses_body(self, admin_h):
        today = datetime.now().date().isoformat()
        r = requests.post(
            f"{BASE_URL}/api/attendance/recalc-late",
            json={"start": today, "end": today, "dry_run": True},
            headers=admin_h, timeout=20,
        )
        assert r.status_code == 200, r.text[:400]
        body = r.json()
        assert body.get("dry_run") is True
        assert "scanned" in body and "changes" in body

    def test_resolve_stale_body_parses(self, admin_h):
        # Passing a fake session id should NOT 422 — it should 404 or 400,
        # proving body parsing works.
        r = requests.post(
            f"{BASE_URL}/api/attendance/resolve-stale",
            json={"session_id": "nonexistent-id", "action": "work_end"},
            headers=admin_h, timeout=15,
        )
        assert r.status_code != 422, f"body still mis-parsed: {r.text[:400]}"
        assert r.status_code in (400, 404), r.text[:300]


# ---------- (4) Regression — basic meals endpoints still 200 ----------


class TestMealsRegression:
    def test_meal_calendar_get(self, admin_h):
        r = requests.get(
            f"{BASE_URL}/api/meals/meal-calendar",
            params={"start": "2026-10-01", "end": "2026-10-07"},
            headers=admin_h, timeout=10,
        )
        assert r.status_code == 200, r.text[:300]

    def test_meal_calendar_events(self, admin_h):
        r = requests.get(
            f"{BASE_URL}/api/meals/meal-calendar/events",
            params={"start": "2026-10-01", "end": "2026-10-07"},
            headers=admin_h, timeout=10,
        )
        assert r.status_code == 200, r.text[:300]

    def test_issues_suggest(self, admin_h):
        r = requests.post(
            f"{BASE_URL}/api/meals/issues/suggest",
            json={"date": "2026-10-02"}, headers=admin_h, timeout=30,
        )
        assert r.status_code == 200, r.text[:300]
