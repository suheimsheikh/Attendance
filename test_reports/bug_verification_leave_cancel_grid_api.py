#!/usr/bin/env python3
"""Focused API seed + verification for the Grid leave/tour cancellation bug.

Creates isolated QA members/leaves through the public API, verifies calendar-grid
cell_meta and LP conversion semantics, and writes a UI seed for the browser test.
"""
from __future__ import annotations

import json
import os
import sys
import time
from datetime import date, timedelta

import requests
from pymongo import MongoClient


BASE = os.environ.get("TEST_BASE_URL", "https://attendance-portal-56.preview.emergentagent.com").rstrip("/")
ADMIN_EMAIL = os.environ.get("TEST_ADMIN_EMAIL", "admin@attendance.app")
ADMIN_PASSWORD = os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345")
OUT_PATH = "/app/test_reports/bug_verification_leave_cancel_grid_api_results.json"
UI_SEED_PATH = "/app/test_reports/bug_verification_leave_cancel_grid_ui_seed.json"


class TestFailure(AssertionError):
    pass


def api_request(method: str, path: str, token: str | None = None, **kwargs):
    headers = kwargs.pop("headers", {})
    if token:
        headers["Authorization"] = f"Bearer {token}"
    url = f"{BASE}/api{path}"
    resp = requests.request(method, url, headers=headers, timeout=30, **kwargs)
    if resp.status_code >= 400:
        raise TestFailure(f"{method} {path} failed {resp.status_code}: {resp.text[:500]}")
    if not resp.text:
        return None
    try:
        return resp.json()
    except Exception as exc:  # pragma: no cover - debug aid
        raise TestFailure(f"{method} {path} did not return JSON: {resp.text[:200]}") from exc


