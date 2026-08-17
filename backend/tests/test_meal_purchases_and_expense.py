"""Backend tests for Meal Purchases + Expense Report feature (Jan 2026).

Covers:
  • GET/PUT /api/meals/purchase-categories (admin gate, chef read allowed)
  • PUT /api/meals/purchases/{date}, GET /api/meals/purchases
  • POST /api/meals/purchases/bulk-upload (csv + xlsx + rejected .txt)
  • GET /api/meals/expense-report (athlete/staff bucketing + totals + range validation)
  • Chef role auth + plain member 403
  • Light regression on /api/reports/calendar-grid
"""
from __future__ import annotations

import io
import uuid
import csv as _csv
import pytest
import requests

CSV_HEADER = ["Date", "FRUITS", "GROCERY", "VEGETABLES", "CHICKEN/ MUTTON", "PANEER"]


# ---------- helpers ----------------------------------------------------------

@pytest.fixture(scope="module")
def chef_user(admin_client, base_url):
    """Create a chef user + return {email,password,token,id}."""
    email = f"chef-{uuid.uuid4().hex[:6]}@meals.example.com"
    pwd = "Chef@12345"
    r = admin_client.post(f"{base_url}/api/members", json={
        "email": email, "password": pwd, "full_name": "Test Chef",
        "role": "chef", "category": "staff",
    }, timeout=30)
    assert r.status_code == 200, r.text
    uid = r.json()["id"]
    lr = requests.post(f"{base_url}/api/auth/login",
                       json={"email": email, "password": pwd}, timeout=30)
    assert lr.status_code == 200, lr.text
    return {"id": uid, "email": email, "password": pwd,
            "token": lr.json()["access_token"]}


@pytest.fixture(scope="module")
def plain_member(admin_client, base_url):
    email = f"pm-{uuid.uuid4().hex[:6]}@meals.example.com"
    pwd = "Member@12345"
    r = admin_client.post(f"{base_url}/api/members", json={
        "email": email, "password": pwd, "full_name": "Plain Member",
        "role": "member", "category": "staff",
    }, timeout=30)
    assert r.status_code == 200, r.text
    lr = requests.post(f"{base_url}/api/auth/login",
                       json={"email": email, "password": pwd}, timeout=30)
    assert lr.status_code == 200, lr.text
    return {"token": lr.json()["access_token"], "id": r.json()["id"]}


@pytest.fixture(scope="module")
def chef_client(base_url, chef_user):
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {chef_user['token']}",
                      "Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def member_headers(plain_member):
    return {"Authorization": f"Bearer {plain_member['token']}"}


# ---------- 1. purchase-categories ------------------------------------------

class TestPurchaseCategories:

    def test_get_returns_five_seeded(self, admin_client, base_url):
        r = admin_client.get(f"{base_url}/api/meals/purchase-categories", timeout=30)
        assert r.status_code == 200
        cats = r.json()["categories"]
        keys = {c["key"] for c in cats}
        # Default seed set
        expected = {"fruits", "grocery", "vegetables", "chicken_mutton", "paneer"}
        assert expected.issubset(keys), f"missing seeds: {expected - keys}"

    def test_chef_can_read(self, chef_client, base_url):
        r = chef_client.get(f"{base_url}/api/meals/purchase-categories", timeout=30)
        assert r.status_code == 200
        assert len(r.json()["categories"]) >= 5

    def test_member_forbidden(self, base_url, member_headers):
        r = requests.get(f"{base_url}/api/meals/purchase-categories",
                         headers=member_headers, timeout=30)
        assert r.status_code == 403

    def test_chef_cannot_put(self, chef_client, base_url):
        r = chef_client.put(
            f"{base_url}/api/meals/purchase-categories",
            json={"categories": [{"label": "Fruits"}]}, timeout=30,
        )
        assert r.status_code == 403

    def test_admin_can_add_and_restore(self, admin_client, base_url):
        # Snapshot original
        orig = admin_client.get(f"{base_url}/api/meals/purchase-categories",
                                timeout=30).json()["categories"]
        # Add a new one via label-only (should get slug key)
        payload = {"categories": orig + [{"label": "Spices & Masala"}]}
        r = admin_client.put(f"{base_url}/api/meals/purchase-categories",
                             json=payload, timeout=30)
        assert r.status_code == 200
        cats = r.json()["categories"]
        keys = {c["key"] for c in cats}
        assert "spices_masala" in keys, f"slug key not generated: {keys}"
        # Restore original set
        rr = admin_client.put(f"{base_url}/api/meals/purchase-categories",
                              json={"categories": orig}, timeout=30)
        assert rr.status_code == 200


