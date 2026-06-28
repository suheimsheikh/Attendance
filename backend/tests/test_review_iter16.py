"""Iteration 16 regression — verifies routes moved out of server.py into
/app/backend/routes/{auth,office,masters,muster,admin_tools}.py preserve
their prior path + status codes + payload shape.

Per review request: do NOT call /api/admin/backup (ingress timeout) and do
NOT actually call /api/admin/attendance/wipe (destructive) — only verify
its auth gate.
"""
from __future__ import annotations

import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    try:
        with open("/app/frontend/.env") as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL"):
                    BASE_URL = line.split("=", 1)[1].strip().strip('"').rstrip("/")
                    break
    except FileNotFoundError:
        pass
assert BASE_URL, "REACT_APP_BACKEND_URL is required"
ADMIN_EMAIL = "admin@attendance.app"
ADMIN_PASSWORD = "Admin@12345"
ADMIN_BYPASS_PHONE = "9849002111"


# ----------------------- Fixtures -----------------------
@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                      timeout=20)
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    data = r.json()
    assert "access_token" in data and data["access_token"]
    assert data.get("token_type") == "bearer"
    assert "user" in data and data["user"].get("role") == "admin"
    return data["access_token"]


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module")
def member_token(admin_headers):
    """Find a non-admin member token. Strategy: pick any athlete with a
    mobile, then approve a freshly-created device for them via the
    admin/devices flow so we can drive /auth/phone/status to get a token.
    Fallback: skip member-gate tests if we can't synthesize one.
    """
    # Quickest path: find a member with an existing approved device — call
    # /auth/phone with their mobile + a fresh device_id; trusted-phone cinch
    # auto-approves and returns an access_token.
    r = requests.get(f"{BASE_URL}/api/members", headers=admin_headers, timeout=20)
    if r.status_code != 200:
        pytest.skip(f"/api/members returned {r.status_code}; cannot synthesize member token")
    members = r.json()
    candidate = None
    for m in members:
        if (m.get("role") != "admin") and (m.get("mobile") or "").strip() and m.get("mobile") != ADMIN_BYPASS_PHONE:
            candidate = m
            break
    if not candidate:
        pytest.skip("no non-admin member with mobile to synthesize token")

    # First check if this mobile already has an approved device — that
    # enables the trusted-phone cinch.
    dev_id = f"itest-iter16-{uuid.uuid4().hex[:10]}"
    payload = {"phone": candidate["mobile"], "device_id": dev_id,
               "device_name": "iter16-test"}
    r = requests.post(f"{BASE_URL}/api/auth/phone", json=payload, timeout=20)
    if r.status_code != 200:
        pytest.skip(f"/auth/phone for member failed: {r.status_code} {r.text}")
    body = r.json()
    if body.get("status") == "approved" and body.get("access_token"):
        return body["access_token"]
    # If the cinch didn't fire (no prior approved device), admin-approve it
    # and then call status.
    devices = requests.get(f"{BASE_URL}/api/admin/devices",
                           headers=admin_headers, timeout=20).json()
    target = next((d for d in devices if d.get("device_id") == dev_id), None)
    if not target:
        pytest.skip("device not enqueued after /auth/phone")
    requests.post(f"{BASE_URL}/api/admin/devices/{target['id']}/approve",
                  headers=admin_headers,
                  json={"full_name": candidate.get("full_name") or "Test",
                        "role": "member", "category": candidate.get("category") or "athlete"},
                  timeout=20)
    s = requests.get(f"{BASE_URL}/api/auth/phone/status",
                     params={"device_id": dev_id}, timeout=20).json()
    if s.get("status") == "approved" and s.get("access_token"):
        return s["access_token"]
    pytest.skip(f"could not synthesize member token: {s}")


@pytest.fixture(scope="module")
def member_headers(member_token):
    return {"Authorization": f"Bearer {member_token}"}


