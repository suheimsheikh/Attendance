#!/usr/bin/env python3
"""Focused backend verification for ex-member/offboarding fix."""
import os
import sys
import json
import asyncio
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
import jwt
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

BACKEND_URL = os.environ.get("TEST_BACKEND_URL", "https://attendance-portal-56.preview.emergentagent.com").rstrip("/")
API = f"{BACKEND_URL}/api"
ADMIN_EMAIL = "admin@attendance.app"
ADMIN_PASSWORD = "Admin@12345"

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / "backend" / ".env")
MONGO_URL = os.environ["MONGO_URL"].strip('"')
DB_NAME = os.environ.get("DB_NAME", "test_database").strip('"')
JWT_SECRET = os.environ["JWT_SECRET_KEY"].strip('"')
JWT_ALGO = os.environ.get("JWT_ALGORITHM", "HS256").strip('"')


def make_token(user_id, role="member", device_id=None, minutes=60):
    payload = {
        "sub": user_id,
        "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(minutes=minutes),
    }
    if device_id:
        payload["device_id"] = device_id
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


def req(method, path, token=None, **kwargs):
    headers = kwargs.pop("headers", {})
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return requests.request(method, f"{API}{path}", headers=headers, timeout=25, **kwargs)


async def main():
    results = []
    inserted_devices = []
    inserted_attendance_ids = []
    inserted_leave_ids = []
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    admin_token = None
    member = None
    member_orig_lv = None
    active = None
    active_orig_lv = None
    staff = None
    staff_orig_lv = None
    try:
        login = req("POST", "/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
        assert login.status_code == 200, f"admin login failed {login.status_code} {login.text[:300]}"
        admin_token = login.json()["access_token"]
        results.append({"check": "admin_login", "ok": True})

        member = await db.users.find_one({"role": "member", "category": {"$in": ["athlete", "elite"]}}, {"_id": 0})
        if not member:
            member = await db.users.find_one({"role": "member"}, {"_id": 0})
        assert member, "no member user found"
        member_orig_lv = member.get("leaving_date")
        member_token = make_token(member["id"], member.get("role", "member"))

        active = await db.users.find_one({"role": "member", "id": {"$ne": member["id"]}, "$or": [{"leaving_date": None}, {"leaving_date": ""}, {"leaving_date": {"$exists": False}}]}, {"_id": 0})
        if not active:
            active = await db.users.find_one({"role": "member", "id": {"$ne": member["id"]}}, {"_id": 0})
        assert active, "no second active member found for muster"
        active_orig_lv = active.get("leaving_date")
        r = req("PATCH", f"/members/{active['id']}", admin_token, json={"leaving_date": None})
        assert r.status_code == 200, f"clear active leaving_date failed {r.status_code} {r.text[:200]}"

        staff = await db.users.find_one({"role": "member", "category": {"$nin": ["athlete", "elite"]}}, {"_id": 0})
        if staff:
            staff_orig_lv = staff.get("leaving_date")

        att_before = await db.attendance.count_documents({"user_id": member["id"]})
        leaves_before = await db.leaves.count_documents({"user_id": member["id"]})
        if att_before == 0:
            att_id = "qa-ex-preserve-att-" + member["id"][:8]
            await db.attendance.insert_one({
                "id": att_id, "user_id": member["id"], "date": "2019-12-15",
                "check_in_at": "2019-12-15T03:30:00+00:00", "check_out_at": "2019-12-15T11:30:00+00:00",
                "hours": 8, "method": "qa_seed", "created_at": datetime.now(timezone.utc).isoformat(),
            })
            inserted_attendance_ids.append(att_id)
            att_before = await db.attendance.count_documents({"user_id": member["id"]})
        if leaves_before == 0:
            leave_id = "qa-ex-preserve-leave-" + member["id"][:8]
            await db.leaves.insert_one({
                "id": leave_id, "user_id": member["id"], "type": "leave", "status": "approved",
                "start_date": "2019-12-20", "end_date": "2019-12-20", "created_at": datetime.now(timezone.utc).isoformat(),
            })
            inserted_leave_ids.append(leave_id)
            leaves_before = await db.leaves.count_documents({"user_id": member["id"]})

        await db.attendance.update_many(
            {"user_id": {"$in": [member["id"], active["id"]]}, "check_out_at": None},
            {"$set": {"check_out_at": "2019-01-01T00:00:00+00:00", "qa_closed_for_ex_test": True}},
        )

        r = req("PATCH", f"/members/{member['id']}", admin_token, json={"leaving_date": "2020-01-01"})
        assert r.status_code == 200, f"set past leaving_date failed {r.status_code} {r.text[:300]}"

        hard_cases = [
            ("geo-toggle", "POST", "/attendance/geo-toggle", member_token, {"latitude": 0, "longitude": 0, "reason": "qa ex cutoff"}),
            ("mark-member", "POST", "/attendance/mark-member", admin_token, {"member_id": member["id"], "latitude": 0, "longitude": 0, "reason": "qa ex cutoff"}),
            ("scan-card", "POST", "/attendance/scan-card", admin_token, {"personal_qr": member.get("personal_qr"), "latitude": 0, "longitude": 0, "reason": "qa ex cutoff"}),
            ("admin-toggle", "POST", f"/admin/attendance/toggle/{member['id']}", admin_token, {"reason": "qa ex cutoff"}),
        ]
        for label, method, path, token, body in hard_cases:
            assert body.get("personal_qr") or label != "scan-card", "member missing personal_qr for scan-card test"
            before = await db.attendance.count_documents({"user_id": member["id"]})
            resp = req(method, path, token, json=body)
            after = await db.attendance.count_documents({"user_id": member["id"]})
            try:
                detail = resp.json().get("detail", "")
            except Exception:
                detail = resp.text[:200]
            ok = resp.status_code == 403 and "exited" in detail and "2020-01-01" in detail and before == after
            results.append({"check": f"hard_cutoff_{label}", "ok": ok, "status": resp.status_code, "detail": detail, "attendance_count_before": before, "attendance_count_after": after})

        before_ex = await db.attendance.count_documents({"user_id": member["id"]})
        before_active = await db.attendance.count_documents({"user_id": active["id"]})
        resp = req("POST", "/muster/checkin-bulk", admin_token, json={"athlete_ids": [member["id"], active["id"]], "latitude": 0, "longitude": 0})
        after_ex = await db.attendance.count_documents({"user_id": member["id"]})
        after_active = await db.attendance.count_documents({"user_id": active["id"]})
        if resp.status_code == 200:
            js = resp.json()
            skipped = js.get("skipped", [])
            done = js.get("checked_in", [])
            ok = any(s.get("id") == member["id"] and "exited on 2020-01-01" in s.get("reason", "") for s in skipped) and any(d.get("id") == active["id"] for d in done) and after_ex == before_ex and after_active == before_active + 1
            inserted = await db.attendance.find_one({"user_id": active["id"], "check_out_at": None}, {"_id": 0, "id": 1})
            if inserted:
                inserted_attendance_ids.append(inserted["id"])
        else:
            js = {"error": resp.text[:300]}
            ok = False
        results.append({"check": "muster_ex_skipped_active_done", "ok": ok, "status": resp.status_code, "response": js, "ex_count_before": before_ex, "ex_count_after": after_ex, "active_count_before": before_active, "active_count_after": after_active})

        r = req("PATCH", f"/members/{member['id']}", admin_token, json={"leaving_date": None})
        assert r.status_code == 200, f"reset member leaving date before device tests failed {r.status_code}"
        device_future = "qa-device-future-" + member["id"][:8]
        await db.devices.update_one({"device_id": device_future}, {"$set": {"device_id": device_future, "id": device_future, "user_id": member["id"], "status": "approved", "created_at": datetime.now(timezone.utc).isoformat()}}, upsert=True)
        inserted_devices.append(device_future)
        resp = req("PATCH", f"/members/{member['id']}", admin_token, json={"leaving_date": "2999-01-01"})
        future_dev = await db.devices.find_one({"device_id": device_future}, {"_id": 0})
        results.append({"check": "future_leaving_date_does_not_revoke", "ok": resp.status_code == 200 and future_dev.get("status") == "approved", "status": resp.status_code, "device_status": future_dev.get("status")})

        device_past = "qa-device-past-" + member["id"][:8]
        await db.devices.update_one({"device_id": device_past}, {"$set": {"device_id": device_past, "id": device_past, "user_id": member["id"], "status": "approved", "created_at": datetime.now(timezone.utc).isoformat()}}, upsert=True)
        inserted_devices.append(device_past)
        non_rev_before = await db.devices.count_documents({"user_id": member["id"], "status": {"$ne": "revoked"}})
        yesterday = (datetime.now(timezone.utc).date() - timedelta(days=1)).isoformat()
        resp = req("PATCH", f"/members/{member['id']}", admin_token, json={"leaving_date": yesterday})
        non_rev_after = await db.devices.count_documents({"user_id": member["id"], "status": {"$ne": "revoked"}})
        revoked_docs = await db.devices.find({"user_id": member["id"], "device_id": {"$in": [device_future, device_past]}}, {"_id": 0}).to_list(10)
        ok = resp.status_code == 200 and non_rev_before >= 2 and non_rev_after == 0 and all(d.get("status") == "revoked" and "Member exited" in (d.get("revoked_reason") or "") and d.get("revoked_at") for d in revoked_docs)
        results.append({"check": "transition_to_past_revokes_devices", "ok": ok, "status": resp.status_code, "non_revoked_before": non_rev_before, "non_revoked_after": non_rev_after, "revoked_docs": revoked_docs})

        device_after = "qa-device-after-ex-" + member["id"][:8]
        await db.devices.update_one({"device_id": device_after}, {"$set": {"device_id": device_after, "id": device_after, "user_id": member["id"], "status": "approved", "created_at": datetime.now(timezone.utc).isoformat()}}, upsert=True)
        inserted_devices.append(device_after)
        resp = req("PATCH", f"/members/{member['id']}", admin_token, json={"leaving_date": yesterday})
        after_dev = await db.devices.find_one({"device_id": device_after}, {"_id": 0})
        results.append({"check": "already_exited_does_not_refire_revocation", "ok": resp.status_code == 200 and after_dev.get("status") == "approved" and not after_dev.get("revoked_at"), "status": resp.status_code, "device_status": after_dev.get("status"), "revoked_at": after_dev.get("revoked_at")})

        att_after = await db.attendance.count_documents({"user_id": member["id"]})
        leaves_after = await db.leaves.count_documents({"user_id": member["id"]})
        lb = req("GET", "/leave-balances", admin_token)
        lb_contains = None
        if lb.status_code == 200:
            lb_contains = any(row.get("id") == member["id"] for row in lb.json().get("rows", []))
        results.append({"check": "historical_attendance_and_leaves_preserved", "ok": att_after == att_before and leaves_after == leaves_before, "attendance_before": att_before, "attendance_after": att_after, "leaves_before": leaves_before, "leaves_after": leaves_after})
        results.append({"check": "leave_balances_api_still_emits_ex_if_eligible", "ok": True if member.get("category") in ["athlete", "elite"] else (lb.status_code == 200 and lb_contains is True), "status": lb.status_code, "member_category": member.get("category"), "contains_member": lb_contains, "note": "Athletes/elite are intentionally excluded from leave-balances API by pre-existing design."})

        if staff:
            r = req("PATCH", f"/members/{staff['id']}", admin_token, json={"leaving_date": "2020-01-01"})
            lb2 = req("GET", "/leave-balances", admin_token)
            contains_staff = lb2.status_code == 200 and any(row.get("id") == staff["id"] for row in lb2.json().get("rows", []))
            results.append({"check": "leave_balances_api_emits_ex_staff", "ok": r.status_code == 200 and contains_staff, "patch_status": r.status_code, "leave_balances_status": lb2.status_code, "staff_id": staff["id"], "contains_staff": contains_staff})

        all_ok = all(x.get("ok") for x in results)
        print(json.dumps({"ok": all_ok, "api": API, "member_id": member["id"], "member_name": member["full_name"], "active_id": active["id"], "staff_id": staff and staff.get("id"), "results": results}, indent=2, default=str))
        return 0 if all_ok else 2
    finally:
        if admin_token:
            if member:
                req("PATCH", f"/members/{member['id']}", admin_token, json={"leaving_date": member_orig_lv})
            if active:
                req("PATCH", f"/members/{active['id']}", admin_token, json={"leaving_date": active_orig_lv})
            if staff:
                req("PATCH", f"/members/{staff['id']}", admin_token, json={"leaving_date": staff_orig_lv})
        if inserted_devices:
            await db.devices.delete_many({"device_id": {"$in": inserted_devices}})
        if inserted_attendance_ids:
            await db.attendance.delete_many({"id": {"$in": inserted_attendance_ids}})
        if inserted_leave_ids:
            await db.leaves.delete_many({"id": {"$in": inserted_leave_ids}})
        if active:
            await db.attendance.update_many({"user_id": active["id"], "check_out_at": None, "method": "muster"}, {"$set": {"check_out_at": datetime.now(timezone.utc).isoformat(), "qa_closed_for_cleanup": True}})
        client.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))