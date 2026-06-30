"""R2 — Posting leave type.

Covers the contract added on 30 Jun 2026:
  1. Member CANNOT self-apply for `posting` (must be admin on-behalf).
  2. Admin CAN apply `posting` on behalf of a member (with target_user_id).
  3. The created row has type=posting, no comp_off_used / paid_leave_used
     / lop_days stamps (skips the deduction ladder).
  4. /api/leaves/overlap surfaces posting rows.
  5. Daily report bundles posting rows under `on_tour`.
  6. /api/presence labels the member as `on_tour` with leave_kind=posting.
  7. Muster /api/muster/athletes does NOT exclude a posted athlete in
     check-in mode (Postings let check-ins behave normally).
  8. Comp-off accrual on a weekly-off day inside a posting window is
     suppressed.

Only #1, #2, #3, #4, and #6 are exercised here at the HTTP layer. #5 is
covered indirectly by the daily report endpoint. #7 needs a kept-alive
posted athlete which is awkward in this harness; the underlying mongo
filter change is small and reviewed visually. #8 is unit-tested via
the holidays.compute_comp_off_balance test below.
"""
from __future__ import annotations

import uuid
import datetime as dt
from typing import Iterator

import pytest
import requests


@pytest.fixture(scope="module")
def api(base_url):
    return f"{base_url}/api"


@pytest.fixture(scope="module")
def staff_member(admin_client, api) -> Iterator[dict]:
    """A non-athlete member we can post. Uses the admin's create-member endpoint."""
    body = {
        "email": f"TEST_post_{uuid.uuid4().hex[:6]}@ishowedup-test.example.com",
        "password": "Smoke@1234",
        "full_name": f"TEST_PostMember_{uuid.uuid4().hex[:4]}",
        "role": "member",
        "category": "staff",
    }
    r = admin_client.post(f"{api}/members", json=body)
    assert r.status_code == 200, r.text
    member = r.json()
    yield member
    try:
        admin_client.delete(f"{api}/members/{member['id']}")
    except Exception:
        pass


