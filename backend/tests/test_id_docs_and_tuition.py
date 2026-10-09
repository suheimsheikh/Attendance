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


def test_audit_log_records_full_id_numbers(admin_client, base_url, make_member, mongo_db):
    if mongo_db is None:
        pytest.skip("mongo_db fixture unavailable")
    m = make_member("staff")
    r = admin_client.put(f"{base_url}/api/members/{m['id']}/id-docs",
                         json={"people": {"self": {"pan": "ZZZZZ9999Z", "aadhaar": "987654321098"}}}, timeout=30)
    assert r.status_code == 200
    import json
    rows = list(mongo_db.audit_log.find({"entity_id": m["id"], "action": "id_numbers_updated"}, {"_id": 0}))
    assert rows, "change must still be audited"
    blob = json.dumps(rows, default=str, ensure_ascii=False)
    # Oct 2026: PAN/Aadhaar aren't private — full numbers in the change log.
    assert "ZZZZZ9999Z" in blob and "987654321098" in blob


def test_unique_indexes_on_new_collections(mongo_db):
    if mongo_db is None:
        pytest.skip("mongo_db fixture unavailable")
    for coll, key in (("absent_dispatch_log", "date"), ("member_id_docs", "user_id")):
        idx = mongo_db[coll].index_information()
        assert any(i.get("unique") and i["key"][0][0] == key for i in idx.values()), coll


def test_scan_filename_sanitised(admin_client, base_url, make_member):
    import requests
    m = make_member("staff")
    base = f"{base_url}/api/members/{m['id']}/id-docs/self/pan"
    hdrs = {"Authorization": admin_client.headers["Authorization"]}
    r = requests.post(base, headers=hdrs, files={"file": ('pan"\r\nx.pdf', PDF, "application/pdf")}, timeout=60)
    assert r.status_code == 200, r.text
    name = r.json()["people"]["self"]["pan_file"]["name"]
    assert '"' not in name and "\r" not in name and "\n" not in name
    d = requests.get(base + "/file", headers=hdrs, timeout=60)
    assert d.status_code == 200 and d.content == PDF


def test_name_matches_helper():
    from services.id_ocr import name_matches
    assert name_matches("RAVI KUMAR", "Ravi Kumar Sharma") is True
    assert name_matches("SITA DEVI", "Ravi Kumar") is False
    assert name_matches(None, "Ravi") is None


def test_scan_upload_detects_pan_number_and_name(admin_client, base_url, make_member):
    """Real Gemini vision call on a generated PAN image: number + name are
    returned as `detected` but NOT saved until the admin confirms."""
    import io
    import requests
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (700, 320), "white")
    d = ImageDraw.Draw(img)
    d.text((20, 40), "INCOME TAX DEPARTMENT   GOVT. OF INDIA", fill="black")
    d.text((20, 110), "Name: RAVI KUMAR", fill="black")
    d.text((20, 180), "Permanent Account Number: ABCDE1234F", fill="black")
    buf = io.BytesIO()
    img.save(buf, "PNG")
    m = make_member("staff", full_name="TEST Sita Devi QA")
    hdrs = {"Authorization": admin_client.headers["Authorization"]}
    r = requests.post(f"{base_url}/api/members/{m['id']}/id-docs/self/pan", headers=hdrs,
                      files={"file": ("pan.png", buf.getvalue(), "image/png")}, timeout=120)
    assert r.status_code == 200, r.text
    det = r.json()["detected"]
    assert det and det["number"] == "ABCDE1234F"
    assert det["name_matches"] is False  # card says Ravi Kumar, member is Sita Devi
    assert not (r.json()["people"]["self"].get("pan"))  # not auto-saved


def test_report_and_partial_save(admin_client, base_url, make_member):
    ath = make_member("athlete", father_name="TEST Father Qa")
    url = f"{base_url}/api/members/{ath['id']}/id-docs"
    assert admin_client.put(url, json={"people": {"self": {"pan": "ABCDE1234F", "aadhaar": "123456789012"}}}, timeout=30).status_code == 200
    # Partial save (bulk upload) must not wipe the other card.
    r = admin_client.put(url, json={"people": {"self": {"pan": "PQRSX9876Z"}}}, timeout=30)
    assert r.json()["people"]["self"] == {"pan": "PQRSX9876Z", "aadhaar": "123456789012"}
    rows = admin_client.get(f"{base_url}/api/id-docs/report", timeout=60).json()["rows"]
    mine = {x["person"]: x for x in rows if x["member_id"] == ath["id"]}
    assert set(mine) == {"self", "father", "mother", "guardian"}
    assert mine["self"]["pan"] == "PQRSX9876Z" and mine["self"]["pan_scan"] is False
    assert mine["father"]["person_name"] == "TEST Father Qa" and mine["father"]["pan"] == ""


