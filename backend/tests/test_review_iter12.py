"""Iter12 review tests — Escort step-out also surfaces in Presence's
'Stepped Out' column (in addition to the existing EscortsStrip chip).

Since this iteration's NEW work is frontend-only (the backend already
shipped `escorts_present` with `temp_out`/`temp_out_reason` in iter11),
these backend tests are regression checks that the contract feeding
the column is intact:

  1. Active escort checked-in, no step-out  →  escorts_present row has
     temp_out=False, temp_out_reason=None.
  2. After /escort-attendance/temp-exit  →  same row flips to
     temp_out=True with temp_out_reason=<reason>.
  3. After /escort-attendance/return     →  row flips back to
     temp_out=False, temp_out_reason=None.
  4. Historical /api/presence?on=<past>  →  escorts_present == [].
  5. Step-out while already stepped out → 400 (defensive).
  6. Return without an open step-out → 400 (defensive).
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
                           json={"name": f"TEST_Iter12_{uuid.uuid4().hex[:6]}"})
    assert cr.status_code in (200, 201), cr.text
    return cr.json()


@pytest.fixture
def escort_checked_in(admin_client, api, any_institution):
    """Create an active escort and check them in for today via the
    admin-as-proxy path. Yields {escort, attendance_id}.
    Cleans up the escort + (best-effort) the attendance row."""
    phone = f"96{uuid.uuid4().int % 100000000:08d}"
    body = {"name": f"TEST_Iter12Esc_{uuid.uuid4().hex[:5]}",
            "phone": phone, "start_date": "2026-01-01"}
    r = admin_client.post(f"{api}/institutions/{any_institution['id']}/escorts", json=body)
    assert r.status_code in (200, 201), r.text
    esc = r.json()

    ci = admin_client.post(f"{api}/escort-attendance/checkin",
                           json={"escort_id": esc["id"], "selfie": TINY, "athlete_ids": []})
    assert ci.status_code == 200, ci.text
    att = ci.json()

    yield {"escort": esc, "attendance": att}

    # best-effort cleanup
    try:
        # close any open excursion so checkout passes
        admin_client.post(f"{api}/escort-attendance/return",
                          json={"escort_id": esc["id"]})
    except Exception:
        pass
    try:
        admin_client.post(f"{api}/escort-attendance/checkout",
                          json={"escort_id": esc["id"], "selfie": TINY, "athlete_ids": []})
    except Exception:
        pass
    try:
        admin_client.delete(f"{api}/escorts/{esc['id']}")
    except Exception:
        pass


def _find_in_present(presence, escort_id):
    for e in presence.get("escorts_present") or []:
        if e.get("escort_id") == escort_id:
            return e
    return None


# ════════════════════════════════════════════════════════════════
# Presence /api/presence  →  escorts_present.temp_out wiring
# ════════════════════════════════════════════════════════════════
class TestPresenceTempOutWiring:
    def test_active_no_stepout_has_temp_out_false(
            self, admin_client, api, escort_checked_in):
        eid = escort_checked_in["escort"]["id"]
        r = admin_client.get(f"{api}/presence")
        assert r.status_code == 200, r.text
        row = _find_in_present(r.json(), eid)
        assert row is not None, "escort not in escorts_present"
        assert row["temp_out"] is False
        assert row.get("temp_out_reason") in (None, "")
        # shape sanity
        for k in ("attendance_id", "escort_id", "name",
                  "institution", "check_in_at"):
            assert k in row, f"missing key {k} in escorts_present row"

    def test_temp_exit_flips_temp_out_true_with_reason(
            self, admin_client, api, escort_checked_in):
        eid = escort_checked_in["escort"]["id"]
        reason = "TEST_Iter12 lunch run"
        r = admin_client.post(f"{api}/escort-attendance/temp-exit",
                              json={"escort_id": eid, "reason": reason})
        assert r.status_code == 200, r.text

        p = admin_client.get(f"{api}/presence")
        assert p.status_code == 200, p.text
        row = _find_in_present(p.json(), eid)
        assert row is not None
        assert row["temp_out"] is True
        assert row["temp_out_reason"] == reason

    def test_return_flips_temp_out_back_to_false(
            self, admin_client, api, escort_checked_in):
        eid = escort_checked_in["escort"]["id"]
        # Step out first
        r = admin_client.post(f"{api}/escort-attendance/temp-exit",
                              json={"escort_id": eid, "reason": "stub"})
        assert r.status_code == 200, r.text
        # Then return
        ret = admin_client.post(f"{api}/escort-attendance/return",
                                json={"escort_id": eid})
        assert ret.status_code == 200, ret.text

        p = admin_client.get(f"{api}/presence")
        row = _find_in_present(p.json(), eid)
        assert row is not None
        assert row["temp_out"] is False
        assert row.get("temp_out_reason") in (None, "")

    def test_historical_presence_returns_empty_escorts(
            self, admin_client, api, escort_checked_in):
        # iter11 documented contract: ?on=<past> → escorts_present == []
        past = (dt.date.today() - dt.timedelta(days=3)).isoformat()
        r = admin_client.get(f"{api}/presence?on={past}")
        assert r.status_code == 200, r.text
        assert r.json().get("escorts_present") == []

    def test_double_stepout_rejected(
            self, admin_client, api, escort_checked_in):
        eid = escort_checked_in["escort"]["id"]
        r1 = admin_client.post(f"{api}/escort-attendance/temp-exit",
                               json={"escort_id": eid, "reason": "first"})
        assert r1.status_code == 200, r1.text
        r2 = admin_client.post(f"{api}/escort-attendance/temp-exit",
                               json={"escort_id": eid, "reason": "second"})
        assert r2.status_code == 400, r2.text

    def test_return_without_open_stepout_rejected(
            self, admin_client, api, escort_checked_in):
        eid = escort_checked_in["escort"]["id"]
        r = admin_client.post(f"{api}/escort-attendance/return",
                              json={"escort_id": eid})
        assert r.status_code == 400, r.text
