"""iter103 — Name mismatch report, birth certificate, re-read old scans,
and removal of PAN/Aadhaar use-name endpoints. Uses throwaway members only.
Combines a few real-OCR calls (Gemini) with many fast API-only assertions.
"""
from __future__ import annotations

import io
import uuid

import pytest
import requests
from PIL import Image, ImageDraw

PDF = b"%PDF-1.4\n% iter103 scan\n"


def _png_bytes(lines, size=(800, 420)):
    img = Image.new("RGB", size, "white")
    d = ImageDraw.Draw(img)
    y = 30
    for ln in lines:
        d.text((20, y), ln, fill="black")
        y += 55
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _auth_hdrs(admin_client):
    return {"Authorization": admin_client.headers["Authorization"]}


# ---- Model/field acceptance (no OCR) ---------------------------------------

def test_put_accepts_birth_dob_and_card_names(admin_client, base_url, make_member):
    ath = make_member("athlete", father_name="TEST Father QA")
    url = f"{base_url}/api/members/{ath['id']}/id-docs"
    r = admin_client.put(url, json={"people": {
        "self": {"birth": "REG-123", "birth_dob": "2010-05-01", "birth_name": "Baby One",
                 "pan_name": "RAVI KUMAR", "aadhaar_name": "RAVI K",
                 "passport_name": "Ravi Kumar"},
        "father": {"pan_name": "Old Father", "aadhaar_name": "OLD FATHER"},
    }}, timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["people"]["self"]["birth"] == "REG-123"
    assert body["people"]["self"]["birth_dob"] == "2010-05-01"
    assert body["people"]["self"]["birth_name"] == "Baby One"
    assert body["people"]["self"]["pan_name"] == "RAVI KUMAR"
    assert body["people"]["father"]["aadhaar_name"] == "OLD FATHER"
    # app_names + app_dob exposed on GET
    g = admin_client.get(url, timeout=30).json()
    assert "app_names" in g and g["app_names"]["self"] == ath["full_name"]
    assert "app_dob" in g


def test_birth_rejected_for_parents(admin_client, base_url, make_member):
    ath = make_member("athlete")
    url = f"{base_url}/api/members/{ath['id']}/id-docs"
    r = admin_client.put(url, json={"people": {"father": {"birth": "X"}}}, timeout=30)
    assert r.status_code == 400
    r = admin_client.put(url, json={"people": {"mother": {"birth_dob": "2010-01-01"}}}, timeout=30)
    assert r.status_code == 400


def test_upload_birth_blocked_for_parents(admin_client, base_url, make_member):
    ath = make_member("athlete")
    base = f"{base_url}/api/members/{ath['id']}/id-docs/father/birth"
    r = requests.post(base, headers=_auth_hdrs(admin_client),
                      files={"file": ("x.pdf", PDF, "application/pdf")}, timeout=30)
    assert r.status_code == 400


def test_pan_and_aadhaar_use_name_removed(admin_client, base_url, make_member):
    """App name follows the passport only (Jan 2026). PAN/Aadhaar routes must be gone."""
    m = make_member("staff")
    base = f"{base_url}/api/members/{m['id']}/id-docs"
    for card in ("pan", "aadhaar"):
        r = admin_client.post(f"{base}/self/{card}/use-name", json={"name": "Whatever"}, timeout=30)
        assert r.status_code in (404, 405), f"{card} use-name still exists: {r.status_code}"
    # Passport use-name still works
    r = admin_client.post(f"{base}/self/passport/use-name", json={"name": "RAVI KUMAR"}, timeout=30)
    assert r.status_code == 200 and r.json() == {"field": "full_name", "name": "Ravi Kumar"}


# ---- Scan save: card_name is stored on upload / cleared on ocr=false/delete

def test_upload_ocr_false_clears_card_name(admin_client, base_url, make_member):
    m = make_member("staff")
    # Pre-seed a card_name
    admin_client.put(f"{base_url}/api/members/{m['id']}/id-docs",
                     json={"people": {"self": {"pan_name": "SOME NAME"}}}, timeout=30)
    base = f"{base_url}/api/members/{m['id']}/id-docs/self/pan"
    r = requests.post(f"{base}?ocr=false", headers=_auth_hdrs(admin_client),
                      files={"file": ("pan.pdf", PDF, "application/pdf")}, timeout=60)
    assert r.status_code == 200
    g = admin_client.get(f"{base_url}/api/members/{m['id']}/id-docs", timeout=30).json()
    assert "pan_name" not in (g["people"].get("self") or {})


def test_delete_scan_clears_card_name(admin_client, base_url, make_member):
    m = make_member("staff")
    admin_client.put(f"{base_url}/api/members/{m['id']}/id-docs",
                     json={"people": {"self": {"pan_name": "SOME NAME"}}}, timeout=30)
    base = f"{base_url}/api/members/{m['id']}/id-docs/self/pan"
    r = requests.post(f"{base}?ocr=false", headers=_auth_hdrs(admin_client),
                      files={"file": ("pan.pdf", PDF, "application/pdf")}, timeout=60)
    assert r.status_code == 200
    r = requests.delete(f"{base}/file", headers=_auth_hdrs(admin_client), timeout=30)
    assert r.status_code == 200
    g = admin_client.get(f"{base_url}/api/members/{m['id']}/id-docs", timeout=30).json()
    assert "pan_name" not in (g["people"].get("self") or {})


# ---- Report includes birth columns -----------------------------------------

def test_report_has_birth_columns(admin_client, base_url, make_member):
    ath = make_member("athlete")
    admin_client.put(f"{base_url}/api/members/{ath['id']}/id-docs",
                     json={"people": {"self": {"birth": "REG-X9"}}}, timeout=30)
    rows = admin_client.get(f"{base_url}/api/id-docs/report", timeout=60).json()["rows"]
    mine = {x["person"]: x for x in rows if x["member_id"] == ath["id"]}
    assert mine["self"]["birth"] == "REG-X9"
    assert mine["self"]["birth_scan"] is False
    # Parents must have null birth / birth_scan
    assert mine["father"]["birth"] is None and mine["father"]["birth_scan"] is None


# ---- Name report + re-read batch -------------------------------------------

def test_name_report_structure_and_reread(admin_client, base_url, make_member):
    """Upload a scan with ocr=false → scan present, no card_name → appears
    as pending re-read. Then run reread-names (small limit) and check counter."""
    m = make_member("staff", full_name=f"TEST ReReadQA {uuid.uuid4().hex[:4]}")
    base = f"{base_url}/api/members/{m['id']}/id-docs/self/pan"
    r = requests.post(f"{base}?ocr=false", headers=_auth_hdrs(admin_client),
                      files={"file": ("pan.pdf", PDF, "application/pdf")}, timeout=60)
    assert r.status_code == 200

    nr = admin_client.get(f"{base_url}/api/id-docs/name-report", timeout=60).json()
    assert "pending_rereads" in nr and nr["pending_rereads"] >= 1
    rows = {(x["member_id"], x["person"]): x for x in nr["rows"]}
    mine = rows.get((m["id"], "self"))
    assert mine is not None
    assert mine["person_name"] == m["full_name"]
    # pan cell: has scan, no name yet → unread True / name empty / match None
    assert mine["pan"]["scan"] is True and mine["pan"]["unread"] is True
    assert mine["pan"]["name"] == "" and mine["pan"]["match"] is None
    # birth null for self when no file (but still a dict with scan=False) OR None allowed
    # per spec: birth null for parents only; self has a dict.
    assert isinstance(mine["birth"], dict) and mine["birth"]["scan"] is False
    father = rows.get((m["id"], "father"))
    assert father is None  # staff has no parent rows

    # reread (OCR will probably fail on dummy PDF → name_tried flag is set,
    # pending_rereads drops to 0 for this scan)
    rr = admin_client.post(f"{base_url}/api/id-docs/reread-names?limit=3", timeout=120).json()
    assert "done" in rr and "named" in rr and "remaining" in rr
    assert rr["done"] >= 1


def test_name_report_shows_mismatch_match_true(admin_client, base_url, make_member):
    """Seed a card_name directly via PUT, verify match flag goes True/False correctly."""
    m = make_member("staff", full_name="Ravi Kumar")
    base = f"{base_url}/api/members/{m['id']}/id-docs/self/pan"
    requests.post(f"{base}?ocr=false", headers=_auth_hdrs(admin_client),
                  files={"file": ("pan.pdf", PDF, "application/pdf")}, timeout=60)
    admin_client.put(f"{base_url}/api/members/{m['id']}/id-docs",
                     json={"people": {"self": {"pan_name": "RAVI KUMAR"}}}, timeout=30)
    nr = admin_client.get(f"{base_url}/api/id-docs/name-report", timeout=60).json()
    row = next(x for x in nr["rows"] if x["member_id"] == m["id"] and x["person"] == "self")
    assert row["pan"]["name"] == "RAVI KUMAR"
    assert row["pan"]["match"] is True  # exact per name_exact

    # Change expected name on the member → mismatch
    admin_client.patch(f"{base_url}/api/members/{m['id']}", json={"full_name": "TEST Sita Devi"}, timeout=30)
    nr = admin_client.get(f"{base_url}/api/id-docs/name-report", timeout=60).json()
    row = next(x for x in nr["rows"] if x["member_id"] == m["id"] and x["person"] == "self")
    assert row["pan"]["match"] is False


# ---- Birth cert OCR + use-dob (real Gemini) --------------------------------

@pytest.mark.timeout(180)
def test_birth_certificate_ocr_and_use_dob(admin_client, base_url, make_member):
    """Real OCR: synthetic birth certificate → child name + dob + reg no.
    use-dob then updates users.date_of_birth."""
    png = _png_bytes([
        "BIRTH CERTIFICATE   GOVERNMENT OF INDIA",
        "Registration No.: BC-2026-99887",
        "Name of Child: ANIKA SHARMA",
        "Date of Birth: 2012-08-15",
        "Father's Name: Mr RAJ SHARMA",
        "Mother's Name: Mrs PRIYA SHARMA",
        "Place: Mumbai",
    ], size=(900, 500))
    m = make_member("athlete", full_name="TEST Different Name")
    base = f"{base_url}/api/members/{m['id']}/id-docs/self/birth"
    r = requests.post(base, headers=_auth_hdrs(admin_client),
                      files={"file": ("birth.png", png, "image/png")}, timeout=180)
    assert r.status_code == 200, r.text
    det = r.json()["detected"]
    assert det is not None, "OCR returned nothing"
    # Gemini should pick child name 'ANIKA SHARMA' and dob
    assert det.get("name"), f"no name: {det}"
    assert "anika" in det["name"].lower()
    assert det.get("dob") == "2012-08-15", det
    assert det.get("expected_dob") == ""  # member has no DOB set
    # expected_name set + name_matches False (child name != TEST Different Name)
    assert det.get("expected_name") == "TEST Different Name"
    assert det.get("name_matches") is False

    # Use the DOB
    r = admin_client.post(f"{base_url}/api/members/{m['id']}/id-docs/self/birth/use-dob",
                          json={"dob": "2012-08-15"}, timeout=30)
    assert r.status_code == 200 and r.json() == {"field": "date_of_birth", "dob": "2012-08-15"}
    # Verify member doc updated
    g = admin_client.get(f"{base_url}/api/members/{m['id']}/id-docs", timeout=30).json()
    assert g["app_dob"] == "2012-08-15"

    # Empty dob rejected
    r = admin_client.post(f"{base_url}/api/members/{m['id']}/id-docs/self/birth/use-dob",
                          json={"dob": ""}, timeout=30)
    assert r.status_code == 400


# ---- bulk/read detects birth type ------------------------------------------

@pytest.mark.timeout(180)
def test_bulk_read_detects_birth_and_matches_self(admin_client, base_url, make_member):
    png = _png_bytes([
        "BIRTH CERTIFICATE   GOVERNMENT OF INDIA",
        "Registration No.: BC-2027-11223",
        "Name of Child: KARTIK VERMA",
        "Date of Birth: 2015-02-20",
        "Father's Name: Mr SURESH VERMA",
    ], size=(900, 500))
    # Member with matching name so bulk matcher picks them
    m = make_member("athlete", full_name="Kartik Verma")
    r = requests.post(f"{base_url}/api/id-docs/bulk/read",
                      headers=_auth_hdrs(admin_client),
                      files={"file": ("bc.png", png, "image/png")}, timeout=180)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["detected"]["type"] == "birth", j
    assert j["detected"].get("dob") == "2015-02-20"
    if j["match"]:
        # Birth only matches self rows
        assert j["match"]["person"] == "self"
        assert j["match"]["member_id"] == m["id"]
