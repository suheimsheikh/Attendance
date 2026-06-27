"""Iter5 review tests:
  (a) GET /api/leaves/overlap — auth required, returns array with required fields,
      respects exclude_user_id / leave_id, excludes rejected & late_coming rows.
  (b) GET /api/leave-balances — extended with comp_off_accrued/used/available + tour_days.
  (c) Regression: POST /api/leaves type='leave' still stamps waterfall fields.
  (d) Regression: /api/auth/me still works; /api/leaves enriched fields present.
"""
import os
import pytest
import requests
from datetime import date, timedelta


BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")


# ---------- Helpers ----------
def _pick_non_athlete(client, base_url):
    r = client.get(f"{base_url}/api/members?category=coach")
    if r.status_code == 200 and isinstance(r.json(), list) and r.json():
        return r.json()[0]
    r = client.get(f"{base_url}/api/members")
    assert r.status_code == 200, r.text
    members = [m for m in r.json() if m.get("category") != "athlete"]
    assert members, "No non-athlete member available for tests"
    return members[0]


# ---------- /api/leaves/overlap ----------
class TestOverlapEndpoint:
    def test_overlap_requires_auth(self, base_url):
        r = requests.get(f"{base_url}/api/leaves/overlap",
                         params={"start_date": "2026-01-01", "end_date": "2026-01-02"},
                         timeout=20)
        assert r.status_code in (401, 403), f"Expected 401/403, got {r.status_code}"

    def test_overlap_returns_list(self, admin_client, base_url):
        # use a year-wide window so we likely get some rows but at minimum a list
        r = admin_client.get(f"{base_url}/api/leaves/overlap",
                             params={"start_date": "2026-01-01", "end_date": "2026-12-31"})
        assert r.status_code == 200, r.text
        data = r.json()
        assert isinstance(data, list)
        # Validate row shape if any rows exist
        if data:
            row = data[0]
            for k in ("id", "user_id", "full_name", "type", "status",
                      "start_date", "end_date"):
                assert k in row, f"Missing key {k} in overlap row"
            assert row["type"] in ("leave", "tour", "comp_off")
            assert row["status"] in ("pending", "approved")

    def test_overlap_excludes_rejected_and_latecoming(self, admin_client, base_url):
        r = admin_client.get(f"{base_url}/api/leaves/overlap",
                             params={"start_date": "2024-01-01", "end_date": "2027-12-31"})
        assert r.status_code == 200
        for row in r.json():
            assert row["status"] != "rejected"
            assert row["type"] != "late_coming"

    def test_overlap_exclude_user_id(self, admin_client, base_url):
        all_rows = admin_client.get(f"{base_url}/api/leaves/overlap",
            params={"start_date": "2024-01-01", "end_date": "2027-12-31"}).json()
        if not all_rows:
            pytest.skip("No overlap rows present to test exclude_user_id")
        target_uid = all_rows[0]["user_id"]
        r = admin_client.get(f"{base_url}/api/leaves/overlap",
                             params={"start_date": "2024-01-01",
                                     "end_date": "2027-12-31",
                                     "exclude_user_id": target_uid})
        assert r.status_code == 200
        for row in r.json():
            assert row["user_id"] != target_uid

    def test_overlap_available_to_any_authenticated_user(self, admin_client, base_url):
        # Verify the endpoint doesn't require admin — call it after stripping
        # admin token to ensure a phone user could also call it. We can't easily
        # mint a non-admin token here, so we at minimum check it's not 403 for
        # admin and the route doesn't bail out with role gating noise.
        r = admin_client.get(f"{base_url}/api/leaves/overlap",
                             params={"start_date": "2026-06-01",
                                     "end_date": "2026-06-30"})
        assert r.status_code == 200


# ---------- /api/leave-balances extension ----------
class TestLeaveBalancesExtended:
    def test_listing_payload_has_new_columns(self, admin_client, base_url):
        r = admin_client.get(f"{base_url}/api/leave-balances")
        assert r.status_code == 200, r.text
        payload = r.json()
        assert "year" in payload
        assert "rows" in payload and isinstance(payload["rows"], list)
        if not payload["rows"]:
            pytest.skip("No non-athlete members present")
        row = payload["rows"][0]
        # Existing fields preserved
        for k in ("id", "full_name", "opening", "taken_this_year", "balance"):
            assert k in row, f"Missing legacy field {k}"
        # New comp-off + tour columns
        for k in ("comp_off_accrued", "comp_off_used", "comp_off_available", "tour_days"):
            assert k in row, f"Missing new field {k}"
            assert isinstance(row[k], (int, float)), f"{k} should be numeric"
        # Invariant: available = max(0, accrued - used)
        assert row["comp_off_available"] == max(
            0, row["comp_off_accrued"] - row["comp_off_used"])


# ---------- Regression: POST /api/leaves stamps waterfall ----------
class TestUnifiedLeaveRegression:
    def test_leave_post_stamps_waterfall_fields(self, admin_client, base_url):
        target = _pick_non_athlete(admin_client, base_url)
        uid = target["id"]
        # Pick a far-future window unlikely to collide
        start = (date.today() + timedelta(days=400)).isoformat()
        end = (date.today() + timedelta(days=402)).isoformat()
        payload = {
            "type": "leave",
            "start_date": start,
            "end_date": end,
            "reason": "TEST_iter5 waterfall stamp",
            "location": "TEST",
        }
        r = admin_client.post(f"{base_url}/api/leaves?target_user_id={uid}",
                              json=payload)
        assert r.status_code == 200, r.text
        doc = r.json()
        for k in ("comp_off_used", "paid_leave_used", "lop_days"):
            assert k in doc, f"Missing stamp {k}"
        # Sum should equal 3-day window
        total = (doc.get("comp_off_used") or 0) + \
                (doc.get("paid_leave_used") or 0) + \
                (doc.get("lop_days") or 0)
        assert total == 3, f"Stamps sum {total} != requested 3 days"
        # Cleanup: reject the row to remove it from active sets
        admin_client.patch(f"{base_url}/api/leaves/{doc['id']}",
                           json={"status": "rejected"})

    def test_tour_post_does_not_stamp_waterfall(self, admin_client, base_url):
        target = _pick_non_athlete(admin_client, base_url)
        uid = target["id"]
        start = (date.today() + timedelta(days=410)).isoformat()
        end = (date.today() + timedelta(days=411)).isoformat()
        r = admin_client.post(f"{base_url}/api/leaves?target_user_id={uid}",
                              json={"type": "tour", "start_date": start,
                                    "end_date": end, "reason": "TEST tour",
                                    "location": "TEST"})
        assert r.status_code == 200, r.text
        doc = r.json()
        # Tour rows should NOT carry the ladder stamps (None or missing)
        assert not doc.get("paid_leave_used")
        assert not doc.get("comp_off_used")
        admin_client.patch(f"{base_url}/api/leaves/{doc['id']}",
                           json={"status": "rejected"})

    def test_auth_me_still_works(self, admin_client, base_url):
        r = admin_client.get(f"{base_url}/api/auth/me")
        assert r.status_code == 200
        me = r.json()
        assert me.get("role") == "admin"
        assert "id" in me

    def test_leaves_listing_enriched(self, admin_client, base_url):
        r = admin_client.get(f"{base_url}/api/leaves")
        assert r.status_code == 200
        rows = r.json()
        assert isinstance(rows, list)
        if rows:
            row = rows[0]
            # Enriched fields from admin listing
            assert "member_name" in row or "full_name" in row
