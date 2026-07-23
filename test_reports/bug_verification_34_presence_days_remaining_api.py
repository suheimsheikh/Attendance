#!/usr/bin/env python3
"""Focused API/DB verification for /api/presence days_remaining bug."""
import json
import os
import sys
import uuid
from datetime import date, timedelta
from pathlib import Path

import requests
from pymongo import MongoClient

BASE_URL = os.environ.get("TEST_BASE_URL", "http://localhost:8001")
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")
ADMIN_EMAIL = os.environ.get("TEST_ADMIN_EMAIL", "admin@attendance.app")
ADMIN_PASSWORD = os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345")
META_PATH = Path("/app/test_reports/presence_days_remaining_seed_meta.json")
OUT_PATH = Path("/app/test_reports/presence_days_remaining_api_result.json")

REQUIRED_MEMBER_KEYS = {
    "id", "full_name", "role", "category", "rank", "institution", "fleet", "leaving_date",
    "status", "detail", "site_id", "site_name", "since", "photo", "flagged", "late",
    "expected_return", "expected_return_time", "overdue_minutes", "geo_in", "geo_out",
    "father_mobile", "mother_mobile", "guardian_mobile", "work_start", "notified_today",
    "notify_due", "excursion_count", "excursions", "sessions_today_count", "leave_kind",
    "half_day", "days_remaining", "days_absent_streak", "check_in_at", "check_in_time",
    "check_out_at", "check_out_time", "stored_hours", "auto_checkout", "auto_checkout_reason",
    "late_minutes",
}


def load_env_file(path):
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k, v.strip().strip('"').strip("'"))


def api_login():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=30,
    )
    r.raise_for_status()
    token = r.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def fetch_presence(headers, on=None):
    params = {"on": on} if on else None
    r = requests.get(f"{BASE_URL}/api/presence", headers=headers, params=params, timeout=30)
    if r.status_code != 200:
        raise AssertionError(f"GET /api/presence failed {r.status_code}: {r.text[:500]}")
    data = r.json()
    if not isinstance(data, dict) or not isinstance(data.get("members"), list):
        raise AssertionError(f"Unexpected presence payload shape: {type(data)} keys={list(data) if isinstance(data, dict) else None}")
    return data


def ensure_synthetic_data(db):
    """Create deterministic leave rows only if preview DB lacks usable rows."""
    today = date.today()
    today_s = today.isoformat()
    # Existing active leave preferred.
    active = db.leaves.find_one(
        {"status": "approved", "type": "leave", "start_date": {"$lte": today_s}, "end_date": {"$gte": today_s}},
        {"_id": 0},
    )
    # Existing historical leave preferred: any approved normal leave before today.
    historical = db.leaves.find_one(
        {"status": "approved", "type": "leave", "start_date": {"$lt": today_s}, "end_date": {"$gte": "$start_date"}},
        {"_id": 0},
    )
    created = []
    synthetic_user_id = None

    if active and historical:
        META_PATH.write_text(json.dumps({"created": [], "active_leave_id": active.get("id"), "historical_leave_id": historical.get("id")}, indent=2))
        return {"created": created, "active": active, "historical": historical}

    synthetic_user_id = f"qa-presence-days-{uuid.uuid4().hex[:8]}"
    user_doc = {
        "id": synthetic_user_id,
        "email": f"{synthetic_user_id}@example.test",
        "full_name": "QA Presence Days Remaining",
        "role": "member",
        "category": "staff",
        "rank": "QA",
        "mobile": "9999900000",
        "mobile_last10": "9999900000",
        "work_start": "09:00",
        "work_end": "17:00",
        "institution": "QA Institute",
        "fleet": "QA Fleet",
        "father_mobile": None,
        "mother_mobile": None,
        "guardian_mobile": None,
        "leaving_date": None,
        "personal_qr": "QA-" + uuid.uuid4().hex[:10].upper(),
        "hashed_password": "not-used-for-presence-test",
    }
    db.users.insert_one(user_doc)
    created.append({"collection": "users", "id": synthetic_user_id})

    if not active:
        active_leave = {
            "id": f"qa-active-leave-{uuid.uuid4().hex[:8]}",
            "user_id": synthetic_user_id,
            "type": "leave",
            "status": "approved",
            "start_date": today_s,
            "end_date": (today + timedelta(days=4)).isoformat(),
            "reason": "QA active leave for days_remaining verification",
            "created_at": date.today().isoformat(),
        }
        db.leaves.insert_one(active_leave)
        created.append({"collection": "leaves", "id": active_leave["id"]})
        active = {k: v for k, v in active_leave.items() if k != "_id"}

    if not historical:
        hist_start = today - timedelta(days=12)
        hist_on = today - timedelta(days=10)
        hist_end = today - timedelta(days=8)
        hist_leave = {
            "id": f"qa-historical-leave-{uuid.uuid4().hex[:8]}",
            "user_id": synthetic_user_id,
            "type": "leave",
            "status": "approved",
            "start_date": hist_start.isoformat(),
            "end_date": hist_end.isoformat(),
            "reason": "QA historical leave for days_remaining verification",
            "created_at": date.today().isoformat(),
            "_qa_on_date": hist_on.isoformat(),
        }
        db.leaves.insert_one({k: v for k, v in hist_leave.items() if not k.startswith("_qa")})
        created.append({"collection": "leaves", "id": hist_leave["id"]})
        historical = {k: v for k, v in hist_leave.items() if k != "_id"}

    META_PATH.write_text(json.dumps({"created": created, "synthetic_user_id": synthetic_user_id}, indent=2))
    return {"created": created, "active": active, "historical": historical}


