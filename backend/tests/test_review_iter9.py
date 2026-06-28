"""Iter9 review tests — Escort module polish.

Covers the 3 new enhancements:
  1. GET /api/escorts/{escort_id}/recent-visits — visible to any logged-in
     user; returns up to N (default 5) recent visit rows with date,
     check_in_at, check_out_at; `limit` param honoured (clamped 1..20).
  2. POST /api/escorts/{escort_id}/invalidate (admin-only) — flips status
     to 'left', stamps ended_at + invalidated_by + invalidated_at; subsequent
     escort token requests return 401.
  3. Muster institution filter for escorts:
        - GET /api/muster/athletes restricts to escort's institution
        - POST /api/muster/checkin-bulk skips out-of-institution athletes
        - POST /api/muster/checkout-bulk skips out-of-institution athletes
        - Coaches/admins continue to see/muster ALL athletes (no regression)
"""
import uuid
import time
import pytest
import requests


@pytest.fixture(scope="module")
def api(base_url):
    return f"{base_url}/api"


@pytest.fixture(scope="module")
def two_institutions(admin_client, api):
    """Ensure we have two distinct institutions to use for cross-institution
    isolation tests. Re-uses existing institutions when available."""
    r = admin_client.get(f"{api}/institutions")
    assert r.status_code == 200, r.text
    insts = r.json()
    created = []
    while len(insts) < 2:
        body = {"name": f"TEST_Inst_{uuid.uuid4().hex[:6]}"}
        cr = admin_client.post(f"{api}/institutions", json=body)
        assert cr.status_code in (200, 201), cr.text
        created.append(cr.json())
        insts.append(cr.json())
    yield insts[0], insts[1]
    # Cleanup ones we created
    for inst in created:
        try:
            admin_client.delete(f"{api}/institutions/{inst['id']}")
        except Exception:
            pass


@pytest.fixture(scope="module")
def escort_in_inst_a(admin_client, api, two_institutions):
    """Create a fresh active escort under institution A with a unique phone."""
    inst_a, _ = two_institutions
    phone = f"99{uuid.uuid4().int % 100000000:08d}"
    body = {"name": f"TEST_Escort_{uuid.uuid4().hex[:6]}",
            "phone": phone,
            "start_date": "2026-01-01"}
    r = admin_client.post(f"{api}/institutions/{inst_a['id']}/escorts", json=body)
    assert r.status_code in (200, 201), r.text
    esc = r.json()
    yield {**esc, "phone": phone, "institution_obj": inst_a}
    # Cleanup
    try:
        admin_client.delete(f"{api}/escorts/{esc['id']}")
    except Exception:
        pass


@pytest.fixture(scope="module")
def escort_token(base_url, escort_in_inst_a):
    """Phone-login as the escort and grab the bearer token."""
    payload = {"phone": escort_in_inst_a["phone"],
               "device_id": f"test-device-{uuid.uuid4().hex[:8]}",
               "device_name": "pytest", "model": "pytest", "platform": "test"}
    r = requests.post(f"{base_url}/api/auth/phone", json=payload, timeout=30)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data.get("is_escort") is True, f"Expected escort token, got {data}"
    return data["access_token"]


@pytest.fixture(scope="module")
def escort_client(base_url, escort_token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {escort_token}",
                      "Content-Type": "application/json"})
    return s


