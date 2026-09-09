"""Team To-dos + recurring Checklists (Sep 2026).

Scope: members with category in TASK_CATEGORIES (executive + coach); admins
can view everything. Everyone in the group sees everyone's to-dos and can
assign; only the owner or an admin can mark done. Checklists are personal
(daily / days-of-week / monthly) and tick-offs flow into the member's DAR
via /tasks/dar-prefill.
"""
from __future__ import annotations

import calendar
import uuid
from datetime import date, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from services.time_utils import local_date_str, now_utc

WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
RECURRENCES = {"daily", "dow", "monthly"}
TASK_CATEGORIES = {"executive", "coach"}


class TodoIn(BaseModel):
    title: str
    notes: Optional[str] = None
    owner_id: Optional[str] = None
    due_date: Optional[str] = None


class TodoPatch(BaseModel):
    title: Optional[str] = None
    notes: Optional[str] = None
    owner_id: Optional[str] = None
    due_date: Optional[str] = None
    status: Optional[str] = None


class ChecklistIn(BaseModel):
    title: str
    recurrence: str = "daily"
    days_of_week: Optional[List[str]] = None
    day_of_month: Optional[str] = None
    active: bool = True


class TickIn(BaseModel):
    date: Optional[str] = None
    done: bool = True


def _valid_date(s: Optional[str], field: str) -> Optional[str]:
    if not s:
        return None
    try:
        date.fromisoformat(s)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{field} must be YYYY-MM-DD")
    return s


def _last_working_day(d: date, weekly_off: str) -> int:
    last = calendar.monthrange(d.year, d.month)[1]
    cur = date(d.year, d.month, last)
    while WEEKDAYS[cur.weekday()] == weekly_off and cur.day > 1:
        cur -= timedelta(days=1)
    return cur.day


def checklist_applies(item: dict, iso: str, weekly_off: str = "sunday") -> bool:
    d = date.fromisoformat(iso)
    rec = item.get("recurrence")
    if rec == "daily":
        return True
    if rec == "dow":
        return WEEKDAYS[d.weekday()] in (item.get("days_of_week") or [])
    if rec == "monthly":
        dom = item.get("day_of_month")
        if dom == "last_working":
            return d.day == _last_working_day(d, weekly_off)
        try:
            n = int(dom)
        except (TypeError, ValueError):
            return False
        last = calendar.monthrange(d.year, d.month)[1]
        return d.day == min(n, last)
    return False