def validate_member_shape(data):
    members = data.get("members", [])
    missing = []
    for m in members:
        missing_keys = sorted(REQUIRED_MEMBER_KEYS - set(m.keys()))
        if missing_keys:
            missing.append({"id": m.get("id"), "full_name": m.get("full_name"), "missing": missing_keys})
    if missing:
        raise AssertionError(f"Presence member shape regression; missing keys: {missing[:3]}")
    return len(members)


def find_presence_row(data, user_id):
    for m in data["members"]:
        if m.get("id") == user_id:
            return m
    return None


def choose_historical_on_date(leave):
    if leave.get("_qa_on_date"):
        return leave["_qa_on_date"]
    start = date.fromisoformat(leave["start_date"])
    end = date.fromisoformat(leave["end_date"])
    today = date.today()
    # Pick a date inside the leave, ideally before today to prove historical calculation.
    candidate = start
    if start < today:
        candidate = min(end, today - timedelta(days=1))
        if candidate < start:
            candidate = start
    return candidate.isoformat()


def main():
    load_env_file("/app/backend/.env")
    global MONGO_URL, DB_NAME
    MONGO_URL = os.environ.get("MONGO_URL", MONGO_URL)
    DB_NAME = os.environ.get("DB_NAME", DB_NAME)
    client = MongoClient(MONGO_URL, serverSelectionTimeoutMS=5000)
    db = client[DB_NAME]

    setup = ensure_synthetic_data(db)
    headers = api_login()

    live = fetch_presence(headers)
    total_members = validate_member_shape(live)
    active_leave = setup["active"]
    active_row = find_presence_row(live, active_leave["user_id"])
    if not active_row:
        raise AssertionError(f"Active leave user {active_leave['user_id']} absent from live presence")
    expected_live = max(0, (date.fromisoformat(active_leave["end_date"]) - date.today()).days + 1)
    if active_row.get("status") != "on_leave":
        raise AssertionError(f"Expected active leave row status on_leave, got {active_row.get('status')} for {active_row.get('full_name')}")
    if active_row.get("days_remaining") != expected_live:
        raise AssertionError(
            f"Live days_remaining mismatch for {active_row.get('full_name')}: got {active_row.get('days_remaining')}, expected {expected_live}"
        )
    if not isinstance(active_row.get("days_remaining"), int) or active_row.get("days_remaining") <= 0:
        raise AssertionError(f"Live days_remaining should be positive int, got {active_row.get('days_remaining')!r}")

    historical_leave = setup["historical"]
    hist_on = choose_historical_on_date(historical_leave)
    hist = fetch_presence(headers, hist_on)
    validate_member_shape(hist)
    hist_row = find_presence_row(hist, historical_leave["user_id"])
    if not hist_row:
        raise AssertionError(f"Historical leave user {historical_leave['user_id']} absent from presence?on={hist_on}")
    expected_hist = max(0, (date.fromisoformat(historical_leave["end_date"]) - date.fromisoformat(hist_on)).days + 1)
    if hist_row.get("status") != "on_leave":
        raise AssertionError(f"Expected historical row status on_leave, got {hist_row.get('status')} for {hist_row.get('full_name')}")
    if hist_row.get("days_remaining") != expected_hist:
        raise AssertionError(
            f"Historical days_remaining mismatch relative to {hist_on}: got {hist_row.get('days_remaining')}, expected {expected_hist}"
        )
    if hist_on == date.today().isoformat():
        raise AssertionError("Historical test did not use a past date")

    output = {
        "ok": True,
        "base_url": BASE_URL,
        "db_name": DB_NAME,
        "created_seed": setup["created"],
        "live": {
            "member_id": active_row["id"],
            "full_name": active_row["full_name"],
            "status": active_row["status"],
            "leave_end_date": active_leave["end_date"],
            "days_remaining": active_row["days_remaining"],
            "expected": expected_live,
        },
        "historical": {
            "on": hist_on,
            "member_id": hist_row["id"],
            "full_name": hist_row["full_name"],
            "status": hist_row["status"],
            "leave_start_date": historical_leave["start_date"],
            "leave_end_date": historical_leave["end_date"],
            "days_remaining": hist_row["days_remaining"],
            "expected": expected_hist,
        },
        "regression_shape": {
            "required_member_keys_present_for_all_live_members": True,
            "live_member_count": total_members,
        },
    }
    OUT_PATH.write_text(json.dumps(output, indent=2))
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        OUT_PATH.write_text(json.dumps({"ok": False, "error": str(exc)}, indent=2))
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
