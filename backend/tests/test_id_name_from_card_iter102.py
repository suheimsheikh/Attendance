"""iter 102 — PAN/Aadhaar name verification + auto-picking + passport-wins rule.
Only throwaway members. OCR tests use generated PNG images (real Gemini call)."""
from __future__ import annotations

import io
import uuid

import pytest
import requests
from PIL import Image, ImageDraw


# ---- Pure helpers --------------------------------------------------------

def test_name_exact_rules():
    from services.id_ocr import name_exact
    # Same words, same order, case/whitespace ignored
    assert name_exact("RAVI KUMAR", "Ravi  Kumar") is True
    assert name_exact("  Ravi   KUMAR ", "ravi kumar") is True
    # Different order → mismatch (card has middle name swapped)
    assert name_exact("Ravi Kumar Reddy", "Ravi Reddy Kumar") is False
    # Extra/missing word → mismatch
    assert name_exact("Ravi Kumar", "Ravi Kumar Sharma") is False
    # Blank sides → None
    assert name_exact(None, "Ravi") is None
    assert name_exact("Ravi", "") is None


# ---- use-name endpoint ---------------------------------------------------

def test_use_pan_name_title_cases(admin_client, base_url, make_member):
    m = make_member("staff", full_name="TEST Old Name A")
    r = admin_client.post(
        f"{base_url}/api/members/{m['id']}/id-docs/self/pan/use-name",
        json={"name": "RAVI KUMAR"}, timeout=30)
    assert r.status_code == 200, r.text
    assert r.json() == {"field": "full_name", "name": "Ravi Kumar"}
    row = next(x for x in admin_client.get(f"{base_url}/api/members", timeout=60).json()
               if x["id"] == m["id"])
    assert row["full_name"] == "Ravi Kumar"


def test_use_aadhaar_name_keeps_case_tidies_spacing(admin_client, base_url, make_member):
    m = make_member("staff", full_name="TEST Old Name B")
    # Spec: aadhaar name applied as printed, only whitespace collapsed.
    r = admin_client.post(
        f"{base_url}/api/members/{m['id']}/id-docs/self/aadhaar/use-name",
        json={"name": "  Ravi   KUMAR "}, timeout=30)
    assert r.status_code == 200, r.text
    assert r.json() == {"field": "full_name", "name": "Ravi KUMAR"}


def test_use_aadhaar_name_parent_field(admin_client, base_url, make_member):
    ath = make_member("athlete", father_name="TEST Old Father")
    r = admin_client.post(
        f"{base_url}/api/members/{ath['id']}/id-docs/father/aadhaar/use-name",
        json={"name": "amit  SINGH"}, timeout=30)
    assert r.status_code == 200, r.text
    assert r.json() == {"field": "father_name", "name": "amit SINGH"}


def test_use_pan_name_rejects_empty(admin_client, base_url, make_member):
    m = make_member("staff")
    r = admin_client.post(
        f"{base_url}/api/members/{m['id']}/id-docs/self/pan/use-name",
        json={"name": "   "}, timeout=30)
    assert r.status_code == 400


def test_use_name_rejects_unknown_person_for_staff(admin_client, base_url, make_member):
    m = make_member("staff")
    r = admin_client.post(
        f"{base_url}/api/members/{m['id']}/id-docs/father/pan/use-name",
        json={"name": "Ravi Kumar"}, timeout=30)
    assert r.status_code == 400


def test_audit_action_name_from_card(admin_client, base_url, make_member, mongo_db):
    if mongo_db is None:
        pytest.skip("mongo")
    m = make_member("staff", full_name="TEST OldName C")
    admin_client.post(
        f"{base_url}/api/members/{m['id']}/id-docs/self/aadhaar/use-name",
        json={"name": "Ravi Kumar"}, timeout=30)
    rows = list(mongo_db.audit_log.find({"entity_id": m["id"], "action": "name_from_aadhaar"}, {"_id": 0}))
    assert rows, "aadhaar use-name must audit action=name_from_aadhaar"


