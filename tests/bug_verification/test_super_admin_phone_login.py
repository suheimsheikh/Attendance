#!/usr/bin/env python3
"""Focused verification for super-admin phone passwordless login bug.

This script intentionally mutates only the seeded admin row and test device rows,
then restores the admin row to a known-good state at the end.
"""
from __future__ import annotations

import json
import os
import subprocess
import time
import uuid
from pathlib import Path

import requests
from dotenv import dotenv_values
from pymongo import MongoClient

BACKEND_LOCAL = "http://localhost:8001/api"
SUPER_PHONE = "9849002111"
ADMIN_EMAIL = "admin@attendance.app"
ADMIN_PASSWORD = "Admin@12345"
UNKNOWN_PHONE = "7777771234"


def load_db():
    cfg = dotenv_values("/app/backend/.env")
    mongo_url = cfg.get("MONGO_URL") or os.environ.get("MONGO_URL") or "mongodb://localhost:27017"
    db_name = cfg.get("DB_NAME") or os.environ.get("DB_NAME") or "test_database"
    client = MongoClient(mongo_url)
    return client, client[db_name]


def phone_login(phone: str, label: str, full_name: str | None = None):
    payload = {
        "phone": phone,
        "device_id": f"qa-{label}-{uuid.uuid4().hex}",
        "device_name": "QA Browser",
        "model": "Playwright/API",
        "platform": "bug-verification",
    }
    if full_name:
        payload["full_name"] = full_name
    res = requests.post(f"{BACKEND_LOCAL}/auth/phone", json=payload, timeout=20)
    try:
        data = res.json()
    except Exception:
        data = {"raw": res.text}
    return res.status_code, data, payload["device_id"]


def assert_true(condition: bool, message: str):
    if not condition:
        raise AssertionError(message)


def wait_backend_ready(timeout_s: int = 45):
    deadline = time.time() + timeout_s
    last_error = None
    while time.time() < deadline:
        try:
            r = requests.get(f"{BACKEND_LOCAL}/health", timeout=5)
            if r.status_code < 500:
                return True
        except Exception as e:
            last_error = e
        time.sleep(1)
    raise RuntimeError(f"backend did not become ready: {last_error}")


