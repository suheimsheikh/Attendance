"""Detailed daily register; day codes and totals come from the payroll grid."""
import asyncio
import re

from fastapi import HTTPException

from profile_models import ProfileAttendanceMonth, ProfileLeave, ProfileSession
from services.dar import dar_day_applies, dar_required_for, get_dar_policy
from services.time_utils import local_date_str, local_hm, office_tz


def _session_detail(doc: dict, office: dict, work_end: str) -> ProfileSession:
    # Match the Grid's legacy early-out calculation. Never turn an automatic
    # missing check-out closure into worked hours or a genuine out timestamp.
    early = doc.get("early_out_minutes")
    if early is None and doc.get("check_out_at"):
        try:
            end_h, end_m = map(int, work_end.split(":")[:2])
            out_h, out_m = map(int, local_hm(office, doc["check_out_at"]).split(":"))
            early = max(0, end_h * 60 + end_m - out_h * 60 - out_m)
        except (ValueError, TypeError, AttributeError):
            early = 0
    safe = {key: doc.get(key) for key in ProfileSession.model_fields if doc.get(key) is not None}
    safe["early_out_minutes"] = int(early or 0) if int(early or 0) >= 15 else 0
    if doc.get("missing_checkout"):
        safe["hours"] = None
    return ProfileSession(**safe)


def _dar_status(day: str, today: str, sessions: list, filed: set,
                required: bool, policy: dict) -> str:
    if day in filed:
        return "filed"
    if not required or not any(s.check_in_at for s in sessions):
        return "not_applicable"
    if dar_day_applies(policy, day, today):
        return "missing"
    if day == today and policy.get("enabled", True) and day >= policy["effective_from"]:
        return "pending"
    return "not_applicable"


async def attendance_month(db, grid_impl, user: dict, month: str | None) -> ProfileAttendanceMonth:
    office = await db.config.find_one({"id": "office"}, {"_id": 0}) or {}
    month = month or local_date_str(office)[:7]
    if not re.fullmatch(r"[0-9]{4}-(0[1-9]|1[0-2])", month) or not 1 <= int(month[:4]) <= 9998:
        raise HTTPException(400, "month must be YYYY-MM")
    # Scope at the database query, not by filtering other members' data later.
    grid = await grid_impl(month, with_meta=True, member_id=user["id"])
    if not grid["rows"]:
        raise HTTPException(404, "Member not found")
    row = grid["rows"][0]
    window = {"$gte": grid["start"], "$lte": grid["end"]}
    query = {"user_id": user["id"], "date": window}
    session_projection = {"_id": 0, "date": 1, **{key: 1 for key in ProfileSession.model_fields}}
    leave_query = {"user_id": user["id"], "start_date": {"$lte": grid["end"]},
                   "end_date": {"$gte": grid["start"]}, "$or": [
                       {"status": {"$in": ["approved", "pending"]}},
                       {"status": "cancelled", "converted_to_lop": True}]}
    sessions, leaves, dars, overrides, policy = await asyncio.gather(
        db.attendance.find(query, session_projection).sort("check_in_at", 1).to_list(None),
        db.leaves.find(leave_query, {"_id": 0, **{key: 1 for key in ProfileLeave.model_fields}}).to_list(None),
        db.dars.find(query, {"_id": 0, "date": 1}).to_list(None),
        db.grid_overrides.find(query, {"_id": 0, "date": 1, "code": 1}).to_list(None),
        get_dar_policy(db, grid["today"]),
    )
    by_date = {}
    for doc in sessions:
        by_date.setdefault(doc["date"], []).append(_session_detail(doc, office, row["work_end"]))
    safe_leaves = [ProfileLeave(**doc) for doc in leaves]
    filed = {d["date"] for d in dars}
    overridden = {d["date"] for d in overrides if d.get("code")}
    days = []
    for iso, code in zip(grid["days"], row["cells"]):
        day_sessions = by_date.get(iso, [])
        days.append({
            "date": iso, "code": code, "is_future": iso > grid["today"],
            "is_today": iso == grid["today"], "sessions": day_sessions,
            "leaves": [leave for leave in safe_leaves if leave.start_date <= iso <= leave.end_date],
            "meta": row["cell_meta"].get(iso, {}), "manual_override": iso in overridden,
            "dar_status": _dar_status(iso, grid["today"], day_sessions, filed, dar_required_for(user), policy),
        })
    return ProfileAttendanceMonth(
        member_id=user["id"], member_name=row["member_name"], month=month,
        today=grid["today"], timezone=str(office_tz(office)),
        work_start=row["work_start"], work_end=row["work_end"], totals=row["totals"], days=days,
    )