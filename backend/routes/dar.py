"""Daily Activity Report (DAR) — member submission at check-out, member
history, admin viewer with filters + keyword search, CSV export, missed
report, policy config and a key-gated PayCraft pull."""
from __future__ import annotations

import csv
import io
import re
import uuid
from datetime import date, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from services.dar import (
    DAR_CATEGORIES, compute_missed_by_user, dar_required_for, get_dar_policy, validate_dar_text,
)
from services.time_utils import local_date_str, now_utc


class DarIn(BaseModel):
    text: str
    date: Optional[str] = None


class DarPolicyIn(BaseModel):
    enabled: Optional[bool] = None
    effective_from: Optional[str] = None
    min_chars: Optional[int] = None
    group_name: Optional[str] = None


def _month_window(month: str):
    try:
        y, m = (int(x) for x in month.split("-"))
        start = date(y, m, 1)
        end = (date(y + 1, 1, 1) if m == 12 else date(y, m + 1, 1)) - timedelta(days=1)
    except (ValueError, AttributeError):
        raise HTTPException(status_code=400, detail="month must be YYYY-MM")
    return start.isoformat(), end.isoformat()


def _pack(d: dict) -> dict:
    return {k: d.get(k) for k in (
        "id", "user_id", "user_name", "category", "rank", "date", "text",
        "submitted_at", "updated_at", "check_in_at", "check_out_at", "filed_late", "source", "site_name",
    )}