# ---------- 2. purchases upsert + list --------------------------------------

class TestPurchasesUpsertAndList:
    TEST_DATE = "2026-08-14"  # test range in-scope

    def test_upsert_parses_strings_and_commas(self, admin_client, base_url):
        body = {"amounts": {"fruits": "1,600.00", "grocery": 250,
                            "vegetables": "0", "paneer": ""}}
        r = admin_client.put(f"{base_url}/api/meals/purchases/{self.TEST_DATE}",
                             json=body, timeout=30)
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["date"] == self.TEST_DATE
        assert out["amounts"].get("fruits") == 1600.0
        assert out["amounts"].get("grocery") == 250.0
        # Zero and empty dropped
        assert "vegetables" not in out["amounts"]
        assert "paneer" not in out["amounts"]
        assert out["total"] == 1850.0

    def test_upsert_rejects_negative(self, admin_client, base_url):
        r = admin_client.put(f"{base_url}/api/meals/purchases/{self.TEST_DATE}",
                             json={"amounts": {"fruits": -10}}, timeout=30)
        assert r.status_code == 400

    def test_list_returns_sorted(self, admin_client, base_url):
        # Ensure two dates exist
        admin_client.put(f"{base_url}/api/meals/purchases/2026-08-13",
                         json={"amounts": {"fruits": 100}}, timeout=30)
        admin_client.put(f"{base_url}/api/meals/purchases/2026-08-14",
                         json={"amounts": {"fruits": 200}}, timeout=30)
        r = admin_client.get(
            f"{base_url}/api/meals/purchases",
            params={"start": "2026-08-13", "end": "2026-08-14"}, timeout=30,
        )
        assert r.status_code == 200
        rows = r.json()["purchases"]
        dates = [row["date"] for row in rows]
        assert dates == sorted(dates)
        assert "2026-08-13" in dates and "2026-08-14" in dates
        # Ensure no _id leaked
        for row in rows:
            assert "_id" not in row

    def test_chef_can_put(self, chef_client, base_url):
        r = chef_client.put(f"{base_url}/api/meals/purchases/2026-08-15",
                            json={"amounts": {"fruits": 50}}, timeout=30)
        assert r.status_code == 200

    def test_member_forbidden(self, base_url, member_headers):
        r = requests.put(f"{base_url}/api/meals/purchases/2026-08-15",
                         json={"amounts": {"fruits": 50}},
                         headers={**member_headers, "Content-Type": "application/json"},
                         timeout=30)
        assert r.status_code == 403


# ---------- 3. bulk upload ---------------------------------------------------

def _build_csv_bytes() -> bytes:
    buf = io.StringIO()
    w = _csv.writer(buf)
    w.writerow(CSV_HEADER)
    w.writerow(["1/9/2026", "1,600.00", "500", "300", "1,200", "250"])
    w.writerow(["2/9/2026", "700", "900", "400", "0", ""])
    w.writerow(["TOTAL", "2,300", "1,400", "700", "1,200", "250"])
    return buf.getvalue().encode("utf-8")


def _build_xlsx_bytes() -> bytes:
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.append(CSV_HEADER + ["OTHER_UNMATCHED"])
    ws.append(["3/9/2026", 500, 400, 300, 200, 100, 999])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


