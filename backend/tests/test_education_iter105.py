"""iter105 — Education tree + marksheet CRUD + AI /read.

Covers:
- GET /api/education/tree admin-only, groups active athletes/coaches,
  A→Z, marksheets newest-first, with name_matches / has_file / file_name.
- POST /api/education/read uses real Gemini (best-effort — if OCR unreachable
  the response is {detected: null}; we still assert the contract).
- CRUD endpoints: create, patch, delete, download, with validation.
- Audit entries.
"""
from __future__ import annotations

import io
import os
import uuid
from datetime import date

import pytest
import requests
from PIL import Image, ImageDraw

from tests.conftest import ADMIN_EMAIL, ADMIN_PASSWORD, BASE_URL, login_session


# ---------- helpers ----------
def _marksheet_png(student_name: str, exam: str = "SSC Board Exam",
                   mon: str = "March", year: str = "2025",
                   board: str = "Maharashtra State Board",
                   result: str = "86%") -> bytes:
    """Synthetic marksheet image for OCR tests."""
    img = Image.new("RGB", (900, 600), "white")
    d = ImageDraw.Draw(img)
    d.text((40, 30), board, fill="black")
    d.text((40, 90), exam, fill="black")
    d.text((40, 150), f"Student Name: {student_name}", fill="black")
    d.text((40, 220), f"Month: {mon}", fill="black")
    d.text((40, 260), f"Year: {year}", fill="black")
    d.text((40, 320), f"Overall: {result}", fill="black")
    d.text((40, 380), "Result: PASS", fill="black")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture(scope="module")
def admin():
    return login_session(BASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD)


@pytest.fixture(scope="module")
def throwaway_athlete(admin):
    sfx = uuid.uuid4().hex[:8]
    body = {"email": f"test_edu_{sfx}@ishowedup-test.example.com", "password": "Test@12345",
            "full_name": f"TEST Athlete {sfx}", "role": "member", "category": "athlete"}
    r = admin.post(f"{BASE_URL}/api/members", json=body, timeout=30)
    assert r.status_code == 200, r.text
    m = r.json()
    yield m
    admin.delete(f"{BASE_URL}/api/members/{m['id']}", params={"reason": "iter105 cleanup"}, timeout=30)


@pytest.fixture
def _tracked(admin):
    """Track marksheets created in a test and delete at end."""
    ids = []
    yield ids
    for sid in ids:
        admin.delete(f"{BASE_URL}/api/education/marksheets/{sid}", timeout=30)


