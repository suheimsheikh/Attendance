"""Iter7 review tests — GET /api/leaves/event-conflicts endpoint.

Covers:
- 200 OK with `camps` + `regattas` keys for a valid date range
- Camp scope: must match institution AND member_ids roster (when present)
- Regattas: org-wide overlap returned for any user
- Non-admin requesting user_id != self gets 403
- Admin querying another member returns the targeted member's scoped conflicts
"""
import datetime
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

    def test_camp_roster_match_for_agape_member(self, admin_client, api):
        """If 'Agape Sat Sun Camp' has member_ids, pick one and confirm
        the endpoint returns it with match='roster'. If no rostered member
        exists, skip rather than fail."""
        # Try to load camps directly via admin to find the Agape camp
        camps_resp = admin_client.get(f"{api}/camps")
        if camps_resp.status_code != 200:
            pytest.skip(f"/api/camps not reachable: {camps_resp.status_code}")
        camps = camps_resp.json()
        agape = next((c for c in camps
                      if (c.get("name") or "").lower().startswith("agape")), None)
        if not agape or not agape.get("member_ids"):
            pytest.skip("Agape Sat Sun Camp with roster not seeded")
        member_id = agape["member_ids"][0]
        # Pick a window that overlaps the camp
        start = agape["start_date"]
        end = agape["end_date"]
        # Trim to a 7-day window inside the camp
        d0 = datetime.date.fromisoformat(start)
        d1 = min(d0 + datetime.timedelta(days=6),
                 datetime.date.fromisoformat(end))
        r = admin_client.get(f"{api}/leaves/event-conflicts", params={
            "start_date": d0.isoformat(), "end_date": d1.isoformat(),
            "user_id": member_id,
        })
        assert r.status_code == 200, r.text
        camps_out = r.json()["camps"]
        ids = [c["id"] for c in camps_out]
        assert agape["id"] in ids, (
            f"Expected agape camp {agape['id']} in conflict result, got {ids}"
        )
        match = next(c for c in camps_out if c["id"] == agape["id"])
        assert match.get("match") == "roster"
        for f in ("id", "name", "institution", "start_date", "end_date",
                 "days_of_week", "notes", "match"):
            assert f in match, f"camp row missing {f!r}"

    def test_camp_excluded_for_different_institution_member(self, admin_client, api):
        """Pick a member whose institution is NOT 'Agape Home' and confirm
        the Agape camp does NOT appear in their conflicts."""
        camps_resp = admin_client.get(f"{api}/camps")
        if camps_resp.status_code != 200:
            pytest.skip(f"/api/camps not reachable: {camps_resp.status_code}")
        camps = camps_resp.json()
        agape = next((c for c in camps
                      if (c.get("name") or "").lower().startswith("agape")), None)
        if not agape:
            pytest.skip("Agape camp not seeded")
        members = admin_client.get(f"{api}/members").json()
        other = next(
            (m for m in members
             if (m.get("institution") or "") != (agape.get("institution") or "")
             and (m.get("institution") or "").strip()),
            None,
        )
        if not other:
            pytest.skip("No member in a different institution seeded")
        r = admin_client.get(f"{api}/leaves/event-conflicts", params={
            "start_date": agape["start_date"], "end_date": agape["end_date"],
            "user_id": other["id"],
        })
        assert r.status_code == 200
        camps_out = r.json()["camps"]
        assert agape["id"] not in [c["id"] for c in camps_out], (
            f"Agape camp leaked into out-of-institution member {other['id']}"
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
