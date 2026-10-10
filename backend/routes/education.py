"""Education: marksheets for active athletes & coaches, shown as a tree (Oct 2026).
Admin-only. Records live in `marksheets`; scans in Emergent Object Storage.
POST /education/read reads a scan with AI to pre-fill the form (nothing saved)."""
from __future__ import annotations

import asyncio
import re
import uuid
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from routes.admin_audit import write_audit
from services.id_ocr import name_exact, read_marksheet
from services.object_storage import APP_PREFIX, get_object, put_object
from services.permissions import is_ex_member
from services.scope import athlete_like_keys
from services.time_utils import now_utc

MAX_BYTES = 10 * 1024 * 1024
ALLOWED_TYPES = {"application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
COACH_KEYS = {"coach"}
TEXT_FIELDS = {"exam_name": 120, "board": 120, "result": 40, "notes": 1000}


def _safe_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._ -]", "_", name)[:120] or "marksheet"


def _fields(exam_name, month, year, board, result, notes) -> dict:
    vals = {"exam_name": exam_name, "board": board, "result": result, "notes": notes}
    out = {k: " ".join((v or "").split())[:TEXT_FIELDS[k]] if k != "notes" else (v or "").strip()[:1000]
           for k, v in vals.items()}
    if not out["exam_name"]:
        raise HTTPException(status_code=400, detail="Exam name is required")
    if not (isinstance(month, int) and 1 <= month <= 12):
        raise HTTPException(status_code=400, detail="Pick the exam month")
    if not (isinstance(year, int) and 1980 <= year <= date.today().year + 1):
        raise HTTPException(status_code=400, detail="Exam year looks wrong")
    return {**out, "month": month, "year": year}


async def _read_file(file: UploadFile) -> tuple:
    ctype = (file.content_type or "").lower()
    if ctype not in ALLOWED_TYPES:
        raise HTTPException(status_code=400, detail="Upload a PDF, JPG, PNG or WEBP file")
    data = await file.read(MAX_BYTES + 1)
    if not data or len(data) > MAX_BYTES:
        raise HTTPException(status_code=400, detail="File must be between 1 byte and 10 MB")
    return data, ctype