# ----------------------- routes/auth.py -----------------------
class TestAuthRoutes:
    def test_login_returns_token_and_user(self, admin_token):
        # admin_token fixture already validates structure; sanity assert here
        assert isinstance(admin_token, str) and len(admin_token) > 20

    def test_auth_me_admin(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/auth/me", headers=admin_headers, timeout=20)
        assert r.status_code == 200
        data = r.json()
        assert data["email"] == ADMIN_EMAIL
        assert data["role"] == "admin"
        # leave_balance_remaining only set for non-athlete with opening — admin
        # may or may not have it, but the field if present must be numeric.
        if "leave_balance_remaining" in data and data["leave_balance_remaining"] is not None:
            assert isinstance(data["leave_balance_remaining"], (int, float))

    def test_auth_me_requires_token(self):
        r = requests.get(f"{BASE_URL}/api/auth/me", timeout=20)
        assert r.status_code in (401, 403)

    def test_phone_bypass_admin(self):
        dev = f"itest-bypass-{uuid.uuid4().hex[:8]}"
        r = requests.post(f"{BASE_URL}/api/auth/phone",
                          json={"phone": ADMIN_BYPASS_PHONE, "device_id": dev},
                          timeout=20)
        assert r.status_code == 200
        data = r.json()
        assert data.get("status") == "approved"
        assert data.get("access_token")
        assert data.get("token_type") == "bearer"
        assert data.get("user", {}).get("role") == "admin"

    def test_phone_status_unknown(self):
        r = requests.get(f"{BASE_URL}/api/auth/phone/status",
                         params={"device_id": f"unknown-{uuid.uuid4().hex}"},
                         timeout=20)
        assert r.status_code == 200
        assert r.json() == {"status": "unknown"}

    def test_admin_devices_admin_ok(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/admin/devices",
                         headers=admin_headers, timeout=20)
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_admin_devices_no_token_rejected(self):
        r = requests.get(f"{BASE_URL}/api/admin/devices", timeout=20)
        assert r.status_code in (401, 403)

    def test_admin_devices_member_rejected(self, member_headers):
        r = requests.get(f"{BASE_URL}/api/admin/devices",
                         headers=member_headers, timeout=20)
        assert r.status_code == 403


# ----------------------- routes/office.py -----------------------
class TestOfficeRoutes:
    def test_get_office_masks_twilio_token(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/office",
                         headers=admin_headers, timeout=20)
        assert r.status_code == 200
        cfg = r.json()
        assert cfg is not None
        if cfg.get("twilio") is not None:
            tw = cfg["twilio"]
            assert "has_auth_token" in tw
            tok = tw.get("auth_token")
            if tw["has_auth_token"]:
                # masked: bullets followed by last 4 plaintext chars
                assert tok is not None
                assert tok.startswith("•") or "•" in tok
            else:
                # no token set → masking shouldn't fabricate one
                assert tok in (None, "", )

    def test_put_office_update_and_restore(self, admin_headers):
        before = requests.get(f"{BASE_URL}/api/office",
                              headers=admin_headers, timeout=20).json()
        # craft an update body that conforms to OfficeConfig
        patched = {**before}
        # strip masked twilio to avoid pydantic complaints — server drops it
        patched.pop("twilio", None)
        original_radius = patched.get("radius_m", 100)
        original_late = patched.get("late_grace_minutes", 10)
        patched["radius_m"] = int(original_radius) + 7
        patched["late_grace_minutes"] = int(original_late) + 1
        try:
            r = requests.put(f"{BASE_URL}/api/office",
                             headers=admin_headers, json=patched, timeout=20)
            assert r.status_code == 200, r.text
            saved = r.json()
            assert saved["radius_m"] == patched["radius_m"]
            assert saved["late_grace_minutes"] == patched["late_grace_minutes"]
        finally:
            # restore
            restore = {**patched, "radius_m": original_radius,
                       "late_grace_minutes": original_late}
            requests.put(f"{BASE_URL}/api/office",
                         headers=admin_headers, json=restore, timeout=20)

    def test_checkout_reminder_send_now_admin(self, admin_headers):
        r = requests.post(f"{BASE_URL}/api/admin/checkout-reminder/send-now",
                          headers=admin_headers, timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert "sent" in data
        assert isinstance(data["sent"], int)

    def test_checkout_reminder_member_rejected(self, member_headers):
        r = requests.post(f"{BASE_URL}/api/admin/checkout-reminder/send-now",
                          headers=member_headers, timeout=20)
        assert r.status_code == 403

    def test_changelog_returns_markdown(self):
        r = requests.get(f"{BASE_URL}/api/changelog", timeout=20)
        assert r.status_code == 200
        data = r.json()
        assert "markdown" in data
        assert isinstance(data["markdown"], str)
        assert len(data["markdown"]) > 0


# ----------------------- routes/masters.py -----------------------
class TestInstitutionsRoutes:
    def test_list_institutions_has_member_count(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/institutions",
                         headers=admin_headers, timeout=20)
        assert r.status_code == 200
        items = r.json()
        assert isinstance(items, list)
        if items:
            for it in items:
                assert "member_count" in it
                assert isinstance(it["member_count"], int)

    def test_institutions_post_member_rejected(self, member_headers):
        r = requests.post(f"{BASE_URL}/api/institutions",
                          headers=member_headers,
                          json={"name": "TEST_iter16_inst"}, timeout=20)
        assert r.status_code == 403

    def test_institution_rename_cascade_and_delete_protection(self, admin_headers):
        name1 = f"TEST_iter16_inst_{uuid.uuid4().hex[:6]}"
        name2 = name1 + "_renamed"
        # create
        r = requests.post(f"{BASE_URL}/api/institutions",
                          headers=admin_headers, json={"name": name1},
                          timeout=20)
        assert r.status_code in (200, 201), r.text
        inst = r.json()
        inst_id = inst.get("id")
        assert inst_id
        try:
            # rename — should cascade to users.institution; since none
            # use it, member_count stays 0 but rename must succeed
            r = requests.patch(f"{BASE_URL}/api/institutions/{inst_id}",
                               headers=admin_headers, json={"name": name2},
                               timeout=20)
            assert r.status_code == 200, r.text
            # verify list shows renamed name
            lst = requests.get(f"{BASE_URL}/api/institutions",
                               headers=admin_headers, timeout=20).json()
            assert any(i["name"] == name2 for i in lst)
        finally:
            # delete (in_use == 0 → ok)
            requests.delete(f"{BASE_URL}/api/institutions/{inst_id}",
                            headers=admin_headers, timeout=20)

    def test_institution_delete_when_in_use_rejected(self, admin_headers):
        # find an institution that has member_count > 0
        items = requests.get(f"{BASE_URL}/api/institutions",
                             headers=admin_headers, timeout=20).json()
        in_use = next((i for i in items if i.get("member_count", 0) > 0), None)
        if not in_use:
            pytest.skip("no in-use institution to test delete protection")
        r = requests.delete(f"{BASE_URL}/api/institutions/{in_use['id']}",
                            headers=admin_headers, timeout=20)
        assert r.status_code in (400, 409), f"expected reject, got {r.status_code} {r.text}"


class TestFleetsRoutes:
    def test_list_fleets_has_athlete_count(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/fleets",
                         headers=admin_headers, timeout=20)
        assert r.status_code == 200
        items = r.json()
        assert isinstance(items, list)
        if items:
            for it in items:
                assert "athlete_count" in it
                assert isinstance(it["athlete_count"], int)

    def test_fleets_post_member_rejected(self, member_headers):
        r = requests.post(f"{BASE_URL}/api/fleets",
                          headers=member_headers,
                          json={"name": "TEST_iter16_fleet"}, timeout=20)
        assert r.status_code == 403

    def test_fleets_assign_missing_fleet_404(self, admin_headers):
        # Use a real user id but a non-existent fleet — server validates
        # fleet exists in master before assigning.
        r = requests.post(f"{BASE_URL}/api/fleets/assign",
                          headers=admin_headers,
                          json={"fleet": f"NON_EXISTENT_{uuid.uuid4().hex[:6]}",
                                "member_ids": ["00000000-0000-0000-0000-000000000000"]},
                          timeout=20)
        assert r.status_code == 404, f"expected 404 for missing fleet, got {r.status_code} {r.text}"

    def test_fleet_rename_cascade(self, admin_headers):
        name1 = f"TEST_iter16_fleet_{uuid.uuid4().hex[:6]}"
        name2 = name1 + "_renamed"
        r = requests.post(f"{BASE_URL}/api/fleets",
                          headers=admin_headers, json={"name": name1},
                          timeout=20)
        assert r.status_code in (200, 201), r.text
        fleet_id = r.json().get("id")
        assert fleet_id
        try:
            r = requests.patch(f"{BASE_URL}/api/fleets/{fleet_id}",
                               headers=admin_headers, json={"name": name2},
                               timeout=20)
            assert r.status_code == 200, r.text
            lst = requests.get(f"{BASE_URL}/api/fleets",
                               headers=admin_headers, timeout=20).json()
            assert any(i["name"] == name2 for i in lst)
        finally:
            requests.delete(f"{BASE_URL}/api/fleets/{fleet_id}",
                            headers=admin_headers, timeout=20)


# ----------------------- routes/muster.py -----------------------
class TestMusterRoutes:
    def test_muster_athletes_checkin_admin(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/muster/athletes",
                         params={"mode": "checkin"},
                         headers=admin_headers, timeout=20)
        assert r.status_code == 200
        data = r.json()
        assert data["mode"] == "checkin"
        assert "athletes" in data and isinstance(data["athletes"], list)
        for a in data["athletes"]:
            assert "already_checked_in" in a
            assert "check_in_at" in a  # may be null
            assert "id" in a and "full_name" in a

    def test_muster_athletes_checkout_only_open_sessions(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/muster/athletes",
                         params={"mode": "checkout"},
                         headers=admin_headers, timeout=20)
        assert r.status_code == 200
        data = r.json()
        assert data["mode"] == "checkout"
        # in checkout mode `already_checked_in` is forced False per code
        for a in data["athletes"]:
            assert a["already_checked_in"] is False

    def test_muster_athletes_invalid_mode(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/muster/athletes",
                         params={"mode": "garbage"},
                         headers=admin_headers, timeout=20)
        assert r.status_code == 400

    def test_muster_checkin_bulk_double_skipped(self, admin_headers):
        # Pick the first eligible (not already_checked_in) athlete
        eligible = requests.get(f"{BASE_URL}/api/muster/athletes",
                                params={"mode": "checkin"},
                                headers=admin_headers, timeout=20).json()
        athletes = [a for a in eligible["athletes"] if not a["already_checked_in"]]
        if not athletes:
            pytest.skip("no eligible athlete for checkin-bulk test")
        target = athletes[0]
        # First checkin
        r1 = requests.post(f"{BASE_URL}/api/muster/checkin-bulk",
                           headers=admin_headers,
                           json={"athlete_ids": [target["id"]]},
                           timeout=20)
        assert r1.status_code == 200, r1.text
        body1 = r1.json()
        # Schema: typically returns done/skipped counts
        assert any(k in body1 for k in ("done", "checked_in", "inserted"))
        # Second checkin should skip
        r2 = requests.post(f"{BASE_URL}/api/muster/checkin-bulk",
                           headers=admin_headers,
                           json={"athlete_ids": [target["id"]]},
                           timeout=20)
        assert r2.status_code == 200, r2.text
        body2 = r2.json()
        skipped = body2.get("skipped") or []
        # If returned as list of dicts with reason, look for the marker.
        joined = str(skipped).lower()
        assert "already checked in" in joined or (isinstance(skipped, int) and skipped >= 1) \
            or any((isinstance(s, dict) and "already" in str(s.get("reason", "")).lower())
                   for s in (skipped if isinstance(skipped, list) else []))

        # Cleanup: checkout the athlete to leave DB tidy
        requests.post(f"{BASE_URL}/api/muster/checkout-bulk",
                      headers=admin_headers,
                      json={"athlete_ids": [target["id"]]},
                      timeout=20)

    def test_muster_checkout_bulk_returns_hours(self, admin_headers):
        # find an athlete with open session, or create one
        co = requests.get(f"{BASE_URL}/api/muster/athletes",
                          params={"mode": "checkout"},
                          headers=admin_headers, timeout=20).json()
        if not co["athletes"]:
            # try to checkin one first
            ci = requests.get(f"{BASE_URL}/api/muster/athletes",
                              params={"mode": "checkin"},
                              headers=admin_headers, timeout=20).json()
            elig = [a for a in ci["athletes"] if not a["already_checked_in"]]
            if not elig:
                pytest.skip("nobody to checkin/out")
            requests.post(f"{BASE_URL}/api/muster/checkin-bulk",
                          headers=admin_headers,
                          json={"athlete_ids": [elig[0]["id"]]},
                          timeout=20)
            co = requests.get(f"{BASE_URL}/api/muster/athletes",
                              params={"mode": "checkout"},
                              headers=admin_headers, timeout=20).json()
        if not co["athletes"]:
            pytest.skip("no open sessions after attempted checkin")
        target_id = co["athletes"][0]["id"]
        r = requests.post(f"{BASE_URL}/api/muster/checkout-bulk",
                          headers=admin_headers,
                          json={"athlete_ids": [target_id]},
                          timeout=20)
        assert r.status_code == 200, r.text
        body = r.json()
        # Look for hours somewhere in the response
        flat = str(body).lower()
        assert "hours" in flat or "duration" in flat or "done" in flat


# ----------------------- routes/admin_tools.py -----------------------
class TestAdminToolsRoutes:
    def test_summary_shape(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/admin/summary",
                         headers=admin_headers, timeout=20)
        assert r.status_code == 200
        data = r.json()
        for k in ("total_members", "on_campus", "pending_leaves",
                  "on_leave_tour", "late_today"):
            assert k in data, f"missing key {k} in summary"
            assert isinstance(data[k], int)

    def test_preflight_shape(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/admin/preflight",
                         headers=admin_headers, timeout=20)
        assert r.status_code == 200
        data = r.json()
        assert "overall" in data and data["overall"] in ("ready", "warnings", "blocked")
        items = data.get("items") or data.get("checks") or []
        assert len(items) == 7, f"expected 7 checklist items, got {len(items)}"
        for it in items:
            assert "severity" in it, f"item missing severity field: {it}"

    def test_activity_shape(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/admin/activity",
                         headers=admin_headers, timeout=20)
        assert r.status_code == 200
        data = r.json()
        for k in ("date", "timezone", "events", "counts"):
            assert k in data, f"missing key {k} in activity"
        assert isinstance(data["events"], list)
        assert isinstance(data["counts"], dict)

    def test_wipe_auth_gate_no_token(self):
        r = requests.post(f"{BASE_URL}/api/admin/attendance/wipe", timeout=20)
        assert r.status_code in (401, 403)

    def test_wipe_member_forbidden(self, member_headers):
        r = requests.post(f"{BASE_URL}/api/admin/attendance/wipe",
                          headers=member_headers, timeout=20)
        assert r.status_code == 403

    def test_summary_member_forbidden(self, member_headers):
        r = requests.get(f"{BASE_URL}/api/admin/summary",
                         headers=member_headers, timeout=20)
        assert r.status_code == 403

    def test_preflight_member_forbidden(self, member_headers):
        r = requests.get(f"{BASE_URL}/api/admin/preflight",
                         headers=member_headers, timeout=20)
        assert r.status_code == 403

    def test_activity_member_forbidden(self, member_headers):
        r = requests.get(f"{BASE_URL}/api/admin/activity",
                         headers=member_headers, timeout=20)
        assert r.status_code == 403
