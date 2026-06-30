"""Iter14 review tests — Escorts surface in On Campus + Exited columns.

The Presence response `escorts_present` is no longer "currently checked-in
escorts only". It now contains ALL escort attendance rows for today, each
carrying a `status` discriminator ('on_campus' | 'temp_out' | 'exited') and
a `check_out_at` field (null unless exited). The frontend buckets by status
to render escort sub-sections in the On Campus / Stepped Out / Exited
columns, and the EscortsStrip filters out 'exited' rows.

This file validates the backend contract that powers all of the above.
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
    body = {"name": f"TEST_Iter14_{uuid.uuid4().hex[:6]}"}
    cr = admin_client.post(f"{api}/institutions", json=body)
    assert cr.status_code in (200, 201), cr.text
    return cr.json()


@pytest.fixture
def fresh_escort(admin_client, api, any_institution):
    phone = f"96{uuid.uuid4().int % 100000000:08d}"
    body = {"name": f"TEST_Iter14Esc_{uuid.uuid4().hex[:5]}",
            "phone": phone, "start_date": "2026-01-01",
            "valid_until": "2099-12-31"}
    r = admin_client.post(f"{api}/institutions/{any_institution['id']}/escorts", json=body)
    assert r.status_code in (200, 201), r.text
    esc = r.json()
    yield {**esc, "phone": phone, "institution_obj": any_institution}
    try:
        admin_client.delete(f"{api}/escorts/{esc['id']}")
    except Exception:
        pass


def _find(presence, escort_id):
    for e in presence.get("escorts_present") or []:
        if e.get("escort_id") == escort_id:
            return e
    return None


class TestEscortStatusDiscriminator:
    """Row shape: status, check_out_at, plus existing temp_out/overdue_minutes."""

    def test_on_campus_row_shape(self, admin_client, api, fresh_escort):
        admin_client.post(f"{api}/escort-attendance/checkin",
                          json={"escort_id": fresh_escort["id"],
                                "selfie": TINY, "athlete_ids": []})
        body = admin_client.get(f"{api}/presence").json()
        row = _find(body, fresh_escort["id"])
        assert row is not None
        # New iter14 fields
        assert "status" in row
        assert "check_out_at" in row
        assert row["status"] == "on_campus"
        assert row["check_out_at"] is None
        # Existing iter11/13 fields preserved
        assert row["temp_out"] is False
        # An on-campus escort with no open excursion has no ETA
        assert row.get("overdue_minutes") is None
        assert row.get("expected_return_time") is None

    def test_temp_out_status_when_open_excursion(self, admin_client, api, fresh_escort):
        admin_client.post(f"{api}/escort-attendance/checkin",
                          json={"escort_id": fresh_escort["id"], "athlete_ids": []})
        r = admin_client.post(f"{api}/escort-attendance/temp-exit",
                              json={"escort_id": fresh_escort["id"],
                                    "reason": "lunch",
                                    "expected_return": None})
        assert r.status_code == 200, r.text
        body = admin_client.get(f"{api}/presence").json()
        row = _find(body, fresh_escort["id"])
        assert row is not None
        assert row["status"] == "temp_out"
        assert row["temp_out"] is True
        assert row["check_out_at"] is None
        assert row.get("temp_out_reason") == "lunch"

    def test_return_flips_status_back_to_on_campus(self, admin_client, api, fresh_escort):
        admin_client.post(f"{api}/escort-attendance/checkin",
                          json={"escort_id": fresh_escort["id"], "athlete_ids": []})
        admin_client.post(f"{api}/escort-attendance/temp-exit",
                          json={"escort_id": fresh_escort["id"],
                                "reason": "errand", "expected_return": None})
        # Sanity: temp_out first
        b1 = admin_client.get(f"{api}/presence").json()
        assert _find(b1, fresh_escort["id"])["status"] == "temp_out"
        # Return — close the excursion
        rr = admin_client.post(f"{api}/escort-attendance/return",
                               json={"escort_id": fresh_escort["id"]})
        assert rr.status_code == 200, rr.text
        b2 = admin_client.get(f"{api}/presence").json()
        row = _find(b2, fresh_escort["id"])
        assert row is not None
        assert row["status"] == "on_campus"
        assert row["temp_out"] is False
        assert row["check_out_at"] is None

    def test_checkout_marks_exited_keeps_row(self, admin_client, api, fresh_escort):
        """Core iter14 behaviour: a checked-out escort STAYS in
        escorts_present with status='exited' and check_out_at populated."""
        admin_client.post(f"{api}/escort-attendance/checkin",
                          json={"escort_id": fresh_escort["id"], "athlete_ids": []})
        co = admin_client.post(f"{api}/escort-attendance/checkout",
                               json={"escort_id": fresh_escort["id"],
                                     "athlete_ids": []})
        assert co.status_code == 200, co.text
        body = admin_client.get(f"{api}/presence").json()
        row = _find(body, fresh_escort["id"])
        assert row is not None, "checked-out escort must remain in escorts_present"
        assert row["status"] == "exited"
        assert row["check_out_at"] is not None
        # Exited rows are NOT stepped out — they've left for the day
        assert row["temp_out"] is False
        assert row.get("overdue_minutes") is None

    def test_exited_takes_precedence_over_temp_out(self, admin_client, api, fresh_escort):
        """If a row has both an open excursion AND check_out_at set, exited wins."""
        admin_client.post(f"{api}/escort-attendance/checkin",
                          json={"escort_id": fresh_escort["id"], "athlete_ids": []})
        admin_client.post(f"{api}/escort-attendance/temp-exit",
                          json={"escort_id": fresh_escort["id"],
                                "reason": "test", "expected_return": None})
        co = admin_client.post(f"{api}/escort-attendance/checkout",
                               json={"escort_id": fresh_escort["id"],
                                     "athlete_ids": []})
        # checkout may legitimately fail if backend requires a closed
        # excursion first; if it succeeds, exited must win.
        if co.status_code == 200:
            body = admin_client.get(f"{api}/presence").json()
            row = _find(body, fresh_escort["id"])
            assert row is not None
            assert row["status"] == "exited"
            assert row["temp_out"] is False
            assert row["check_out_at"] is not None
        else:
            # Acceptable: backend enforces "return before checkout".
            # In that case the row stays in temp_out — also valid.
            body = admin_client.get(f"{api}/presence").json()
            row = _find(body, fresh_escort["id"])
            assert row is not None
            assert row["status"] in ("temp_out", "on_campus")


class TestHistoricalAndRegression:
    def test_historical_returns_empty_escorts(self, admin_client, api, fresh_escort):
        admin_client.post(f"{api}/escort-attendance/checkin",
                          json={"escort_id": fresh_escort["id"], "athlete_ids": []})
        past = (dt.date.today() - dt.timedelta(days=14)).isoformat()
        r = admin_client.get(f"{api}/presence", params={"on": past})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("is_historical") is True
        assert body.get("escorts_present") == []

    def test_member_rows_still_have_eta_triple(self, admin_client, api):
        """Regression — every member row still carries the ETA triple
        (expected_return, expected_return_time, overdue_minutes)."""
        body = admin_client.get(f"{api}/presence").json()
        for m in body.get("members", []):
            assert "expected_return" in m
            assert "expected_return_time" in m
            assert "overdue_minutes" in m

    def test_no_duplicate_escort_ids(self, admin_client, api):
        """Even with exited rows now included, each escort_id appears at most once."""
        body = admin_client.get(f"{api}/presence").json()
        ids = [e["escort_id"] for e in body.get("escorts_present") or []]
        assert len(ids) == len(set(ids)), f"duplicates in escorts_present: {ids}"

    def test_statuses_are_within_known_set(self, admin_client, api):
        body = admin_client.get(f"{api}/presence").json()
        for e in body.get("escorts_present") or []:
            assert e.get("status") in {"on_campus", "temp_out", "exited"}, \
                f"unexpected status: {e.get('status')}"

    def test_no_heavy_selfie_payload_leak(self, admin_client, api):
        body = admin_client.get(f"{api}/presence").json()
        for e in body.get("escorts_present") or []:
            assert "check_in_selfie" not in e
            assert "check_out_selfie" not in e