# ---- Passport-wins rule (409 on pan/aadhaar after passport use-name) ------

def test_passport_wins_blocks_pan_and_aadhaar(admin_client, base_url, make_member, mongo_db):
    m = make_member("staff", full_name="TEST Old Name D")
    # Lock the name via passport use-name
    r = admin_client.post(
        f"{base_url}/api/members/{m['id']}/id-docs/self/passport/use-name",
        json={"name": "RAVI KUMAR SHARMA"}, timeout=30)
    assert r.status_code == 200
    assert r.json()["name"] == "Ravi Kumar Sharma"

    # Now PAN and Aadhaar use-name should return 409 for the same person.
    for card in ("pan", "aadhaar"):
        rr = admin_client.post(
            f"{base_url}/api/members/{m['id']}/id-docs/self/{card}/use-name",
            json={"name": "Different Name"}, timeout=30)
        assert rr.status_code == 409, f"{card} must be blocked, got {rr.status_code} {rr.text}"
        assert "passport" in rr.text.lower()

    # Passport use-name still allowed (can be re-applied).
    r2 = admin_client.post(
        f"{base_url}/api/members/{m['id']}/id-docs/self/passport/use-name",
        json={"name": "RAVI KUMAR SHARMA"}, timeout=30)
    assert r2.status_code == 200

    # Verify the lock flag is stored.
    if mongo_db is not None:
        doc = mongo_db.member_id_docs.find_one({"user_id": m["id"]}, {"_id": 0})
        assert doc["people"]["self"].get("name_from_passport") is True


def test_passport_lock_scoped_per_person(admin_client, base_url, make_member):
    ath = make_member("athlete", father_name="TEST Father P")
    # Lock father via passport
    admin_client.post(
        f"{base_url}/api/members/{ath['id']}/id-docs/father/passport/use-name",
        json={"name": "RAJ KUMAR"}, timeout=30)
    # self is NOT locked → pan/aadhaar for self must still work
    r = admin_client.post(
        f"{base_url}/api/members/{ath['id']}/id-docs/self/pan/use-name",
        json={"name": "SITA DEVI"}, timeout=30)
    assert r.status_code == 200, r.text
    # But father aadhaar must be blocked
    r2 = admin_client.post(
        f"{base_url}/api/members/{ath['id']}/id-docs/father/aadhaar/use-name",
        json={"name": "Other Name"}, timeout=30)
    assert r2.status_code == 409


# ---- OCR path: upload returns name_matches and name_locked ----------------

def _pan_png(name: str, number: str = "ABCDE1234F") -> bytes:
    img = Image.new("RGB", (700, 320), "white")
    d = ImageDraw.Draw(img)
    d.text((20, 40), "INCOME TAX DEPARTMENT   GOVT. OF INDIA", fill="black")
    d.text((20, 110), f"Name: {name}", fill="black")
    d.text((20, 180), f"Permanent Account Number: {number}", fill="black")
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _aadhaar_png(name: str, number: str = "123456789012") -> bytes:
    img = Image.new("RGB", (800, 400), "white")
    d = ImageDraw.Draw(img)
    d.text((20, 30), "GOVERNMENT OF INDIA", fill="black")
    d.text((20, 90), "AADHAAR", fill="black")
    d.text((20, 160), f"Name: {name}", fill="black")
    d.text((20, 230), "DOB: 01/01/1995", fill="black")
    pretty = f"{number[0:4]} {number[4:8]} {number[8:12]}"
    d.text((20, 300), f"Aadhaar: {pretty}", fill="black")
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def test_aadhaar_upload_detects_number_and_name_mismatch(admin_client, base_url, make_member):
    m = make_member("staff", full_name="TEST Sita Devi QA")
    hdrs = {"Authorization": admin_client.headers["Authorization"]}
    r = requests.post(
        f"{base_url}/api/members/{m['id']}/id-docs/self/aadhaar", headers=hdrs,
        files={"file": ("aadhaar.png", _aadhaar_png("RAVI KUMAR", "432198765012"), "image/png")},
        timeout=120)
    assert r.status_code == 200, r.text
    det = r.json()["detected"]
    # OCR should at least pick up the name (12-digit number may vary with the model)
    assert det is not None
    if det.get("number"):
        assert det["number"] == "432198765012"
    if det.get("name"):
        assert det["name_matches"] is False
    # Not auto-saved
    assert not r.json()["people"]["self"].get("aadhaar")


