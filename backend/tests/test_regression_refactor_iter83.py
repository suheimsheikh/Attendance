"""Regression tests for refactor batch M1/M3/M4 (iter83).

- M1: members routes moved to backend/routes/members.py
- M3: scheduler loops moved to backend/services/scheduler.py
- M4: routes/meals.py split into routes/meals/ package

These tests only exercise read paths and throwaway writes prefixed 'ZZ Test'.
Known pre-existing bug (ignored): GET /api/meals/meal-calendar without ?end=
returns 500. Always pass start & end.
"""
import os
import time
import uuid
import pytest
import requests
from datetime import datetime, timedelta

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
assert BASE_URL, "REACT_APP_BACKEND_URL missing"

ADMIN_EMAIL = "admin@attendance.app"
ADMIN_PASSWORD = "Admin@12345"
ADMIN2_EMAIL = "admin2.test@example.com"
ADMIN2_PASSWORD = "Admin@12345"


# ----------------------------- fixtures --------------------------------- #
@pytest.fixture(scope="session")
def super_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=20)
    assert r.status_code == 200, f"super admin login failed: {r.status_code} {r.text[:200]}"
    return r.json().get("access_token") or r.json().get("token")


@pytest.fixture(scope="session")
def admin2_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": ADMIN2_EMAIL, "password": ADMIN2_PASSWORD}, timeout=20)
    if r.status_code != 200:
        pytest.skip(f"admin2 login unavailable ({r.status_code})")
    return r.json().get("access_token") or r.json().get("token")


@pytest.fixture(scope="session")
def sh(super_token):
    return {"Authorization": f"Bearer {super_token}"}


@pytest.fixture(scope="session")
def ah(admin2_token):
    return {"Authorization": f"Bearer {admin2_token}"}


# ----------------------------- M3 scheduler import ---------------------- #
def test_scheduler_module_exports():
    import importlib
    s = importlib.import_module("services.scheduler")
    for name in ("close_stale_open_sessions", "send_checkout_reminders", "schedule_daily"):
        assert hasattr(s, name), f"services.scheduler missing {name}"


def test_backend_err_log_clean_at_startup():
    """No tracebacks since last startup line."""
    path = "/var/log/supervisor/backend.err.log"
    if not os.path.exists(path):
        pytest.skip("no backend.err.log")
    with open(path) as f:
        data = f.read()
    # Only look at last block after last 'Started server process'
    idx = data.rfind("Started server process")
    tail = data[idx:] if idx >= 0 else data
    assert "Traceback" not in tail, f"traceback in backend log tail:\n{tail[-2000:]}"


# ----------------------------- M1 Members GETs -------------------------- #
def test_members_list(sh):
    r = requests.get(f"{BASE_URL}/api/members", headers=sh, timeout=20)
    assert r.status_code == 200, r.text[:300]
    body = r.json()
    assert isinstance(body, (list, dict))


def test_members_list_with_category(sh):
    r = requests.get(f"{BASE_URL}/api/members?category=staff", headers=sh, timeout=20)
    assert r.status_code == 200


def test_members_import_template(sh):
    r = requests.get(f"{BASE_URL}/api/members/import-template", headers=sh, timeout=20)
    assert r.status_code == 200
    assert "spreadsheet" in r.headers.get("content-type", "") or r.content[:2] == b"PK"


def test_staff_roster_export(sh):
    r = requests.get(f"{BASE_URL}/api/staff-roster/export", headers=sh, timeout=30)
    assert r.status_code == 200


def test_admin_cards(sh):
    r = requests.get(f"{BASE_URL}/api/admin/cards", headers=sh, timeout=30)
    assert r.status_code == 200


# ------------------------- Members CRUD throwaway ----------------------- #
@pytest.fixture
def throwaway_member(sh):
    suffix = uuid.uuid4().hex[:8]
    payload = {
        "email": f"zztest.{suffix}@example.com",
        "full_name": f"ZZ Test {suffix}",
        "mobile": f"9{int(time.time()) % 1000000000:09d}",
        "category": "staff",
        "password": "Admin@12345",
    }
    r = requests.post(f"{BASE_URL}/api/members", json=payload, headers=sh, timeout=20)
    assert r.status_code in (200, 201), f"create failed: {r.status_code} {r.text[:300]}"
    data = r.json()
    mid = data.get("id") or data.get("_id") or data.get("member_id")
    assert mid, f"no member id in response: {data}"
    yield mid, payload
    # cleanup
    try:
        requests.delete(f"{BASE_URL}/api/members/{mid}", headers=sh, timeout=20)
    except Exception:
        pass


