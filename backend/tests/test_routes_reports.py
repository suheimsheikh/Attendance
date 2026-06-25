"""
Pytest for `routes/reports.py` — covers /reports/hours, /payroll, /daily,
and the CSV+PDF export endpoints.

Run from /app/backend:
  python -m pytest tests/test_routes_reports.py -v
"""
import csv
import io
from datetime import date, timedelta

import pytest
import requests


# ------------------ /reports/hours ------------------
def test_hours_returns_shape_with_start_end(admin_client, base_url):
    today = date.today()
    first = today.replace(day=1).isoformat()
    end = today.isoformat()
    r = admin_client.get(f"{base_url}/api/reports/hours", params={"start": first, "end": end}, timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["start"] == first
    assert body["end"] == end
    assert isinstance(body["rows"], list)


def test_hours_each_row_has_required_fields(admin_client, base_url):
    today = date.today()
    first = today.replace(day=1).isoformat()
    end = today.isoformat()
    rows = admin_client.get(f"{base_url}/api/reports/hours",
                            params={"start": first, "end": end}, timeout=30).json()["rows"]
    if not rows:
        pytest.skip("No attendance rows in this window — nothing to assert.")
    sample = rows[0]
    # Contract — keep in sync with the CSV header below.
    for key in ("member_name", "category", "attendance_pct", "days_present",
                "days_absent", "total_hours"):
        assert key in sample, f"Missing field: {key}"


def test_hours_requires_admin(base_url):
    today = date.today()
    r = requests.get(
        f"{base_url}/api/reports/hours",
        params={"start": today.isoformat(), "end": today.isoformat()},
        timeout=30,
    )
    assert r.status_code == 401


# ------------------ /reports/payroll ------------------
def test_payroll_default_month_is_previous_calendar_month(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/reports/payroll", timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    # The default selects last calendar month.
    today = date.today()
    first_this = today.replace(day=1)
    last_prev = first_this - timedelta(days=1)
    expected_month = f"{last_prev.year:04d}-{last_prev.month:02d}"
    assert body["month"] == expected_month
    # start = 1st of that month, end = last day
    assert body["start"].endswith("-01")
    assert body["end"][:7] == expected_month


def test_payroll_explicit_month(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/reports/payroll", params={"month": "2026-01"}, timeout=30)
    assert r.status_code == 200
    body = r.json()
    assert body["month"] == "2026-01"
    assert body["start"] == "2026-01-01"
    assert body["end"] == "2026-01-31"


def test_payroll_includes_only_staff_and_coaches(admin_client, base_url):
    """Payroll is for staff + coaches only. Athletes and executives must NOT appear."""
    body = admin_client.get(f"{base_url}/api/reports/payroll", timeout=30).json()
    for r in body["rows"]:
        assert r["category"] in ("staff", "coach"), \
            f"Non-payroll category leaked into payroll listing: {r}"


def test_payroll_rows_have_leave_balance_fields(admin_client, base_url):
    """Payroll rows are decorated with leave-balance breakdown."""
    body = admin_client.get(f"{base_url}/api/reports/payroll", timeout=30).json()
    if not body["rows"]:
        pytest.skip("No staff/coach rows for this month.")
    sample = body["rows"][0]
    for key in ("leave_balance_opening", "leave_balance_taken_ytd", "leave_balance_remaining"):
        assert key in sample, f"Missing leave-balance field: {key}"


def test_payroll_december_end_date_calculation(admin_client, base_url):
    """December → end_date should be Dec 31, NOT Jan 0. Regression guard."""
    r = admin_client.get(f"{base_url}/api/reports/payroll", params={"month": "2025-12"}, timeout=30)
    assert r.status_code == 200
    body = r.json()
    assert body["end"] == "2025-12-31"


def test_payroll_requires_admin(base_url):
    r = requests.get(f"{base_url}/api/reports/payroll", timeout=30)
    assert r.status_code == 401


# ------------------ /reports/daily ------------------
def test_daily_default_is_today_shape(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/reports/daily", timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    assert "date" in body
    assert "on_leave" in body and isinstance(body["on_leave"], list)
    assert "on_tour" in body and isinstance(body["on_tour"], list)


def test_daily_explicit_date(admin_client, base_url):
    target = (date.today() - timedelta(days=1)).isoformat()
    r = admin_client.get(f"{base_url}/api/reports/daily", params={"on": target}, timeout=30)
    assert r.status_code == 200
    assert r.json()["date"] == target


def test_daily_leaves_split_by_type(admin_client, base_url):
    """Every row in on_leave must have type='leave'; on_tour must have type='tour'."""
    body = admin_client.get(f"{base_url}/api/reports/daily", timeout=30).json()
    for r in body["on_leave"]:
        assert r["type"] == "leave"
    for r in body["on_tour"]:
        assert r["type"] == "tour"


# ------------------ /reports/hours/export (CSV + PDF) ------------------
def test_hours_export_csv_has_correct_header_row(admin_client, base_url):
    today = date.today()
    first = today.replace(day=1).isoformat()
    end = today.isoformat()
    r = admin_client.get(
        f"{base_url}/api/reports/hours/export",
        params={"start": first, "end": end, "fmt": "csv"},
        timeout=30,
    )
    assert r.status_code == 200
    assert "text/csv" in r.headers.get("content-type", "")
    reader = csv.reader(io.StringIO(r.text))
    headers = next(reader)
    # These headers are referenced by the frontend's Reports page — keep stable.
    for required in ("Attendance %", "Name", "Category", "Total hrs", "Late Days"):
        assert required in headers, f"Missing CSV header: {required}"


def test_hours_export_pdf_returns_pdf_bytes(admin_client, base_url):
    today = date.today()
    first = today.replace(day=1).isoformat()
    end = today.isoformat()
    r = admin_client.get(
        f"{base_url}/api/reports/hours/export",
        params={"start": first, "end": end, "fmt": "pdf"},
        timeout=30,
    )
    assert r.status_code == 200
    assert r.headers.get("content-type") == "application/pdf"
    assert r.content[:4] == b"%PDF", "Body must start with the PDF magic header"


def test_hours_export_filename_includes_date_range(admin_client, base_url):
    today = date.today()
    first = today.replace(day=1).isoformat()
    end = today.isoformat()
    r = admin_client.get(
        f"{base_url}/api/reports/hours/export",
        params={"start": first, "end": end, "fmt": "csv"},
        timeout=30,
    )
    disposition = r.headers.get("content-disposition", "")
    assert first in disposition
    assert end in disposition


# ------------------ /reports/daily/export ------------------
def test_daily_export_csv_has_correct_header_row(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/reports/daily/export", params={"fmt": "csv"}, timeout=30)
    assert r.status_code == 200
    assert "text/csv" in r.headers.get("content-type", "")
    reader = csv.reader(io.StringIO(r.text))
    headers = next(reader)
    for required in ("Name", "Type", "From", "Till"):
        assert required in headers, f"Missing CSV header: {required}"


def test_daily_export_pdf(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/reports/daily/export", params={"fmt": "pdf"}, timeout=30)
    assert r.status_code == 200
    assert r.headers.get("content-type") == "application/pdf"
    assert r.content[:4] == b"%PDF"


# ------------------ Request-ID propagation ------------------
def test_reports_response_carries_request_id(admin_client, base_url):
    """The Request-ID middleware (added pre-launch) tags every response with X-Request-ID."""
    r = admin_client.get(f"{base_url}/api/reports/daily", timeout=30)
    rid = r.headers.get("x-request-id") or r.headers.get("X-Request-ID")
    assert rid, "Every API response must carry X-Request-ID"
    assert len(rid) <= 64
