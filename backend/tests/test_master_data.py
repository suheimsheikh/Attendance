"""Iteration 3 — Master data: Office settings + per-member custom fields + bulk import."""
import io
import os
import re
import openpyxl
import pytest
import requests

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"
ADMIN = {"email": "admin@attendance.app", "password": "Admin@12345"}


# ---------- helpers ----------
@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{API}/auth/login", json=ADMIN, timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def admin_hdr(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(scope="module")
def office(admin_hdr):
    r = requests.get(f"{API}/office", headers=admin_hdr, timeout=30)
    assert r.status_code == 200
    return r.json()


# bulk import file used by multiple tests
def _build_xlsx(rows):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Members"
    ws.append(["full_name", "mobile", "email", "password", "rank", "category", "work_start", "work_end"])
    for row in rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return buf


# ============================ Office Settings ============================
class TestOffice:
    def test_get_office_returns_default_work_hours(self, admin_hdr):
        r = requests.get(f"{API}/office", headers=admin_hdr, timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert "default_work_start" in data and "default_work_end" in data
        assert re.match(r"^\d{1,2}:\d{2}$", data["default_work_start"])
        assert re.match(r"^\d{1,2}:\d{2}$", data["default_work_end"])

    def test_put_office_persists(self, admin_hdr, office):
        # save a known-good payload; restore originals at the end
        new_payload = {
            "name": "TEST Naval Academy",
            "latitude": 15.4909,
            "longitude": 73.8278,
            "radius_m": 80,
            "default_work_start": "08:30",
            "default_work_end": "16:30",
        }
        r = requests.put(f"{API}/office", json=new_payload, headers=admin_hdr, timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        for k, v in new_payload.items():
            assert body[k] == v, f"mismatch on {k}: got {body.get(k)}"
        # confirm via fresh GET
        g = requests.get(f"{API}/office", headers=admin_hdr, timeout=30).json()
        for k, v in new_payload.items():
            assert g[k] == v

    def test_put_office_forbidden_for_member(self, admin_hdr):
        # create a temp member
        m = {
            "email": "TEST_member_office@attendance.app",
            "password": "secret123",
            "full_name": "TEST Member Office",
            "category": "sailor",
        }
        # ensure clean
        existing = requests.get(f"{API}/members", headers=admin_hdr).json()
        for u in existing:
            if u["email"] == m["email"]:
                requests.delete(f"{API}/members/{u['id']}", headers=admin_hdr)
        c = requests.post(f"{API}/members", json=m, headers=admin_hdr, timeout=30)
        assert c.status_code == 200, c.text
        mid = c.json()["id"]
        try:
            login = requests.post(f"{API}/auth/login",
                                  json={"email": m["email"], "password": m["password"]}).json()
            tok = login["access_token"]
            r = requests.put(f"{API}/office",
                             json={"name": "X", "latitude": 0, "longitude": 0, "radius_m": 50,
                                   "default_work_start": "09:00", "default_work_end": "17:00"},
                             headers={"Authorization": f"Bearer {tok}"}, timeout=30)
            assert r.status_code == 403
        finally:
            requests.delete(f"{API}/members/{mid}", headers=admin_hdr)


# ============================ Member custom fields ============================
class TestMemberFields:
    def test_create_member_with_new_fields_and_patch(self, admin_hdr):
        payload = {
            "email": "TEST_custom_member@attendance.app",
            "password": "secret123",
            "full_name": "TEST Custom Member",
            "category": "sailor",
            "rank": "PO",
            "mobile": "9876512345",
            "work_start": "07:30",
            "work_end": "15:30",
        }
        # cleanup if exists
        for u in requests.get(f"{API}/members", headers=admin_hdr).json():
            if u["email"] == payload["email"]:
                requests.delete(f"{API}/members/{u['id']}", headers=admin_hdr)
        r = requests.post(f"{API}/members", json=payload, headers=admin_hdr, timeout=30)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["mobile"] == "9876512345"
        assert body["work_start"] == "07:30"
        assert body["work_end"] == "15:30"
        mid = body["id"]
        try:
            # GET /api/members reflects fields
            allm = requests.get(f"{API}/members", headers=admin_hdr).json()
            this = next(u for u in allm if u["id"] == mid)
            assert this["mobile"] == "9876512345"
            assert this["work_start"] == "07:30"
            # PATCH updates the fields
            p = requests.patch(f"{API}/members/{mid}",
                               json={"mobile": "9000000000", "work_start": "06:00", "work_end": "14:00"},
                               headers=admin_hdr, timeout=30)
            assert p.status_code == 200, p.text
            assert p.json()["mobile"] == "9000000000"
            assert p.json()["work_start"] == "06:00"
            assert p.json()["work_end"] == "14:00"
        finally:
            requests.delete(f"{API}/members/{mid}", headers=admin_hdr)


# ============================ Excel template ============================
class TestTemplate:
    def test_template_returns_xlsx_with_correct_headers(self, admin_hdr):
        r = requests.get(f"{API}/members/import-template", headers=admin_hdr, timeout=30)
        assert r.status_code == 200
        ct = r.headers.get("content-type", "")
        assert "spreadsheetml.sheet" in ct, ct
        wb = openpyxl.load_workbook(io.BytesIO(r.content))
        assert "Members" in wb.sheetnames
        ws = wb["Members"]
        headers = [c.value for c in ws[1]]
        assert headers == ["full_name", "mobile", "email", "password", "rank",
                           "category", "work_start", "work_end"]

    def test_template_forbidden_for_member(self, admin_hdr):
        m = {
            "email": "TEST_tmpl_member@attendance.app",
            "password": "secret123",
            "full_name": "TEST Tmpl Member",
            "category": "sailor",
        }
        for u in requests.get(f"{API}/members", headers=admin_hdr).json():
            if u["email"] == m["email"]:
                requests.delete(f"{API}/members/{u['id']}", headers=admin_hdr)
        c = requests.post(f"{API}/members", json=m, headers=admin_hdr)
        mid = c.json()["id"]
        try:
            tok = requests.post(f"{API}/auth/login",
                                json={"email": m["email"], "password": m["password"]}).json()["access_token"]
            r = requests.get(f"{API}/members/import-template",
                             headers={"Authorization": f"Bearer {tok}"})
            assert r.status_code == 403
        finally:
            requests.delete(f"{API}/members/{mid}", headers=admin_hdr)


# ============================ Bulk Import ============================
MOBILE_FULL = "9810099001"
MOBILE_MIN = "9810099002"

EMAIL_FULL = "test_import_full@attendance.app"
EMAIL_MIN = f"{MOBILE_MIN}@attendance.app"


class TestBulkImport:
    @pytest.fixture(autouse=True)
    def _cleanup_before(self, admin_hdr):
        for u in requests.get(f"{API}/members", headers=admin_hdr).json():
            if u["email"] in (EMAIL_FULL, EMAIL_MIN):
                requests.delete(f"{API}/members/{u['id']}", headers=admin_hdr)
        yield

    def test_import_three_rows_one_bad(self, admin_hdr):
        rows = [
            ["TEST Full Row", MOBILE_FULL, EMAIL_FULL, "secret123", "PO", "sailor", "08:00", "17:00"],
            ["TEST Minimal Row", MOBILE_MIN, "", "", "", "", "", ""],
            ["", "9999999999", "bad@attendance.app", "x", "", "", "", ""],  # missing full_name
        ]
        f = _build_xlsx(rows)
        r = requests.post(f"{API}/members/import",
                          headers=admin_hdr,
                          files={"file": ("import.xlsx", f,
                                          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                          timeout=60)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["created_count"] == 2, body
        assert body["error_count"] == 1, body
        # Error must reference missing-name row
        assert any("full_name" in e.get("reason", "").lower() for e in body["errors"])

        # Minimal member must be able to log in with mobile-derived creds
        login = requests.post(f"{API}/auth/login",
                              json={"email": EMAIL_MIN, "password": MOBILE_MIN})
        assert login.status_code == 200, login.text
        tok = login.json()["access_token"]
        me = requests.get(f"{API}/auth/me",
                          headers={"Authorization": f"Bearer {tok}"}).json()
        assert me["mobile"] == MOBILE_MIN
        # work fields default to None when blank
        assert me.get("work_start") in (None, "")
        assert me.get("work_end") in (None, "")

        # Full row stores supplied work fields
        full_users = [u for u in requests.get(f"{API}/members", headers=admin_hdr).json()
                      if u["email"] == EMAIL_FULL]
        assert full_users and full_users[0]["work_start"] == "08:00"
        assert full_users[0]["work_end"] == "17:00"
        assert full_users[0]["mobile"] == MOBILE_FULL

    def test_import_same_file_again_skips(self, admin_hdr):
        # Re-import the same rows; expect zero created and an "email already exists" error for each
        rows = [
            ["TEST Full Row", MOBILE_FULL, EMAIL_FULL, "secret123", "PO", "sailor", "08:00", "17:00"],
            ["TEST Minimal Row", MOBILE_MIN, "", "", "", "", "", ""],
        ]
        # First seed if not present from previous test
        f1 = _build_xlsx(rows)
        requests.post(f"{API}/members/import",
                      headers=admin_hdr,
                      files={"file": ("import.xlsx", f1,
                                      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                      timeout=60)
        # Now re-import
        f2 = _build_xlsx(rows)
        r = requests.post(f"{API}/members/import",
                          headers=admin_hdr,
                          files={"file": ("import.xlsx", f2,
                                          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
                          timeout=60)
        assert r.status_code == 200
        body = r.json()
        assert body["created_count"] == 0
        assert body["error_count"] >= 2
        joined = " ".join(e["reason"] for e in body["errors"]).lower()
        assert "already exists" in joined

    def test_import_forbidden_for_member(self, admin_hdr):
        m = {
            "email": "TEST_imp_forbid@attendance.app",
            "password": "secret123",
            "full_name": "TEST Imp Forbid",
            "category": "sailor",
        }
        for u in requests.get(f"{API}/members", headers=admin_hdr).json():
            if u["email"] == m["email"]:
                requests.delete(f"{API}/members/{u['id']}", headers=admin_hdr)
        c = requests.post(f"{API}/members", json=m, headers=admin_hdr)
        mid = c.json()["id"]
        try:
            tok = requests.post(f"{API}/auth/login",
                                json={"email": m["email"], "password": m["password"]}).json()["access_token"]
            f = _build_xlsx([["x", "9", "", "", "", "", "", ""]])
            r = requests.post(f"{API}/members/import",
                              headers={"Authorization": f"Bearer {tok}"},
                              files={"file": ("x.xlsx", f, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
            assert r.status_code == 403
        finally:
            requests.delete(f"{API}/members/{mid}", headers=admin_hdr)

    @classmethod
    def teardown_class(cls):
        try:
            tok = requests.post(f"{API}/auth/login", json=ADMIN).json()["access_token"]
            hdr = {"Authorization": f"Bearer {tok}"}
            for u in requests.get(f"{API}/members", headers=hdr).json():
                if u["email"] in (EMAIL_FULL, EMAIL_MIN):
                    requests.delete(f"{API}/members/{u['id']}", headers=hdr)
        except Exception:
            pass


# ============================ Regression: critical existing flows ============================
class TestRegression:
    def test_login_admin(self):
        r = requests.post(f"{API}/auth/login", json=ADMIN)
        assert r.status_code == 200
        assert r.json()["user"]["role"] == "admin"

    def test_presence_and_summary(self, admin_hdr):
        r = requests.get(f"{API}/presence", headers=admin_hdr)
        assert r.status_code == 200
        assert "members" in r.json() and "counts" in r.json()
        s = requests.get(f"{API}/admin/summary", headers=admin_hdr)
        assert s.status_code == 200
        body = s.json()
        for k in ("total_members", "on_campus", "pending_leaves", "on_leave_tour"):
            assert k in body

    def test_checkin_checkout_at_current_office(self, admin_hdr):
        # Re-read office fresh (state may have changed during prior tests)
        office = requests.get(f"{API}/office", headers=admin_hdr).json()
        st = requests.get(f"{API}/attendance/status", headers=admin_hdr).json()
        if st["checked_in"]:
            r = requests.post(f"{API}/attendance/checkout",
                              json={"qr_token": office["qr_token"],
                                    "latitude": office["latitude"],
                                    "longitude": office["longitude"]},
                              headers=admin_hdr)
            assert r.status_code == 200, r.text

        # Check-in
        r = requests.post(f"{API}/attendance/checkin",
                          json={"qr_token": office["qr_token"],
                                "latitude": office["latitude"],
                                "longitude": office["longitude"]},
                          headers=admin_hdr)
        assert r.status_code == 200, r.text
        assert r.json()["action"] == "checkin"
        # Check-out
        r = requests.post(f"{API}/attendance/checkout",
                          json={"qr_token": office["qr_token"],
                                "latitude": office["latitude"],
                                "longitude": office["longitude"]},
                          headers=admin_hdr)
        assert r.status_code == 200
        assert r.json()["action"] == "checkout"

    def test_scan_card_with_admin_personal_qr(self, admin_hdr):
        office = requests.get(f"{API}/office", headers=admin_hdr).json()
        # Find admin's personal_qr via members list isn't exposed; instead create a TEST member
        m = {
            "email": "TEST_scan_reg@attendance.app",
            "password": "secret123",
            "full_name": "TEST Scan Reg",
            "category": "sailor",
        }
        for u in requests.get(f"{API}/members", headers=admin_hdr).json():
            if u["email"] == m["email"]:
                requests.delete(f"{API}/members/{u['id']}", headers=admin_hdr)
        c = requests.post(f"{API}/members", json=m, headers=admin_hdr).json()
        mid = c["id"]
        try:
            card = requests.get(f"{API}/members/{mid}/card", headers=admin_hdr).json()
            pqr = card["personal_qr"]
            r = requests.post(f"{API}/attendance/scan-card",
                              json={"personal_qr": pqr,
                                    "latitude": office["latitude"],
                                    "longitude": office["longitude"]},
                              headers=admin_hdr)
            assert r.status_code == 200
            assert r.json()["action"] == "checkin"
        finally:
            requests.delete(f"{API}/members/{mid}", headers=admin_hdr)

    def test_leaves_and_reports(self, admin_hdr):
        # Create + approve a leave for admin (only admin exists, that's fine)
        body = {"type": "leave", "start_date": "2026-01-01", "end_date": "2026-01-02", "reason": "TEST"}
        r = requests.post(f"{API}/leaves", json=body, headers=admin_hdr)
        assert r.status_code == 200
        lid = r.json()["id"]
        d = requests.patch(f"{API}/leaves/{lid}", json={"status": "approved"}, headers=admin_hdr)
        assert d.status_code == 200
        # cleanup not strictly needed; leaves don't block other tests
        rep = requests.get(f"{API}/reports/hours?start=2026-01-01&end=2026-01-31",
                           headers=admin_hdr)
        assert rep.status_code == 200
        assert "rows" in rep.json()
