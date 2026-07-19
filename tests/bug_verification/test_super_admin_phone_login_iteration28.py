#!/usr/bin/env python3
"""Iteration 28 focused verification for super-admin phone break-glass login.

This script intentionally simulates the reported production drift, verifies API
and MongoDB persistence, and restores admin/QA-created rows at the end.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

import requests
from dotenv import dotenv_values
from pymongo import MongoClient

BACKEND_LOCAL = "http://localhost:8001/api"
SUPER_PHONE = "9849002111"
ADMIN_EMAIL = "admin@attendance.app"
ADMIN_PASSWORD = "Admin@12345"
UNKNOWN_PHONE = "1234567890"
RESULT_PATH = Path("/app/test_reports/super_admin_phone_iter28_backend_results.json")


def load_db():
    cfg = dotenv_values("/app/backend/.env")
    mongo_url = cfg.get("MONGO_URL") or os.environ.get("MONGO_URL") or "mongodb://localhost:27017"
    db_name = cfg.get("DB_NAME") or os.environ.get("DB_NAME") or "test_database"
    client = MongoClient(mongo_url)
    return client, client[db_name]


def scrub_doc(doc: dict[str, Any] | None) -> dict[str, Any] | None:
    if not doc:
        return doc
    return {k: v for k, v in doc.items() if k not in {"_id", "hashed_password"}}


def phone_login(phone: str, label: str, full_name: str | None = None):
    device_id = f"qa-iter28-{label}-{uuid.uuid4().hex}"
    payload = {
        "phone": phone,
        "device_id": device_id,
        "device_name": "QA Browser",
        "model": "API",
        "platform": "bug-verification-iter28",
    }
    if full_name:
        payload["full_name"] = full_name
    res = requests.post(f"{BACKEND_LOCAL}/auth/phone", json=payload, timeout=20)
    try:
        data = res.json()
    except Exception:
        data = {"raw": res.text}
    return res.status_code, data, device_id


def wait_backend_ready(timeout_s: int = 60):
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        try:
            r = requests.get(f"{BACKEND_LOCAL}/health", timeout=5)
            if r.status_code < 500:
                return
            last = f"HTTP {r.status_code}"
        except Exception as e:
            last = repr(e)
        time.sleep(1)
    raise RuntimeError(f"backend not ready after restart: {last}")


def backend_log_tail(lines: int = 300) -> str:
    proc = subprocess.run(
        ["bash", "-lc", f"tail -n {lines} /var/log/supervisor/backend.*.log 2>/dev/null || true"],
        cwd="/app", capture_output=True, text=True, timeout=20,
    )
    return (proc.stdout or "") + (proc.stderr or "")


def main():
    client, db = load_db()
    results: list[dict[str, Any]] = []
    created_device_ids: list[str] = []
    created_user_ids: list[str] = []
    created_escort_ids: list[str] = []
    original_admin = db.users.find_one({"email": ADMIN_EMAIL})
    if not original_admin:
        raise AssertionError("Seeded admin@attendance.app is missing; cannot test break-glass")
    admin_id = original_admin["id"]

    def record(name: str, ok: bool, detail: Any):
        row = {"name": name, "ok": bool(ok), "detail": detail}
        results.append(row)
        print(("PASS" if ok else "FAIL"), name, json.dumps(detail, default=str)[:2000])

    try:
        # Ensure the exact contested precondition exists: two active escorts share the super-admin phone.
        existing_super_escorts = list(db.escorts.find({"mobile_last10": SUPER_PHONE}, {"_id": 0}).limit(10))
        if len(existing_super_escorts) < 2:
            for i in range(2 - len(existing_super_escorts)):
                eid = f"qa-iter28-super-escort-{uuid.uuid4().hex}"
                db.escorts.insert_one({
                    "id": eid,
                    "name": f"QA Super Phone Escort {i+1}",
                    "phone": SUPER_PHONE,
                    "mobile_last10": SUPER_PHONE,
                    "status": "active",
                    "institution": "QA",
                    "valid_from": "2020-01-01",
                    "valid_until": None,
                    "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                })
                created_escort_ids.append(eid)
            existing_super_escorts = list(db.escorts.find({"mobile_last10": SUPER_PHONE}, {"_id": 0}).limit(10))
        record(
            "precondition: at least two escorts share 9849002111",
            len(existing_super_escorts) >= 2,
            [{k: e.get(k) for k in ["id", "name", "phone", "mobile_last10", "status", "valid_from", "valid_until"]} for e in existing_super_escorts],
        )

        before_logs = backend_log_tail()

        # Primary prod-drift scenario: admin lacks phone fields and is downgraded; escorts still share phone.
        db.users.update_one(
            {"id": admin_id},
            {"$unset": {"mobile": "", "mobile_last10": ""}, "$set": {"role": "member"}},
        )
        drifted = scrub_doc(db.users.find_one({"id": admin_id}, {"_id": 0, "email": 1, "role": 1, "mobile": 1, "mobile_last10": 1, "full_name": 1}))
        record(
            "precondition: seeded admin drifted to member with no mobile fields",
            drifted.get("role") == "member" and not drifted.get("mobile") and not drifted.get("mobile_last10"),
            drifted,
        )

        code, data, dev = phone_login(SUPER_PHONE, "primary", full_name="QA Super Admin")
        created_device_ids.append(dev)
        admin_after = scrub_doc(db.users.find_one({"id": admin_id}, {"_id": 0, "id": 1, "email": 1, "full_name": 1, "role": 1, "mobile": 1, "mobile_last10": 1}))
        ghost_count = db.users.count_documents({"email": {"$regex": r"^super-admin-"}})
        token = data.get("access_token") or ""
        record(
            "primary API: super-admin phone returns approved seeded admin token, not escort",
            code == 200
            and data.get("status") == "approved"
            and bool(token)
            and not data.get("is_escort")
            and data.get("user", {}).get("role") == "admin"
            and data.get("user", {}).get("email") == ADMIN_EMAIL,
            {"http": code, "status": data.get("status"), "is_escort": data.get("is_escort"), "user": data.get("user"), "token_present": bool(token)},
        )
        record(
            "post-login DB: seeded admin restored and no super-admin ghost users",
            admin_after.get("role") == "admin" and admin_after.get("mobile") == SUPER_PHONE and admin_after.get("mobile_last10") == SUPER_PHONE and ghost_count == 0,
            {"admin_after": admin_after, "ghost_count": ghost_count},
        )
        # Verify token resolves as normal admin, not an escort identity.
        me_res = requests.get(f"{BACKEND_LOCAL}/auth/me", headers={"Authorization": f"Bearer {token}"}, timeout=20)
        me_data = me_res.json() if me_res.headers.get("content-type", "").startswith("application/json") else {"raw": me_res.text}
        record(
            "primary token resolves through /auth/me as admin user",
            me_res.status_code == 200 and me_data.get("role") == "admin" and me_data.get("email") == ADMIN_EMAIL and not me_data.get("is_escort"),
            {"http": me_res.status_code, "me": me_data},
        )

        after_logs = backend_log_tail()
        new_logs = after_logs[len(before_logs):] if after_logs.startswith(before_logs) else after_logs
        record(
            "escort preemption guard: break-glass restore log emitted before any escort token outcome",
            "Break-glass: restored seeded admin" in new_logs,
            {"log_contains_restore": "Break-glass: restored seeded admin" in new_logs, "new_log_excerpt": new_logs[-2500:]},
        )

        # Layer 1: unset mobile on admin and restart backend; startup backfill should restore phone.
        db.users.update_one({"id": admin_id}, {"$unset": {"mobile": "", "mobile_last10": ""}, "$set": {"role": "admin"}})
        restart_before = backend_log_tail()
        restart = subprocess.run(["sudo", "supervisorctl", "restart", "backend"], cwd="/app", capture_output=True, text=True, timeout=60)
        wait_backend_ready()
        admin_after_restart = scrub_doc(db.users.find_one({"id": admin_id}, {"_id": 0, "role": 1, "mobile": 1, "mobile_last10": 1, "email": 1}))
        restart_logs = backend_log_tail()
        new_restart_logs = restart_logs[len(restart_before):] if restart_logs.startswith(restart_before) else restart_logs
        record(
            "startup backfill restores admin mobile and logs backfill",
            restart.returncode == 0
            and admin_after_restart.get("role") == "admin"
            and admin_after_restart.get("mobile") == SUPER_PHONE
            and admin_after_restart.get("mobile_last10") == SUPER_PHONE
            and "Backfilled super-admin phone" in new_restart_logs,
            {"restart_rc": restart.returncode, "admin_after_restart": admin_after_restart, "log_contains_backfill": "Backfilled super-admin phone" in new_restart_logs, "restart_stdout": restart.stdout, "restart_stderr": restart.stderr, "log_excerpt": new_restart_logs[-2500:]},
        )

        # Regression: regular member phone does not get elevated to admin. Force pending by deleting QA device only.
        member = db.users.find_one({"role": "member", "mobile": {"$exists": True, "$nin": [None, "", SUPER_PHONE]}}, {"_id": 0, "id": 1, "email": 1, "full_name": 1, "role": 1, "mobile": 1, "mobile_last10": 1})
        if not member:
            mid = f"qa-iter28-member-{uuid.uuid4().hex}"
            member_phone = "5550002111"
            db.users.insert_one({
                "id": mid,
                "email": f"qa-iter28-member-{uuid.uuid4().hex[:8]}@attendance.app",
                "full_name": "QA Iter28 Member",
                "role": "member",
                "category": "staff",
                "mobile": member_phone,
                "mobile_last10": member_phone,
                "photo": None,
                "hashed_password": "qa-not-used",
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
            })
            created_user_ids.append(mid)
            member = db.users.find_one({"id": mid}, {"_id": 0, "id": 1, "email": 1, "full_name": 1, "role": 1, "mobile": 1, "mobile_last10": 1})
        code, data, dev = phone_login(member["mobile"], "regular-member")
        created_device_ids.append(dev)
        member_after = scrub_doc(db.users.find_one({"id": member["id"]}, {"_id": 0, "id": 1, "email": 1, "role": 1, "mobile": 1}))
        record(
            "regression: regular member phone is not elevated",
            code == 200 and member_after.get("role") == "member" and data.get("user", {}).get("role") != "admin",
            {"http": code, "response_status": data.get("status"), "response_user": data.get("user"), "member_after": member_after},
        )

        # Regression: entirely unknown non-super phone stays pending and creates no admin.
        db.users.delete_many({"$or": [{"mobile": UNKNOWN_PHONE}, {"mobile_last10": UNKNOWN_PHONE}], "email": {"$regex": r"^qa-iter28-"}})
        if db.users.count_documents({"$or": [{"mobile": UNKNOWN_PHONE}, {"mobile_last10": UNKNOWN_PHONE}]}) != 0:
            record("precondition: unknown phone absent", False, "1234567890 already exists in users; cannot prove unknown flow")
        else:
            code, data, dev = phone_login(UNKNOWN_PHONE, "unknown")
            created_device_ids.append(dev)
            unknown_admins = list(db.users.find({"$or": [{"mobile": UNKNOWN_PHONE}, {"mobile_last10": UNKNOWN_PHONE}], "role": "admin"}, {"_id": 0, "id": 1, "email": 1, "role": 1, "mobile": 1}))
            record(
                "regression: unknown non-super phone remains pending with profile and no admin account",
                code == 200 and data.get("status") == "pending" and data.get("needs_profile") is True and len(unknown_admins) == 0,
                {"http": code, "response": data, "unknown_admins": unknown_admins},
            )

        # Regression: non-super escort phone still routes to escort flow.
        non_super_escort = db.escorts.find_one({
            "status": "active",
            "mobile_last10": {"$nin": [SUPER_PHONE, None, ""]},
        }, {"_id": 0})
        if not non_super_escort:
            eid = f"qa-iter28-nonsuper-escort-{uuid.uuid4().hex}"
            escort_phone = "5550003111"
            db.escorts.insert_one({
                "id": eid,
                "name": "QA Iter28 Non-super Escort",
                "phone": escort_phone,
                "mobile_last10": escort_phone,
                "status": "active",
                "institution": "QA",
                "valid_from": "2020-01-01",
                "valid_until": None,
                "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
            })
            created_escort_ids.append(eid)
            non_super_escort = db.escorts.find_one({"id": eid}, {"_id": 0})
        escort_phone = non_super_escort.get("mobile_last10") or re.sub(r"\D", "", non_super_escort.get("phone", ""))[-10:]
        code, data, dev = phone_login(escort_phone, "nonsuper-escort")
        created_device_ids.append(dev)
        record(
            "regression: non-super escort phone still returns escort approved flow",
            code == 200 and data.get("status") == "approved" and data.get("is_escort") is True and data.get("user", {}).get("is_escort") is True and data.get("user", {}).get("role") is None,
            {"escort": {k: non_super_escort.get(k) for k in ["id", "name", "phone", "mobile_last10"]}, "http": code, "response_status": data.get("status"), "is_escort": data.get("is_escort"), "user": data.get("user"), "token_present": bool(data.get("access_token"))},
        )

        # Regression: admin email/password login still works in preview.
        email_res = requests.post(f"{BACKEND_LOCAL}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=20)
        try:
            email_data = email_res.json()
        except Exception:
            email_data = {"raw": email_res.text}
        record(
            "regression: admin email login still works in preview",
            email_res.status_code == 200 and email_data.get("user", {}).get("role") == "admin" and bool(email_data.get("access_token")),
            {"http": email_res.status_code, "role": email_data.get("user", {}).get("role"), "token_present": bool(email_data.get("access_token")), "detail": email_data.get("detail")},
        )

        final_admin = scrub_doc(db.users.find_one({"id": admin_id}, {"_id": 0, "email": 1, "role": 1, "mobile": 1, "mobile_last10": 1, "full_name": 1}))
        final_ghost_count = db.users.count_documents({"email": {"$regex": r"^super-admin-"}})
        record(
            "cleanup invariant before finalizer: admin restored and no ghost super-admin users",
            final_admin.get("role") == "admin" and final_admin.get("mobile") == SUPER_PHONE and final_admin.get("mobile_last10") == SUPER_PHONE and final_ghost_count == 0,
            {"final_admin": final_admin, "ghost_count": final_ghost_count},
        )

    finally:
        restore_fields = {"role": "admin", "mobile": SUPER_PHONE, "mobile_last10": SUPER_PHONE}
        for field in ["email", "full_name", "category", "rank", "photo", "personal_qr"]:
            if field in original_admin:
                restore_fields[field] = original_admin[field]
        db.users.update_one({"id": admin_id}, {"$set": restore_fields})
        db.users.delete_many({"email": {"$regex": r"^super-admin-"}})
        if created_user_ids:
            db.users.delete_many({"id": {"$in": created_user_ids}})
        if created_device_ids:
            db.devices.delete_many({"device_id": {"$in": created_device_ids}})
        if created_escort_ids:
            db.escorts.delete_many({"id": {"$in": created_escort_ids}})
        client.close()

    output = {"all_ok": all(r["ok"] for r in results), "results": results}
    RESULT_PATH.write_text(json.dumps(output, indent=2, default=str))
    if not output["all_ok"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
