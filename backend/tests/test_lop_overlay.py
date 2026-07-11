"""Contract tests for the LOP overlay on The Grid.

Shipped 20 Feb 2026 alongside:
  • `LP` cell code — tail portion of an approved `leave` whose
    requested days exceeded the comp-off + paid-leave balance.
  • `totals.lop` sub-count — surfaces the same number payroll uses.
  • `cell_meta.balance_split` — tooltip line ("Paid: 3d · LOP: 2d").
"""
from __future__ import annotations

import os
import uuid
from datetime import date, timedelta

import pytest
import requests


def _login(base_url) -> str:
    r = requests.post(
        f"{base_url}/api/auth/login",
        json={"email": os.environ.get("TEST_ADMIN_EMAIL", "admin@attendance.app"),
              "password": os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345")},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def _current_month() -> str:
    d = date.today()
    return f"{d.year:04d}-{d.month:02d}"


@pytest.fixture
def seeded_lop_member(base_url):
    """Seed a staff member with an approved 5-day leave stamped
    `paid_leave_used=3, lop_days=2` — the last 2 days should render as
    `LP` on the Grid, the first 3 as `LV`.

    Cleaned up after the test even if it fails."""
    tok = _login(base_url)
    hdr = {"Authorization": f"Bearer {tok}"}
    uniq = uuid.uuid4().hex[:8]
    member = requests.post(
        f"{base_url}/api/members",
        headers=hdr,
        json={
            "full_name": f"LOP Test {uniq}",
            "email": f"lop-{uniq}@attendance.app",
            "password": "Test@12345",
            "category": "staff",
            "rank": "Test Rank",
            "mobile": f"9{uniq[:9]}",
        },
        timeout=30,
    )
    assert member.status_code in (200, 201), member.text
    m = member.json()

    # Seed opening leave balance via PATCH — the create endpoint doesn't
    # accept it directly. 3 days = the paid pool for our 5-day test.
    patch = requests.patch(
        f"{base_url}/api/members/{m['id']}",
        headers=hdr,
        json={"leave_balance_opening": 3},
        timeout=15,
    )
    assert patch.status_code == 200, patch.text

    # Pick a 5-day window inside the current month so the Grid picks it up.
    today = date.today()
    # Start on the 5th so we don't collide with month-end.
    start = today.replace(day=5)
    end = start + timedelta(days=4)  # 5 days inclusive

    # File on behalf so it enters `pending`, then approve so it enters
    # `approved` with the balance-split stamped.
    leave = requests.post(
        f"{base_url}/api/leaves?target_user_id={m['id']}",
        headers=hdr,
        json={
            "type": "leave",
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
            "reason": "LOP overlay contract test",
        },
        timeout=30,
    )
    assert leave.status_code in (200, 201), leave.text
    leave_id = leave.json()["id"]
    approve = requests.patch(
        f"{base_url}/api/leaves/{leave_id}",
        headers=hdr,
        json={"status": "approved"},
        timeout=30,
    )
    assert approve.status_code == 200, approve.text

    yield {"member_id": m["id"], "leave_id": leave_id,
           "start": start.isoformat(), "end": end.isoformat()}

    # Teardown — delete the leave doc and the member.
    requests.delete(f"{base_url}/api/leaves/{leave_id}", headers=hdr, timeout=15)
    requests.delete(f"{base_url}/api/members/{m['id']}", headers=hdr, timeout=15)


def test_lop_tail_cells_render_as_LP(seeded_lop_member, base_url):
    tok = _login(base_url)
    hdr = {"Authorization": f"Bearer {tok}"}
    month = _current_month()
    r = requests.get(
        f"{base_url}/api/reports/calendar-grid",
        headers=hdr, params={"month": month}, timeout=45,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    row = next((x for x in data["rows"] if x["member_id"] == seeded_lop_member["member_id"]), None)
    assert row is not None, "Seeded LOP member missing from Grid payload"

    days = data["days"]
    cells_by_iso = dict(zip(days, row["cells"]))
    start, end = seeded_lop_member["start"], seeded_lop_member["end"]
    # Days 1..3 in the window are covered by paid balance (LV);
    # days 4..5 are LOP tail (LP).
    d0 = date.fromisoformat(start)
    codes = [cells_by_iso.get((d0 + timedelta(days=i)).isoformat()) for i in range(5)]
    # First three should be LV, last two LP.
    assert codes[0] == "LV", codes
    assert codes[1] == "LV", codes
    assert codes[2] == "LV", codes
    assert codes[3] == "LP", codes
    assert codes[4] == "LP", codes


def test_totals_include_lop_subcount(seeded_lop_member, base_url):
    tok = _login(base_url)
    hdr = {"Authorization": f"Bearer {tok}"}
    r = requests.get(
        f"{base_url}/api/reports/calendar-grid",
        headers=hdr, params={"month": _current_month()}, timeout=45,
    )
    row = next(x for x in r.json()["rows"] if x["member_id"] == seeded_lop_member["member_id"])
    totals = row["totals"]
    # LOP sub-count matches what payroll would deduct.
    assert totals.get("lop") == 2, totals
    # LP still rolls into the leave total (backward compat).
    assert totals.get("leave") >= 5, totals


def test_cell_meta_carries_balance_split(seeded_lop_member, base_url):
    tok = _login(base_url)
    hdr = {"Authorization": f"Bearer {tok}"}
    r = requests.get(
        f"{base_url}/api/reports/calendar-grid",
        headers=hdr, params={"month": _current_month()}, timeout=45,
    )
    row = next(x for x in r.json()["rows"] if x["member_id"] == seeded_lop_member["member_id"])
    meta = row.get("cell_meta") or {}
    d0 = date.fromisoformat(seeded_lop_member["start"])
    # Pick a mid-leave day — should carry the balance-split tooltip line.
    day2 = (d0 + timedelta(days=1)).isoformat()
    assert day2 in meta, f"Expected cell_meta for {day2}"
    entry = meta[day2]
    assert "balance_split" in entry, entry
    # Should mention both "Paid" and "LOP".
    assert "Paid" in entry["balance_split"] or "LOP" in entry["balance_split"], entry
