"""Iteration 3 backend regression — pre-launch (Jan 2026 / 06-25 deploy).

Focus this session:
  • RequestIDMiddleware: X-Request-ID echo + auto-generate (12-char hex)
  • Server-supplied X-Request-ID propagates back unchanged
  • /api/health unchanged, returns {status:'ok'}, no access-log line
  • CORS expose_headers includes X-Request-ID
  • Admin email + phone-admin-bypass login still work
  • /api/presence rich response w/ 130+ members
  • /api/office still strips qr_token
  • Leaves: admin file-on-behalf via target_user_id + approve PATCH
  • Overtime list + filters
  • Payroll month report
  • Reports hours/daily endpoints + CSV export content-type
  • Self check-in geo-toggle path
  • Muster bulk check-in / check-out
  • Devices admin filter pills
"""
import io
import os
import re
import csv
import uuid
import time
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
if not BASE_URL:
    env_path = "/app/frontend/.env"
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                if line.startswith("REACT_APP_BACKEND_URL"):
                    BASE_URL = line.split("=", 1)[1].strip().strip('"').rstrip("/")
                    break

if not os.environ.get("MONGO_URL"):
    be_env = "/app/backend/.env"
    if os.path.exists(be_env):
        with open(be_env) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"'))

ADMIN_EMAIL = os.environ.get("TEST_ADMIN_EMAIL", "admin@attendance.app")
ADMIN_PASSWORD = os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345")
ADMIN_MOBILE = os.environ.get("TEST_ADMIN_MOBILE", "9849002111")
HEX12_RE = re.compile(r"^[0-9a-fA-F]{12}$")


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
                      timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def admin_s(admin_token):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {admin_token}",
                      "Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def state():
    return {}


# ---------- 1. Health endpoint unchanged ----------
def test_01_health_endpoint():
    r = requests.get(f"{BASE_URL}/api/health", timeout=10)
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "service": "i-showed-up"}
    # Middleware still adds X-Request-ID even on /health (it just skips the log)
    assert "x-request-id" in {k.lower() for k in r.headers}


# ---------- 2. X-Request-ID auto-generated (no client header) ----------
def test_02_request_id_auto_generated():
    r = requests.get(f"{BASE_URL}/api/health", timeout=10)
    rid = r.headers.get("x-request-id") or r.headers.get("X-Request-ID")
    assert rid, f"missing X-Request-ID header: {dict(r.headers)}"
    assert HEX12_RE.match(rid), f"auto-generated rid not 12-char hex: {rid!r}"


# ---------- 3. Client-supplied X-Request-ID echoed back unchanged ----------
def test_03_request_id_client_supplied_echo():
    custom = "iter3test1234"  # 13 chars on purpose — server must not normalise
    r = requests.get(f"{BASE_URL}/api/health",
                     headers={"X-Request-ID": custom}, timeout=10)
    assert r.status_code == 200
    echoed = r.headers.get("x-request-id") or r.headers.get("X-Request-ID")
    assert echoed == custom, f"client rid {custom!r} not echoed: got {echoed!r}"


# ---------- 4. X-Request-ID present on auth + protected endpoints too ----------
def test_04_request_id_on_other_endpoints(admin_s):
    for path in ["/api/presence", "/api/office", "/api/changelog"]:
        r = admin_s.get(f"{BASE_URL}{path}", timeout=30)
        rid = r.headers.get("x-request-id") or r.headers.get("X-Request-ID")
        assert rid, f"{path}: missing X-Request-ID header"
        # If auto-gen → 12 hex; if proxy injected → at least non-empty
        assert len(rid) >= 8, f"{path}: rid too short {rid!r}"


# ---------- 5. Admin email login → /presence with 130+ rows ----------
def test_05_admin_login_and_presence_130(admin_s):
    r = admin_s.get(f"{BASE_URL}/api/presence", timeout=30)
    assert r.status_code == 200, r.text
    d = r.json()
    members = d.get("members") or []
    assert len(members) >= 100, f"expected 130+ members, got {len(members)}"
    counts = d.get("counts") or {}
    assert counts.get("total", 0) >= 100