# ════════════════════════════════════════════════════════════════
# 1. recent-visits endpoint
# ════════════════════════════════════════════════════════════════
class TestRecentVisits:
    def test_recent_visits_returns_list_for_admin(self, admin_client, api, escort_in_inst_a):
        r = admin_client.get(f"{api}/escorts/{escort_in_inst_a['id']}/recent-visits")
        assert r.status_code == 200, r.text
        rows = r.json()
        assert isinstance(rows, list)
        # New escort has no visits yet, but the shape should still be a list
        for row in rows:
            assert "date" in row
            assert "check_in_at" in row
            # check_out_at may be None

    def test_recent_visits_visible_to_escort_token(self, escort_client, api, escort_in_inst_a):
        r = escort_client.get(f"{api}/escorts/{escort_in_inst_a['id']}/recent-visits")
        assert r.status_code == 200, r.text
        assert isinstance(r.json(), list)

    def test_recent_visits_limit_param_honoured(self, admin_client, api, escort_in_inst_a):
        # limit=3 should clamp at 3 rows max
        r = admin_client.get(
            f"{api}/escorts/{escort_in_inst_a['id']}/recent-visits",
            params={"limit": 3})
        assert r.status_code == 200
        assert len(r.json()) <= 3

    def test_recent_visits_after_checkin_includes_today(self, escort_client, api, escort_in_inst_a):
        """Self-check-in as the escort, then recent-visits should surface a row."""
        # Idempotent check-in (no selfie, no athletes)
        ci = escort_client.post(f"{api}/escort-attendance/checkin", json={})
        assert ci.status_code == 200, ci.text

        r = escort_client.get(f"{api}/escorts/{escort_in_inst_a['id']}/recent-visits")
        assert r.status_code == 200
        rows = r.json()
        assert len(rows) >= 1
        # Shape check on first row
        assert "date" in rows[0] and "check_in_at" in rows[0]
        assert rows[0]["check_in_at"] is not None

    def test_recent_visits_requires_auth(self, base_url, escort_in_inst_a):
        r = requests.get(
            f"{base_url}/api/escorts/{escort_in_inst_a['id']}/recent-visits",
            timeout=30)
        assert r.status_code in (401, 403)


# ════════════════════════════════════════════════════════════════
# 3. Muster institution filter for escorts (run BEFORE invalidate so
#    the escort token is still valid)
# ════════════════════════════════════════════════════════════════
class TestMusterEscortInstitutionFilter:
    def test_muster_athletes_admin_full_list(self, admin_client, api):
        r = admin_client.get(f"{api}/muster/athletes", params={"mode": "checkin"})
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["mode"] == "checkin"
        assert isinstance(data["athletes"], list)
        # Admin sees multiple institutions
        insts = {a.get("institution") for a in data["athletes"] if a.get("institution")}
        # Cache the full set for cross-checking the escort scope
        return insts

    def test_muster_athletes_escort_scoped_to_own_institution(
            self, escort_client, admin_client, api, escort_in_inst_a):
        r = escort_client.get(f"{api}/muster/athletes", params={"mode": "checkin"})
        assert r.status_code == 200, r.text
        data = r.json()
        my_inst = escort_in_inst_a["institution_obj"]["name"]
        for a in data["athletes"]:
            # Every returned athlete must be from the escort's own institution
            assert a.get("institution") == my_inst, (
                f"Escort got cross-institution athlete: {a}")

        # And admin sees AT LEAST as many (usually more) for the same mode
        r2 = admin_client.get(f"{api}/muster/athletes", params={"mode": "checkin"})
        assert r2.status_code == 200
        admin_count = r2.json()["count"]
        assert admin_count >= data["count"]

    def test_muster_checkin_bulk_escort_skips_other_institution(
            self, escort_client, admin_client, api, two_institutions, escort_in_inst_a):
        """Send a mixed list — athletes from Inst A (escort's inst) AND Inst B.
        Inst B athletes must be skipped with reason 'outside your institution'."""
        inst_a, inst_b = two_institutions
        my_inst = escort_in_inst_a["institution_obj"]["name"]

        # Pull a few athletes from each institution via admin
        all_r = admin_client.get(f"{api}/muster/athletes", params={"mode": "checkin"})
        assert all_r.status_code == 200
        all_athletes = all_r.json()["athletes"]
        in_inst = [a["id"] for a in all_athletes if a.get("institution") == my_inst][:2]
        out_inst = [a["id"] for a in all_athletes if a.get("institution") and a["institution"] != my_inst][:2]

        if not out_inst:
            pytest.skip("No cross-institution athletes available to test isolation")

        body = {"athlete_ids": in_inst + out_inst}
        r = escort_client.post(f"{api}/muster/checkin-bulk", json=body)
        assert r.status_code == 200, r.text
        data = r.json()

        # All out-of-institution athletes appear in `skipped` with reason
        skipped_outside = [s for s in data["skipped"]
                           if s.get("reason") == "outside your institution"]
        skipped_ids = {s["id"] for s in skipped_outside}
        for oid in out_inst:
            assert oid in skipped_ids, (
                f"Athlete {oid} from foreign institution was NOT skipped: {data}")

        # Cleanup: checkout anyone we successfully checked in to leave state clean
        done_ids = [d["id"] for d in data.get("checked_in", [])]
        if done_ids:
            admin_client.post(f"{api}/muster/checkout-bulk",
                              json={"athlete_ids": done_ids})

    def test_muster_checkout_bulk_escort_skips_other_institution(
            self, escort_client, admin_client, api, two_institutions, escort_in_inst_a):
        """Check in a foreign-institution athlete (as admin), then call
        escort checkout-bulk on them — they must be skipped with
        reason 'outside your institution', not checked out."""
        my_inst = escort_in_inst_a["institution_obj"]["name"]
        all_r = admin_client.get(f"{api}/muster/athletes", params={"mode": "checkin"})
        assert all_r.status_code == 200
        all_athletes = all_r.json()["athletes"]
        out_inst = [a["id"] for a in all_athletes if a.get("institution") and a["institution"] != my_inst][:1]
        if not out_inst:
            pytest.skip("No cross-institution athlete to test checkout isolation")

        # Admin checks them in
        ci = admin_client.post(f"{api}/muster/checkin-bulk",
                               json={"athlete_ids": out_inst})
        assert ci.status_code == 200, ci.text

        # Escort tries to check them out — must be skipped
        co = escort_client.post(f"{api}/muster/checkout-bulk",
                                json={"athlete_ids": out_inst})
        assert co.status_code == 200, co.text
        co_data = co.json()
        reasons = {s.get("reason") for s in co_data.get("skipped", [])}
        assert "outside your institution" in reasons, (
            f"Expected 'outside your institution' skip reason, got: {co_data}")

        # Cleanup — admin checks them out
        admin_client.post(f"{api}/muster/checkout-bulk",
                          json={"athlete_ids": out_inst})

    def test_admin_muster_no_institution_restriction_regression(
            self, admin_client, api):
        """Admin running muster sees athletes across ALL institutions —
        confirm the escort gate didn't accidentally affect admin path."""
        r = admin_client.get(f"{api}/muster/athletes", params={"mode": "checkin"})
        assert r.status_code == 200
        data = r.json()
        insts = {a.get("institution") for a in data["athletes"] if a.get("institution")}
        # If the dataset is rich enough, admin should see > 1 institution
        # When only one institution exists in the DB this assertion is skipped.
        if len(insts) <= 1:
            pytest.skip("Dataset has <=1 institution; admin breadth check inconclusive")
        assert len(insts) > 1


