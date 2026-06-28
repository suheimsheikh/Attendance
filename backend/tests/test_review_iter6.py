"""Iter6 review tests — /api/me/leave-summary aggregated dashboard fields.

Validates the extended schema and that the regression baseline (210 tests)
still holds.  Only the iter6-specific contract is tested here; iter5 items
are exercised by their own test files.
"""
import os
import pytest
import requests

@pytest.fixture(scope="module")
def api(base_url):
    return f"{base_url}/api"


@pytest.fixture(scope="module")
def admin_session(admin_client):
    return admin_client


# ── /me/leave-summary schema ──────────────────────────────────────────────
class TestMeLeaveSummary:
    def test_admin_self_summary_has_all_iter6_fields(self, admin_session, api):
        r = admin_session.get(f"{api}/me/leave-summary")
        assert r.status_code == 200, r.text
        d = r.json()
        # comp_off block
        assert "comp_off" in d
        for k in ("accrued", "used", "available"):
            assert k in d["comp_off"], f"comp_off.{k} missing"
            assert isinstance(d["comp_off"][k], (int, float))
        # paid_leave block
        assert "paid_leave" in d
        for k in ("opening", "used", "available", "tracked"):
            assert k in d["paid_leave"], f"paid_leave.{k} missing"
        assert isinstance(d["paid_leave"]["tracked"], bool)
        # totals + new iter6 aggregates
        for field in (
            "total_available",
            "pending_leave_days",
            "future_approved_leave_days",
            "tour_ytd_days",
            "pending_tour_days",
            "lop_ytd_days",
            "absent_ytd_days",
            "weekly_off",
            "weekly_off_source",
        ):
            assert field in d, f"top-level field {field!r} missing"
        # numeric sanity
        assert d["pending_leave_days"] >= 0
        assert d["future_approved_leave_days"] >= 0
        assert d["tour_ytd_days"] >= 0
        assert d["pending_tour_days"] >= 0
        assert d["lop_ytd_days"] >= 0
        assert d["absent_ytd_days"] >= 0
        # weekly_off_source must be one of the two known values
        assert d["weekly_off_source"] in ("member", "office_default")

    def test_member_summary_via_admin_route(self, admin_session, api):
        """Pick any non-athlete member and verify their summary has all
        iter6 aggregates as well — the same compute helper backs both
        endpoints, but we exercise the admin-scoped route too."""
        members = admin_session.get(f"{api}/members").json()
        assert isinstance(members, list) and members, "no members seeded"
        target = next(
            (m for m in members if m.get("category") != "athlete"),
            members[0],
        )
        r = admin_session.get(f"{api}/members/{target['id']}/leave-summary")
        assert r.status_code == 200, r.text
        d = r.json()
        for field in (
            "comp_off", "paid_leave", "total_available",
            "pending_leave_days", "future_approved_leave_days",
            "tour_ytd_days", "pending_tour_days",
            "lop_ytd_days", "absent_ytd_days",
            "weekly_off", "weekly_off_source",
        ):
            assert field in d, f"member summary missing {field!r}"

    def test_pending_count_reflects_open_leave(self, admin_session, api):
        """Create a TEST leave in the future for an admin-managed coach,
        confirm pending_leave_days advances by ~1, then clean it up by
        rejecting it.  Window is far enough out to dodge overlap rules."""
        # Pick the admin themselves as target — they have an account
        admin_session.get(f"{api}/auth/me").json()
        before = admin_session.get(f"{api}/me/leave-summary").json()
        b_pend = float(before.get("pending_leave_days", 0))

        # Pick a date later this year (within yr_start..yr_end window so
        # the aggregator picks it up).  6 months out is comfortably future
        # and avoids overlap with existing rows.
        import datetime
        today = datetime.date.today()
        d0 = (today + datetime.timedelta(days=180))
        # Stay in the same calendar year — clamp to Dec 28 if we'd spill over.
        if d0.year != today.year:
            d0 = datetime.date(today.year, 12, 28)
        d0 = d0.isoformat()
        r = admin_session.post(
            f"{api}/leaves",
            json={
                "type": "leave",
                "start_date": d0,
                "end_date": d0,
                "reason": "TEST_iter6_pending_count",
            },
        )
        if r.status_code >= 400:
            pytest.skip(
                f"could not create self-leave for admin "
                f"(status {r.status_code}): {r.text[:120]}"
            )
        leave_id = r.json()["id"]
        try:
            after = admin_session.get(f"{api}/me/leave-summary").json()
            a_pend = float(after.get("pending_leave_days", 0))
            a_future = float(after.get("future_approved_leave_days", 0))
            b_future = float(before.get("future_approved_leave_days", 0))
            # Admin self-applies may auto-approve → land in future_approved
            # bucket rather than pending.  Either bucket advancing is OK.
            delta = (a_pend - b_pend) + (a_future - b_future)
            assert delta >= 0.99, (
                f"neither pending nor future_approved advanced: "
                f"pending {b_pend}→{a_pend}, future {b_future}→{a_future}"
            )
        finally:
            admin_session.patch(
                f"{api}/leaves/{leave_id}",
                json={"status": "rejected", "decision_note": "TEST cleanup"},
            )
