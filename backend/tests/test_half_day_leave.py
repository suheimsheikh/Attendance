"""Half-day leave (30 Jun 2026 evening).

Contract:
  1. `half_day` is `None` | "FN" | "PN".
  2. Only allowed on `type=leave`; other types → 400.
  3. Must be single-day (start_date == end_date) → 400 otherwise.
  4. Deducts 0.5 from the balance ladder (comp-off is whole-day only,
     so the 0.5 always drops to paid_leave; if paid_leave is empty it
     becomes LOP).
  5. Works via both single-apply (`POST /api/leaves`) and admin
     apply-on-behalf group path (`POST /api/leaves/group`).
  6. Approved half-day rows carry `paid_leave_used=0.5` (or `lop_days=0.5`)
     — never a whole day.
"""
from __future__ import annotations

import uuid
import datetime as dt

import pytest
import requests


@pytest.fixture(scope="module")
def api(base_url):
    return f"{base_url}/api"


@pytest.fixture(scope="module")
def member(admin_client, api, base_url):
    body = {
        "email": f"TEST_half_{uuid.uuid4().hex[:6]}@ishowedup-test.example.com",
        "password": "Smoke@1234",
        "full_name": f"TEST_HalfMember_{uuid.uuid4().hex[:4]}",
        "role": "member",
        "category": "staff",
    }
    r = admin_client.post(f"{api}/members", json=body)
    assert r.status_code == 200, r.text
    m = r.json()
    # Seed the paid-leave opening balance (MemberCreate doesn't accept
    # this field; PATCH does).
    admin_client.patch(f"{api}/members/{m['id']}",
                       json={"leave_balance_opening": 10})
    tok_r = requests.post(f"{base_url}/api/auth/login",
                          json={"email": body["email"], "password": body["password"]},
                          timeout=30)
    assert tok_r.status_code == 200, tok_r.text
    yield {**m, "token": tok_r.json()["access_token"], "email": body["email"]}
    try:
        admin_client.delete(f"{api}/members/{m['id']}")
    except Exception:
        pass


def _sess(token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {token}",
                      "Content-Type": "application/json"})
    return s


class TestHalfDayValidation:
    def test_half_day_only_on_leave_type(self, base_url, member):
        s = _sess(member["token"])
        future = (dt.date.today() + dt.timedelta(days=15)).isoformat()
        r = s.post(f"{base_url}/api/leaves",
                   json={"type": "tour", "start_date": future,
                         "end_date": future, "reason": "trying half tour",
                         "location": "X", "half_day": "FN"})
        assert r.status_code == 400, r.text
        assert "leave" in (r.json().get("detail") or "").lower()

    def test_half_day_must_be_single_day(self, base_url, member):
        s = _sess(member["token"])
        start = (dt.date.today() + dt.timedelta(days=15)).isoformat()
        end = (dt.date.today() + dt.timedelta(days=16)).isoformat()
        r = s.post(f"{base_url}/api/leaves",
                   json={"type": "leave", "start_date": start,
                         "end_date": end, "reason": "two-day half",
                         "half_day": "FN"})
        assert r.status_code == 400, r.text
        assert "single day" in (r.json().get("detail") or "").lower()

    def test_invalid_half_day_value_rejected(self, base_url, member):
        s = _sess(member["token"])
        future = (dt.date.today() + dt.timedelta(days=15)).isoformat()
        r = s.post(f"{base_url}/api/leaves",
                   json={"type": "leave", "start_date": future,
                         "end_date": future, "reason": "invalid half",
                         "half_day": "XY"})
        # Pydantic Literal validator → 422 by default; either 400 or 422 is fine.
        assert r.status_code in (400, 422), r.text