def login() -> str:
    data = api_request("POST", "/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
    token = data.get("access_token")
    if not token:
        raise TestFailure("Admin login did not return an access token")
    return token


def cleanup_prefix(prefix: str):
    env_path = "/app/backend/.env"
    env = {}
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.strip().split("=", 1)
                env[k] = v.strip().strip('"')
    client = MongoClient(env.get("MONGO_URL", "mongodb://localhost:27017"))
    db = client[env.get("DB_NAME", "test_database")]
    users = list(db.users.find({"email": {"$regex": f"^{prefix}"}}, {"_id": 0, "id": 1}))
    user_ids = [u["id"] for u in users]
    if user_ids:
        db.corrections.delete_many({"$or": [{"requester_id": {"$in": user_ids}}, {"on_behalf_of": {"$in": user_ids}}]})
        db.leaves.delete_many({"user_id": {"$in": user_ids}})
        db.attendance.delete_many({"user_id": {"$in": user_ids}})
        db.users.delete_many({"id": {"$in": user_ids}})
    client.close()


def make_member(token: str, prefix: str, label: str) -> dict:
    stamp = int(time.time() * 1000)
    payload = {
        "email": f"{prefix}{label}.{stamp}@example.com",
        "password": "Test@12345",
        "full_name": f"QA Leave Grid {label} {stamp}",
        "category": "staff",
        "rank": "QA",
        "role": "member",
        "work_start": "09:00",
        "work_end": "17:00",
        "weekly_off": "sunday",
    }
    user = api_request("POST", "/members", token, json=payload)
    # Leave type rows need paid balance to render LV instead of the existing LOP-tail overlay.
    user = api_request("PATCH", f"/members/{user['id']}", token, json={"leave_balance_opening": 30})
    return user


def get_grid(token: str, month: str) -> dict:
    return api_request("GET", "/reports/calendar-grid", token, params={"month": month})


def row_for(grid: dict, member_id: str) -> dict:
    for row in grid.get("rows", []):
        if row.get("member_id") == member_id:
            return row
    raise TestFailure(f"Calendar grid row missing for member {member_id}")


def pick_three_day_ab_range(grid: dict, member_id: str) -> list[str]:
    row = row_for(grid, member_id)
    days = grid["days"]
    today = date.fromisoformat(grid["today"])
    last_allowed = today - timedelta(days=1)
    # Prefer a clean Tue/Wed/Thu-style AB range so non-LOP fallback is deterministic.
    for i in range(len(days) - 2):
        dates = [date.fromisoformat(d) for d in days[i : i + 3]]
        if dates[-1] > last_allowed:
            continue
        codes = row["cells"][i : i + 3]
        if all(c == "AB" for c in codes):
            return [d.isoformat() for d in dates]
    # Fallback: any non-future three-day range; explicit no-LOP assertion accepts WO/HO.
    for i in range(len(days) - 2):
        dates = [date.fromisoformat(d) for d in days[i : i + 3]]
        if dates[-1] <= last_allowed:
            return [d.isoformat() for d in dates]
    raise TestFailure("Could not find any three-day past range in the current grid month")


def date_codes(grid: dict, member_id: str, dates: list[str]) -> list[str]:
    row = row_for(grid, member_id)
    idx = {d: i for i, d in enumerate(grid["days"])}
    return [row["cells"][idx[d]] for d in dates]


def assert_leave_meta(grid: dict, member_id: str, dates: list[str], leave_id: str, expected_codes: set[str]):
    row = row_for(grid, member_id)
    idx = {d: i for i, d in enumerate(grid["days"])}
    for d in dates:
        code = row["cells"][idx[d]]
        if code not in expected_codes:
            raise TestFailure(f"Expected {d} code in {expected_codes}, got {code}")
        meta = (row.get("cell_meta") or {}).get(d) or {}
        if meta.get("leave_id") != leave_id:
            raise TestFailure(f"Expected cell_meta[{d}].leave_id={leave_id}, got {meta}")


def assert_no_leave_id_on_non_leave_family(grid: dict):
    bad = []
    leave_family = {"LV", "LP", "TR", "CO", "PS"}
    for row in grid.get("rows", []):
        meta = row.get("cell_meta") or {}
        for iso, code in zip(grid["days"], row.get("cells", [])):
            if code not in leave_family and (meta.get(iso) or {}).get("leave_id"):
                bad.append({"member_id": row.get("member_id"), "date": iso, "code": code, "meta": meta.get(iso)})
                if len(bad) >= 5:
                    break
        if len(bad) >= 5:
            break
    if bad:
        raise TestFailure(f"Non leave-family cells exposed leave_id: {bad}")


def create_approved_leave(token: str, member_id: str, leave_type: str, dates: list[str], reason: str) -> dict:
    leave = api_request(
        "POST",
        f"/leaves?target_user_id={member_id}",
        token,
        json={"type": leave_type, "start_date": dates[0], "end_date": dates[-1], "reason": reason, "location": "QA"},
    )
    leave = api_request("PATCH", f"/leaves/{leave['id']}", token, json={"status": "approved"})
    if leave.get("status") != "approved":
        raise TestFailure(f"Leave approval did not persist: {leave}")
    return leave


def fetch_leave(token: str, leave_id: str, status_filter: str | None = None) -> dict:
    params = {"status_filter": status_filter} if status_filter else {}
    leaves = api_request("GET", "/leaves", token, params=params)
    for leave in leaves:
        if leave.get("id") == leave_id:
            return leave
    # Fall back to all statuses for undo checks.
    if status_filter:
        return fetch_leave(token, leave_id, None)
    raise TestFailure(f"Leave {leave_id} not found in /leaves")


def cancel_leave(token: str, member_id: str, leave_id: str, target_date: str, reason: str, payload: dict | None = None) -> dict:
    return api_request(
        "POST",
        "/corrections",
        token,
        json={
            "entity_type": "leave",
            "kind": "leave_cancel",
            "entity_id": leave_id,
            "target_date": target_date,
            "payload": payload or {},
            "reason": reason,
            "on_behalf_of": member_id,
        },
    )


def run():
    prefix = "qa.leavegrid."
    cleanup_prefix(prefix)
    token = login()

    # Resolve actual current calendar-grid month from backend today.
    provisional_month = "2026-07"
    grid = get_grid(token, provisional_month)
    month = (grid.get("today") or provisional_month)[:7]
    grid = get_grid(token, month)

    evidence: dict = {"base_url": BASE, "month": month, "checks": []}

    # LEAVE: approved LV + leave_id, default cancellation -> LP whole range, undo -> LV.
    member_leave = make_member(token, prefix, "Leave")
    grid = get_grid(token, month)
    leave_dates = pick_three_day_ab_range(grid, member_leave["id"])
    leave = create_approved_leave(token, member_leave["id"], "leave", leave_dates, "QA approved leave meta")
    grid = get_grid(token, month)
    assert_leave_meta(grid, member_leave["id"], leave_dates, leave["id"], {"LV"})
    assert_no_leave_id_on_non_leave_family(grid)
    evidence["checks"].append({"name": "approved leave LV cells include leave_id", "member_id": member_leave["id"], "leave_id": leave["id"], "dates": leave_dates, "codes": date_codes(grid, member_leave["id"], leave_dates)})

    corr = cancel_leave(token, member_leave["id"], leave["id"], leave_dates[0], "QA default LP conversion")
    if not (corr.get("ok") and corr.get("auto_approved") and corr.get("applied", {}).get("converted_to_lop") is True):
        raise TestFailure(f"Default leave_cancel did not auto-approve with converted_to_lop=True: {corr}")
    cancelled = fetch_leave(token, leave["id"], "cancelled")
    if cancelled.get("status") != "cancelled" or cancelled.get("converted_to_lop") is not True or float(cancelled.get("lop_days") or 0) != 3.0:
        raise TestFailure(f"Cancelled leave missing converted_to_lop/lop_days=3: {cancelled}")
    grid = get_grid(token, month)
    assert_leave_meta(grid, member_leave["id"], leave_dates, leave["id"], {"LP"})
    evidence["checks"].append({"name": "default leave_cancel paints LP across whole leave", "correction_id": corr["id"], "codes": date_codes(grid, member_leave["id"], leave_dates), "leave_status": {k: cancelled.get(k) for k in ["status", "converted_to_lop", "lop_days"]}})

    undo = api_request("POST", f"/admin/corrections/{corr['id']}/undo", token)
    if not undo.get("ok"):
        raise TestFailure(f"Undo failed: {undo}")
    restored = fetch_leave(token, leave["id"], "approved")
    if restored.get("status") != "approved" or restored.get("converted_to_lop") is not None or restored.get("lop_days") is not None:
        raise TestFailure(f"Undo did not restore approved and clear LOP flags: {restored}")
    grid = get_grid(token, month)
    assert_leave_meta(grid, member_leave["id"], leave_dates, leave["id"], {"LV"})
    evidence["checks"].append({"name": "undo restores approved LV and clears LOP flags", "codes": date_codes(grid, member_leave["id"], leave_dates)})

    # TOUR: approved TR + leave_id, cancellation -> LP, undo -> TR.
    member_tour = make_member(token, prefix, "Tour")
    grid = get_grid(token, month)
    tour_dates = pick_three_day_ab_range(grid, member_tour["id"])
    tour = create_approved_leave(token, member_tour["id"], "tour", tour_dates, "QA tour cancel LP")
    grid = get_grid(token, month)
    assert_leave_meta(grid, member_tour["id"], tour_dates, tour["id"], {"TR"})
    tcorr = cancel_leave(token, member_tour["id"], tour["id"], tour_dates[0], "QA default tour LP conversion")
    grid = get_grid(token, month)
    assert_leave_meta(grid, member_tour["id"], tour_dates, tour["id"], {"LP"})
    api_request("POST", f"/admin/corrections/{tcorr['id']}/undo", token)
    grid = get_grid(token, month)
    assert_leave_meta(grid, member_tour["id"], tour_dates, tour["id"], {"TR"})
    evidence["checks"].append({"name": "tour TR cancels to LP across range and undo restores TR", "tour_id": tour["id"], "dates": tour_dates, "codes_after_undo": date_codes(grid, member_tour["id"], tour_dates)})

    # Regression: explicit convert_to_lop=false cancels but does NOT paint LP/leave_id.
    member_no_lop = make_member(token, prefix, "NoLop")
    grid = get_grid(token, month)
    no_lop_dates = pick_three_day_ab_range(grid, member_no_lop["id"])
    no_lop_leave = create_approved_leave(token, member_no_lop["id"], "leave", no_lop_dates, "QA no LOP opt out")
    no_lop_corr = cancel_leave(token, member_no_lop["id"], no_lop_leave["id"], no_lop_dates[0], "QA explicit no LP", {"convert_to_lop": False})
    if no_lop_corr.get("applied", {}).get("converted_to_lop") is not False:
        raise TestFailure(f"convert_to_lop=false not respected in applied payload: {no_lop_corr}")
    cancelled_no_lop = fetch_leave(token, no_lop_leave["id"], "cancelled")
    if cancelled_no_lop.get("converted_to_lop") is not None:
        raise TestFailure(f"convert_to_lop=false stamped converted_to_lop unexpectedly: {cancelled_no_lop}")
    grid = get_grid(token, month)
    codes = date_codes(grid, member_no_lop["id"], no_lop_dates)
    if any(c == "LP" for c in codes):
        raise TestFailure(f"convert_to_lop=false still painted LP: {codes}")
    row = row_for(grid, member_no_lop["id"])
    bad_meta = {d: (row.get("cell_meta") or {}).get(d) for d in no_lop_dates if ((row.get("cell_meta") or {}).get(d) or {}).get("leave_id")}
    if bad_meta:
        raise TestFailure(f"cancelled non-LOP leave still exposed leave_id metadata: {bad_meta}")
    evidence["checks"].append({"name": "convert_to_lop false cancels without LP or leave_id", "codes": codes, "leave_status": {k: cancelled_no_lop.get(k) for k in ["status", "converted_to_lop", "lop_days"]}})

    # UI seed: leave an approved LV row for browser click/submit verification.
    member_ui = make_member(token, prefix, "Ui")
    grid = get_grid(token, month)
    ui_dates = pick_three_day_ab_range(grid, member_ui["id"])
    ui_leave = create_approved_leave(token, member_ui["id"], "leave", ui_dates, "QA UI click prebind")
    grid = get_grid(token, month)
    assert_leave_meta(grid, member_ui["id"], ui_dates, ui_leave["id"], {"LV"})
    ui_seed = {
        "base_url": BASE,
        "month": month,
        "member_id": member_ui["id"],
        "member_name": member_ui["full_name"],
        "leave_id": ui_leave["id"],
        "dates": ui_dates,
        "target_date": ui_dates[0],
        "admin_email": ADMIN_EMAIL,
        "admin_password": ADMIN_PASSWORD,
    }
    with open(UI_SEED_PATH, "w", encoding="utf-8") as f:
        json.dump(ui_seed, f, indent=2)
    evidence["ui_seed"] = ui_seed

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(evidence, f, indent=2)
    print(json.dumps({"ok": True, "results": OUT_PATH, "ui_seed": UI_SEED_PATH, "checks": len(evidence["checks"])}))


if __name__ == "__main__":
    try:
        run()
    except Exception as exc:
        payload = {"ok": False, "error": str(exc), "type": type(exc).__name__}
        with open(OUT_PATH, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        print(json.dumps(payload), file=sys.stderr)
        raise