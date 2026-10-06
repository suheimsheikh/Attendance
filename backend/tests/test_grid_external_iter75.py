"""Iteration 75: external /api/grid key-gated punch-metadata regression tests."""

from __future__ import annotations

import copy
import json
import os
import uuid
from pathlib import Path

import pytest
import requests

from services.grid_punches import _punch_hm, grid_punch_meta




def _grid_key() -> str:
    return (os.environ.get("GRID_API_KEY") or "").strip()


def _embed_key() -> str:
    return (os.environ.get("EMBED_KEY") or "").strip()


def _read_json(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _without_row_cell_meta(payload: dict) -> dict:
    data = copy.deepcopy(payload)
    for row in data.get("rows", []):
        row.pop("cell_meta", None)
    return data


# Modules/features: external key gating and auth/session independence.
def test_grid_key_only_access_and_401_without_or_invalid_key(base_url: str, admin_client: requests.Session):
    key = _grid_key()
    if not key:
        pytest.skip("GRID_API_KEY missing")

    ok = requests.get(
        f"{base_url}/api/grid",
        params={"month": "2026-09", "key": key},
        timeout=60,
    )
    assert ok.status_code == 200, ok.text

    no_key = requests.get(
        f"{base_url}/api/grid",
        params={"month": "2026-09"},
        timeout=60,
    )
    assert no_key.status_code == 401, no_key.text

    invalid_key = admin_client.get(
        f"{base_url}/api/grid",
        params={"month": "2026-09", "key": "invalid-grid-key"},
        timeout=60,
    )
    assert invalid_key.status_code == 401, invalid_key.text


# Modules/features: legacy EMBED_KEY compatibility for /api/grid read access.
def test_grid_embed_key_still_works(base_url: str):
    embed_key = _embed_key()
    if not embed_key:
        pytest.skip("EMBED_KEY missing")
    r = requests.get(
        f"{base_url}/api/grid",
        params={"month": "2026-08", "key": embed_key},
        timeout=60,
    )
    assert r.status_code == 200, r.text


# Modules/features: legacy payload parity (excluding per-row cell_meta).
@pytest.mark.parametrize(
    "month,snapshot",
    [
        ("2026-08", "/tmp/grid-before-2026-08.json"),
        ("2026-09", "/tmp/grid-before-2026-09.json"),
    ],
)
def test_grid_legacy_contract_unchanged_except_cell_meta(base_url: str, month: str, snapshot: str):
    key = _grid_key()
    if not key:
        pytest.skip("GRID_API_KEY missing")
    if not Path(snapshot).exists():
        pytest.skip("Pre-change snapshot exists only in the original verification environment")

    current = requests.get(
        f"{base_url}/api/grid",
        params={"month": month, "key": key},
        timeout=90,
    )
    assert current.status_code == 200, current.text
    before = _read_json(snapshot)

    assert _without_row_cell_meta(current.json()) == _without_row_cell_meta(before)


# Modules/features: admin calendar-grid full-tooltip metadata remains unchanged.
def test_admin_calendar_grid_aug_full_payload_matches_snapshot(admin_client: requests.Session, base_url: str):
    snap = "/tmp/admin-grid-before-2026-08.json"
    if not Path(snap).exists():
        pytest.skip("Pre-change snapshot exists only in the original verification environment")
    r = admin_client.get(
        f"{base_url}/api/reports/calendar-grid",
        params={"month": "2026-08"},
        timeout=90,
    )
    assert r.status_code == 200, r.text
    assert r.json() == _read_json(snap)


# Modules/features: cell_meta code/date alignment and known real-data punch facts.
def test_grid_cell_meta_shape_and_known_august_values(base_url: str):
    key = _grid_key()
    if not key:
        pytest.skip("GRID_API_KEY missing")

    r = requests.get(
        f"{base_url}/api/grid",
        params={"month": "2026-08", "key": key, "category": "all"},
        timeout=90,
    )
    assert r.status_code == 200, r.text
    payload = r.json()
    days = payload["days"]

    for row in payload["rows"]:
        assert set(row["cell_meta"].keys()) == set(days)
        for idx, iso in enumerate(days):
            m = row["cell_meta"][iso]
            assert m["code"] == row["cells"][idx]

    ainul = next((x for x in payload["rows"] if (x.get("member_name") or "").strip().upper() == "AINUL HAQUE"), None)
    assert ainul is not None, "Expected AINUL HAQUE in Aug 2026 grid"

    aug1 = ainul["cell_meta"].get("2026-08-01")
    assert aug1 and aug1.get("code") in {"P", "LT", "HD"}
    assert aug1.get("in") == "09:22"
    assert aug1.get("out") == "18:01"

    aug6 = ainul["cell_meta"].get("2026-08-06")
    assert aug6 and aug6.get("code") == "TR"
    assert "in" not in aug6 and "out" not in aug6


# Modules/features: category semantics (all/default, exact matches, unknown empty, fleet/institution filters).
def test_grid_category_and_dimension_filters(base_url: str):
    key = _grid_key()
    if not key:
        pytest.skip("GRID_API_KEY missing")

    no_cat = requests.get(
        f"{base_url}/api/grid",
        params={"month": "2026-08", "key": key},
        timeout=90,
    )
    all_cat = requests.get(
        f"{base_url}/api/grid",
        params={"month": "2026-08", "key": key, "category": "all"},
        timeout=90,
    )
    assert no_cat.status_code == 200 and all_cat.status_code == 200
    rows_no_cat = no_cat.json()["rows"]
    rows_all = all_cat.json()["rows"]
    assert [r["member_id"] for r in rows_no_cat] == [r["member_id"] for r in rows_all]

    all_payload = all_cat.json()
    for exact in ["staff", "coach", "executive"]:
        exact_resp = requests.get(
            f"{base_url}/api/grid",
            params={"month": "2026-08", "key": key, "category": exact},
            timeout=90,
        )
        assert exact_resp.status_code == 200, exact_resp.text
        assert exact_resp.json()["rows"] == [r for r in rows_all if r.get("category") == exact]
        for row in exact_resp.json()["rows"]:
            assert (row.get("category") or "") == exact

    unknown = requests.get(
        f"{base_url}/api/grid",
        params={"month": "2026-08", "key": key, "category": "definitely-unknown-category"},
        timeout=90,
    )
    assert unknown.status_code == 200, unknown.text
    assert unknown.json().get("rows") == []

    custom = next(
        (
            r.get("category")
            for r in all_payload["rows"]
            if (r.get("category") or "") not in {"athlete", "elite", "rest", "payroll", "staff", "coach", "executive"}
        ),
        None,
    )
    if custom:
        custom_resp = requests.get(
            f"{base_url}/api/grid",
            params={"month": "2026-08", "key": key, "category": custom},
            timeout=90,
        )
        assert custom_resp.status_code == 200, custom_resp.text
        assert all((r.get("category") or "") == custom for r in custom_resp.json()["rows"])

    target_fleet = next((r for r in all_payload["rows"] if r.get("fleet")), None)
    if target_fleet:
        fleet_name = target_fleet["fleet"]
        fleet_resp = requests.get(
            f"{base_url}/api/grid",
            params={"month": "2026-08", "key": key, "fleet": fleet_name},
            timeout=90,
        )
        assert fleet_resp.status_code == 200, fleet_resp.text
        frows = fleet_resp.json()["rows"]
        assert frows
        assert all((r.get("fleet") or "").lower() == fleet_name.lower() for r in frows)

    target_inst = next((r for r in all_payload["rows"] if r.get("institution")), None)
    if target_inst:
        inst_name = target_inst["institution"]
        inst_resp = requests.get(
            f"{base_url}/api/grid",
            params={"month": "2026-08", "key": key, "institution": inst_name},
            timeout=90,
        )
        assert inst_resp.status_code == 200, inst_resp.text
        irows = inst_resp.json()["rows"]
        assert irows
        assert all((r.get("institution") or "") == inst_name for r in irows)


# Modules/features: _punch_hm timezone and malformed-input safety.
def test_punch_hm_timezone_behaviour_and_malformed_input():
    office = {"timezone": "Asia/Kolkata"}

    assert _punch_hm("2026-08-10T09:30:00", office) == "09:30"
    assert _punch_hm("2026-08-10T04:00:00+00:00", office) == "09:30"
    assert _punch_hm("2026-08-01T23:40:00Z", office) == "05:10"
    assert _punch_hm("2026-08-10T23:50:00-02:00", office) == "07:20"
    assert _punch_hm("not-an-iso", office) is None
    assert _punch_hm(None, office) is None


@pytest.mark.parametrize("category", ["athlete", "elite", "rest", "payroll"])
def test_legacy_grid_category_buckets_unchanged(base_url, admin_client, category):
    params = {"month": "2026-08", "category": category}
    external = requests.get(f"{base_url}/api/grid", params={**params, "key": _grid_key()}, timeout=60)
    internal = admin_client.get(f"{base_url}/api/reports/calendar-grid", params=params, timeout=60)
    assert external.status_code == internal.status_code == 200
    assert _without_row_cell_meta(external.json()) == _without_row_cell_meta(internal.json())


@pytest.mark.parametrize("code", ["WO", "HO", "LV", "TR", "PS", "CO", "BK", "AB", "LP", "NJ", "LF", ""])
def test_code_only_days_never_expose_punches(code):
    iso = "2026-09-01"
    stale = {iso: {"check_in_at": "2026-09-01T04:00:00Z", "check_out_at": "2026-09-01T12:30:00Z"}}
    assert grid_punch_meta([iso], [code], stale, {"timezone": "Asia/Kolkata"}) == {iso: {"code": code}}
    assert grid_punch_meta([iso], [code], {}, {"timezone": "Asia/Kolkata"}) == {iso: {"code": code}}


def test_worked_day_missing_checkin_and_missing_checkout_are_explicit_null():
    office = {"timezone": "Asia/Kolkata"}
    days = ["2026-09-01", "2026-09-02"]
    meta = grid_punch_meta(days, ["P", "LT"], {
        days[0]: {"check_out_at": "2026-09-01T12:30:00Z"},
        days[1]: {"check_in_at": "2026-09-02T04:30:00Z"},
    }, office)
    assert meta[days[0]] == {"code": "P", "in": None, "out": "18:00"}
    assert meta[days[1]] == {"code": "LT", "in": "10:00", "out": None}


# Modules/features: grid_punch_meta null/omit logic for worked/code-only/override days.
def test_grid_punch_meta_null_omit_and_override_rules():
    office = {"timezone": "Asia/Kolkata"}
    days = [
        "2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05",
        "2026-08-06", "2026-08-07", "2026-08-08",
    ]
    cells = ["P", "P", "P", "P", "HD", "TR", "TR", "AB"]
    attendance = {
        "2026-08-01": {"check_in_at": "2026-08-01T04:00:00+00:00", "check_out_at": "2026-08-01T12:30:00+00:00"},
        # Explicit missing checkout.
        "2026-08-02": {
            "check_in_at": "2026-08-02T04:00:00+00:00",
            "check_out_at": "2026-08-02T12:30:00+00:00",
            "missing_checkout": True,
            "auto_checkout": True,
        },
        # Legacy auto-checkout rows without missing flag still hide out.
        "2026-08-03": {
            "check_in_at": "2026-08-03T04:00:00+00:00",
            "check_out_at": "2026-08-03T12:30:00+00:00",
            "auto_checkout": True,
        },
        # Corrected row: missing_checkout=False + auto_checkout=True should expose out.
        "2026-08-04": {
            "check_in_at": "2026-08-04T04:00:00+00:00",
            "check_out_at": "2026-08-04T12:30:00+00:00",
            "missing_checkout": False,
            "auto_checkout": True,
        },
        # Worked code without attendance should still include explicit nulls.
        # (No session for 2026-08-05)
        # Code-only TR (no punches) should omit in/out.
        # A code-only manual override stays code-only even with stale punches.
        "2026-08-07": {
            "check_in_at": "2026-08-07T04:10:00+00:00",
            "check_out_at": "2026-08-07T12:00:00+00:00",
        },
    }

    meta = grid_punch_meta(days, cells, attendance, office)

    assert meta["2026-08-01"] == {"code": "P", "in": "09:30", "out": "18:00"}
    assert meta["2026-08-02"] == {"code": "P", "in": "09:30", "out": None}
    assert meta["2026-08-03"] == {"code": "P", "in": "09:30", "out": None}
    assert meta["2026-08-04"] == {"code": "P", "in": "09:30", "out": "18:00"}
    assert meta["2026-08-05"] == {"code": "HD", "in": None, "out": None}
    assert meta["2026-08-06"] == {"code": "TR"}
    assert meta["2026-08-07"] == {"code": "TR"}
    assert meta["2026-08-08"] == {"code": "AB"}


# Modules/features: external /api/grid DB projection + alias/exclude_unset with synthetic QA fixtures.
def test_grid_api_synthetic_projection_and_alias_exclude_unset(base_url: str, mongo_db, make_member):
    if mongo_db is None:
        pytest.skip("mongo_db fixture unavailable")
    QA_MEMBER_ID = make_member("staff")["id"]  # throwaway (the old profile.qa account is gone)

    key = _grid_key()
    if not key:
        pytest.skip("GRID_API_KEY missing")

    prefix = f"iter75-grid-{uuid.uuid4().hex[:10]}"

    attendance_docs = [
        {
            "id": f"{prefix}-att-1",
            "user_id": QA_MEMBER_ID,
            "date": "2026-08-24",
            "check_in_at": "2026-08-24T04:00:00+00:00",
            "check_out_at": "2026-08-24T12:30:00+00:00",
            "auto_checkout": True,
            "missing_checkout": True,
        },
        {
            "id": f"{prefix}-att-2",
            "user_id": QA_MEMBER_ID,
            "date": "2026-08-25",
            "check_in_at": "2026-08-25T04:00:00+00:00",
            "check_out_at": "2026-08-25T12:30:00+00:00",
            "auto_checkout": True,
            "missing_checkout": False,
        },
        {
            "id": f"{prefix}-att-3",
            "user_id": QA_MEMBER_ID,
            "date": "2026-08-26",
            "check_in_at": "2026-08-26T09:30:00",
            "check_out_at": "2026-08-26T18:00:00",
            "missing_checkout": False,
        },
        {
            "id": f"{prefix}-att-4", "user_id": QA_MEMBER_ID, "date": "2026-08-29",
            "check_in_at": "2026-08-29T09:30:00", "check_out_at": "2026-08-29T18:00:00",
            "missing_checkout": False,
        },
    ]
    override_docs = [
        {"id": f"{prefix}-ovr-hd", "user_id": QA_MEMBER_ID, "date": "2026-08-27", "code": "HD"},
        {"id": f"{prefix}-ovr-tr", "user_id": QA_MEMBER_ID, "date": "2026-08-26", "code": "TR"},
        {"id": f"{prefix}-ovr-tr2", "user_id": QA_MEMBER_ID, "date": "2026-08-28", "code": "TR"},
    ]

    try:
        mongo_db.attendance.insert_many(attendance_docs)
        mongo_db.grid_overrides.insert_many(override_docs)

        r = requests.get(
            f"{base_url}/api/grid",
            params={"month": "2026-08", "key": key, "category": "staff"},
            timeout=90,
        )
        assert r.status_code == 200, r.text
        payload = r.json()
        row = next((x for x in payload.get("rows", []) if x.get("member_id") == QA_MEMBER_ID), None)
        assert row is not None, "QA member row missing from grid"

        d24 = row["cell_meta"]["2026-08-24"]
        assert d24["code"] in {"P", "LT", "HD", "TR", "AB", "LV", "CO", "PS", "WO", "HO", "BK", "LP", "NJ", "LF", ""}
        assert d24.get("in") == "09:30"
        assert "out" in d24 and d24["out"] is None

        d25 = row["cell_meta"]["2026-08-25"]
        assert d25.get("in") == "09:30"
        assert d25.get("out") == "18:00"

        # Override TR remains code-only, even with attendance.
        d26 = row["cell_meta"]["2026-08-26"]
        assert d26.get("code") == "TR"
        assert "in" not in d26 and "out" not in d26

        # Worked override without attendance keeps explicit nulls.
        d27 = row["cell_meta"]["2026-08-27"]
        assert d27.get("code") == "HD"
        assert "in" in d27 and d27["in"] is None
        assert "out" in d27 and d27["out"] is None

        assert row["cell_meta"]["2026-08-29"] == {"code": "P", "in": "09:30", "out": "18:00"}

        # Code-only non-worked day omits punch keys.
        d28 = row["cell_meta"]["2026-08-28"]
        assert d28.get("code") == "TR"
        assert "in" not in d28 and "out" not in d28
    finally:
        mongo_db.attendance.delete_many({"id": {"$regex": f"^{prefix}"}})
        mongo_db.grid_overrides.delete_many({"id": {"$regex": f"^{prefix}"}})
