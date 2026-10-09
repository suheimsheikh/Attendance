"""PAN/Aadhaar ID docs (admin-only) + Tuition Teacher DAR/WhatsApp group.
Throwaway members/categories only."""
from __future__ import annotations

import uuid

import pytest

PDF = b"%PDF-1.4\n% test id scan\n"


def test_id_docs_people_and_validation(admin_client, base_url, make_member):
    ath = make_member("athlete")
    staff = make_member("staff", login=True)
    url = f"{base_url}/api/members/{ath['id']}/id-docs"
    r = admin_client.get(url, timeout=30)
    assert r.status_code == 200 and r.json()["allowed_people"] == ["self", "father", "mother", "guardian"]
    r = admin_client.get(f"{base_url}/api/members/{staff['id']}/id-docs", timeout=30)
    assert r.json()["allowed_people"] == ["self"]
    assert staff["client"].get(url, timeout=30).status_code == 403

    bad = admin_client.put(url, json={"people": {"self": {"pan": "12345"}}}, timeout=30)
    assert bad.status_code == 400
    bad = admin_client.put(url, json={"people": {"father": {"aadhaar": "1234"}}}, timeout=30)
    assert bad.status_code == 400
    ok = admin_client.put(url, json={"people": {"self": {"pan": "abcde1234f", "aadhaar": "1234 5678 9012"},
                                                "father": {"pan": "PQRSX9876Z"}}}, timeout=30)
    assert ok.status_code == 200, ok.text
    p = ok.json()["people"]
    assert p["self"] == {"pan": "ABCDE1234F", "aadhaar": "123456789012"}
    assert p["father"]["pan"] == "PQRSX9876Z"
    # Staff can't have parent rows.
    r = admin_client.put(f"{base_url}/api/members/{staff['id']}/id-docs",
                         json={"people": {"father": {"pan": "PQRSX9876Z"}}}, timeout=30)
    assert r.status_code == 400


def test_id_scan_upload_download_delete(admin_client, base_url, make_member):
    ath = make_member("athlete")
    base = f"{base_url}/api/members/{ath['id']}/id-docs/mother/aadhaar"
    hdrs = {"Authorization": admin_client.headers["Authorization"]}
    import requests
    r = requests.post(base, headers=hdrs, files={"file": ("a.txt", b"x", "text/plain")}, timeout=30)
    assert r.status_code == 400
    r = requests.post(base, headers=hdrs, files={"file": ("aadhaar.pdf", PDF, "application/pdf")}, timeout=60)
    assert r.status_code == 200, r.text
    meta = r.json()["people"]["mother"]["aadhaar_file"]
    assert meta["name"] == "aadhaar.pdf" and meta["size"] == len(PDF)
    d = requests.get(base + "/file", headers=hdrs, timeout=60)
    assert d.status_code == 200 and d.content == PDF
    r = requests.delete(base + "/file", headers=hdrs, timeout=30)
    assert r.status_code == 200 and "aadhaar_file" not in (r.json()["people"].get("mother") or {})


def test_tuition_teacher_dar_required_and_group(admin_client, base_url, make_member):
    key = f"tuition_t{uuid.uuid4().hex[:6]}"
    r = admin_client.post(f"{base_url}/api/masters/categories",
                          json={"key": key, "label": "Tuition Teacher Test", "color": "slate",
                                "is_athlete_like": False, "meal_eligible": False, "sort_order": 99}, timeout=30)
    assert r.status_code == 200, r.text
    cat_id = r.json()["id"]
    try:
        cats = admin_client.get(f"{base_url}/api/masters/categories?include_inactive=true", timeout=30).json()
        assert any(c["key"] == key for c in cats), "new category must be listed straight away"
        m = make_member(key, login=True)
        me = m["client"].get(f"{base_url}/api/auth/me", timeout=30).json()
        assert me["category"] == "staff" and me["custom_category"] == key  # staff rules underneath
        cats = admin_client.get(f"{base_url}/api/masters/categories", timeout=30).json()
        assert next(c for c in cats if c["key"] == key)["member_count"] == 1
        assert admin_client.delete(f"{base_url}/api/masters/categories/{cat_id}", timeout=30).status_code == 409
        r = admin_client.patch(f"{base_url}/api/members/{m['id']}", json={"category": "coach"}, timeout=30)
        assert r.status_code == 200 and r.json()["category"] == "coach" and r.json()["custom_category"] is None
        r = admin_client.patch(f"{base_url}/api/members/{m['id']}", json={"category": key}, timeout=30)
        assert r.json()["category"] == "staff" and r.json()["custom_category"] == key
        assert admin_client.patch(f"{base_url}/api/members/{m['id']}", json={"category": "nope_x"},
                                  timeout=30).status_code == 400
        st = m["client"].get(f"{base_url}/api/dar/status", timeout=30).json()
        assert st["is_tuition_teacher"] is True and st["required"] is True
        assert st["group_name"] == st["checkin_group_name"] == "YCH Tuitions"
        admin_client.delete(f"{base_url}/api/members/{m['id']}", params={"reason": "test cleanup"}, timeout=30)
    finally:
        admin_client.delete(f"{base_url}/api/masters/categories/{cat_id}", timeout=30)


def test_whatsapp_groups_has_tuitions(admin_client, base_url):
    g = admin_client.get(f"{base_url}/api/config/whatsapp-groups", timeout=30).json()
    assert g.get("tuitions_group_name")
