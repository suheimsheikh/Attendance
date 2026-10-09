"""PAN / Aadhaar numbers + one scan per card for a member and (athlete-like
members only) their father, mother and guardian. Admin-only (Oct 2026).
Numbers live in `member_id_docs`; scans live in Emergent Object Storage.
On upload the number + name are read off the scan (services/id_ocr.py) and
returned as `detected` for the admin to confirm — never auto-saved."""
from __future__ import annotations

import asyncio
import re
import uuid
from typing import Dict, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from routes.admin_audit import write_audit
from services.id_ocr import name_exact, name_matches, name_score, read_id_card
from services.permissions import is_ex_member
from services.object_storage import APP_PREFIX, get_object, put_object
from services.scope import athlete_like_keys
from services.time_utils import local_date_str, now_utc

CARDS = ("pan", "aadhaar", "passport")
NUMBER_KEYS = ("pan", "aadhaar", "passport", "passport_expiry")
PASSPORT_RE = re.compile(r"^[A-Z0-9]{6,9}$")
PARENTS = ("father", "mother", "guardian")
MAX_BYTES = 10 * 1024 * 1024
ALLOWED_TYPES = {"application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
PAN_RE = re.compile(r"^[A-Z]{5}[0-9]{4}[A-Z]$")


class PersonNumbers(BaseModel):
    pan: Optional[str] = None
    aadhaar: Optional[str] = None
    passport: Optional[str] = None
    passport_expiry: Optional[str] = None


class IdNumbersIn(BaseModel):
    people: Dict[str, PersonNumbers]


def _clean_pan(v: Optional[str]) -> str:
    v = (v or "").replace(" ", "").upper()
    if v and not PAN_RE.match(v):
        raise HTTPException(status_code=400, detail=f"PAN '{v}' must look like ABCDE1234F")
    return v


def _clean_passport(v: Optional[str]) -> str:
    v = re.sub(r"[\s-]", "", v or "").upper()
    if v and not PASSPORT_RE.match(v):
        raise HTTPException(status_code=400, detail="Passport number must be 6–9 letters/digits")
    return v


def _clean_date(v: Optional[str]) -> str:
    v = (v or "").strip()
    if v and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
        raise HTTPException(status_code=400, detail="Passport expiry must be a date (YYYY-MM-DD)")
    return v


def _expiry_status(exp: str, today: str) -> str:
    if not exp:
        return ""
    if exp < today:
        return "expired"
    y, m, d = (int(x) for x in today.split("-"))
    m += 6
    y, m = y + (m - 1) // 12, (m - 1) % 12 + 1
    return "soon" if exp <= f"{y:04d}-{m:02d}-{min(d, 28):02d}" else "ok"


def _clean_aadhaar(v: Optional[str]) -> str:
    v = re.sub(r"[\s-]", "", v or "")
    if v and not (v.isdigit() and len(v) == 12):
        raise HTTPException(status_code=400, detail="Aadhaar must be 12 digits")
    return v


def _numbers(people: dict) -> dict:
    """Audit view: numbers only (PAN/Aadhaar aren't treated as private — user, Oct 2026)."""
    return {p: {k: v for k, v in (d or {}).items() if k in NUMBER_KEYS} for p, d in (people or {}).items()}


def _safe_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._ -]", "_", name)[:120] or "scan"


