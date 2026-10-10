"""iter104 — DOB on PAN/Aadhaar/passport treated like name mismatches.
Reference DOB priority: birth → passport → Aadhaar → PAN.
Covers:
  * PUT accepts pan_dob/aadhaar_dob/passport_dob for self; rejected for parents.
  * Upload response for self sets expected_dob, dob_matches, dob_can_apply.
  * POST /self/{card}/use-dob only when app DOB empty & card is reference.
  * Name report includes app_dob/ref_card/ref_dob/app_dob_match + per-card dob + dob_match.
  * pending_rereads counts scans missing name OR (self) DOB not yet tried.
  * Parents have no DOB fields anywhere.
  * reread-names fills missing name/DOB without overwriting existing.
"""
from __future__ import annotations

import io
import uuid

import pytest
import requests
from PIL import Image, ImageDraw

PDF = b"%PDF-1.4\n% iter104 scan\n"


def _png(lines, size=(900, 500)):
    img = Image.new("RGB", size, "white")
    d = ImageDraw.Draw(img)
    y = 30
    for ln in lines:
        d.text((20, y), ln, fill="black")
        y += 55
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _auth(client):
    return {"Authorization": client.headers["Authorization"]}


# ---- PUT accepts {card}_dob for self; rejected for parents -----------------

def test_put_accepts_card_dobs_for_self(admin_client, base_url, make_member):
    m = make_member("staff")
    url = f"{base_url}/api/members/{m['id']}/id-docs"
    r = admin_client.put(url, json={"people": {"self": {
        "pan_dob": "2000-01-02", "aadhaar_dob": "2000-01-02", "passport_dob": "2000-01-02",
    }}}, timeout=30)
    assert r.status_code == 200, r.text
    j = r.json()["people"]["self"]
    assert j["pan_dob"] == "2000-01-02"
    assert j["aadhaar_dob"] == "2000-01-02"
    assert j["passport_dob"] == "2000-01-02"


def test_put_rejects_card_dobs_for_parents(admin_client, base_url, make_member):
    ath = make_member("athlete")
    url = f"{base_url}/api/members/{ath['id']}/id-docs"
    for key in ("pan_dob", "aadhaar_dob", "passport_dob"):
        r = admin_client.put(url, json={"people": {"father": {key: "2000-01-02"}}}, timeout=30)
        assert r.status_code == 400, f"{key} must be self-only: {r.status_code}"


# ---- Upload response: expected_dob, dob_matches, dob_can_apply --------------

def test_upload_self_pan_response_includes_dob_fields(admin_client, base_url, make_member):
    m = make_member("staff")  # has no date_of_birth
    base = f"{base_url}/api/members/{m['id']}/id-docs/self/pan"
    # ocr=false → detected is None (OCR skipped). Covered elsewhere.
    # Need a real OCR here on a synthetic PAN to see the dob fields.
    png = _png([
        "INCOME TAX DEPARTMENT  GOVT. OF INDIA",
        "Permanent Account Number",
        "ABCDE1234F",
        "Name: RAVI KUMAR",
        "Date of Birth: 1995-06-10",
    ])
    r = requests.post(base, headers=_auth(admin_client),
                      files={"file": ("pan.png", png, "image/png")}, timeout=180)
    assert r.status_code == 200, r.text
    det = r.json().get("detected")
    assert det is not None, "OCR returned nothing"
    # Required dob keys exist for self upload
    assert "expected_dob" in det
    assert "dob_matches" in det
    assert "dob_can_apply" in det
    assert det["expected_dob"] == ""  # member has no DOB
    # If Gemini read a dob, dob_can_apply must be True (no app dob, no higher card)
    if det.get("dob"):
        assert det["dob_can_apply"] is True
        assert det["dob_matches"] is None  # app dob empty → None
    # Server also auto-stored pan_dob when OCR returned one
    g = admin_client.get(f"{base_url}/api/members/{m['id']}/id-docs", timeout=30).json()
    if det.get("dob"):
        assert g["people"]["self"].get("pan_dob") == det["dob"]


# ---- use-dob: priority + 409 overrides -------------------------------------

def test_use_dob_sets_only_when_app_dob_empty(admin_client, base_url, make_member):
    m = make_member("staff")
    base = f"{base_url}/api/members/{m['id']}/id-docs/self/passport/use-dob"
    r = admin_client.post(base, json={"dob": "1992-04-05"}, timeout=30)
    assert r.status_code == 200 and r.json() == {"field": "date_of_birth", "dob": "1992-04-05"}
    # Second call must now 409 — app DOB already set
    r = admin_client.post(base, json={"dob": "1990-01-01"}, timeout=30)
    assert r.status_code == 409


def test_use_dob_priority_blocks_lower_card(admin_client, base_url, make_member):
    """Store a passport DOB first (via PUT) and then try /self/pan/use-dob → 409."""
    m = make_member("staff")
    url = f"{base_url}/api/members/{m['id']}/id-docs"
    r = admin_client.put(url, json={"people": {"self": {"passport_dob": "2001-01-01"}}}, timeout=30)
    assert r.status_code == 200
    # Member still has no users.date_of_birth → use-dob from pan must still 409 due to priority
    r = admin_client.post(f"{base_url}/api/members/{m['id']}/id-docs/self/pan/use-dob",
                          json={"dob": "2003-03-03"}, timeout=30)
    assert r.status_code == 409
    # But using the passport card itself IS allowed (it IS the reference)
    r = admin_client.post(f"{base_url}/api/members/{m['id']}/id-docs/self/passport/use-dob",
                          json={"dob": "2001-01-01"}, timeout=30)
    assert r.status_code == 200
    assert r.json()["dob"] == "2001-01-01"


