"""Tests for new features: out-of-geofence + personal QR cards (scan-card)."""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"

ADMIN_EMAIL = "admin@attendance.app"
ADMIN_PW = "Admin@12345"

OFFICE_LAT, OFFICE_LNG = 19.0760, 72.8777
FAR_LAT, FAR_LNG = 19.50, 73.50


def H(t):
    return {"Authorization": f"Bearer {t}"}


@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(f"{API}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PW}, timeout=15)
    assert r.status_code == 200
    return r.json()["access_token"]


@pytest.fixture(scope="session")
def office_qr(admin_token):
    return requests.get(f"{API}/office", headers=H(admin_token)).json()["qr_token"]


def _new_member(admin_token, name="TEST New"):
    email = f"TEST_{uuid.uuid4().hex[:6]}@attendance.app"
    r = requests.post(f"{API}/members", headers=H(admin_token),
                      json={"email": email, "password": "pass1234", "full_name": name,
                            "category": "sailor", "role": "member"})
    assert r.status_code == 200, r.text
    mid = r.json()["id"]
    lr = requests.post(f"{API}/auth/login", json={"email": email, "password": "pass1234"})
    return mid, lr.json()["access_token"]


# ---------- Out-of-geofence on self check-in ----------
class TestOutOfGeofence:
    @pytest.fixture(scope="class")
    def setup(self, admin_token, office_qr):
        mid, tok = _new_member(admin_token, "TEST OOG")
        yield mid, tok
        requests.delete(f"{API}/members/{mid}", headers=H(admin_token))

    def test_far_no_reason_400(self, setup, office_qr):
        _, tok = setup
        r = requests.post(f"{API}/attendance/checkin", headers=H(tok),
                          json={"qr_token": office_qr, "latitude": FAR_LAT, "longitude": FAR_LNG})
        assert r.status_code == 400
        assert r.json()["detail"].startswith("OUT_OF_GEOFENCE:"), r.json()

    def test_far_with_reason_succeeds(self, setup, office_qr, admin_token):
        mid, tok = setup
        r = requests.post(f"{API}/attendance/checkin", headers=H(tok),
                          json={"qr_token": office_qr, "latitude": FAR_LAT, "longitude": FAR_LNG,
                                "reason": "Open-water training"})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["action"] == "checkin"
        assert d["out_of_geofence"] is True
        # Verify presence flagged
        pres = requests.get(f"{API}/presence", headers=H(admin_token)).json()
        target = next((m for m in pres["members"] if m["id"] == mid), None)
        assert target and target["status"] == "on_campus"
        assert target["flagged"] is True
        # Verify stored record via /attendance/status
        st = requests.get(f"{API}/attendance/status", headers=H(tok)).json()
        sess = st["session"]
        assert sess["out_of_geofence"] is True
        assert sess["latitude"] == FAR_LAT and sess["longitude"] == FAR_LNG
        assert sess["geo_reason"] == "Open-water training"


# ---------- In-geofence check-in: no reason needed ----------
class TestInGeofence:
    def test_in_geofence_no_reason(self, admin_token, office_qr):
        mid, tok = _new_member(admin_token, "TEST IN")
        try:
            r = requests.post(f"{API}/attendance/checkin", headers=H(tok),
                              json={"qr_token": office_qr, "latitude": OFFICE_LAT, "longitude": OFFICE_LNG})
            assert r.status_code == 200, r.text
            d = r.json()
            assert d["out_of_geofence"] is False
            st = requests.get(f"{API}/attendance/status", headers=H(tok)).json()
            assert st["session"]["out_of_geofence"] is False
            assert st["session"]["geo_reason"] is None
        finally:
            requests.delete(f"{API}/members/{mid}", headers=H(admin_token))


# ---------- Personal QR Card endpoint ----------
class TestMemberCard:
    def test_card_admin_returns_personal_qr(self, admin_token):
        members = requests.get(f"{API}/members", headers=H(admin_token)).json()
        assert members
        mid = members[0]["id"]
        r = requests.get(f"{API}/members/{mid}/card", headers=H(admin_token))
        assert r.status_code == 200, r.text
        d = r.json()
        assert "personal_qr" in d and d["personal_qr"].startswith("CARD-")
        assert "full_name" in d

    def test_card_member_forbidden(self, admin_token):
        # need a member token
        mid, mtok = _new_member(admin_token, "TEST Card-Forbid")
        try:
            members = requests.get(f"{API}/members", headers=H(mtok)).json()
            target = members[0]["id"]
            r = requests.get(f"{API}/members/{target}/card", headers=H(mtok))
            assert r.status_code == 403
        finally:
            requests.delete(f"{API}/members/{mid}", headers=H(admin_token))

    def test_all_members_have_personal_qr(self, admin_token):
        members = requests.get(f"{API}/members", headers=H(admin_token)).json()
        for m in members:
            r = requests.get(f"{API}/members/{m['id']}/card", headers=H(admin_token))
            assert r.status_code == 200, f"{m['email']} -> {r.text}"
            qr = r.json().get("personal_qr")
            assert qr and qr.startswith("CARD-"), f"{m['email']} missing personal_qr"


# ---------- Card scan toggle ----------
class TestScanCard:
    @pytest.fixture(scope="class")
    def setup(self, admin_token):
        # create scannee + scanner
        s_mid, s_tok = _new_member(admin_token, "TEST Scanner")
        t_mid, _ = _new_member(admin_token, "TEST Scannee")
        card = requests.get(f"{API}/members/{t_mid}/card", headers=H(admin_token)).json()
        yield {"scanner_tok": s_tok, "scanner_id": s_mid, "target_id": t_mid,
               "personal_qr": card["personal_qr"]}
        requests.delete(f"{API}/members/{s_mid}", headers=H(admin_token))
        requests.delete(f"{API}/members/{t_mid}", headers=H(admin_token))

    def test_scan_invalid_card(self, setup):
        r = requests.post(f"{API}/attendance/scan-card", headers=H(setup["scanner_tok"]),
                          json={"personal_qr": "CARD-BOGUS", "latitude": OFFICE_LAT, "longitude": OFFICE_LNG})
        assert r.status_code == 404

    def test_scan_oog_no_reason(self, setup):
        r = requests.post(f"{API}/attendance/scan-card", headers=H(setup["scanner_tok"]),
                          json={"personal_qr": setup["personal_qr"],
                                "latitude": FAR_LAT, "longitude": FAR_LNG})
        assert r.status_code == 400
        assert r.json()["detail"].startswith("OUT_OF_GEOFENCE:")

    def test_scan_checkin_then_checkout(self, setup, admin_token):
        # checkin
        r = requests.post(f"{API}/attendance/scan-card", headers=H(setup["scanner_tok"]),
                          json={"personal_qr": setup["personal_qr"],
                                "latitude": OFFICE_LAT, "longitude": OFFICE_LNG})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["action"] == "checkin"
        assert d["proxy"] is True
        assert "member" in d

        # verify stored checked_in_by
        members = requests.get(f"{API}/members", headers=H(admin_token)).json()
        # use admin to check presence -> ensure on_campus
        pres = requests.get(f"{API}/presence", headers=H(admin_token)).json()
        target = next((m for m in pres["members"] if m["id"] == setup["target_id"]), None)
        assert target and target["status"] == "on_campus"

        # checkout
        r2 = requests.post(f"{API}/attendance/scan-card", headers=H(setup["scanner_tok"]),
                           json={"personal_qr": setup["personal_qr"],
                                 "latitude": OFFICE_LAT, "longitude": OFFICE_LNG})
        assert r2.status_code == 200, r2.text
        d2 = r2.json()
        assert d2["action"] == "checkout"
        assert "hours" in d2 and isinstance(d2["hours"], (int, float))
        assert d2["proxy"] is True

    def test_scan_oog_with_reason(self, setup):
        # target now has no open session — should checkin out-of-geofence with reason
        r = requests.post(f"{API}/attendance/scan-card", headers=H(setup["scanner_tok"]),
                          json={"personal_qr": setup["personal_qr"],
                                "latitude": FAR_LAT, "longitude": FAR_LNG,
                                "reason": "At regatta site"})
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["action"] == "checkin"
        assert d["out_of_geofence"] is True
        assert d["proxy"] is True