def make_router(db, require_admin) -> APIRouter:
    router = APIRouter(prefix="/api")

    async def _member_and_people(mid: str):
        m = await db.users.find_one({"id": mid}, {"_id": 0, "id": 1, "full_name": 1, "category": 1,
                                                  "father_name": 1, "mother_name": 1, "guardian_name": 1})
        if not m:
            raise HTTPException(status_code=404, detail="Member not found")
        people = ["self"] + (list(PARENTS) if m.get("category") in await athlete_like_keys(db) else [])
        return m, people

    async def _doc(mid: str) -> dict:
        return await db.member_id_docs.find_one({"user_id": mid}, {"_id": 0}) or {"user_id": mid, "people": {}}

    def _check(person: str, card: str, people: list):
        if person not in people or card not in CARDS:
            raise HTTPException(status_code=400, detail="Unknown person or card")

    @router.get("/members/{mid}/id-docs")
    async def get_id_docs(mid: str, admin: dict = Depends(require_admin)):
        _, people = await _member_and_people(mid)
        return {**await _doc(mid), "allowed_people": people}

    @router.put("/members/{mid}/id-docs")
    async def save_id_numbers(mid: str, body: IdNumbersIn, admin: dict = Depends(require_admin)):
        m, people = await _member_and_people(mid)
        before = await _doc(mid)
        sets = {}
        for person, nums in body.people.items():
            _check(person, "pan", people)
            # Only fields sent are written (bulk upload saves one card at a time).
            if nums.pan is not None:
                sets[f"people.{person}.pan"] = _clean_pan(nums.pan)
            if nums.aadhaar is not None:
                sets[f"people.{person}.aadhaar"] = _clean_aadhaar(nums.aadhaar)
            if nums.passport is not None:
                sets[f"people.{person}.passport"] = _clean_passport(nums.passport)
            if nums.passport_expiry is not None:
                sets[f"people.{person}.passport_expiry"] = _clean_date(nums.passport_expiry)
        await db.member_id_docs.update_one(
            {"user_id": mid}, {"$set": {**sets, "user_id": mid, "updated_at": now_utc().isoformat()}}, upsert=True)
        after = await _doc(mid)
        await write_audit(db, actor=admin, action="id_numbers_updated", entity_type="member",
                          entity_id=mid, entity_name=m.get("full_name"),
                          before={"people": _numbers(before.get("people"))},
                          after={"people": _numbers(after.get("people"))})
        return {**after, "allowed_people": people}

    @router.post("/members/{mid}/id-docs/{person}/{card}")
    async def upload_scan(mid: str, person: str, card: str, file: UploadFile = File(...), ocr: bool = True,
                          admin: dict = Depends(require_admin)):
        m, people = await _member_and_people(mid)
        _check(person, card, people)
        ctype = (file.content_type or "").lower()
        if ctype not in ALLOWED_TYPES:
            raise HTTPException(status_code=400, detail="Upload a PDF, JPG, PNG or WEBP file")
        data = await file.read(MAX_BYTES + 1)
        if not data or len(data) > MAX_BYTES:
            raise HTTPException(status_code=400, detail="File must be between 1 byte and 10 MB")
        path = f"{APP_PREFIX}/id-docs/{mid}/{person}_{card}_{uuid.uuid4().hex}.{ALLOWED_TYPES[ctype]}"
        await asyncio.to_thread(put_object, path, data, ctype)
        meta = {"path": path, "name": _safe_name(file.filename or path.rsplit("/", 1)[-1]), "content_type": ctype,
                "size": len(data), "uploaded_at": now_utc().isoformat(),
                "uploaded_by": admin.get("full_name") or admin.get("email")}
        await db.member_id_docs.update_one(
            {"user_id": mid}, {"$set": {f"people.{person}.{card}_file": meta, "user_id": mid,
                                        "updated_at": meta["uploaded_at"]}}, upsert=True)
        await write_audit(db, actor=admin, action="id_scan_uploaded", entity_type="member",
                          entity_id=mid, entity_name=m.get("full_name"),
                          after={"person": person, "card": card, "file": meta["name"]})
        detected = await read_id_card(data, ctype, card) if ocr else None
        if detected:
            expected = m.get("full_name") if person == "self" else m.get(f"{person}_name")
            match = name_exact if card == "passport" else name_matches
            detected.update(expected_name=expected, name_matches=match(detected["name"], expected))
        return {**await _doc(mid), "allowed_people": people, "detected": detected}

    @router.get("/members/{mid}/id-docs/{person}/{card}/file")
    async def download_scan(mid: str, person: str, card: str, admin: dict = Depends(require_admin)):
        meta = ((await _doc(mid)).get("people", {}).get(person) or {}).get(f"{card}_file")
        if not meta:
            raise HTTPException(status_code=404, detail="No scan uploaded")
        data, _ = await asyncio.to_thread(get_object, meta["path"])
        return Response(content=data, media_type=meta["content_type"],
                        headers={"Content-Disposition": f'inline; filename="{_safe_name(meta["name"])}"',
                                 "Cache-Control": "no-store"})

    @router.delete("/members/{mid}/id-docs/{person}/{card}/file")
    async def delete_scan(mid: str, person: str, card: str, admin: dict = Depends(require_admin)):
        m, people = await _member_and_people(mid)
        _check(person, card, people)
        await db.member_id_docs.update_one({"user_id": mid}, {"$unset": {f"people.{person}.{card}_file": ""}})
        await write_audit(db, actor=admin, action="id_scan_removed", entity_type="member",
                          entity_id=mid, entity_name=m.get("full_name"), before={"person": person, "card": card})
        return {**await _doc(mid), "allowed_people": people}

    async def _active_people() -> list:
        """Every (member, person) slot for active members — feeds the report + bulk matcher."""
        athlete_keys = set(await athlete_like_keys(db))
        users = await db.users.find(
            {"archived": {"$ne": True}, "active": {"$ne": False}, "email": {"$exists": True}},
            {"_id": 0, "id": 1, "full_name": 1, "category": 1, "custom_category": 1, "leaving_date": 1,
             "father_name": 1, "mother_name": 1, "guardian_name": 1}).to_list(5000)
        out = []
        for u in users:
            if is_ex_member(u):
                continue
            for p in ["self"] + (list(PARENTS) if u.get("category") in athlete_keys else []):
                out.append({"member_id": u["id"], "member_name": u.get("full_name"),
                            "category": u.get("custom_category") or u.get("category"), "person": p,
                            "person_name": u.get("full_name") if p == "self" else u.get(f"{p}_name")})
        return out

    @router.get("/id-docs/report")
    async def id_docs_report(admin: dict = Depends(require_admin)):
        docs = {d["user_id"]: d.get("people") or {}
                async for d in db.member_id_docs.find({}, {"_id": 0, "user_id": 1, "people": 1})}
        rows = []
        today = local_date_str(await db.config.find_one({"id": "office"}) or {})
        for r in await _active_people():
            p = docs.get(r["member_id"], {}).get(r["person"]) or {}
            rows.append({**r, "pan": p.get("pan") or "", "aadhaar": p.get("aadhaar") or "",
                         "pan_scan": bool(p.get("pan_file")), "aadhaar_scan": bool(p.get("aadhaar_file")),
                         "passport": p.get("passport") or "", "passport_scan": bool(p.get("passport_file")),
                         "passport_expiry": p.get("passport_expiry") or "",
                         "passport_status": _expiry_status(p.get("passport_expiry") or "", today)})
        rows.sort(key=lambda x: ((x["member_name"] or "").lower(), ["self", *PARENTS].index(x["person"])))
        return {"rows": rows}

    @router.post("/id-docs/bulk/read")
    async def bulk_read(file: UploadFile = File(...), admin: dict = Depends(require_admin)):
        """Read one scan (type, number, name) and suggest the best-matching person. Saves nothing."""
        ctype = (file.content_type or "").lower()
        if ctype not in ALLOWED_TYPES:
            raise HTTPException(status_code=400, detail="Upload a PDF, JPG, PNG or WEBP file")
        data = await file.read(MAX_BYTES + 1)
        if not data or len(data) > MAX_BYTES:
            raise HTTPException(status_code=400, detail="File must be between 1 byte and 10 MB")
        det = await read_id_card(data, ctype, "auto") or {"type": None, "number": None, "name": None}
        best, best_score = None, 0.0
        if det.get("name"):
            for r in await _active_people():
                s = name_score(det["name"], r["person_name"])
                if s > best_score:
                    best, best_score = r, s
        match = best if best_score >= 0.5 else None
        if match and det.get("type") == "passport":
            det["name_matches"] = name_exact(det["name"], match["person_name"])
        return {"detected": det, "match": match, "score": round(best_score, 2)}

    return router
