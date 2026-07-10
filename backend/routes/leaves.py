"""
Leave & tour endpoints — split out of `server.py`. Covers individual leave
filing (POST /api/leaves), the member's own list (GET /api/leaves/mine),
the admin all-leaves view (GET /api/leaves), the group-leave admin tool
(POST /api/leaves/group), and the approve / reject mutator
(PATCH /api/leaves/{id}).

The `make_router(...)` factory receives its callable dependencies so this
module has no import-cycle with `server.py`.
"""
from __future__ import annotations

import uuid
from datetime import date as _date_cls
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from services.time_utils import now_utc, local_date_str
from holidays import _days_inclusive


# -------------------- Pydantic bodies --------------------
class LeaveCreate(BaseModel):
    type: str  # leave | tour | comp_off | late_coming | posting
    start_date: str
    end_date: str
    reason: Optional[str] = None
    location: Optional[str] = None
    expected_arrival: Optional[str] = None  # HH:MM for late_coming
    # Half-day support (30 Jun 2026): when set, `type` MUST be `leave`,
    # `start_date` MUST equal `end_date`, and the request consumes 0.5
    # of a day from the balance waterfall. "FN" = forenoon window (per
    # OfficeConfig.half_day_fn_*), "PN" = postnoon window.
    half_day: Optional[Literal["FN", "PN"]] = None


class GroupLeaveIn(BaseModel):
    type: str
    user_ids: List[str]
    start_date: str
    end_date: str
    reason: Optional[str] = None
    location: Optional[str] = None
    auto_approve: bool = False
    half_day: Optional[Literal["FN", "PN"]] = None


class LeaveDecision(BaseModel):
    status: str  # approved | rejected | pending