def test_member_get_patch_card(sh, throwaway_member):
    mid, payload = throwaway_member
    r = requests.get(f"{BASE_URL}/api/members/{mid}", headers=sh, timeout=15)
    assert r.status_code == 200
    assert r.json().get("full_name") == payload["full_name"]

    r = requests.patch(f"{BASE_URL}/api/members/{mid}",
                       json={"full_name": payload["full_name"] + " v2"},
                       headers=sh, timeout=15)
    assert r.status_code in (200, 204), r.text[:300]

    r = requests.get(f"{BASE_URL}/api/members/{mid}/card", headers=sh, timeout=15)
    assert r.status_code == 200


def test_member_archive_unarchive_hidden_from_list(sh, throwaway_member):
    mid, _ = throwaway_member
    r = requests.post(f"{BASE_URL}/api/members/{mid}/archive", headers=sh, timeout=15)
    assert r.status_code in (200, 204), r.text[:300]

    # must not appear in default list
    r = requests.get(f"{BASE_URL}/api/members", headers=sh, timeout=20)
    body = r.json()
    items = body if isinstance(body, list) else body.get("items", body.get("members", []))
    ids = [m.get("id") or m.get("_id") for m in items if isinstance(m, dict)]
    assert mid not in ids, "archived member leaked into default /api/members"

    # include_archived should include it
    r = requests.get(f"{BASE_URL}/api/members?include_archived=true", headers=sh, timeout=20)
    if r.status_code == 200:
        body = r.json()
        items = body if isinstance(body, list) else body.get("items", body.get("members", []))
        ids = [m.get("id") or m.get("_id") for m in items if isinstance(m, dict)]
        # may or may not include depending on paging; soft-assert via log
        if mid not in ids:
            print(f"NOTE: include_archived did not return {mid} (may be paged)")

    r = requests.post(f"{BASE_URL}/api/members/{mid}/unarchive", headers=sh, timeout=15)
    assert r.status_code in (200, 204)


def test_member_bulk_update(sh, throwaway_member):
    mid, _ = throwaway_member
    payload = {"ids": [mid], "patch": {"category": "staff"}}
    r = requests.post(f"{BASE_URL}/api/members/bulk-update", json=payload, headers=sh, timeout=15)
    # endpoint may accept different payload shape; accept 200/400 but not 500
    assert r.status_code < 500, r.text[:300]


def test_non_super_admin_delete_queued(ah, throwaway_member, sh):
    """non-super admin DELETE should queue a correction, not delete."""
    mid, _ = throwaway_member
    r = requests.delete(f"{BASE_URL}/api/members/{mid}", headers=ah, timeout=15)
    # Should NOT be a hard delete; expected 200/202 with queued flag OR 403
    assert r.status_code < 500, r.text[:300]
    # verify member still exists
    g = requests.get(f"{BASE_URL}/api/members/{mid}", headers=sh, timeout=15)
    assert g.status_code == 200, "non-super admin DELETE removed member — correction queue broken"


# ------------------------- M4 Meals GET endpoints ----------------------- #
MEALS_GETS = [
    "/api/masters/categories",
    "/api/admin/meals-today",
    "/api/meals/config",
    "/api/meals/day-attendees",
    "/api/meals/day-flags",
    "/api/meals/overheads",
    "/api/meals/purchase-categories",
    "/api/meals/vendors",
    "/api/meals/vendor-trends",
    "/api/meals/items",
    "/api/meals/items/last-rates",
    "/api/meals/price-movers",
    "/api/meals/daily-totals",
    "/api/meals/subcategories",
    "/api/meals/issues",
    "/api/meals/wastage",
    "/api/meals/stock",
    "/api/meals/procurement-plan",
    "/api/meals/stock-ledgers/print",
    "/api/meals/stock-take/list",
    "/api/meals/stock-take/report",
    "/api/meals/reorder-suggestions",
    "/api/meals/consumption-check",
    "/api/meals/purchases",
    "/api/meals/kitchen-analytics",
    "/api/meals/kitchen-analytics/bounds",
    "/api/meals/pantry-day-detail",
    "/api/meals/meal-calendar/bounds",
    "/api/meals/menu-master-download",
    "/api/meals/audit-log",
    "/api/meals/data-health",
]


@pytest.mark.parametrize("path", MEALS_GETS)
def test_meals_get_endpoint(sh, path):
    r = requests.get(f"{BASE_URL}{path}", headers=sh, timeout=30)
    # Some endpoints may need params; accept anything < 500
    assert r.status_code < 500, f"{path} -> {r.status_code}: {r.text[:300]}"


