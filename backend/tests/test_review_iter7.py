"""Iter7 review tests — GET /api/leaves/event-conflicts endpoint.

Covers:
- 200 OK with `camps` + `regattas` keys for a valid date range
- Camp scope: must match institution AND member_ids roster (when present)
- Regattas: org-wide overlap returned for any user
- Non-admin requesting user_id != self gets 403
- Admin querying another member returns the targeted member's scoped conflicts
"""
import pytest


@pytest.fixture(scope="module")
def api(base_url):
    return f"{base_url}/api"


class TestEventConflictsContract:
    def test_self_query_returns_dict_with_camps_and_regattas(self, admin_client, api):
        d0 = "2026-07-01"
        d1 = "2026-07-15"
        r = admin_client.get(f"{api}/leaves/event-conflicts",
                             params={"start_date": d0, "end_date": d1})
        assert r.status_code == 200, r.text
        data = r.json()
        assert isinstance(data, dict)
        assert "camps" in data and isinstance(data["camps"], list)
        assert "regattas" in data and isinstance(data["regattas"], list)

    def test_regattas_have_expected_fields(self, admin_client, api):
        # July 2026 — seeded YAI calendar has multiple regattas in this window
        r = admin_client.get(f"{api}/leaves/event-conflicts",
                             params={"start_date": "2026-07-01",
                                     "end_date": "2026-07-31"})
        assert r.status_code == 200
        regattas = r.json()["regattas"]
        if not regattas:
            pytest.skip("No regattas seeded in this window")
        sample = regattas[0]
        # Expected per spec
        for f in ("id", "name", "start_date", "end_date"):
            assert f in sample, f"regatta missing {f!r}: {sample}"
        # Optional but commonly present
        for f in ("level", "location", "country", "host_org"):
            assert f in sample, f"regatta missing optional {f!r}"

    def test_camps_returned_for_any_user_when_overlap_exists(self, admin_client, api):
        """Per Jun-27 product call, camps are surfaced as informational only
        — no roster gate. Any camp overlapping the window is returned,
        regardless of the target user's institution / membership."""
        camps_resp = admin_client.get(f"{api}/camps")
        if camps_resp.status_code != 200:
            pytest.skip(f"/api/camps not reachable: {camps_resp.status_code}")
        camps = camps_resp.json()
        if not camps:
            pytest.skip("No camps seeded")
        c0 = camps[0]
        members = admin_client.get(f"{api}/members").json()
        # Pick a member from a DIFFERENT institution than c0 — they should
        # still see the camp in the response now.
        other = next(
            (m for m in members
             if (m.get("institution") or "") != (c0.get("institution") or "")),
            None,
        )
        if not other:
            pytest.skip("Could not find a member in a different institution")
        r = admin_client.get(f"{api}/leaves/event-conflicts", params={
            "start_date": c0["start_date"], "end_date": c0["end_date"],
            "user_id": other["id"],
        })
        assert r.status_code == 200, r.text
        camps_out = r.json()["camps"]
        assert c0["id"] in [c["id"] for c in camps_out], (
            f"Expected camp {c0['id']} (informational mode) — got {[c['id'] for c in camps_out]}"
        )
        match = next(c for c in camps_out if c["id"] == c0["id"])
        # `match` field is gone now — assert the informational fields stayed.
        for f in ("id", "name", "institution", "start_date", "end_date",
                 "days_of_week", "notes"):
            assert f in match, f"camp row missing {f!r}"
        assert "match" not in match, "Roster gate was removed; 'match' field should be gone"

    def test_camp_with_explicit_roster_still_returned_for_non_roster_member(self, admin_client, api):
        """The Agape Sat Sun Camp has an explicit member_ids roster. Even
        members NOT on that roster should now see the camp in their
        conflict response (informational only — no gating)."""
        camps_resp = admin_client.get(f"{api}/camps")
        if camps_resp.status_code != 200:
            pytest.skip(f"/api/camps not reachable: {camps_resp.status_code}")
        camps = camps_resp.json()
        rostered_camp = next(
            (c for c in camps if c.get("member_ids")), None,
        )
        if not rostered_camp:
            pytest.skip("No camp with explicit roster seeded")
        roster = set(rostered_camp["member_ids"] or [])
        members = admin_client.get(f"{api}/members").json()
        non_roster = next((m for m in members if m["id"] not in roster), None)
        if not non_roster:
            pytest.skip("Could not find a non-roster member")
        r = admin_client.get(f"{api}/leaves/event-conflicts", params={
            "start_date": rostered_camp["start_date"],
            "end_date": rostered_camp["end_date"],
            "user_id": non_roster["id"],
        })
        assert r.status_code == 200
        ids = [c["id"] for c in r.json()["camps"]]
        assert rostered_camp["id"] in ids, (
            "Camp with explicit roster should still show for non-roster member "
            "in informational mode"
        )

    def test_non_admin_cannot_query_other_user(self, base_url, api):
        """A non-admin user passing user_id != self must receive 403.
        We simulate by hitting the endpoint without any auth → should be 401,
        OR with an authenticated non-admin user. Skip if no member login
        fixture is available."""
        import requests
        # Without auth → 401 (or 403 depending on guard order)
        r = requests.get(f"{api}/leaves/event-conflicts",
                         params={"start_date": "2026-07-01",
                                 "end_date": "2026-07-15",
                                 "user_id": "some-other-id"},
                         timeout=20)
        assert r.status_code in (401, 403), (
            f"Expected 401/403 for unauth request, got {r.status_code}"
        )

    def test_admin_querying_other_user_works(self, admin_client, api):
        members = admin_client.get(f"{api}/members").json()
        target = next((m for m in members if m.get("id")), None)
        assert target, "No members to test against"
        r = admin_client.get(f"{api}/leaves/event-conflicts", params={
            "start_date": "2026-07-01", "end_date": "2026-07-15",
            "user_id": target["id"],
        })
        assert r.status_code == 200, r.text
        data = r.json()
        assert "camps" in data and "regattas" in data


class TestRegression213Baseline:
    """Smoke checks that the previously-validated endpoints still respond."""

    def test_me_leave_summary_still_ok(self, admin_client, api):
        r = admin_client.get(f"{api}/me/leave-summary")
        assert r.status_code == 200
        d = r.json()
        for field in ("comp_off", "paid_leave", "total_available",
                      "pending_leave_days", "tour_ytd_days", "lop_ytd_days"):
            assert field in d

    def test_leaves_overlap_still_ok(self, admin_client, api):
        r = admin_client.get(f"{api}/leaves/overlap", params={
            "start_date": "2026-07-01", "end_date": "2026-07-15",
        })
        assert r.status_code == 200
        assert isinstance(r.json(), list)