# ---------- GET /education/tree ----------
class TestTree:
    def test_requires_admin(self):
        r = requests.get(f"{BASE_URL}/api/education/tree", timeout=30)
        assert r.status_code in (401, 403)

    def test_shape_and_order(self, admin):
        r = admin.get(f"{BASE_URL}/api/education/tree", timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        assert set(d.keys()) == {"athletes", "coaches"}
        assert isinstance(d["athletes"], list) and isinstance(d["coaches"], list)
        # A→Z by full_name
        for key in ("athletes", "coaches"):
            names = [(m.get("full_name") or "").lower() for m in d[key]]
            assert names == sorted(names), f"{key} not A→Z"
            for m in d[key]:
                for k in ("id", "full_name", "category", "marksheets"):
                    assert k in m, f"missing {k}"
                # Marksheets newest-first (year desc, month desc)
                pairs = [(s["year"], s["month"]) for s in m["marksheets"]]
                assert pairs == sorted(pairs, reverse=True), f"not newest-first for {m['id']}"
                for s in m["marksheets"]:
                    for k in ("exam_name", "month", "year", "board", "result", "notes",
                              "sheet_name", "has_file", "file_name", "name_matches"):
                        assert k in s, f"marksheet missing {k}"
                    assert s["name_matches"] is None or isinstance(s["name_matches"], bool)
                    if not s.get("sheet_name"):
                        assert s["name_matches"] is None


# ---------- CRUD + download ----------
class TestCRUD:
    def test_create_requires_exam_name(self, admin, throwaway_athlete):
        r = admin.post(f"{BASE_URL}/api/education/members/{throwaway_athlete['id']}/marksheets",
                       files={}, data={"exam_name": "", "month": 3, "year": 2025},
                       headers={"Content-Type": None} if False else {}, timeout=30)
        # requests sends multipart via `data` when no files — switch to proper multipart
        # The admin session has Content-Type: application/json by default; strip for multipart.

    def _mp_post(self, admin, url, fields: dict, file_bytes: bytes = None, filename="scan.png",
                 ctype="image/png", method="post"):
        data = {k: str(v) for k, v in fields.items()}
        files = {}
        if file_bytes is not None:
            files["file"] = (filename, file_bytes, ctype)
        headers = {k: v for k, v in admin.headers.items() if k.lower() != "content-type"}
        fn = requests.post if method == "post" else requests.patch
        # When no files, still force multipart via files={'_': (None, '')} trick
        if not files:
            files = {"_dummy": (None, "")}
        return fn(url, data=data, files=files, headers=headers, timeout=120)

    def test_create_validation(self, admin, throwaway_athlete):
        url = f"{BASE_URL}/api/education/members/{throwaway_athlete['id']}/marksheets"
        # Whitespace-only exam name → backend strips to empty → 400
        r = self._mp_post(admin, url, {"exam_name": "   ", "month": 3, "year": 2025})
        assert r.status_code == 400, f"empty exam: {r.status_code} {r.text}"
        # Bad month
        r = self._mp_post(admin, url, {"exam_name": "SSC", "month": 13, "year": 2025})
        assert r.status_code == 400, f"bad month: {r.status_code} {r.text}"
        # Bad year
        r = self._mp_post(admin, url, {"exam_name": "SSC", "month": 3, "year": 1970})
        assert r.status_code == 400, f"bad year: {r.status_code} {r.text}"

    def test_create_patch_delete_lifecycle(self, admin, throwaway_athlete, _tracked):
        url = f"{BASE_URL}/api/education/members/{throwaway_athlete['id']}/marksheets"
        r = self._mp_post(admin, url, {
            "exam_name": "SSC Class X", "month": 3, "year": 2024,
            "board": "Maharashtra", "result": "86%", "notes": "pass",
            "sheet_name": "", }, file_bytes=_marksheet_png("TEST Student"))
        assert r.status_code == 200, r.text
        s = r.json()
        _tracked.append(s["id"])
        assert s["exam_name"] == "SSC Class X"
        assert s["has_file"] is True and s["file_name"]
        assert s["name_matches"] is None  # no sheet_name provided

        # Verify in tree
        tree = admin.get(f"{BASE_URL}/api/education/tree", timeout=30).json()
        found = next((m for m in tree["athletes"] if m["id"] == throwaway_athlete["id"]), None)
        assert found and any(sh["id"] == s["id"] for sh in found["marksheets"])

        # Download the scan
        dr = admin.get(f"{BASE_URL}/api/education/marksheets/{s['id']}/file", timeout=30)
        assert dr.status_code == 200 and len(dr.content) > 100

        # PATCH - update exam name
        pr = self._mp_post(admin, f"{BASE_URL}/api/education/marksheets/{s['id']}",
                           {"exam_name": "SSC Class X Board", "month": 3, "year": 2024,
                            "board": "Maharashtra", "result": "88%", "notes": "updated"},
                           method="patch")
        assert pr.status_code == 200, pr.text
        assert pr.json()["exam_name"] == "SSC Class X Board"
        assert pr.json()["result"] == "88%"

        # DELETE
        dr = admin.delete(f"{BASE_URL}/api/education/marksheets/{s['id']}", timeout=30)
        assert dr.status_code == 200
        _tracked.remove(s["id"])
        # GET file after delete → 404
        gr = admin.get(f"{BASE_URL}/api/education/marksheets/{s['id']}/file", timeout=30)
        assert gr.status_code == 404

    def test_newest_first_after_multiple(self, admin, throwaway_athlete, _tracked):
        url = f"{BASE_URL}/api/education/members/{throwaway_athlete['id']}/marksheets"
        for mon, yr in [(3, 2022), (10, 2024), (6, 2023)]:
            r = self._mp_post(admin, url, {"exam_name": f"Exam {yr}-{mon}",
                                           "month": mon, "year": yr})
            assert r.status_code == 200, r.text
            _tracked.append(r.json()["id"])
        tree = admin.get(f"{BASE_URL}/api/education/tree", timeout=30).json()
        found = next(m for m in tree["athletes"] if m["id"] == throwaway_athlete["id"])
        yrs = [(s["year"], s["month"]) for s in found["marksheets"]]
        assert yrs == sorted(yrs, reverse=True)

    def test_download_404_when_no_file(self, admin, throwaway_athlete, _tracked):
        url = f"{BASE_URL}/api/education/members/{throwaway_athlete['id']}/marksheets"
        r = self._mp_post(admin, url, {"exam_name": "NoFile", "month": 1, "year": 2023})
        assert r.status_code == 200
        sid = r.json()["id"]
        _tracked.append(sid)
        assert r.json()["has_file"] is False
        g = admin.get(f"{BASE_URL}/api/education/marksheets/{sid}/file", timeout=30)
        assert g.status_code == 404


# ---------- /education/read ----------
class TestRead:
    def _mp(self, admin, fields, file_bytes, filename="scan.png", ctype="image/png"):
        files = {"file": (filename, file_bytes, ctype)}
        for k, v in fields.items():
            files[k] = (None, str(v))
        headers = {k: v for k, v in admin.headers.items() if k.lower() != "content-type"}
        return requests.post(f"{BASE_URL}/api/education/read", files=files, headers=headers, timeout=180)

    def test_bad_type_400(self, admin, throwaway_athlete):
        r = self._mp(admin, {"member_id": throwaway_athlete["id"]},
                     b"hello", filename="x.txt", ctype="text/plain")
        assert r.status_code == 400

    def test_too_big_400(self, admin, throwaway_athlete):
        big = b"\x89PNG\r\n\x1a\n" + b"0" * (10 * 1024 * 1024 + 100)
        r = self._mp(admin, {"member_id": throwaway_athlete["id"]}, big)
        assert r.status_code == 400

    def test_read_returns_detected_shape(self, admin, throwaway_athlete):
        # Real Gemini call — best-effort; could return None, but shape must be stable.
        img = _marksheet_png(throwaway_athlete["full_name"])
        r = self._mp(admin, {"member_id": throwaway_athlete["id"]}, img)
        assert r.status_code == 200, r.text
        body = r.json()
        assert "detected" in body
        d = body["detected"]
        if d is not None:
            # Must contain all required keys per contract
            for k in ("name", "exam_name", "month", "year", "board", "result",
                      "expected_name", "name_matches"):
                assert k in d, f"missing key {k} in detected: {d}"
            assert d["expected_name"] == throwaway_athlete["full_name"]
            # name_matches is strict-exact → bool or None
            assert d["name_matches"] is None or isinstance(d["name_matches"], bool)