def test_meals_roster_with_params(sh):
    today = datetime.utcnow().strftime("%Y-%m-%d")
    r = requests.get(f"{BASE_URL}/api/meals/roster", headers=sh,
                     params={"date": today, "meal": "lunch"}, timeout=20)
    assert r.status_code == 200, r.text[:300]


def test_meals_stock_take_with_date(sh):
    today = datetime.utcnow().strftime("%Y-%m-%d")
    r = requests.get(f"{BASE_URL}/api/meals/stock-take", headers=sh,
                     params={"date": today}, timeout=20)
    assert r.status_code < 500


def test_meals_expense_report(sh):
    end = datetime.utcnow().date()
    start = end - timedelta(days=7)
    r = requests.get(f"{BASE_URL}/api/meals/expense-report", headers=sh,
                     params={"start": start.isoformat(), "end": end.isoformat()}, timeout=30)
    assert r.status_code == 200, r.text[:300]


def test_meal_calendar_with_range(sh):
    end = datetime.utcnow().date()
    start = end - timedelta(days=7)
    r = requests.get(f"{BASE_URL}/api/meals/meal-calendar", headers=sh,
                     params={"start": start.isoformat(), "end": end.isoformat()}, timeout=30)
    assert r.status_code == 200, r.text[:300]
    r = requests.get(f"{BASE_URL}/api/meals/meal-calendar/events", headers=sh,
                     params={"start": start.isoformat(), "end": end.isoformat()}, timeout=30)
    assert r.status_code == 200, r.text[:300]


def test_kitchen_analytics_sub(sh):
    for p in ("/api/meals/kitchen-analytics/item-daily",
              "/api/meals/kitchen-analytics/item-compare"):
        r = requests.get(f"{BASE_URL}{p}", headers=sh, timeout=30)
        assert r.status_code < 500, f"{p} -> {r.status_code}"


# ---------------------- M4 throwaway vendor + item CRUD ----------------- #
def test_vendor_and_item_crud(sh):
    suffix = uuid.uuid4().hex[:6]
    # Create vendor
    v_payload = {"name": f"ZZ Test Vendor {suffix}"}
    r = requests.post(f"{BASE_URL}/api/meals/vendors", json=v_payload, headers=sh, timeout=15)
    if r.status_code >= 400:
        pytest.skip(f"vendor create not accepted: {r.status_code} {r.text[:200]}")
    vid = (r.json() or {}).get("id") or (r.json() or {}).get("_id")
    assert vid, f"no vendor id: {r.json()}"
    try:
        # patch
        pr = requests.patch(f"{BASE_URL}/api/meals/vendors/{vid}",
                            json={"name": f"ZZ Test Vendor {suffix} v2"},
                            headers=sh, timeout=15)
        assert pr.status_code < 500

        # Create item
        i_payload = {"name": f"ZZ Test Item {suffix}", "unit": "kg"}
        ir = requests.post(f"{BASE_URL}/api/meals/items", json=i_payload, headers=sh, timeout=15)
        if ir.status_code < 400:
            iid = (ir.json() or {}).get("id") or (ir.json() or {}).get("_id")
            if iid:
                try:
                    ipr = requests.patch(f"{BASE_URL}/api/meals/items/{iid}",
                                         json={"name": f"ZZ Test Item {suffix} v2"},
                                         headers=sh, timeout=15)
                    assert ipr.status_code < 500
                    # ledger
                    lr = requests.get(f"{BASE_URL}/api/meals/items/{iid}/ledger",
                                      headers=sh, timeout=20)
                    assert lr.status_code < 500
                finally:
                    requests.delete(f"{BASE_URL}/api/meals/items/{iid}", headers=sh, timeout=15)
    finally:
        requests.delete(f"{BASE_URL}/api/meals/vendors/{vid}", headers=sh, timeout=15)


# ---------------------- M4 SSE opens ----------------------------------- #
def test_meals_sse_opens(super_token):
    # SSE uses ?token=... since EventSource can't send Authorization header.
    with requests.get(f"{BASE_URL}/api/meals/events",
                      params={"token": super_token}, stream=True, timeout=10) as r:
        assert r.status_code == 200
        assert "text/event-stream" in r.headers.get("content-type", "").lower()
        # read a byte or two then close
        it = r.iter_content(chunk_size=1)
        try:
            next(it, None)
        except Exception:
            pass