def main():
    client, db = load_db()
    results = []
    created_device_ids = []
    original_admin = db.users.find_one({"email": ADMIN_EMAIL})
    assert_true(original_admin is not None, "Seeded admin row is missing")
    admin_id = original_admin["id"]

    def record(name, ok, detail):
        results.append({"name": name, "ok": bool(ok), "detail": detail})
        print(("PASS" if ok else "FAIL"), name, "-", detail)

    try:
        # Direct API proof for normal current state.
        code, data, dev = phone_login(SUPER_PHONE, "direct-super")
        created_device_ids.append(dev)
        record(
            "direct super-admin phone login approved",
            code == 200 and data.get("status") == "approved" and data.get("user", {}).get("role") == "admin" and bool(data.get("access_token")),
            {"http": code, "status": data.get("status"), "role": data.get("user", {}).get("role"), "token_present": bool(data.get("access_token"))},
        )

        # Email login regression in the normal, restored admin state.
        email_res = requests.post(f"{BACKEND_LOCAL}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=20)
        try:
            email_data = email_res.json()
        except Exception:
            email_data = {"raw": email_res.text}
        record(
            "admin email login still works",
            email_res.status_code == 200 and email_data.get("user", {}).get("role") == "admin" and bool(email_data.get("access_token")),
            {"http": email_res.status_code, "role": email_data.get("user", {}).get("role"), "token_present": bool(email_data.get("access_token"))},
        )

        # Layer 1: remove mobile fields, restart backend so startup seed/backfill runs, verify restored.
        db.users.update_one({"id": admin_id}, {"$unset": {"mobile": "", "mobile_last10": ""}, "$set": {"role": "admin"}})
        mutated = db.users.find_one({"id": admin_id}, {"_id": 0, "mobile": 1, "mobile_last10": 1, "role": 1})
        assert_true("mobile" not in mutated and "mobile_last10" not in mutated, f"precondition failed: admin mobile not unset: {mutated}")
        restart = subprocess.run(["sudo", "supervisorctl", "restart", "backend"], cwd="/app", capture_output=True, text=True, timeout=60)
        assert_true(restart.returncode == 0, f"backend restart failed: {restart.stdout} {restart.stderr}")
        wait_backend_ready()
        admin_after_restart = db.users.find_one({"id": admin_id}, {"_id": 0, "role": 1, "mobile": 1, "mobile_last10": 1})
        record(
            "startup backfill restores admin mobile",
            admin_after_restart.get("mobile") == SUPER_PHONE and admin_after_restart.get("mobile_last10") == SUPER_PHONE and admin_after_restart.get("role") == "admin",
            admin_after_restart,
        )

        # Layer 2: drift-corrupt admin row without restart, then login must elevate and restore mobile.
        db.users.update_one({"id": admin_id}, {"$unset": {"mobile": "", "mobile_last10": ""}, "$set": {"role": "member"}})
        code, data, dev = phone_login(SUPER_PHONE, "breakglass", full_name="QA Super Admin")
        created_device_ids.append(dev)
        admin_after_breakglass = db.users.find_one({"id": admin_id}, {"_id": 0, "email": 1, "full_name": 1, "role": 1, "mobile": 1, "mobile_last10": 1})
        # Note: expected by main-agent description: DB now shows original admin role+mobile.
        record(
            "runtime break-glass restores original admin row after role/mobile drift",
            code == 200 and data.get("status") == "approved" and data.get("user", {}).get("role") == "admin" and bool(data.get("access_token")) and admin_after_breakglass.get("role") == "admin" and admin_after_breakglass.get("mobile") == SUPER_PHONE,
            {"http": code, "response_status": data.get("status"), "response_user": data.get("user"), "admin_row": admin_after_breakglass},
        )

        # Member phone regression.
        member = db.users.find_one({"role": "member", "mobile": {"$exists": True, "$nin": [None, "", SUPER_PHONE]}}, {"_id": 0, "id": 1, "full_name": 1, "role": 1, "mobile": 1})
        assert_true(member is not None, "No regular member with mobile found for regression test")
        # Make sure no prior approved device auto-approves this QA device, so endpoint returns pending but matched_member.
        code, data, dev = phone_login(member["mobile"], "regular-member")
        created_device_ids.append(dev)
        member_after = db.users.find_one({"id": member["id"]}, {"_id": 0, "id": 1, "role": 1, "mobile": 1})
        record(
            "non-super-admin member phone is not elevated",
            code == 200 and member_after.get("role") == "member" and (data.get("user", {}).get("role") in (None, "member")) and data.get("status") in ("pending", "approved"),
            {"http": code, "response_status": data.get("status"), "response_user_role": data.get("user", {}).get("role"), "member_row": member_after},
        )

        # Unknown non-super phone regression.
        assert_true(db.users.count_documents({"$or": [{"mobile": UNKNOWN_PHONE}, {"mobile_last10": UNKNOWN_PHONE}]}) == 0, "Unknown phone already exists in users")
        code, data, dev = phone_login(UNKNOWN_PHONE, "unknown")
        created_device_ids.append(dev)
        unknown_admins = list(db.users.find({"$or": [{"mobile": UNKNOWN_PHONE}, {"mobile_last10": UNKNOWN_PHONE}], "role": "admin"}, {"_id": 0, "id": 1, "role": 1, "mobile": 1}))
        record(
            "unknown non-super phone stays pending and does not create admin",
            code == 200 and data.get("status") == "pending" and data.get("needs_profile") is True and not unknown_admins,
            {"http": code, "response": data, "unknown_admins": unknown_admins},
        )

    finally:
        # Restore original seeded admin identity to known-good super-admin state.
        restore_fields = {
            "role": "admin",
            "mobile": SUPER_PHONE,
            "mobile_last10": SUPER_PHONE,
        }
        if original_admin:
            # Preserve normal seeded identity; do not restore hashed_password from printed output.
            for field in ["email", "full_name", "category", "rank"]:
                if field in original_admin:
                    restore_fields[field] = original_admin[field]
        db.users.update_one({"id": admin_id}, {"$set": restore_fields})
        if created_device_ids:
            db.devices.delete_many({"device_id": {"$in": created_device_ids}})
        client.close()

    all_ok = all(r["ok"] for r in results)
    out = {"all_ok": all_ok, "results": results}
    Path("/app/test_reports/super_admin_phone_api_results.json").write_text(json.dumps(out, indent=2, default=str))
    if not all_ok:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