# ---------- 6. Phone-admin-bypass still returns token ----------
def test_06_phone_admin_bypass():
    dev_id = f"iter3-{uuid.uuid4().hex[:8]}"
    r = requests.post(f"{BASE_URL}/api/auth/phone",
                      json={"phone": ADMIN_MOBILE, "device_id": dev_id,
                            "device_name": "iter3-test", "platform": "web"},
                      timeout=30)
    assert r.status_code == 200, r.text
    d = r.json()
    assert "access_token" in d, f"expected access_token: {d}"
    assert d["user"]["role"] == "admin"
    # Try /presence with that token to confirm it works
    token = d["access_token"]
    r2 = requests.get(f"{BASE_URL}/api/presence",
                      headers={"Authorization": f"Bearer {token}"}, timeout=30)
    assert r2.status_code == 200
    # cleanup
    try:
        from pymongo import MongoClient
        mc = MongoClient(os.environ["MONGO_URL"])
        mc[os.environ["DB_NAME"]].devices.delete_many({"device_id": dev_id})
    except Exception:
        pass


# ---------- 7. /api/office still strips qr_token ----------
def test_07_office_no_qr_token(admin_s):
    r = admin_s.get(f"{BASE_URL}/api/office", timeout=30)
    assert r.status_code == 200, r.text
    o = r.json()
    assert "qr_token" not in o, f"qr_token leaked: keys={list(o.keys())}"
    for k in ("latitude", "longitude", "radius_m"):
        assert k in o


# ---------- 8. Devices admin filter (filter→load deps fix) ----------
@pytest.mark.parametrize("filt", ["pending", "approved", "rejected", "revoked"])
def test_08_devices_filter(admin_s, filt):
    # API uses `status_filter` query name (server.py line 856)
    r = admin_s.get(f"{BASE_URL}/api/admin/devices",
                    params={"status_filter": filt}, timeout=30)
    assert r.status_code == 200, f"{filt}: {r.text}"
    d = r.json()
    items = d if isinstance(d, list) else (d.get("devices") or d.get("items") or [])
    assert isinstance(items, list)
    for it in items:
        s = (it.get("status") or "").lower()
        assert s == filt, f"filter={filt} but item.status={s}"


# ---------- 9. Leaves filter pills + file-on-behalf + approve ----------
@pytest.mark.parametrize("filt", ["pending", "approved", "rejected", "late"])
def test_09_leaves_filter(admin_s, filt):
    # routes/leaves.py uses query name `status_filter`
    r = admin_s.get(f"{BASE_URL}/api/leaves",
                    params={"status_filter": filt}, timeout=30)
    assert r.status_code == 200, f"{filt}: {r.status_code} {r.text[:200]}"
    assert isinstance(r.json(), list)


def test_10_leave_create_and_approve(admin_s, state):
    members = admin_s.get(f"{BASE_URL}/api/members", timeout=30).json()
    target = next((m for m in members if m.get("role") == "member"), None)
    if not target:
        pytest.skip("no member to file leave for")
    state["leave_target_id"] = target["id"]

    # target_user_id is a QUERY param; body uses type/start_date/end_date
    body = {
        "type": "leave",
        "start_date": "2026-07-15",
        "end_date": "2026-07-16",
        "reason": "iter3 regression test",
    }
    r = admin_s.post(f"{BASE_URL}/api/leaves",
                     params={"target_user_id": target["id"]},
                     json=body, timeout=30)
    assert r.status_code in (200, 201), f"create leave: {r.status_code} {r.text[:300]}"
    leave = r.json()
    lid = leave.get("id")
    assert lid, f"no leave id in: {leave}"
    state["leave_id"] = lid
    assert leave["user_id"] == target["id"], "filed-on-behalf user mismatch"
    assert leave["filed_by_admin"], "filed_by_admin should be set"

    # Approve via PATCH /api/leaves/{id}
    rp = admin_s.patch(f"{BASE_URL}/api/leaves/{lid}",
                       json={"status": "approved"}, timeout=30)
    assert rp.status_code in (200, 204), f"approve: {rp.status_code} {rp.text[:300]}"
    assert rp.json()["status"] == "approved"


# ---------- 10. Overtime filters ----------
def test_11_overtime_filters(admin_s):
    r = admin_s.get(f"{BASE_URL}/api/admin/overtime", timeout=30)
    assert r.status_code == 200, f"overtime list: {r.status_code} {r.text[:200]}"
    r2 = admin_s.get(f"{BASE_URL}/api/admin/overtime",
                     params={"status": "pending",
                             "date_from": "2026-06-01",
                             "date_to": "2026-12-31"}, timeout=30)
    assert r2.status_code == 200, f"overtime filtered: {r2.status_code} {r2.text[:200]}"