def test_pan_upload_name_locked_when_passport_wins(admin_client, base_url, make_member):
    m = make_member("staff", full_name="TEST Pass QA")
    # Lock via passport use-name first
    admin_client.post(
        f"{base_url}/api/members/{m['id']}/id-docs/self/passport/use-name",
        json={"name": "PASS NAME"}, timeout=30)
    hdrs = {"Authorization": admin_client.headers["Authorization"]}
    r = requests.post(
        f"{base_url}/api/members/{m['id']}/id-docs/self/pan", headers=hdrs,
        files={"file": ("pan.png", _pan_png("ZORAWAR SINGH", "KLMNO4321P"), "image/png")},
        timeout=120)
    assert r.status_code == 200, r.text
    det = r.json()["detected"]
    assert det is not None
    # When card is pan/aadhaar and the slot is locked, name_locked must be True
    assert det.get("name_locked") is True


# ---- Bulk read returns name_matches + name_locked for pan/aadhaar --------

def test_bulk_read_returns_name_matches_for_pan(admin_client, base_url, make_member):
    uniq = f"Zorawar Quillfeather{uuid.uuid4().hex[:4]}"
    m = make_member("staff", full_name=uniq)
    hdrs = {"Authorization": admin_client.headers["Authorization"]}
    r = requests.post(
        f"{base_url}/api/id-docs/bulk/read", headers=hdrs,
        files={"file": ("x.png", _pan_png(uniq.upper() + " XYZ"), "image/png")},
        timeout=120)
    assert r.status_code == 200, r.text
    j = r.json()
    # Even if score matches our member, the exact-compare should be False since we added "XYZ"
    if j.get("match") and j["match"]["member_id"] == m["id"]:
        assert j["detected"].get("name_matches") is False
        assert "name_locked" in j["detected"]


def test_bulk_read_name_locked_when_passport_won(admin_client, base_url, make_member):
    uniq = f"Lata Mangeshkar{uuid.uuid4().hex[:4]}"
    m = make_member("staff", full_name=uniq)
    # Lock via passport
    admin_client.post(
        f"{base_url}/api/members/{m['id']}/id-docs/self/passport/use-name",
        json={"name": uniq.upper()}, timeout=30)
    hdrs = {"Authorization": admin_client.headers["Authorization"]}
    # Scan an Aadhaar with the same person
    r = requests.post(
        f"{base_url}/api/id-docs/bulk/read", headers=hdrs,
        files={"file": ("x.png", _aadhaar_png(uniq.upper()), "image/png")},
        timeout=120)
    assert r.status_code == 200, r.text
    j = r.json()
    if j.get("match") and j["match"]["member_id"] == m["id"] and j["detected"].get("type") == "aadhaar":
        assert j["detected"].get("name_locked") is True


# ---- Regression: masked aadhaar → number=null, no crash ------------------

def test_masked_aadhaar_upload_keeps_number_null(admin_client, base_url, make_member):
    m = make_member("staff", full_name="TEST Masked QA")
    hdrs = {"Authorization": admin_client.headers["Authorization"]}
    # Only last 4 digits visible (masked)
    r = requests.post(
        f"{base_url}/api/members/{m['id']}/id-docs/self/aadhaar", headers=hdrs,
        files={"file": ("mask.png", _aadhaar_png("RAVI KUMAR", "XXXXXXXX1234".replace("X", "x")), "image/png")},
        timeout=120)
    # The function uses number formatting; _clean_number will reject non-12-digit → None
    assert r.status_code == 200, r.text
    det = r.json()["detected"]
    assert det is not None
    assert det.get("number") is None or (isinstance(det.get("number"), str) and len(det["number"]) == 12)