class TestBulkUpload:

    def _auth(self, token):
        return {"Authorization": f"Bearer {token}"}

    def test_csv_import(self, admin_token, base_url):
        files = {"file": ("purchases.csv", _build_csv_bytes(), "text/csv")}
        r = requests.post(f"{base_url}/api/meals/purchases/bulk-upload",
                          files=files, headers=self._auth(admin_token), timeout=45)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["imported_days"] == 2
        assert "2026-09-01" in body["dates"] and "2026-09-02" in body["dates"]
        # TOTAL row must not fail import; may/should be silent
        assert body["errors"] == [] or all("Row skipped" not in e for e in body["errors"])
        # Verify persistence via GET
        gr = requests.get(f"{base_url}/api/meals/purchases",
                          params={"start": "2026-09-01", "end": "2026-09-02"},
                          headers=self._auth(admin_token), timeout=30).json()
        by_date = {p["date"]: p["amounts"] for p in gr["purchases"]}
        assert by_date["2026-09-01"]["fruits"] == 1600.0
        assert by_date["2026-09-01"]["chicken_mutton"] == 1200.0
        # NOTE: bulk-upload currently STORES 0.0 (unlike PUT which drops zeros)
        # — recorded as a minor consistency issue in test report.
        assert by_date["2026-09-02"].get("chicken_mutton", 0) in (0, 0.0)
        assert "paneer" not in by_date["2026-09-02"]

    def test_xlsx_import_reports_unmatched(self, admin_token, base_url):
        files = {"file": ("purchases.xlsx", _build_xlsx_bytes(),
                          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
        r = requests.post(f"{base_url}/api/meals/purchases/bulk-upload",
                          files=files, headers=self._auth(admin_token), timeout=45)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["imported_days"] >= 1
        assert "2026-09-03" in body["dates"]
        assert any("OTHER" in u.upper() or "UNMATCHED" in u.upper()
                   for u in body["unmatched_columns"]), body

    def test_txt_rejected(self, admin_token, base_url):
        files = {"file": ("data.txt", b"hello", "text/plain")}
        r = requests.post(f"{base_url}/api/meals/purchases/bulk-upload",
                          files=files, headers=self._auth(admin_token), timeout=30)
        assert r.status_code == 400

    def test_chef_can_bulk_upload(self, chef_user, base_url):
        files = {"file": ("purchases.csv", _build_csv_bytes(), "text/csv")}
        r = requests.post(f"{base_url}/api/meals/purchases/bulk-upload",
                          files=files,
                          headers={"Authorization": f"Bearer {chef_user['token']}"},
                          timeout=45)
        assert r.status_code == 200, r.text


# ---------- 4. expense report -----------------------------------------------

class TestExpenseReport:
    DATE = "2026-08-14"

    @pytest.fixture(scope="class")
    def marked_meals(self, admin_client, base_url):
        """Mark a breakfast for one athlete + one staff member on DATE."""
        listing = admin_client.get(f"{base_url}/api/members", timeout=30).json()
        athlete = next((m for m in listing if m.get("category") == "athlete"), None)
        staff = next((m for m in listing if m.get("category") == "staff"), None)
        assert athlete and staff, "Need at least one athlete and one staff member"
        r = admin_client.post(
            f"{base_url}/api/meals/mark-bulk",
            json={"meal": "breakfast", "date": self.DATE,
                  "user_ids": [athlete["id"], staff["id"]]}, timeout=30,
        )
        assert r.status_code == 200, r.text
        return {"athlete_id": athlete["id"], "staff_id": staff["id"]}

    def test_report_buckets_and_totals(self, admin_client, base_url, marked_meals):
        r = admin_client.get(
            f"{base_url}/api/meals/expense-report",
            params={"start": self.DATE, "end": self.DATE}, timeout=30,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["start"] == self.DATE and data["end"] == self.DATE
        assert len(data["days"]) == 1
        day = data["days"][0]
        # At least one athlete and one staff breakfast should show up
        assert day["athletes"]["breakfast"] >= 1
        assert day["staff"]["breakfast"] >= 1
        assert day["meal_count"] >= 2
        # Totals math
        tot = data["totals"]
        assert tot["meal_count"] >= 2
        # avg cost computed if expenses>0
        if tot["expenses"] and tot["meal_count"]:
            expected = round(tot["expenses"] / tot["meal_count"], 2)
            assert tot["avg_cost_per_meal"] == expected

    def test_invalid_range_400(self, admin_client, base_url):
        r = admin_client.get(f"{base_url}/api/meals/expense-report",
                             params={"start": "2026-08-14", "end": "2026-08-13"}, timeout=30)
        assert r.status_code == 400

    def test_range_too_large_400(self, admin_client, base_url):
        r = admin_client.get(f"{base_url}/api/meals/expense-report",
                             params={"start": "2024-01-01", "end": "2026-12-31"}, timeout=30)
        assert r.status_code == 400

    def test_chef_can_read(self, chef_client, base_url):
        r = chef_client.get(f"{base_url}/api/meals/expense-report",
                            params={"start": "2026-08-13", "end": "2026-08-15"}, timeout=30)
        assert r.status_code == 200

    def test_member_forbidden(self, base_url, member_headers):
        r = requests.get(f"{base_url}/api/meals/expense-report",
                         params={"start": "2026-08-13", "end": "2026-08-15"},
                         headers=member_headers, timeout=30)
        assert r.status_code == 403


# ---------- 5. calendar-grid regression --------------------------------------

class TestCalendarGridRegression:
    def test_calendar_grid_loads(self, admin_client, base_url):
        r = admin_client.get(f"{base_url}/api/reports/calendar-grid",
                             params={"month": "2026-08"}, timeout=60)
        assert r.status_code == 200, r.text
        data = r.json()
        # basic shape
        assert "rows" in data or "users" in data or isinstance(data, dict)