def test_bulk_read_detects_type_and_matches_person(admin_client, base_url, make_member):
    import io
    import requests
    from PIL import Image, ImageDraw
    make_member("athlete", father_name="Zorawar Quillfeather")
    img = Image.new("RGB", (700, 320), "white")
    d = ImageDraw.Draw(img)
    d.text((20, 40), "INCOME TAX DEPARTMENT   GOVT. OF INDIA", fill="black")
    d.text((20, 110), "Name: ZORAWAR QUILLFEATHER", fill="black")
    d.text((20, 180), "Permanent Account Number: KLMNO4321P", fill="black")
    buf = io.BytesIO()
    img.save(buf, "PNG")
    r = requests.post(f"{base_url}/api/id-docs/bulk/read", headers={"Authorization": admin_client.headers["Authorization"]},
                      files={"file": ("x.png", buf.getvalue(), "image/png")}, timeout=120)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["detected"]["type"] == "pan" and j["detected"]["number"] == "KLMNO4321P"
    assert j["match"] and j["match"]["person"] == "father" and j["match"]["person_name"] == "Zorawar Quillfeather"


def test_passport_numbers_expiry_and_status(admin_client, base_url, make_member):
    from routes.id_docs import _expiry_status
    assert _expiry_status("", "2026-10-09") == ""
    assert _expiry_status("2026-10-08", "2026-10-09") == "expired"
    assert _expiry_status("2027-03-01", "2026-10-09") == "soon"
    assert _expiry_status("2028-01-01", "2026-10-09") == "ok"
    m = make_member("athlete")
    url = f"{base_url}/api/members/{m['id']}/id-docs"
    assert admin_client.put(url, json={"people": {"mother": {"passport": "12"}}}, timeout=30).status_code == 400
    assert admin_client.put(url, json={"people": {"self": {"passport_expiry": "next year"}}}, timeout=30).status_code == 400
    r = admin_client.put(url, json={"people": {"self": {"pan": "ABCDE1234F"}}}, timeout=30)
    r = admin_client.put(url, json={"people": {"self": {"passport": "z 1234567", "passport_expiry": "2000-01-01"}}}, timeout=30)
    assert r.status_code == 200
    assert r.json()["people"]["self"] == {"pan": "ABCDE1234F", "passport": "Z1234567", "passport_expiry": "2000-01-01"}
    row = next(x for x in admin_client.get(f"{base_url}/api/id-docs/report", timeout=60).json()["rows"]
               if x["member_id"] == m["id"] and x["person"] == "self")
    assert row["passport"] == "Z1234567" and row["passport_status"] == "expired" and row["passport_scan"] is False


def test_passport_name_exact_rule():
    from services.id_ocr import name_exact
    assert name_exact("RAVI KUMAR", "Ravi  Kumar") is True
    assert name_exact("KUMAR RAVI", "Ravi Kumar") is False  # order matters
    assert name_exact("RAVI K", "Ravi Kumar") is False
    assert name_exact(None, "Ravi") is None


def test_passport_scan_detects_number_expiry_and_name_mismatch(admin_client, base_url, make_member):
    import io
    import requests
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (800, 420), "white")
    d = ImageDraw.Draw(img)
    for y, t in [(30, "REPUBLIC OF INDIA   PASSPORT"), (90, "Passport No.: Z7654321"), (150, "Surname: SHARMA"),
                 (210, "Given Name(s): ANITA DEVI"), (270, "Date of Birth: 01/02/2010"), (330, "Date of Expiry: 15/03/2027")]:
        d.text((20, y), t, fill="black")
    buf = io.BytesIO()
    img.save(buf, "PNG")
    m = make_member("athlete", full_name="TEST Anita Sharma")
    r = requests.post(f"{base_url}/api/members/{m['id']}/id-docs/self/passport",
                      headers={"Authorization": admin_client.headers["Authorization"]},
                      files={"file": ("pp.png", buf.getvalue(), "image/png")}, timeout=120)
    assert r.status_code == 200, r.text
    det = r.json()["detected"]
    assert det["number"] == "Z7654321" and det["expiry"] == "2027-03-15"
    assert det["name"].upper() == "ANITA DEVI SHARMA"
    assert det["name_matches"] is False  # DB "TEST Anita Sharma" ≠ "ANITA DEVI SHARMA"


