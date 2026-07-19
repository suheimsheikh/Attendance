#!/usr/bin/env python3
"""Targeted check for the user symptom: phone login pending requests are visible to admins."""
from __future__ import annotations

import json
import uuid
from pathlib import Path

import requests

BASE = "http://localhost:8001/api"
ADMIN_EMAIL = "admin@attendance.app"
ADMIN_PASSWORD = "Admin@12345"
OUT = Path("/app/test_reports/access_request_visibility_iter28_results.json")


def main():
    results = []
    created_device_id = f"qa-access-visible-{uuid.uuid4().hex}"
    phone = "555" + uuid.uuid4().hex[:7]  # 10-ish digits, not a super-admin phone

    def record(name, ok, detail):
        results.append({"name": name, "ok": bool(ok), "detail": detail})
        print(("PASS" if ok else "FAIL"), name, json.dumps(detail, default=str)[:1200])

    admin_login = requests.post(f"{BASE}/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=20)
    admin_data = admin_login.json()
    token = admin_data.get("access_token")
    headers = {"Authorization": f"Bearer {token}"}
    record("admin token available for devices queue", admin_login.status_code == 200 and bool(token), {"http": admin_login.status_code, "role": admin_data.get("user", {}).get("role")})

    try:
        req = requests.post(f"{BASE}/auth/phone", json={
            "phone": phone,
            "device_id": created_device_id,
            "device_name": "QA Access Request Browser",
            "model": "API",
            "platform": "bug-verification-iter28",
            "full_name": "QA Pending Visibility",
            "rank": "QA",
            "category": "staff",
        }, timeout=20)
        req_data = req.json()
        record("unknown phone creates pending request", req.status_code == 200 and req_data.get("status") == "pending", {"http": req.status_code, "response": req_data})

        devices = requests.get(f"{BASE}/admin/devices", params={"status_filter": "pending"}, headers=headers, timeout=20)
        devices_data = devices.json()
        match = next((d for d in devices_data if d.get("device_id") == created_device_id), None) if isinstance(devices_data, list) else None
        record("pending access request is visible to admins", devices.status_code == 200 and bool(match), {"http": devices.status_code, "matched_device": match})

        # Regression for invisible rejected retry: reject the request, retry same device, ensure it returns to pending list.
        if match:
            rej = requests.post(f"{BASE}/admin/devices/{match['id']}/reject", headers=headers, timeout=20)
            retry = requests.post(f"{BASE}/auth/phone", json={
                "phone": phone,
                "device_id": created_device_id,
                "device_name": "QA Access Request Browser",
                "model": "API",
                "platform": "bug-verification-iter28",
                "full_name": "QA Pending Visibility Retry",
                "rank": "QA",
                "category": "staff",
            }, timeout=20)
            retry_data = retry.json()
            devices2 = requests.get(f"{BASE}/admin/devices", params={"status_filter": "pending"}, headers=headers, timeout=20)
            devices2_data = devices2.json()
            match2 = next((d for d in devices2_data if d.get("device_id") == created_device_id), None) if isinstance(devices2_data, list) else None
            record(
                "rejected retry becomes visible as pending again",
                rej.status_code == 200 and retry.status_code == 200 and retry_data.get("status") == "pending" and bool(match2) and match2.get("status") == "pending",
                {"reject_http": rej.status_code, "retry_response": retry_data, "matched_after_retry": match2},
            )
    finally:
        if token:
            # Cleanup by deleting the QA device directly would require a delete endpoint; use DB-free API test cleanup through status is not available.
            # The main backend verification script handles DB cleanup for its own rows; this single pending QA row is intentionally reported below.
            pass

    out = {"all_ok": all(r["ok"] for r in results), "results": results, "created_device_id": created_device_id, "created_phone": phone}
    OUT.write_text(json.dumps(out, indent=2, default=str))
    if not out["all_ok"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