# ════════════════════════════════════════════════════════════════
# 2. invalidate endpoint — runs LAST since it kills the escort token
# ════════════════════════════════════════════════════════════════
class TestInvalidateEscort:
    def test_invalidate_requires_admin(self, escort_client, api, escort_in_inst_a):
        # Escort token attempting to invalidate themselves should be 403
        r = escort_client.post(
            f"{api}/escorts/{escort_in_inst_a['id']}/invalidate", json={})
        assert r.status_code in (401, 403), r.text

    def test_invalidate_flips_status_and_stamps(
            self, admin_client, api, escort_in_inst_a):
        r = admin_client.post(
            f"{api}/escorts/{escort_in_inst_a['id']}/invalidate", json={})
        assert r.status_code == 200, r.text
        doc = r.json()
        assert doc["status"] == "left"
        assert doc.get("ended_at"), "ended_at not stamped"
        assert doc.get("invalidated_by"), "invalidated_by not stamped"
        assert doc.get("invalidated_at"), "invalidated_at not stamped"

    def test_invalidated_escort_token_rejected(
            self, escort_client, api, escort_in_inst_a):
        """The escort token issued before invalidation should now fail on
        any authenticated endpoint (get_current_user re-checks status)."""
        # /auth/me is a cheap authenticated endpoint
        r = escort_client.get(f"{api}/auth/me")
        assert r.status_code == 401, r.text

    def test_invalidate_nonexistent_returns_404(self, admin_client, api):
        r = admin_client.post(f"{api}/escorts/does-not-exist-xyz/invalidate",
                              json={})
        assert r.status_code == 404