def make_router(db, require_admin, get_current_user, compute_comp_off_balance=None, compute_balance_summary=None, split_leave_days=None) -> APIRouter:
    router = APIRouter(prefix="/api")

    async def _comp_off_guard(target_user: dict, start_date: str, end_date: str, is_auto_approve: bool = False) -> None:
        """Hard-block comp-off applications that exceed the member's available
        balance. Admins filing on behalf with `auto_approve=true` are also
        gated — the user decision was explicit: NO silent over-draw. If an
        admin needs to grant extra paid-leave, they can adjust the opening
        leave balance instead.
        """
        if compute_comp_off_balance is None:
            return  # Helper not wired (older test harnesses) — fail open.
        try:
            requested = (
                _date_cls.fromisoformat(end_date)
                - _date_cls.fromisoformat(start_date)
            ).days + 1
        except Exception:
            requested = 1
        if requested <= 0:
            return
        bal = await compute_comp_off_balance(db, target_user)
        if requested > bal["available"]:
            short = requested - bal["available"]
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Comp-off balance is {bal['available']} day"
                    f"{'' if bal['available'] == 1 else 's'} "
                    f"(accrued {bal['accrued']} − used {bal['used']}). "
                    f"This application is for {requested} day{'' if requested == 1 else 's'}, "
                    f"short by {short}. Accrue more comp-off by attending "
                    f"on your weekly off, or shorten the request."
                ),
            )

    async def enrich_leaves(leaves: List[dict]) -> List[dict]:
        """Attach member name/category/rank for each leave row. Used by the
        admin views and the exported reports — extracted here so callers
        outside this module can re-use it via the returned helper below.

        Defensive against legacy rows that lack `user_id` (would have thrown
        KeyError before → the whole `/leaves` endpoint 500'd, which is how
        we ended up with a phantom '82 pending' sidebar badge in prod while
        the Approvals page rendered empty — see 20 Feb 2026 bug report).
        """
        user_ids = list({leave.get("user_id") for leave in leaves if leave.get("user_id")})
        users = await db.users.find({"id": {"$in": user_ids}}, {"_id": 0}).to_list(2000)
        umap = {u["id"]: u for u in users}
        for leave in leaves:
            u = umap.get(leave.get("user_id"), {}) if leave.get("user_id") else {}
            leave["member_name"] = u.get("full_name", "Unknown")
            leave["member_category"] = u.get("category")
            leave["member_rank"] = u.get("rank")
        return leaves

    # Expose for the reports router (no longer lives in server.py).
    router.enrich_leaves = enrich_leaves  # type: ignore[attr-defined]

    @router.post("/leaves")
    async def create_leave(body: LeaveCreate, target_user_id: Optional[str] = None,
                          user: dict = Depends(get_current_user)):
        """Create a leave/tour/comp-off/posting request. Admins may pass `target_user_id`
        to file on behalf of another member."""
        target_user = user
        if target_user_id and target_user_id != user["id"]:
            if user.get("role") != "admin":
                raise HTTPException(status_code=403, detail="Only admins may file on behalf of others")
            target_user = await db.users.find_one({"id": target_user_id}, {"_id": 0})
            if not target_user:
                raise HTTPException(status_code=404, detail="Target member not found")
        # Posting (R2, 30 Jun 2026): admin-only apply-on-behalf. A member
        # cannot self-apply for a Posting — the academy decides who is
        # posted, never the individual.
        if body.type == "posting":
            if user.get("role") != "admin":
                raise HTTPException(status_code=403, detail="Posting can only be filed by an admin on behalf of a member")
            if not target_user_id or target_user_id == user["id"]:
                raise HTTPException(status_code=400, detail="Posting must target another member (apply-on-behalf only)")
        # R3 (30 Jun 2026, per-category 30 Jun 2026 afternoon): N-day
        # notice rule on self-applied leaves. Tours/postings/late-comings
        # are exempt — those are by nature short-notice. Admins filing on
        # behalf bypass the gate so last-minute family emergencies can
        # still be recorded. Threshold comes from Office Settings
        # (`leave_notice_days`, now a per-category dict — falls back to
        # 3 when a category is missing). 0 = gate disabled for that
        # category.
        if body.type == "leave" and user["id"] == target_user["id"] and user.get("role") != "admin":
            office = await db.config.find_one({"id": "office"}, {"_id": 0, "leave_notice_days": 1})
            raw = (office or {}).get("leave_notice_days", 3)
            target_cat = (target_user.get("category") or "").lower()
            # Legacy single-int payload still in mongo is treated as a
            # uniform value across categories.
            if isinstance(raw, dict):
                notice_days = int(raw.get(target_cat, 3) or 0)
            else:
                try:
                    notice_days = int(raw or 0)
                except (TypeError, ValueError):
                    notice_days = 3
            if notice_days > 0:
                try:
                    today_d = _date_cls.today()
                    start_d = _date_cls.fromisoformat(body.start_date)
                    days_off = (start_d - today_d).days
                except Exception:
                    days_off = None
                if days_off is not None and days_off < notice_days:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Leave requires at least {notice_days} day"
                            f"{'' if notice_days == 1 else 's'} of advance notice. "
                            f"Please ask an admin to file this on your behalf."
                        ),
                    )
        # Comp-off: enforce balance ceiling before persisting the row.
        if body.type == "comp_off":
            # Legacy guard kept for direct API hits — the UI no longer
            # surfaces "Comp Off" as an application type (deductions are
            # automatic on `type=leave` now), but old clients/scripts may
            # still POST it. Block over-application same as before.
            await _comp_off_guard(target_user, body.start_date, body.end_date)
        # Half-day validation (30 Jun 2026): FN/PN is single-day AND
        # leave-only. Reject early with a clear message so the frontend
        # can surface it inline.
        if body.half_day:
            if body.type != "leave":
                raise HTTPException(status_code=400, detail="Half-day is only available on the Leave type")
            if body.start_date != body.end_date:
                raise HTTPException(status_code=400, detail="Half-day leave must be a single day (start_date must equal end_date)")
            if body.half_day not in ("FN", "PN"):
                raise HTTPException(status_code=400, detail="half_day must be 'FN' or 'PN'")
        office = await db.config.find_one({"id": "office"})
        today = local_date_str(office)
        late_application = bool(body.start_date and body.start_date < today)
        doc = {
            "id": str(uuid.uuid4()),
            "user_id": target_user["id"],
            "type": body.type,
            "start_date": body.start_date,
            "end_date": body.end_date,
            "reason": body.reason,
            "location": body.location,
            "expected_arrival": body.expected_arrival,
            "half_day": body.half_day,  # None | "FN" | "PN"
            "status": "pending",
            "late_application": late_application,
            "filed_by_admin": user["id"] if target_user["id"] != user["id"] else None,
            "filed_by_admin_name": user["full_name"] if target_user["id"] != user["id"] else None,
            "created_at": now_utc().isoformat(),
        }
        # ── Unified Leave: stamp the deduction ladder at apply time ─────
        # Order: comp-off first, paid leave second, anything left is LOP.
        # Only `type=leave` runs the ladder — Tour is paid in full and
        # Late Coming doesn't touch any balance. Half-day leaves consume
        # 0.5 instead of a full inclusive-day count.
        if body.type == "leave" and compute_balance_summary and split_leave_days:
            summary = await compute_balance_summary(db, target_user)
            requested = 0.5 if body.half_day else _days_inclusive(body.start_date, body.end_date)
            split = split_leave_days(
                requested,
                summary["comp_off"]["available"],
                summary["paid_leave"]["available"],
            )
            doc.update(split)
        await db.leaves.insert_one(doc)
        # Personal reason bank (7 Jul 2026): if the member supplied a
        # reason on a comp-off application, add it to their bank so it
        # re-appears as a suggestion next time they apply. Kept
        # scoped to comp-off (leave/tour/posting reasons are usually
        # one-off explanations like "family wedding" — no gain from
        # cluttering the suggestion list).
        if body.type == "comp_off" and body.reason and body.reason.strip():
            r = body.reason.strip()
            u = await db.users.find_one({"id": target_user["id"]}, {"_id": 0, "reasons": 1})
            cur = list((u or {}).get("reasons") or [])
            lowered = r.lower()
            kept = [x for x in cur if x.lower() != lowered]
            new_list = ([r] + kept)[:50]
            if new_list != cur:
                await db.users.update_one({"id": target_user["id"]}, {"$set": {"reasons": new_list}})
        doc.pop("_id", None)
        return doc

    @router.get("/leaves/event-conflicts")
    async def event_conflicts(
        start_date: str,
        end_date: str,
        user_id: Optional[str] = None,
        user: dict = Depends(get_current_user),
    ):
        """Camps the applicant is rostered into + Regattas active during the
        requested leave window. Used by the apply form and the Approvals
        detail row so admins (and applicants) can catch the "sailor wants
        leave in the middle of their own regatta" foot-gun.

        Camps are user-scoped: matched by `institution` and (when set) the
        explicit `member_ids` roster. Regattas have no per-user attribution
        in the current schema (org-wide events), so they're returned as
        informational only — the admin can eyeball who's on them.

        Args:
          user_id: when admin is querying for another member; defaults to
            the calling user. Non-admins can only query their own.
        """
        target_id = user_id or user["id"]
        if target_id != user["id"] and user.get("role") != "admin":
            from fastapi import HTTPException
            raise HTTPException(status_code=403, detail="Admins only when querying for another member")
        target = await db.users.find_one({"id": target_id}, {"_id": 0})
        if not target:
            return {"camps": [], "regattas": []}
        # Camps overlap — surfaced as INFORMATIONAL only (the admin /
        # applicant gets the heads-up without any roster gating).
        # Earlier iterations matched by institution + member_ids roster,
        # but per product call (Jun 27 2026) camps are now shown like
        # regattas — overlap means "FYI, this is happening", and the
        # admin decides whether to factor it in.
        camps_raw = await db.camps.find({
            "start_date": {"$lte": end_date},
            "end_date":   {"$gte": start_date},
        }, {"_id": 0, "id": 1, "name": 1, "institution": 1, "start_date": 1,
            "end_date": 1, "days_of_week": 1, "notes": 1}).to_list(200)
        camps_out = [{
            "id": c["id"],
            "name": c["name"],
            "institution": c.get("institution"),
            "start_date": c["start_date"],
            "end_date": c["end_date"],
            "days_of_week": c.get("days_of_week") or [],
            "notes": c.get("notes"),
        } for c in camps_raw]
        # Regattas overlap (org-wide; no roster filter)
        regattas_raw = await db.regattas.find({
            "start_date": {"$lte": end_date},
            "end_date":   {"$gte": start_date},
        }, {"_id": 0, "id": 1, "name": 1, "start_date": 1, "end_date": 1,
            "level": 1, "location": 1, "country": 1, "host_org": 1}).to_list(200)
        return {"camps": camps_out, "regattas": regattas_raw}

    @router.get("/leaves/mine")
    async def my_leaves(user: dict = Depends(get_current_user)):
        leaves = await db.leaves.find({"user_id": user["id"]}, {"_id": 0}).sort("created_at", -1).to_list(500)
        return leaves

    @router.get("/leaves/overlap")
    async def overlap_during(
        start_date: str,
        end_date: str,
        exclude_user_id: Optional[str] = None,
        leave_id: Optional[str] = None,
        user: dict = Depends(get_current_user),
    ):
        """Who else is on Leave / Tour during [start_date, end_date]?

        Visible to any logged-in user — the apply-leave form shows it on
        date pick, and the Approvals table shows it next to a pending row.
        Returns ONLY a safe summary (name, category, type, dates, status)
        — no reasons, no internal IDs beyond what the UI needs.

        Filters in MongoDB on the date range using the inverse-overlap
        formula `start_date <= range.end AND end_date >= range.start`.
        Includes `pending` and `approved` rows; rejected rows are excluded
        because they no longer represent real absences.

        Args:
          exclude_user_id: when set, drops rows for that user from the
            result. Used during the apply form so the applicant doesn't
            see their own pending row as a "conflict".
          leave_id: when set, drops the row with that exact id — useful
            so the Approvals view doesn't list the very row being decided.
        """
        # MongoDB overlap query: A overlaps B iff A.start <= B.end and A.end >= B.start.
        q: dict = {
            "start_date": {"$lte": end_date},
            "end_date": {"$gte": start_date},
            "status": {"$in": ["pending", "approved"]},
            # Comp-off rows are deprecated as an application type, but we
            # still surface legacy ones so admins reviewing historic data
            # see the full picture. `late_coming` is intentionally excluded
            # — it's a same-day notice, not a multi-day absence. Postings
            # are included so the apply form / Approvals view warn admins
            # when scheduling on top of an existing posting window.
            "type": {"$in": ["leave", "tour", "comp_off", "posting"]},
        }
        if exclude_user_id:
            q["user_id"] = {"$ne": exclude_user_id}
        if leave_id:
            q["id"] = {"$ne": leave_id}
        rows = await db.leaves.find(
            q,
            {"_id": 0, "id": 1, "user_id": 1, "type": 1, "status": 1,
             "start_date": 1, "end_date": 1, "location": 1},
        ).sort("start_date", 1).to_list(500)
        if not rows:
            return []
        user_ids = list({r["user_id"] for r in rows})
        users = await db.users.find(
            {"id": {"$in": user_ids}},
            {"_id": 0, "id": 1, "full_name": 1, "category": 1, "rank": 1,
             "institution": 1, "fleet": 1},
        ).to_list(len(user_ids))
        ulookup = {u["id"]: u for u in users}
        out = []
        for r in rows:
            u = ulookup.get(r["user_id"], {})
            out.append({
                "id": r["id"],
                "user_id": r["user_id"],
                "full_name": u.get("full_name") or "(deleted)",
                "category": u.get("category"),
                "rank": u.get("rank"),
                "institution": u.get("institution"),
                "fleet": u.get("fleet"),
                "type": r["type"],
                "status": r["status"],
                "start_date": r["start_date"],
                "end_date": r["end_date"],
                "location": r.get("location"),
            })
        return out

    @router.get("/leaves")
    async def all_leaves(status_filter: Optional[str] = None, admin: dict = Depends(require_admin)):
        q = {}
        if status_filter == "late":
            q["late_application"] = True
        elif status_filter:
            q["status"] = status_filter
        leaves = await db.leaves.find(q, {"_id": 0}).sort("created_at", -1).to_list(1000)
        return await enrich_leaves(leaves)

    @router.patch("/leaves/{leave_id}")
    async def decide_leave(leave_id: str, body: LeaveDecision, admin: dict = Depends(require_admin)):
        # Stamp the decision audit fields so the admin Approvals table can
        # show "approved by Jane Doe on 25 Jun" alongside the status pill.
        update = {"status": body.status}
        if body.status in ("approved", "rejected"):
            update["decided_by"] = admin["full_name"]
            update["decided_by_id"] = admin["id"]
            update["decided_at"] = now_utc().isoformat()
        else:
            # Re-opening a request back to pending wipes the prior decision
            # stamp so the audit trail doesn't lie about a stale approver.
            update["decided_by"] = None
            update["decided_by_id"] = None
            update["decided_at"] = None
        await db.leaves.update_one({"id": leave_id}, {"$set": update})
        leave = await db.leaves.find_one({"id": leave_id}, {"_id": 0})
        if not leave:
            raise HTTPException(status_code=404, detail="Leave not found")
        return leave

    @router.post("/leaves/group")
    async def group_leave(body: GroupLeaveIn, admin: dict = Depends(require_admin)):
        if not body.user_ids:
            raise HTTPException(status_code=400, detail="Pick at least one member")
        # Half-day validation (30 Jun 2026): same rules as the single-apply
        # path — leave-only, single-day, FN or PN.
        if body.half_day:
            if body.type != "leave":
                raise HTTPException(status_code=400, detail="Half-day is only available on the Leave type")
            if body.start_date != body.end_date:
                raise HTTPException(status_code=400, detail="Half-day leave must be a single day (start_date must equal end_date)")
            if body.half_day not in ("FN", "PN"):
                raise HTTPException(status_code=400, detail="half_day must be 'FN' or 'PN'")
        # Comp-off: validate every member's balance up-front, so we never
        # half-insert (partial success would be hard for an admin to reconcile).
        if body.type == "comp_off":
            short_list = []
            for uid in body.user_ids:
                u = await db.users.find_one({"id": uid}, {"_id": 0})
                if not u:
                    continue
                try:
                    await _comp_off_guard(u, body.start_date, body.end_date)
                except HTTPException as exc:
                    short_list.append(f"{u.get('full_name', uid)}: {exc.detail}")
            if short_list:
                raise HTTPException(status_code=400, detail=" • ".join(short_list))
        office = await db.config.find_one({"id": "office"})
        today = local_date_str(office)
        late_application = bool(body.start_date and body.start_date < today)
        docs = []
        for uid in body.user_ids:
            d = {
                "id": str(uuid.uuid4()),
                "user_id": uid,
                "type": body.type,
                "start_date": body.start_date,
                "end_date": body.end_date,
                "reason": body.reason,
                "location": body.location,
                "half_day": body.half_day,
                "status": "approved" if body.auto_approve else "pending",
                "late_application": late_application,
                "filed_by_admin": admin["id"],
                "filed_by_admin_name": admin["full_name"],
                "group_leave": True,
                "created_at": now_utc().isoformat(),
            }
            # Stamp the deduction ladder for the leave type too (mirror
            # the single-apply path so balances stay in sync). Half-day
            # rows draw 0.5.
            if body.type == "leave" and compute_balance_summary and split_leave_days:
                u = await db.users.find_one({"id": uid}, {"_id": 0})
                if u:
                    summary = await compute_balance_summary(db, u)
                    requested = 0.5 if body.half_day else _days_inclusive(body.start_date, body.end_date)
                    split = split_leave_days(
                        requested,
                        summary["comp_off"]["available"],
                        summary["paid_leave"]["available"],
                    )
                    d.update(split)
            if body.auto_approve:
                d["decided_by"] = admin["full_name"]
                d["decided_at"] = now_utc().isoformat()
            docs.append(d)
        if docs:
            await db.leaves.insert_many(docs)
        return {"ok": True, "created": len(docs), "status": "approved" if body.auto_approve else "pending"}

    return router