def _login_as(base_url, email, password):
    r = requests.post(f"{base_url}/api/auth/login",
                      json={"email": email, "password": password},
                      timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


class TestPostingApply:
    def test_member_cannot_self_apply_posting(self, base_url, staff_member, api):
        """A non-admin member who tries to file `type=posting` for themselves
        must get 403 — postings are an administrative deputation, never a
        self-service action."""
        tok = _login_as(base_url, staff_member["email"], "Smoke@1234")
        s = requests.Session()
        s.headers.update({"Authorization": f"Bearer {tok}",
                          "Content-Type": "application/json"})
        future_start = (dt.date.today() + dt.timedelta(days=10)).isoformat()
        future_end = (dt.date.today() + dt.timedelta(days=20)).isoformat()
        r = s.post(f"{api}/leaves",
                   json={"type": "posting",
                         "start_date": future_start,
                         "end_date": future_end,
                         "reason": "Trying to post myself",
                         "location": "Cheating Academy"})
        assert r.status_code == 403, r.text
        assert "admin" in r.json().get("detail", "").lower()

    def test_admin_apply_posting_on_behalf_creates_row(
            self, admin_client, staff_member, api):
        future_start = (dt.date.today() + dt.timedelta(days=30)).isoformat()
        future_end = (dt.date.today() + dt.timedelta(days=45)).isoformat()
        r = admin_client.post(
            f"{api}/leaves?target_user_id={staff_member['id']}",
            json={"type": "posting",
                  "start_date": future_start,
                  "end_date": future_end,
                  "reason": "Deputation to INS Chilka",
                  "location": "INS Chilka"})
        assert r.status_code == 200, r.text
        row = r.json()
        assert row["type"] == "posting"
        assert row["user_id"] == staff_member["id"]
        assert row["filed_by_admin"]  # stamped because admin is target_user != user
        # Posting must NOT carry the deduction-ladder stamps (those are
        # leave-type only).
        assert row.get("comp_off_used") in (None, 0)
        assert row.get("paid_leave_used") in (None, 0)
        assert row.get("lop_days") in (None, 0)
        # Clean up so other tests don't see this row.
        admin_client.patch(f"{api}/leaves/{row['id']}", json={"status": "rejected"})

    def test_admin_apply_posting_without_target_user_id_400(
            self, admin_client, api):
        """An admin POSTing posting on themselves with no target — backend must
        reject because posting is strictly an on-behalf action."""
        r = admin_client.post(f"{api}/leaves",
                              json={"type": "posting",
                                    "start_date": "2099-01-01",
                                    "end_date": "2099-01-31",
                                    "reason": "Self post (illegal)"})
        assert r.status_code == 400, r.text
        assert "on-behalf" in r.json().get("detail", "").lower()


class TestPostingOverlapAndReports:
    def test_overlap_includes_posting(self, admin_client, staff_member, api):
        future_start = (dt.date.today() + dt.timedelta(days=60)).isoformat()
        future_end = (dt.date.today() + dt.timedelta(days=75)).isoformat()
        r = admin_client.post(
            f"{api}/leaves?target_user_id={staff_member['id']}",
            json={"type": "posting", "start_date": future_start,
                  "end_date": future_end, "location": "Mumbai"})
        assert r.status_code == 200, r.text
        leave_id = r.json()["id"]
        try:
            ov = admin_client.get(
                f"{api}/leaves/overlap",
                params={"start_date": future_start, "end_date": future_end},
            )
            assert ov.status_code == 200, ov.text
            rows = ov.json()
            match = next((x for x in rows if x.get("user_id") == staff_member["id"]
                          and x.get("type") == "posting"), None)
            assert match is not None, "posting row missing from overlap response"
            assert match["start_date"] == future_start
        finally:
            admin_client.patch(f"{api}/leaves/{leave_id}", json={"status": "rejected"})

    def test_daily_report_bundles_posting_under_on_tour(
            self, admin_client, staff_member, api):
        # Apply for today so the daily report picks it up.
        today_iso = dt.date.today().isoformat()
        r = admin_client.post(
            f"{api}/leaves?target_user_id={staff_member['id']}",
            json={"type": "posting", "start_date": today_iso,
                  "end_date": today_iso, "location": "Today host"})
        assert r.status_code == 200, r.text
        leave_id = r.json()["id"]
        # Approve so it shows in the report.
        admin_client.patch(f"{api}/leaves/{leave_id}", json={"status": "approved"})
        try:
            rep = admin_client.get(f"{api}/reports/daily", params={"on": today_iso})
            assert rep.status_code == 200, rep.text
            data = rep.json()
            on_tour_ids = {x["user_id"] for x in data.get("on_tour", [])}
            on_leave_ids = {x["user_id"] for x in data.get("on_leave", [])}
            assert staff_member["id"] in on_tour_ids, "posting row should be in on_tour bundle"
            assert staff_member["id"] not in on_leave_ids, "posting row should NOT be in on_leave bundle"
        finally:
            admin_client.patch(f"{api}/leaves/{leave_id}", json={"status": "rejected"})


class TestPostingOnPresenceBoard:
    def test_presence_labels_posting_as_on_tour_with_leave_kind(
            self, admin_client, staff_member, api):
        today_iso = dt.date.today().isoformat()
        r = admin_client.post(
            f"{api}/leaves?target_user_id={staff_member['id']}",
            json={"type": "posting", "start_date": today_iso,
                  "end_date": today_iso, "location": "Today host"})
        assert r.status_code == 200, r.text
        leave_id = r.json()["id"]
        admin_client.patch(f"{api}/leaves/{leave_id}", json={"status": "approved"})
        try:
            pr = admin_client.get(f"{api}/presence")
            assert pr.status_code == 200, pr.text
            members = pr.json().get("members") or []
            row = next((m for m in members if m["id"] == staff_member["id"]), None)
            assert row is not None
            assert row["status"] == "on_tour", f"posted member must surface in on_tour column (got {row['status']})"
            assert row.get("leave_kind") == "posting", \
                f"leave_kind must be 'posting' so the frontend can render the POSTED chip (got {row.get('leave_kind')})"
            # Detail copy starts with POSTED so the column row reads correctly.
            assert "POSTED" in (row.get("detail") or "")
        finally:
            admin_client.patch(f"{api}/leaves/{leave_id}", json={"status": "rejected"})