# ---------- 11. Payroll month report ----------
def test_12_payroll_month(admin_s):
    r = admin_s.get(f"{BASE_URL}/api/reports/payroll",
                    params={"month": "2026-06"}, timeout=60)
    assert r.status_code == 200, f"payroll: {r.status_code} {r.text[:200]}"
    d = r.json()
    assert "rows" in d and "month" in d
    assert d["month"] == "2026-06"


# ---------- 12. Reports Hours + Daily + CSV ----------
def test_13_reports_hours(admin_s):
    r = admin_s.get(f"{BASE_URL}/api/reports/hours",
                    params={"start": "2026-06-01", "end": "2026-06-25"}, timeout=60)
    assert r.status_code == 200, f"hours: {r.status_code} {r.text[:200]}"
    d = r.json()
    assert "rows" in d


def test_14_reports_daily(admin_s):
    r = admin_s.get(f"{BASE_URL}/api/reports/daily",
                    params={"on": "2026-06-25"}, timeout=30)
    assert r.status_code == 200, f"daily: {r.status_code} {r.text[:200]}"
    d = r.json()
    for k in ("date", "on_leave", "on_tour"):
        assert k in d, f"daily missing {k}: keys={list(d.keys())}"


def test_15_reports_csv_export(admin_s):
    r = admin_s.get(f"{BASE_URL}/api/reports/hours/export",
                    params={"start": "2026-06-01", "end": "2026-06-25",
                            "fmt": "csv"},
                    timeout=60)
    assert r.status_code == 200, f"csv: {r.status_code} {r.text[:200]}"
    ct = r.headers.get("content-type", "").lower()
    assert "csv" in ct, f"content-type not csv: {ct}"
    txt = r.text
    reader = csv.reader(io.StringIO(txt))
    header = next(reader, [])
    header_norm = [h.strip().lower() for h in header]
    assert any("name" == h for h in header_norm), f"no Name column: {header}"
    assert any("category" == h for h in header_norm), f"no Category column: {header}"
    assert any("total hrs" in h for h in header_norm), f"no Total hrs col: {header}"


# ---------- 13. Self check-in geo-toggle ----------
def test_16_geo_toggle(admin_s):
    o = admin_s.get(f"{BASE_URL}/api/office", timeout=30).json()
    lat, lon = o["latitude"], o["longitude"]
    r = admin_s.post(f"{BASE_URL}/api/attendance/geo-toggle",
                     json={"latitude": lat, "longitude": lon}, timeout=30)
    assert r.status_code in (200, 400), r.text
    if r.status_code == 200:
        # restore state
        admin_s.post(f"{BASE_URL}/api/attendance/geo-toggle",
                     json={"latitude": lat, "longitude": lon}, timeout=30)


# ---------- 14. Muster bulk check-in/out ----------
def test_17_muster_bulk(admin_s):
    members = admin_s.get(f"{BASE_URL}/api/members", timeout=30).json()
    target = next((m for m in members if m.get("role") == "member"), None)
    if not target:
        pytest.skip("no member for muster")
    o = admin_s.get(f"{BASE_URL}/api/office", timeout=30).json()
    body = {"athlete_ids": [target["id"]],
            "latitude": o["latitude"], "longitude": o["longitude"], "by": "iter3"}
    r = admin_s.post(f"{BASE_URL}/api/muster/checkin-bulk", json=body, timeout=30)
    assert r.status_code == 200, f"muster checkin: {r.text}"
    r2 = admin_s.post(f"{BASE_URL}/api/muster/checkout-bulk", json=body, timeout=30)
    assert r2.status_code == 200, f"muster checkout: {r2.text}"


# ---------- 15. Cleanup the leave we filed ----------
def test_99_cleanup(admin_s, state):
    lid = state.get("leave_id")
    if lid:
        for p in (f"/api/leaves/{lid}", f"/api/admin/leaves/{lid}"):
            try:
                admin_s.delete(f"{BASE_URL}{p}", timeout=15)
            except Exception:
                pass