def make_router(db, require_admin) -> APIRouter:
    router = APIRouter(prefix="/api")

    async def _member(mid: str) -> dict:
        m = await db.users.find_one({"id": mid}, {"_id": 0, "id": 1, "full_name": 1, "category": 1})
        if not m:
            raise HTTPException(status_code=404, detail="Member not found")
        return m

    async def _sheet(sid: str) -> dict:
        s = await db.marksheets.find_one({"id": sid}, {"_id": 0})
        if not s:
            raise HTTPException(status_code=404, detail="Marksheet not found")
        return s

    def _public(s: dict, member_name: Optional[str]) -> dict:
        f = s.get("file") or {}
        return {k: s.get(k) for k in ("id", "user_id", "exam_name", "month", "year", "board", "result", "notes",
                                      "sheet_name", "created_at", "updated_at")} | {
            "file_name": f.get("name"), "has_file": bool(f),
            "name_matches": name_exact(s.get("sheet_name"), member_name) if s.get("sheet_name") else None}

    async def _store(mid: str, sid: str, data: bytes, ctype: str, filename: str, admin: dict) -> dict:
        path = f"{APP_PREFIX}/education/{mid}/{sid}_{uuid.uuid4().hex}.{ALLOWED_TYPES[ctype]}"
        await asyncio.to_thread(put_object, path, data, ctype)
        return {"path": path, "name": _safe_name(filename or path.rsplit("/", 1)[-1]), "content_type": ctype,
                "size": len(data), "uploaded_at": now_utc().isoformat(),
                "uploaded_by": admin.get("full_name") or admin.get("email")}

    @router.get("/education/tree")
    async def tree(admin: dict = Depends(require_admin)):
        athlete_keys = set(await athlete_like_keys(db))
        users = await db.users.find(
            {"archived": {"$ne": True}, "active": {"$ne": False}, "category": {"$in": list(athlete_keys | COACH_KEYS)}},
            {"_id": 0, "id": 1, "full_name": 1, "category": 1, "custom_category": 1, "leaving_date": 1}).to_list(5000)
        users = [u for u in users if not is_ex_member(u)]
        by_user: dict = {}
        async for s in db.marksheets.find({"user_id": {"$in": [u["id"] for u in users]}}, {"_id": 0}):
            by_user.setdefault(s["user_id"], []).append(s)
        groups = {"athletes": [], "coaches": []}
        for u in sorted(users, key=lambda x: (x.get("full_name") or "").lower()):
            sheets = sorted(by_user.get(u["id"], []), key=lambda s: (s["year"], s["month"]), reverse=True)
            groups["coaches" if u["category"] in COACH_KEYS else "athletes"].append({
                "id": u["id"], "full_name": u.get("full_name"), "category": u.get("custom_category") or u["category"],
                "marksheets": [_public(s, u.get("full_name")) for s in sheets]})
        return groups

    @router.post("/education/read")
    async def read(file: UploadFile = File(...), member_id: str = Form(...), admin: dict = Depends(require_admin)):
        m = await _member(member_id)
        data, ctype = await _read_file(file)
        det = await read_marksheet(data, ctype)
        if det:
            det.update(expected_name=m.get("full_name"), name_matches=name_exact(det["name"], m.get("full_name")))
        return {"detected": det}

    @router.post("/education/members/{mid}/marksheets")
    async def create(mid: str, exam_name: str = Form(...), month: int = Form(...), year: int = Form(...),
                     board: str = Form(""), result: str = Form(""), notes: str = Form(""), sheet_name: str = Form(""),
                     file: Optional[UploadFile] = File(None), admin: dict = Depends(require_admin)):
        m = await _member(mid)
        doc = {"id": str(uuid.uuid4()), "user_id": mid, **_fields(exam_name, month, year, board, result, notes),
               "sheet_name": " ".join(sheet_name.split())[:120], "created_at": now_utc().isoformat(),
               "created_by": admin.get("full_name") or admin.get("email")}
        if file is not None and file.filename:
            data, ctype = await _read_file(file)
            doc["file"] = await _store(mid, doc["id"], data, ctype, file.filename, admin)
        await db.marksheets.insert_one(dict(doc))
        await write_audit(db, actor=admin, action="marksheet_added", entity_type="member", entity_id=mid,
                          entity_name=m.get("full_name"), after={k: doc[k] for k in ("exam_name", "month", "year")})
        return _public(doc, m.get("full_name"))

    @router.patch("/education/marksheets/{sid}")
    async def update(sid: str, exam_name: str = Form(...), month: int = Form(...), year: int = Form(...),
                     board: str = Form(""), result: str = Form(""), notes: str = Form(""),
                     sheet_name: Optional[str] = Form(None), file: Optional[UploadFile] = File(None),
                     admin: dict = Depends(require_admin)):
        s = await _sheet(sid)
        m = await _member(s["user_id"])
        sets = {**_fields(exam_name, month, year, board, result, notes), "updated_at": now_utc().isoformat()}
        if sheet_name is not None:
            sets["sheet_name"] = " ".join(sheet_name.split())[:120]
        if file is not None and file.filename:
            data, ctype = await _read_file(file)
            sets["file"] = await _store(s["user_id"], sid, data, ctype, file.filename, admin)
        await db.marksheets.update_one({"id": sid}, {"$set": sets})
        await write_audit(db, actor=admin, action="marksheet_edited", entity_type="member", entity_id=s["user_id"],
                          entity_name=m.get("full_name"),
                          before={k: s.get(k) for k in ("exam_name", "month", "year", "board", "result")},
                          after={k: sets[k] for k in ("exam_name", "month", "year", "board", "result")})
        return _public({**s, **sets}, m.get("full_name"))

    @router.delete("/education/marksheets/{sid}")
    async def remove(sid: str, admin: dict = Depends(require_admin)):
        s = await _sheet(sid)
        m = await _member(s["user_id"])
        await db.marksheets.delete_one({"id": sid})
        await write_audit(db, actor=admin, action="marksheet_deleted", entity_type="member", entity_id=s["user_id"],
                          entity_name=m.get("full_name"), before={k: s.get(k) for k in ("exam_name", "month", "year")})
        return {"ok": True}

    @router.get("/education/marksheets/{sid}/file")
    async def download(sid: str, admin: dict = Depends(require_admin)):
        meta = (await _sheet(sid)).get("file")
        if not meta:
            raise HTTPException(status_code=404, detail="No scan uploaded")
        data, _ = await asyncio.to_thread(get_object, meta["path"])
        return Response(content=data, media_type=meta["content_type"],
                        headers={"Content-Disposition": f'inline; filename="{_safe_name(meta["name"])}"',
                                 "Cache-Control": "no-store"})

    return router
