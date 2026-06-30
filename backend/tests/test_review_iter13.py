"""Iter13 review tests — Expected-Return-Time pill data wiring.

The pill is purely visual on the frontend, but it relies on three
NEW (or newly-populated) fields on the /api/presence escort + member
rows when those rows are currently stepped out:

  - expected_return       (ISO datetime — already shipped for members)
  - expected_return_time  (local HH:MM — NEW for both surfaces)
  - overdue_minutes       (int — already shipped for members; NEW for
                           escorts, computed even when expected_return
                           was stored as raw HH:MM)

These tests:
  1. Active escort, no step-out → all three are None on the row.
  2. Escort step-out with expected_return='13:30' → row has
     expected_return_time='13:30', expected_return is an ISO datetime
     anchored to TODAY in office tz, and overdue_minutes is an int >= 0.
  3. Escort step-out with NO expected_return → all three None even
     though temp_out is True.
  4. Escort step-out with a FAR-FUTURE HH:MM (e.g. 23:55) →
     overdue_minutes is 0 (the escort isn't late yet).
  5. Escort step-out with a HH:MM well in the PAST (e.g. 00:01) →
     overdue_minutes is a large positive int.
  6. Member rows in temp_out — when a member excursion has
     expected_return, the row gains expected_return_time (HH:MM)
     alongside the pre-existing expected_return + overdue_minutes
     (this is a contract-shape regression for the NEW member field).
"""
import uuid
import datetime as dt
import pytest