def make_router(db, get_current_user, require_admin, valid_grid_key, write_audit) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["dar"])

    async def _today() -> str:
        office = await db.config.find_one({"id": "office"}, {"_id": 0, "timezone": 1})
        return local_date_str(office)

    async def _upsert_dar(user: dict, iso: str, text: str, source: str) -> dict:
        att = await db.attendance.find_one(
            {"user_id": user["id"], "date": iso}, {"_id": 0, "id": 1, "check_in_at": 1, "check_out_at": 1},
            sort=[("check_in_at", 1)],
        )
        now = now_utc().isoformat()
        today = await _today()
        existing = await db.dars.find_one({"user_id": user["id"], "date": iso}, {"_id": 0})
        doc = {
            "user_id": user["id"],
            "user_name": user.get("full_name"),
            "category": user.get("category"),
            "rank": user.get("rank"),
            "date": iso,
            "text": text,
            "updated_at": now,
            "attendance_id": (att or {}).get("id"),
            "check_in_at": (att or {}).get("check_in_at"),
            "check_out_at": (att or {}).get("check_out_at"),
            "site_name": (att or {}).get("site_name") or (await db.config.find_one({"id": "office"}, {"_id": 0, "name": 1}) or {}).get("name"),
            "source": source,
        }
        if existing:
            await db.dars.update_one({"id": existing["id"]}, {"$set": doc})
            return {**existing, **doc}
        doc.update({"id": str(uuid.uuid4()), "submitted_at": now, "filed_late": iso < today})
        await db.dars.insert_one(dict(doc))
        return doc

    # ── Member ────────────────────────────────────────────────────────
    @router.get("/dar/status")
    async def dar_status(user: dict = Depends(get_current_user)):
        today = await _today()
        policy = await get_dar_policy(db, today)
        required = dar_required_for(user) and policy.get("enabled", True) and today >= policy["effective_from"]
        today_dar = await db.dars.find_one({"user_id": user["id"], "date": today}, {"_id": 0})
        worked = await db.attendance.find_one({"user_id": user["id"], "date": today, "check_in_at": {"$ne": None}}, {"_id": 0, "id": 1})
        return {
            "required": required,
            "done_today": today_dar is not None,
            "today": today,
            "today_dar": _pack(today_dar) if today_dar else None,
            "worked_today": worked is not None,
            "min_chars": policy["min_chars"],
            "group_name": policy["group_name"],
            "effective_from": policy["effective_from"],
        }

    @router.post("/dar")
    async def submit_dar(body: DarIn, user: dict = Depends(get_current_user)):
        today = await _today()
        policy = await get_dar_policy(db, today)
        text = validate_dar_text(body.text, policy["min_chars"])
        iso = body.date or today
        try:
            date.fromisoformat(iso)
        except ValueError:
            raise HTTPException(status_code=400, detail="date must be YYYY-MM-DD")
        if iso > today:
            raise HTTPException(status_code=400, detail="DAR date cannot be in the future")
        doc = await _upsert_dar(user, iso, text, "manual" if iso == today else "backfill")
        return _pack(doc)

    @router.get("/dar/mine")
    async def my_dars(q: str = "", from_: Optional[str] = None, to: Optional[str] = None,
                      user: dict = Depends(get_current_user)):
        query: dict = {"user_id": user["id"]}
        if from_ or to:
            query["date"] = {k: v for k, v in (("$gte", from_), ("$lte", to)) if v}
        if q.strip():
            query["text"] = {"$regex": re.escape(q.strip()), "$options": "i"}
        rows = await db.dars.find(query, {"_id": 0}).sort("date", -1).to_list(2000)
        return {"rows": [_pack(r) for r in rows]}

    # ── Admin ─────────────────────────────────────────────────────────
    async def _admin_query(from_, to, member_id, category, q) -> dict:
        query: dict = {}
        if from_ or to:
            query["date"] = {k: v for k, v in (("$gte", from_), ("$lte", to)) if v}
        if member_id:
            query["user_id"] = member_id
        if category and category in DAR_CATEGORIES:
            query["category"] = category
        if q and q.strip():
            query["text"] = {"$regex": re.escape(q.strip()), "$options": "i"}
        return query

    @router.get("/admin/dar")
    async def admin_dars(from_: Optional[str] = None, to: Optional[str] = None,
                         member_id: Optional[str] = None, category: Optional[str] = None,
                         q: str = "", limit: int = 1000, admin: dict = Depends(require_admin)):
        query = await _admin_query(from_, to, member_id, category, q)
        rows = await db.dars.find(query, {"_id": 0}).sort([("date", -1), ("user_name", 1)]).to_list(min(limit, 5000))
        return {"rows": [_pack(r) for r in rows], "count": len(rows)}

    @router.get("/admin/dar/export")
    async def admin_dars_export(from_: Optional[str] = None, to: Optional[str] = None,
                                member_id: Optional[str] = None, category: Optional[str] = None,
                                q: str = "", admin: dict = Depends(require_admin)):
        query = await _admin_query(from_, to, member_id, category, q)
        rows = await db.dars.find(query, {"_id": 0}).sort([("date", 1), ("user_name", 1)]).to_list(20000)
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["Date", "Name", "Category", "Rank", "Check-in", "Check-out", "Submitted", "Filed late", "DAR"])
        for r in rows:
            w.writerow([r.get("date"), r.get("user_name"), r.get("category"), r.get("rank") or "",
                        r.get("check_in_at") or "", r.get("check_out_at") or "", r.get("submitted_at") or "",
                        "yes" if r.get("filed_late") else "", r.get("text") or ""])
        buf.seek(0)
        fname = f"dar_{from_ or 'all'}_{to or 'all'}.csv"
        return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                                 headers={"Content-Disposition": f'attachment; filename="{fname}"'})

    @router.get("/admin/dar/missed")
    async def admin_dars_missed(month: str, admin: dict = Depends(require_admin)):
        start, end = _month_window(month)
        today = await _today()
        users = await db.users.find(
            {"status": {"$ne": "left"}, "category": {"$in": sorted(DAR_CATEGORIES)}},
            {"_id": 0, "id": 1, "full_name": 1, "category": 1, "rank": 1, "dar_exempt": 1, "status": 1},
        ).to_list(2000)
        missed = await compute_missed_by_user(db, users, start, end, today)
        by_id = {u["id"]: u for u in users}
        rows = [{
            "member_id": uid, "member_name": by_id[uid].get("full_name"),
            "category": by_id[uid].get("category"), "rank": by_id[uid].get("rank"),
            "missed_dates": dates, "missed": len(dates),
        } for uid, dates in missed.items()]
        rows.sort(key=lambda r: (-r["missed"], (r["member_name"] or "").lower()))
        exempt = [{"member_id": u["id"], "member_name": u.get("full_name")} for u in users if u.get("dar_exempt")]
        return {"month": month, "rows": rows, "exempt": exempt,
                "total_missed": sum(r["missed"] for r in rows)}

    @router.get("/config/dar-policy")
    async def get_policy(user: dict = Depends(get_current_user)):
        return await get_dar_policy(db, await _today())

    @router.put("/config/dar-policy")
    async def put_policy(body: DarPolicyIn, admin: dict = Depends(require_admin)):
        before = await get_dar_policy(db, await _today())
        upd = {}
        if body.enabled is not None:
            upd["enabled"] = body.enabled
        if body.effective_from:
            try:
                date.fromisoformat(body.effective_from)
            except ValueError:
                raise HTTPException(status_code=400, detail="effective_from must be YYYY-MM-DD")
            upd["effective_from"] = body.effective_from
        if body.min_chars is not None:
            upd["min_chars"] = max(1, min(int(body.min_chars), 2000))
        if body.group_name is not None and body.group_name.strip():
            upd["group_name"] = body.group_name.strip()[:60]
        if upd:
            await db.config.update_one({"id": "dar_policy"}, {"$set": upd}, upsert=True)
            await write_audit(db, actor=admin, action="dar_policy_update", entity_type="config",
                              entity_id="dar_policy", entity_name="DAR policy", before=before,
                              after={**before, **upd}, reason="Office Settings")
        return await get_dar_policy(db, await _today())

    # ── PayCraft pull (same gate as /api/grid) ────────────────────────
    @router.get("/dar/report")
    async def dar_report(month: str, key: str = ""):
        if not valid_grid_key(key):
            raise HTTPException(status_code=401, detail="Invalid key")
        start, end = _month_window(month)
        today = await _today()
        users = await db.users.find(
            {"status": {"$ne": "left"}, "category": {"$in": sorted(DAR_CATEGORIES)}},
            {"_id": 0, "id": 1, "full_name": 1, "category": 1, "dar_exempt": 1, "status": 1},
        ).to_list(2000)
        missed = await compute_missed_by_user(db, users, start, end, today)
        filed_counts: dict = {}
        async for d in db.dars.find({"date": {"$gte": start, "$lte": end}}, {"_id": 0, "user_id": 1}):
            filed_counts[d["user_id"]] = filed_counts.get(d["user_id"], 0) + 1
        rows = [{
            "member_id": u["id"], "member_name": u.get("full_name"), "category": u.get("category"),
            "dar_required": dar_required_for(u), "dar_exempt": bool(u.get("dar_exempt")),
            "dar_filed": filed_counts.get(u["id"], 0),
            "dar_missed": len(missed.get(u["id"], [])), "missed_dates": missed.get(u["id"], []),
        } for u in users]
        rows.sort(key=lambda r: (r["member_name"] or "").lower())
        return {"month": month, "rows": rows}

    return router