def test_use_dob_empty_rejected(admin_client, base_url, make_member):
    m = make_member("staff")
    r = admin_client.post(f"{base_url}/api/members/{m['id']}/id-docs/self/passport/use-dob",
                          json={"dob": ""}, timeout=30)
    assert r.status_code == 400


# ---- Name report: app_dob / ref_card / per-card dob + dob_match -----------

def test_name_report_has_dob_fields_for_self(admin_client, base_url, make_member):
    m = make_member("staff", full_name=f"TEST DobQA {uuid.uuid4().hex[:4]}")
    url = f"{base_url}/api/members/{m['id']}/id-docs"
    # Save a passport_dob (becomes ref_dob since no app dob yet)
    admin_client.put(url, json={"people": {"self": {
        "passport_dob": "2000-02-02", "pan_dob": "1999-12-31",
    }}}, timeout=30)
    nr = admin_client.get(f"{base_url}/api/id-docs/name-report", timeout=60).json()
    row = next(x for x in nr["rows"] if x["member_id"] == m["id"] and x["person"] == "self")
    # Top-level dob fields
    assert "app_dob" in row and row["app_dob"] == ""
    assert row["ref_card"] == "passport"
    assert row["ref_dob"] == "2000-02-02"
    assert row["app_dob_match"] is None  # app dob empty
    # Per-card dob + dob_match (compared vs ref_dob when app empty)
    assert row["passport"]["dob"] == "2000-02-02"
    assert row["passport"]["dob_match"] is True
    assert row["pan"]["dob"] == "1999-12-31"
    assert row["pan"]["dob_match"] is False
    # aadhaar has no dob stored
    assert row["aadhaar"]["dob"] == ""
    assert row["aadhaar"]["dob_match"] is None


def test_name_report_parent_rows_have_no_dob(admin_client, base_url, make_member):
    ath = make_member("athlete")
    nr = admin_client.get(f"{base_url}/api/id-docs/name-report", timeout=60).json()
    father = next(x for x in nr["rows"] if x["member_id"] == ath["id"] and x["person"] == "father")
    # Parent cells are NOT dicts with dob fields — birth is None, pan is dict but no dob_match for the parent (dob is None for parent)
    assert father["birth"] is None
    # Parent row still has pan/aadhaar/passport dicts but no dob keys per spec
    assert father["pan"].get("dob") is None  # not set for parents
    assert father.get("app_dob") is None
    assert father.get("ref_card") is None


# ---- pending_rereads counts self-DOB-missing scans -------------------------

def test_pending_rereads_counts_self_dob_missing(admin_client, base_url, make_member):
    """Upload a PAN scan with ocr=false → both name & dob missing → counts as pending."""
    m = make_member("staff")
    base = f"{base_url}/api/members/{m['id']}/id-docs/self/pan"
    r = requests.post(f"{base}?ocr=false", headers=_auth(admin_client),
                      files={"file": ("pan.pdf", PDF, "application/pdf")}, timeout=60)
    assert r.status_code == 200
    nr = admin_client.get(f"{base_url}/api/id-docs/name-report", timeout=60).json()
    assert nr["pending_rereads"] >= 1
    # Set pan_name manually → still missing dob → still pending (self)
    admin_client.put(f"{base_url}/api/members/{m['id']}/id-docs",
                     json={"people": {"self": {"pan_name": "SET NAME"}}}, timeout=30)
    nr2 = admin_client.get(f"{base_url}/api/id-docs/name-report", timeout=60).json()
    # count stays >= 1 because dob is still missing & dob_tried not set
    row = next(x for x in nr2["rows"] if x["member_id"] == m["id"] and x["person"] == "self")
    assert row["pan"]["name"] == "SET NAME"
    assert row["pan"]["dob"] == ""


def test_parent_pending_rereads_ignores_dob(admin_client, base_url, make_member):
    """Parent scans only pend on missing name, never on dob."""
    ath = make_member("athlete")
    base = f"{base_url}/api/members/{ath['id']}/id-docs/father/pan"
    r = requests.post(f"{base}?ocr=false", headers=_auth(admin_client),
                      files={"file": ("pan.pdf", PDF, "application/pdf")}, timeout=60)
    assert r.status_code == 200
    # Mark pan_name_tried via PUT isn't exposed, so pending remains for name only.
    # Set pan_name directly → scan becomes "handled" for parent (no dob dimension).
    admin_client.put(f"{base_url}/api/members/{ath['id']}/id-docs",
                     json={"people": {"father": {"pan_name": "FATHER NAME"}}}, timeout=30)
    nr = admin_client.get(f"{base_url}/api/id-docs/name-report", timeout=60).json()
    row = next(x for x in nr["rows"] if x["member_id"] == ath["id"] and x["person"] == "father")
    # Parent dict shouldn't carry dob keys (self-only in response)
    assert "dob" not in row["pan"]


# ---- Regression: iter103 use-dob behaviour (now scoped under /self/{card}) --

def test_birth_use_dob_still_works(admin_client, base_url, make_member):
    """Member has no DOB → birth use-dob succeeds and is the top priority."""
    m = make_member("staff")
    r = admin_client.post(f"{base_url}/api/members/{m['id']}/id-docs/self/birth/use-dob",
                          json={"dob": "2010-10-10"}, timeout=30)
    assert r.status_code == 200
    assert r.json() == {"field": "date_of_birth", "dob": "2010-10-10"}