TINY = ("data:image/png;base64,"
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")


@pytest.fixture(scope="module")
def api(base_url):
    return f"{base_url}/api"


@pytest.fixture(scope="module")
def any_institution(admin_client, api):
    r = admin_client.get(f"{api}/institutions")
    assert r.status_code == 200, r.text
    insts = r.json()
    if insts:
        return insts[0]
    cr = admin_client.post(f"{api}/institutions",
                           json={"name": f"TEST_Iter13_{uuid.uuid4().hex[:6]}"})
    assert cr.status_code in (200, 201), cr.text
    return cr.json()


@pytest.fixture
def escort_checked_in(admin_client, api, any_institution):
    phone = f"96{uuid.uuid4().int % 100000000:08d}"
    body = {"name": f"TEST_Iter13Esc_{uuid.uuid4().hex[:5]}",
            "phone": phone, "start_date": "2026-01-01",
            "valid_until": "2099-12-31"}
    r = admin_client.post(f"{api}/institutions/{any_institution['id']}/escorts", json=body)
    assert r.status_code in (200, 201), r.text
    esc = r.json()

    ci = admin_client.post(f"{api}/escort-attendance/checkin",
                           json={"escort_id": esc["id"], "selfie": TINY, "athlete_ids": []})
    assert ci.status_code == 200, ci.text

    yield {"escort": esc}

    # best-effort cleanup
    for path, body in (
        (f"{api}/escort-attendance/return", {"escort_id": esc["id"]}),
        (f"{api}/escort-attendance/checkout",
         {"escort_id": esc["id"], "selfie": TINY, "athlete_ids": []}),
    ):
        try:
            admin_client.post(path, json=body)
        except Exception:
            pass
    try:
        admin_client.delete(f"{api}/escorts/{esc['id']}")
    except Exception:
        pass


def _row(presence, escort_id):
    for e in presence.get("escorts_present") or []:
        if e.get("escort_id") == escort_id:
            return e
    return None


# ════════════════════════════════════════════════════════════════
# Iter13 — ETA fields on escorts_present rows
# ════════════════════════════════════════════════════════════════
class TestEscortEtaWiring:

    def test_no_stepout_eta_fields_all_none(
            self, admin_client, api, escort_checked_in):
        eid = escort_checked_in["escort"]["id"]
        r = admin_client.get(f"{api}/presence")
        assert r.status_code == 200, r.text
        row = _row(r.json(), eid)
        assert row is not None
        # Contract: when not stepped out, all three ETA fields are null.
        assert row["temp_out"] is False
        assert row["expected_return"] is None
        assert row["expected_return_time"] is None
        assert row["overdue_minutes"] is None

    def test_stepout_with_hhmm_eta_populates_all_three(
            self, admin_client, api, escort_checked_in):
        eid = escort_checked_in["escort"]["id"]
        # Pick an HH:MM ~10 min in the future (office tz = Asia/Kolkata).
        future = (dt.datetime.utcnow() + dt.timedelta(hours=5, minutes=40))  # +5h30 tz + 10 min
        hm = future.strftime("%H:%M")

        ex = admin_client.post(f"{api}/escort-attendance/temp-exit",
                               json={"escort_id": eid, "reason": "TEST_Iter13 etago",
                                     "expected_return": hm})
        assert ex.status_code == 200, ex.text

        p = admin_client.get(f"{api}/presence")
        assert p.status_code == 200, p.text
        row = _row(p.json(), eid)
        assert row is not None
        assert row["temp_out"] is True
        # expected_return_time mirrors the raw HH:MM the escort
        # endpoint stored.
        assert row["expected_return_time"] == hm
        # expected_return is now an ISO datetime anchored to today
        # in the office tz (the /presence code path rehydrates the
        # raw HH:MM).
        assert isinstance(row["expected_return"], str)
        assert "T" in row["expected_return"], (
            "expected_return should be an ISO datetime, got "
            + repr(row["expected_return"]))
        assert isinstance(row["overdue_minutes"], int)
        assert row["overdue_minutes"] >= 0

    def test_stepout_without_eta_keeps_fields_none(
            self, admin_client, api, escort_checked_in):
        eid = escort_checked_in["escort"]["id"]
        # Don't pass expected_return at all.
        ex = admin_client.post(f"{api}/escort-attendance/temp-exit",
                               json={"escort_id": eid, "reason": "no eta"})
        assert ex.status_code == 200, ex.text

        p = admin_client.get(f"{api}/presence")
        row = _row(p.json(), eid)
        assert row is not None
        assert row["temp_out"] is True
        assert row["expected_return"] is None
        assert row["expected_return_time"] is None
        assert row["overdue_minutes"] is None

    def test_future_eta_overdue_minutes_zero(
            self, admin_client, api, escort_checked_in):
        eid = escort_checked_in["escort"]["id"]
        # 23:55 is essentially always far enough in the future today
        # to register overdue_minutes == 0 (unless the test runs in
        # the last 5 minutes of the day, which we accept).
        ex = admin_client.post(f"{api}/escort-attendance/temp-exit",
                               json={"escort_id": eid, "reason": "future",
                                     "expected_return": "23:55"})
        assert ex.status_code == 200, ex.text

        row = _row(admin_client.get(f"{api}/presence").json(), eid)
        assert row is not None
        assert row["expected_return_time"] == "23:55"
        assert row["overdue_minutes"] == 0

    def test_past_eta_overdue_minutes_large_positive(
            self, admin_client, api, escort_checked_in):
        eid = escort_checked_in["escort"]["id"]
        # 00:01 is in the deep past for almost any sensible test
        # run time (we'd be 100s of minutes overdue).
        ex = admin_client.post(f"{api}/escort-attendance/temp-exit",
                               json={"escort_id": eid, "reason": "past",
                                     "expected_return": "00:01"})
        assert ex.status_code == 200, ex.text

        row = _row(admin_client.get(f"{api}/presence").json(), eid)
        assert row is not None
        assert row["expected_return_time"] == "00:01"
        assert isinstance(row["overdue_minutes"], int)
        # Should be many minutes overdue, definitely > 5 (the
        # red-tone threshold on the frontend pill).
        assert row["overdue_minutes"] > 5, (
            f"expected large overdue, got {row['overdue_minutes']}")


# ════════════════════════════════════════════════════════════════
# Iter13 — ETA contract regression on member rows
# ════════════════════════════════════════════════════════════════
class TestMemberEtaShape:
    """Light contract check: every member row carries the three
    ETA keys (values may be null/None). The NEW key is
    `expected_return_time` — previously only expected_return +
    overdue_minutes were exposed."""

    def test_every_member_row_has_eta_triple(self, admin_client, api):
        r = admin_client.get(f"{api}/presence")
        assert r.status_code == 200, r.text
        members = r.json().get("members") or []
        if not members:
            pytest.skip("no members in /api/presence to shape-check")
        for m in members:
            for k in ("expected_return", "expected_return_time", "overdue_minutes"):
                assert k in m, f"member {m.get('id')} missing key {k}"
