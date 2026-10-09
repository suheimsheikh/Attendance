"""Oct 2026: new member profile fields + inline email edit (throwaway members)."""
from __future__ import annotations

import uuid


def test_profile_fields_roundtrip(admin_client, base_url, make_member):
    m = make_member("athlete", blood_group="O+", school_class="9B")
    url = f"{base_url}/api/members/{m['id']}"
    body = {"address": "12 Lake Rd", "emergency_contact_name": "Uncle Raj", "emergency_contact_phone": "+919999900000",
            "medical_notes": "Peanut allergy", "blood_group": "AB-"}
    r = admin_client.patch(url, json=body, timeout=30)
    assert r.status_code == 200, r.text
    row = next(x for x in admin_client.get(f"{base_url}/api/members", timeout=60).json() if x["id"] == m["id"])
    for k, v in {**body, "school_class": "9B"}.items():
        assert row[k] == v, k


def test_inline_email_edit_validates_and_dedupes(admin_client, base_url, make_member):
    a, b = make_member("staff"), make_member("staff")
    url = f"{base_url}/api/members/{a['id']}"
    assert admin_client.patch(url, json={"email": "not-an-email"}, timeout=30).status_code == 400
    other = next(x for x in admin_client.get(f"{base_url}/api/members", timeout=60).json() if x["id"] == b["id"])
    assert admin_client.patch(url, json={"email": other["email"]}, timeout=30).status_code == 409
    new = f"test_{uuid.uuid4().hex[:8]}@ishowedup-test.example.com"
    r = admin_client.patch(url, json={"email": new.upper()}, timeout=30)
    assert r.status_code == 200 and r.json()["email"] == new