class TestHalfDayLadder:
    def test_single_apply_stamps_paid_leave_used_half(
            self, admin_client, base_url, api, member):
        s = _sess(member["token"])
        future = (dt.date.today() + dt.timedelta(days=15)).isoformat()
        r = s.post(f"{base_url}/api/leaves",
                   json={"type": "leave", "start_date": future,
                         "end_date": future, "reason": "half day fn",
                         "half_day": "FN"})
        assert r.status_code == 200, r.text
        row = r.json()
        assert row["half_day"] == "FN"
        # Ladder split: 10 days paid-leave available → 0.5 paid, 0 co, 0 lop.
        assert row.get("comp_off_used", 0) == 0
        assert float(row.get("paid_leave_used") or 0) == 0.5
        assert float(row.get("lop_days") or 0) == 0
        admin_client.patch(f"{api}/leaves/{row['id']}", json={"status": "rejected"})

    def test_group_apply_on_behalf_supports_half_day(
            self, admin_client, api, member):
        future = (dt.date.today() + dt.timedelta(days=17)).isoformat()
        r = admin_client.post(f"{api}/leaves/group",
                              json={"type": "leave",
                                    "user_ids": [member["id"]],
                                    "start_date": future,
                                    "end_date": future,
                                    "reason": "admin half pn",
                                    "half_day": "PN",
                                    "auto_approve": False})
        assert r.status_code == 200, r.text
        assert r.json()["created"] == 1
        # Confirm the created row has the half_day stamped.
        rows = admin_client.get(f"{api}/leaves",
                                params={"user_id": member["id"]}).json()
        half_row = next((x for x in rows if x.get("half_day") == "PN"
                         and x["start_date"] == future), None)
        assert half_row is not None, "PN half-day row missing after group apply"
        assert float(half_row.get("paid_leave_used") or 0) == 0.5
        admin_client.patch(f"{api}/leaves/{half_row['id']}",
                           json={"status": "rejected"})

    def test_group_half_day_must_still_be_single_day(self, admin_client, api, member):
        start = (dt.date.today() + dt.timedelta(days=18)).isoformat()
        end = (dt.date.today() + dt.timedelta(days=19)).isoformat()
        r = admin_client.post(f"{api}/leaves/group",
                              json={"type": "leave",
                                    "user_ids": [member["id"]],
                                    "start_date": start,
                                    "end_date": end,
                                    "reason": "bad group half",
                                    "half_day": "FN",
                                    "auto_approve": False})
        assert r.status_code == 400, r.text


class TestHalfDaySplitFunction:
    """Unit-level: split_leave_days should never split the fractional part
    onto comp-off (comp-off is atomic)."""

    def test_half_day_goes_to_paid_when_available(self):
        from holidays import split_leave_days
        out = split_leave_days(0.5, comp_off_avail=10, paid_avail=10)
        assert out["comp_off_used"] == 0
        assert out["paid_leave_used"] == 0.5
        assert out["lop_days"] == 0

    def test_half_day_goes_to_lop_when_no_paid(self):
        from holidays import split_leave_days
        out = split_leave_days(0.5, comp_off_avail=10, paid_avail=0)
        assert out["comp_off_used"] == 0
        assert out["paid_leave_used"] == 0
        assert out["lop_days"] == 0.5

    def test_full_day_still_works(self):
        from holidays import split_leave_days
        out = split_leave_days(1, comp_off_avail=1, paid_avail=10)
        assert out["comp_off_used"] == 1
        assert out["paid_leave_used"] == 0
        assert out["lop_days"] == 0



class TestSummaryHalfFullBreakdown:
    """The `/api/me/leave-summary` payload should expose per-row counts of
    approved full vs. half leaves so the UI can render "N used (F full +
    H half)"."""

    def test_summary_reports_half_and_full_counts(
            self, admin_client, base_url, api, member):
        s = _sess(member["token"])
        # Apply one half and one full leave, both approved.
        d1 = (dt.date.today() + dt.timedelta(days=30)).isoformat()
        d2a = (dt.date.today() + dt.timedelta(days=31)).isoformat()
        d2b = (dt.date.today() + dt.timedelta(days=32)).isoformat()

        r1 = s.post(f"{base_url}/api/leaves",
                    json={"type": "leave", "start_date": d1, "end_date": d1,
                          "reason": "half fn stat", "half_day": "FN"})
        assert r1.status_code == 200, r1.text
        r2 = s.post(f"{base_url}/api/leaves",
                    json={"type": "leave", "start_date": d2a, "end_date": d2b,
                          "reason": "full 2-day stat"})
        assert r2.status_code == 200, r2.text

        # Approve both via admin.
        admin_client.patch(f"{api}/leaves/{r1.json()['id']}", json={"status": "approved"})
        admin_client.patch(f"{api}/leaves/{r2.json()['id']}", json={"status": "approved"})

        try:
            summary = s.get(f"{base_url}/api/me/leave-summary").json()
            pl = summary.get("paid_leave") or {}
            assert pl.get("half_count", 0) >= 1, f"half_count should be ≥1, got {pl}"
            assert pl.get("full_count", 0) >= 1, f"full_count should be ≥1, got {pl}"
            # Used = 0.5 (half) + 2 (full) = 2.5
            assert float(pl.get("used") or 0) >= 2.4  # allow for prior tests
        finally:
            admin_client.patch(f"{api}/leaves/{r1.json()['id']}", json={"status": "rejected"})
            admin_client.patch(f"{api}/leaves/{r2.json()['id']}", json={"status": "rejected"})