def make_router(db, get_current_user, require_admin, write_audit) -> APIRouter:
    router = APIRouter(prefix="/api", tags=["tasks"])

    def _is_member(u: dict) -> bool:
        return u.get("role") == "admin" or u.get("category") in TASK_CATEGORIES

    def _require(u: dict) -> None:
        if not _is_member(u):
            raise HTTPException(status_code=403, detail="Tasks are available to executives and coaches only")

    async def _office() -> dict:
        return await db.config.find_one({"id": "office"}, {"_id": 0}) or {}

    async def _group() -> list:
        return await db.users.find(
            {"status": {"$ne": "left"}, "category": {"$in": sorted(TASK_CATEGORIES)}},
            {"_id": 0, "id": 1, "full_name": 1, "rank": 1},
        ).sort("full_name", 1).to_list(500)

    def _pack_todo(t: dict) -> dict:
        return {k: t.get(k) for k in (
            "id", "title", "notes", "owner_id", "owner_name", "created_by_id", "created_by_name",
            "due_date", "status", "done_at", "done_by_name", "created_at", "updated_at")}

    def _pack_cl(c: dict) -> dict:
        return {k: c.get(k) for k in (
            "id", "owner_id", "owner_name", "title", "recurrence", "days_of_week", "day_of_month", "active", "created_at")}

    async def _today_payload(user: dict, iso: str) -> dict:
        office = await _office()
        wo = (user.get("weekly_off") or office.get("default_weekly_off") or "sunday").lower()
        items = await db.checklists.find({"owner_id": user["id"], "active": {"$ne": False}}, {"_id": 0}).to_list(500)
        applicable = [c for c in items if checklist_applies(c, iso, wo)]
        ticks = {t["checklist_id"] async for t in db.checklist_ticks.find(
            {"owner_id": user["id"], "date": iso}, {"_id": 0, "checklist_id": 1})}
        checklist = [{**_pack_cl(c), "done": c["id"] in ticks} for c in applicable]
        todos_open = await db.todos.find({"owner_id": user["id"], "status": "open"}, {"_id": 0}).sort("due_date", 1).to_list(500)
        due = [_pack_todo(t) for t in todos_open if t.get("due_date") and t["due_date"] <= iso]
        upcoming = [_pack_todo(t) for t in todos_open if not t.get("due_date") or t["due_date"] > iso]
        done_today = await db.todos.find(
            {"owner_id": user["id"], "status": "done", "done_at": {"$regex": f"^{iso}"}}, {"_id": 0}).to_list(200)
        pending = sum(1 for c in checklist if not c["done"]) + len(due)
        return {
            "date": iso, "enabled": True,
            "checklist": checklist, "todos_due": due, "todos_upcoming": upcoming[:10],
            "todos_done_today": [_pack_todo(t) for t in done_today], "pending": pending,
        }

    # ── Today / reminders ─────────────────────────────────────────────
    @router.get("/tasks/today")
    async def tasks_today(user: dict = Depends(get_current_user)):
        if not _is_member(user):
            return {"enabled": False, "pending": 0}
        return await _today_payload(user, local_date_str(await _office()))

    @router.get("/tasks/dar-prefill")
    async def dar_prefill(user: dict = Depends(get_current_user)):
        if not _is_member(user):
            return {"text": ""}
        p = await _today_payload(user, local_date_str(await _office()))
        done = [c["title"] for c in p["checklist"] if c["done"]] + [t["title"] for t in p["todos_done_today"]]
        pending = [c["title"] for c in p["checklist"] if not c["done"]] + [
            f"{t['title']} (due {t['due_date']})" for t in p["todos_due"]]
        lines = []
        if done:
            lines.append("✅ Done: " + "; ".join(done))
        if pending:
            lines.append("⏳ Not done: " + "; ".join(pending))
        return {"text": "\n".join(lines)}

    @router.get("/tasks/group")
    async def tasks_group(user: dict = Depends(get_current_user)):
        _require(user)
        return {"members": await _group()}

    # ── To-dos ────────────────────────────────────────────────────────
    @router.get("/todos")
    async def list_todos(scope: str = "all", status: str = "open", user: dict = Depends(get_current_user)):
        _require(user)
        q: dict = {}
        if scope == "mine":
            q["owner_id"] = user["id"]
        if status in ("open", "done"):
            q["status"] = status
        rows = await db.todos.find(q, {"_id": 0}).sort([("status", 1), ("due_date", 1), ("created_at", -1)]).to_list(2000)
        return {"rows": [_pack_todo(t) for t in rows], "today": local_date_str(await _office())}

    async def _owner(owner_id: Optional[str], user: dict) -> dict:
        if not owner_id or owner_id == user["id"]:
            return user
        o = await db.users.find_one({"id": owner_id}, {"_id": 0, "id": 1, "full_name": 1, "category": 1, "role": 1})
        if not o or not _is_member(o):
            raise HTTPException(status_code=400, detail="Assignee must be an executive or coach")
        return o

    @router.post("/todos")
    async def create_todo(body: TodoIn, user: dict = Depends(get_current_user)):
        _require(user)
        title = (body.title or "").strip()
        if not title:
            raise HTTPException(status_code=400, detail="title is required")
        owner = await _owner(body.owner_id, user)
        now = now_utc().isoformat()
        doc = {
            "id": str(uuid.uuid4()), "title": title, "notes": (body.notes or "").strip() or None,
            "owner_id": owner["id"], "owner_name": owner.get("full_name"),
            "created_by_id": user["id"], "created_by_name": user.get("full_name"),
            "due_date": _valid_date(body.due_date, "due_date"), "status": "open",
            "done_at": None, "done_by_name": None, "created_at": now, "updated_at": now,
        }
        await db.todos.insert_one(dict(doc))
        return _pack_todo(doc)

    @router.patch("/todos/{tid}")
    async def patch_todo(tid: str, body: TodoPatch, user: dict = Depends(get_current_user)):
        _require(user)
        t = await db.todos.find_one({"id": tid}, {"_id": 0})
        if not t:
            raise HTTPException(status_code=404, detail="To-do not found")
        upd: dict = {"updated_at": now_utc().isoformat()}
        if body.status is not None:
            if body.status not in ("open", "done"):
                raise HTTPException(status_code=400, detail="status must be open|done")
            if user["id"] != t["owner_id"] and user.get("role") != "admin":
                raise HTTPException(status_code=403, detail="Only the owner or an admin can tick this to-do")
            upd["status"] = body.status
            upd["done_at"] = now_utc().isoformat() if body.status == "done" else None
            upd["done_by_name"] = user.get("full_name") if body.status == "done" else None
        if body.title is not None:
            if not body.title.strip():
                raise HTTPException(status_code=400, detail="title cannot be empty")
            upd["title"] = body.title.strip()
        if body.notes is not None:
            upd["notes"] = body.notes.strip() or None
        if body.due_date is not None:
            upd["due_date"] = _valid_date(body.due_date, "due_date")
        if body.owner_id is not None:
            o = await _owner(body.owner_id, user)
            upd["owner_id"], upd["owner_name"] = o["id"], o.get("full_name")
        await db.todos.update_one({"id": tid}, {"$set": upd})
        return _pack_todo({**t, **upd})

    @router.delete("/todos/{tid}")
    async def delete_todo(tid: str, user: dict = Depends(get_current_user)):
        _require(user)
        t = await db.todos.find_one({"id": tid}, {"_id": 0})
        if not t:
            raise HTTPException(status_code=404, detail="To-do not found")
        if user["id"] not in (t["owner_id"], t.get("created_by_id")) and user.get("role") != "admin":
            raise HTTPException(status_code=403, detail="Only the owner, creator or an admin can delete this to-do")
        await db.todos.delete_one({"id": tid})
        return {"ok": True}

    # ── Checklists ────────────────────────────────────────────────────
    @router.get("/checklists")
    async def list_checklists(owner_id: Optional[str] = None, user: dict = Depends(get_current_user)):
        _require(user)
        oid = owner_id or user["id"]
        rows = await db.checklists.find({"owner_id": oid}, {"_id": 0}).sort("created_at", 1).to_list(500)
        return {"rows": [_pack_cl(c) for c in rows], "owner_id": oid}

    def _validate_cl(body: ChecklistIn) -> dict:
        title = (body.title or "").strip()
        if not title:
            raise HTTPException(status_code=400, detail="title is required")
        if body.recurrence not in RECURRENCES:
            raise HTTPException(status_code=400, detail="recurrence must be daily | dow | monthly")
        dows = [d for d in (body.days_of_week or []) if d in WEEKDAYS]
        if body.recurrence == "dow" and not dows:
            raise HTTPException(status_code=400, detail="Pick at least one day of the week")
        dom = body.day_of_month
        if body.recurrence == "monthly":
            if dom != "last_working":
                try:
                    if not 1 <= int(dom) <= 31:
                        raise ValueError
                    dom = str(int(dom))
                except (TypeError, ValueError):
                    raise HTTPException(status_code=400, detail="day_of_month must be 1-31 or 'last_working'")
        else:
            dom = None
        return {"title": title, "recurrence": body.recurrence, "days_of_week": dows if body.recurrence == "dow" else [],
                "day_of_month": dom, "active": bool(body.active)}

    @router.post("/checklists")
    async def create_checklist(body: ChecklistIn, user: dict = Depends(get_current_user)):
        _require(user)
        doc = {"id": str(uuid.uuid4()), "owner_id": user["id"], "owner_name": user.get("full_name"),
               "created_at": now_utc().isoformat(), **_validate_cl(body)}
        await db.checklists.insert_one(dict(doc))
        return _pack_cl(doc)

    @router.patch("/checklists/{cid}")
    async def patch_checklist(cid: str, body: ChecklistIn, user: dict = Depends(get_current_user)):
        _require(user)
        c = await db.checklists.find_one({"id": cid}, {"_id": 0})
        if not c:
            raise HTTPException(status_code=404, detail="Checklist item not found")
        if c["owner_id"] != user["id"] and user.get("role") != "admin":
            raise HTTPException(status_code=403, detail="Not your checklist")
        upd = _validate_cl(body)
        await db.checklists.update_one({"id": cid}, {"$set": upd})
        return _pack_cl({**c, **upd})

    @router.delete("/checklists/{cid}")
    async def delete_checklist(cid: str, user: dict = Depends(get_current_user)):
        _require(user)
        c = await db.checklists.find_one({"id": cid}, {"_id": 0})
        if not c:
            raise HTTPException(status_code=404, detail="Checklist item not found")
        if c["owner_id"] != user["id"] and user.get("role") != "admin":
            raise HTTPException(status_code=403, detail="Not your checklist")
        await db.checklists.delete_one({"id": cid})
        await db.checklist_ticks.delete_many({"checklist_id": cid})
        return {"ok": True}

    @router.post("/checklists/{cid}/tick")
    async def tick_checklist(cid: str, body: TickIn, user: dict = Depends(get_current_user)):
        _require(user)
        c = await db.checklists.find_one({"id": cid}, {"_id": 0})
        if not c:
            raise HTTPException(status_code=404, detail="Checklist item not found")
        if c["owner_id"] != user["id"] and user.get("role") != "admin":
            raise HTTPException(status_code=403, detail="Only the owner or an admin can tick this item")
        iso = _valid_date(body.date, "date") or local_date_str(await _office())
        if body.done:
            await db.checklist_ticks.update_one(
                {"checklist_id": cid, "date": iso},
                {"$set": {"ticked_at": now_utc().isoformat(), "owner_id": c["owner_id"]},
                 "$setOnInsert": {"id": str(uuid.uuid4())}}, upsert=True)
        else:
            await db.checklist_ticks.delete_one({"checklist_id": cid, "date": iso})
        return {"ok": True, "id": cid, "date": iso, "done": body.done}

    # ── Admin overview ────────────────────────────────────────────────
    @router.get("/admin/tasks/overview")
    async def admin_overview(admin: dict = Depends(require_admin)):
        iso = local_date_str(await _office())
        out = []
        for m in await _group():
            u = await db.users.find_one({"id": m["id"]}, {"_id": 0, "id": 1, "full_name": 1, "weekly_off": 1, "category": 1})
            p = await _today_payload(u, iso)
            out.append({"member_id": m["id"], "member_name": m.get("full_name"), "rank": m.get("rank"),
                        "checklist_total": len(p["checklist"]),
                        "checklist_done": sum(1 for c in p["checklist"] if c["done"]),
                        "todos_due": len(p["todos_due"]), "todos_open": len(p["todos_due"]) + len(p["todos_upcoming"])})
        return {"date": iso, "rows": out}

    return router