def test_name_score_tolerates_missing_spaces():
    from services.id_ocr import name_score
    assert name_score("ZORAWARQUILLFEATHER", "Zorawar Quillfeather") == 1.0
    assert name_score("RAVI KUMAR", "Sita Devi") == 0.0


def test_use_passport_name_title_cases_and_audits(admin_client, base_url, make_member):
    m = make_member("athlete", father_name="Old Father")
    base = f"{base_url}/api/members/{m['id']}/id-docs"
    r = admin_client.post(f"{base}/self/passport/use-name", json={"name": "ANITA  DEVI SHARMA"}, timeout=30)
    assert r.status_code == 200 and r.json() == {"field": "full_name", "name": "Anita Devi Sharma"}
    r = admin_client.post(f"{base}/father/passport/use-name", json={"name": "RAJ SHARMA"}, timeout=30)
    assert r.json()["field"] == "father_name"
    row = next(x for x in admin_client.get(f"{base_url}/api/members", timeout=60).json() if x["id"] == m["id"])
    assert row["full_name"] == "Anita Devi Sharma" and row["father_name"] == "Raj Sharma"
    staff = make_member("staff")
    assert admin_client.post(f"{base_url}/api/members/{staff['id']}/id-docs/father/passport/use-name",
                             json={"name": "X Y"}, timeout=30).status_code == 400


def test_weekly_passport_list_first_admin_wins(admin_client, second_admin_client, base_url, make_member, mongo_db):
    if mongo_db is None:
        import pytest
        pytest.skip("mongo")
    m = make_member("staff")
    admin_client.put(f"{base_url}/api/members/{m['id']}/id-docs",
                     json={"people": {"self": {"passport": "Z1112223", "passport_expiry": "2000-01-01"}}}, timeout=30)
    url = f"{base_url}/api/id-docs/passport-expiry-week"
    week = admin_client.get(url, timeout=30).json()["week"]
    prior = mongo_db.passport_reminder_log.find_one({"week": week})
    mongo_db.passport_reminder_log.delete_one({"week": week})
    try:
        st = admin_client.get(url, timeout=30).json()
        assert st["due"] is True and any(x["member_id"] == m["id"] and x["status"] == "expired" for x in st["rows"])
        assert admin_client.post(url, timeout=30).json()["first"] is True
        assert second_admin_client.post(url, timeout=30).json()["first"] is False
        assert second_admin_client.get(url, timeout=30).json()["due"] is False
    finally:
        mongo_db.passport_reminder_log.delete_one({"week": week})
        if prior:
            mongo_db.passport_reminder_log.insert_one(prior)


def test_travel_check_overseas_only(admin_client, base_url, make_member, mongo_db):
    import uuid
    if mongo_db is None:
        import pytest
        pytest.skip("mongo")
    rid = f"test-reg-{uuid.uuid4().hex[:6]}"
    mongo_db.regattas.insert_one({"id": rid, "name": "TEST Worlds", "start_date": "2099-07-01", "end_date": "2099-07-10",
                                  "country": "Portugal", "location": "Lisbon"})
    try:
        ath = make_member("athlete")
        ok = make_member("coach")
        admin_client.put(f"{base_url}/api/members/{ok['id']}/id-docs",
                         json={"people": {"self": {"passport": "Z9998887", "passport_expiry": "2100-12-31"}}}, timeout=30)
        exp = make_member("athlete")
        admin_client.put(f"{base_url}/api/members/{exp['id']}/id-docs",
                         json={"people": {"self": {"passport": "Z9998886", "passport_expiry": "2099-12-01"}}}, timeout=30)
        j = admin_client.get(f"{base_url}/api/id-docs/travel-check", params={"regatta_id": rid}, timeout=60).json()
        assert all(r["country"] != "India" for r in j["regattas"])
        assert j["regatta"]["id"] == rid and j["valid_until_needed"] == "2100-01-10"
        issues = {r["member_id"]: r["issue"] for r in j["rows"]}
        assert issues[ath["id"]] == "missing" and issues[exp["id"]] == "expiring" and issues[ok["id"]] is None
    finally:
        mongo_db.regattas.delete_one({"id": rid})
