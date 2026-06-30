"""
Escort management + escort attendance endpoints.

Escorts are people who accompany athletes (typically parents / guardians /
hired chaperones) to camps, regattas, or daily training. They are NOT
employees — we don't pay or roster them — but we DO need to know whether
they showed up, where they went mid-day, and which athletes they were
responsible for. This module owns the entity, the attendance flows, and
the 30-day photo-retention bookkeeping.

Collections (Mongo, all string ids, dates as ISO `YYYY-MM-DD` and
timestamps as ISO 8601):
  • escorts             — { id, name, phone, institution, start_date,
                            photo?, status: active|replaced|left,
                            replaced_by?, ended_at?, created_at }
  • escort_attendance   — { id, escort_id, institution, date,
                            check_in_at, check_in_selfie?,
                            check_in_athlete_ids: [],
                            check_out_at?, check_out_selfie?,
                            check_out_athlete_ids: [],
                            excursions: [{out_at, expected_return,
                                          return_at?, reason}],
                            created_at }

Photo retention: every selfie field gets purged on day 30. Until then
the row gets a `purge_ready: true` flag in API responses so the admin
photo-curation page can list candidates.
"""
from __future__ import annotations

import base64
import uuid
from datetime import date, timedelta
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from services.time_utils import now_utc, local_date_str

# How long an escort selfie stays around before it's flagged ready for
# admin curation. The image is NOT auto-deleted at this point — we only
# light up the "PURGE READY" badge so an admin can prune what they no
# longer need. (Aligns with the user's "6c" decision on Jun 27 2026.)
PHOTO_RETENTION_DAYS = 30
MAX_SELFIE_BYTES = 600_000  # ~450 KB jpeg base64; bigger gets rejected up-front


# -------------------- Pydantic bodies --------------------
class EscortCreate(BaseModel):
    name: str
    phone: Optional[str] = None
    # `institution` is taken from the URL path — admins create escorts
    # under a specific institution via POST /institutions/{inst_id}/escorts.
    # Field accepted in the body purely for forward-compat with callers
    # that want to be explicit; the path always wins.
    institution: Optional[str] = None
    start_date: str                   # YYYY-MM-DD; admin-entered


class EscortUpdate(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None
    institution: Optional[str] = None
    start_date: Optional[str] = None
    status: Optional[str] = None      # active | replaced | left
    replaced_by: Optional[str] = None # escort id of the substitution
    ended_at: Optional[str] = None


class EscortCheckInIn(BaseModel):
    escort_id: Optional[str] = None   # required when caller is a proxy (coach/admin)
    selfie: Optional[str] = None      # base64 dataURL
    athlete_ids: List[str] = []


class EscortCheckOutIn(BaseModel):
    escort_id: Optional[str] = None
    selfie: Optional[str] = None
    athlete_ids: List[str] = []


class EscortTempExitIn(BaseModel):
    escort_id: Optional[str] = None
    reason: str
    expected_return: Optional[str] = None  # HH:MM


class EscortReturnIn(BaseModel):
    escort_id: Optional[str] = None


def _enforce_selfie_size(b64: Optional[str]) -> None:
    """The selfie field accepts a data URL. We bound the raw byte size
    server-side to keep the Mongo doc and the response payload small —
    the frontend's `fileToResizedDataUrl` helper already targets ~120 KB,
    so this is a sanity ceiling, not the normal path."""
    if not b64:
        return
    # Trim the `data:image/jpeg;base64,` prefix if present before sizing.
    payload = b64.split(",", 1)[-1] if "," in b64 else b64
    try:
        raw = base64.b64decode(payload, validate=False)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not decode photo: {exc}")
    if len(raw) > MAX_SELFIE_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"Photo too large ({len(raw) // 1024} KB). Please retake — the camera should auto-compress to under {MAX_SELFIE_BYTES // 1024} KB."
        )


def _purge_ready(att: dict, today_iso: str) -> bool:
    """True iff the attendance row carries any selfie older than the
    retention window. Used to flag candidates in the admin purge UI."""
    if not (att.get("check_in_selfie") or att.get("check_out_selfie")):
        return False
    try:
        d = date.fromisoformat(att["date"])
        today_d = date.fromisoformat(today_iso)
    except Exception:
        return False
    return (today_d - d).days >= PHOTO_RETENTION_DAYS


def _strip_selfies(att: dict) -> dict:
    """Drop the heavy base64 fields when we're returning a list of rows.
    Detail endpoints (single row) keep them so the admin curation UI
    can still preview before deleting."""
    out = {k: v for k, v in att.items() if k not in ("check_in_selfie", "check_out_selfie")}
    out["has_check_in_selfie"] = bool(att.get("check_in_selfie"))
    out["has_check_out_selfie"] = bool(att.get("check_out_selfie"))
    return out


def make_router(db, require_admin, get_current_user, require_coach_or_admin) -> APIRouter:
    router = APIRouter(prefix="/api")

    # ════════════════════════════════════════════════════════════════
    # ADMIN — escort CRUD under an institution
    # ════════════════════════════════════════════════════════════════
    @router.get("/institutions/{inst_id}/escorts")
    async def list_escorts_for_institution(inst_id: str, admin: dict = Depends(require_admin)):
        inst = await db.institutions.find_one({"id": inst_id}, {"_id": 0})
        if not inst:
            raise HTTPException(status_code=404, detail="Institution not found")
        rows = await db.escorts.find(
            {"institution": inst["name"]}, {"_id": 0}
        ).sort([("status", 1), ("name", 1)]).to_list(500)
        return rows

    @router.post("/institutions/{inst_id}/escorts")
    async def add_escort(inst_id: str, body: EscortCreate, admin: dict = Depends(require_admin)):
        inst = await db.institutions.find_one({"id": inst_id}, {"_id": 0})
        if not inst:
            raise HTTPException(status_code=404, detail="Institution not found")
        if not body.name.strip():
            raise HTTPException(status_code=400, detail="Escort name required")
        # Force the FK by institution NAME so it matches the members
        # collection's existing convention.
        doc = {
            "id": str(uuid.uuid4()),
            "name": body.name.strip(),
            "phone": (body.phone or "").strip() or None,
            # Last-10-digit normalisation for the indexed phone-login
            # lookup. Mirrors the convention used by the members table.
            "mobile_last10": (("".join(c for c in (body.phone or "") if c.isdigit())[-10:]) or None) if body.phone else None,
            "institution": inst["name"],
            "start_date": body.start_date,
            "status": "active",
            "replaced_by": None,
            "ended_at": None,
            "created_at": now_utc().isoformat(),
        }
        await db.escorts.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @router.patch("/escorts/{escort_id}")
    async def update_escort(escort_id: str, body: EscortUpdate, admin: dict = Depends(require_admin)):
        escort = await db.escorts.find_one({"id": escort_id}, {"_id": 0})
        if not escort:
            raise HTTPException(status_code=404, detail="Escort not found")
        update: dict = {}
        for k in ("name", "phone", "institution", "start_date", "status",
                  "replaced_by", "ended_at"):
            v = getattr(body, k, None)
            if v is not None:
                update[k] = v.strip() if isinstance(v, str) else v
        # Re-stamp the normalised phone key whenever the phone changes.
        if "phone" in update:
            digits = "".join(c for c in (update["phone"] or "") if c.isdigit())[-10:]
            update["mobile_last10"] = digits or None
        # If status transitions to a terminal value, stamp ended_at if
        # the admin didn't supply it explicitly.
        if update.get("status") in ("replaced", "left") and not update.get("ended_at"):
            update["ended_at"] = local_date_str(await db.config.find_one({"id": "office"}))
        await db.escorts.update_one({"id": escort_id}, {"$set": update})
        doc = await db.escorts.find_one({"id": escort_id}, {"_id": 0})
        return doc

    @router.delete("/escorts/{escort_id}")
    async def delete_escort(escort_id: str, admin: dict = Depends(require_admin)):
        """Hard-delete an escort and any attendance trail. The data is
        not referenced by payroll / reports (escorts are NOT employees),
        so a hard purge here keeps the audit surface honest — once an
        escort is removed there's nothing left to ghost through reports.

        For "they're leaving, but keep the trail", admins use the
        status transition (active → left) via PATCH instead.
        """
        await db.escort_attendance.delete_many({"escort_id": escort_id})
        await db.escorts.delete_one({"id": escort_id})
        return {"ok": True}

    # ════════════════════════════════════════════════════════════════
    # ACTIVE LIST — used by the kiosk picker on /escort-checkin
    # Visible to anyone logged in (Member menu).
    # ════════════════════════════════════════════════════════════════
    @router.get("/escorts/active")
    async def list_active_escorts(user: dict = Depends(get_current_user)):
        """All `status="active"` escorts. The kiosk picker uses this; the
        list is small (few dozen per academy) so we return the whole set
        in one go."""
        rows = await db.escorts.find(
            {"status": "active"}, {"_id": 0}
        ).sort([("institution", 1), ("name", 1)]).to_list(500)
        return rows

    # ════════════════════════════════════════════════════════════════
    # ATTENDANCE — check-in / check-out / temp-exit / return
    # ════════════════════════════════════════════════════════════════
    async def _resolve_escort(body_escort_id: Optional[str], user: dict) -> dict:
        """Pick the escort target. Three legal callers:

          1. The escort themselves (phone-login bound to an escort id),
             in which case we ignore `body_escort_id` and use the
             session escort.
          2. A coach / admin filing on behalf — must pass `body_escort_id`.
          3. Anyone else with a logged-in user account who supplies a
             body_escort_id IS treated as a proxy — the use-case is
             athletes/staff at the venue helping mark in a parent who
             doesn't have the app. Tracked via `proxied_by`.
        """
        # Path 1: caller IS an escort (phone-login resolved to escorts).
        if user.get("is_escort") and user.get("escort_id"):
            esc = await db.escorts.find_one({"id": user["escort_id"]}, {"_id": 0})
            if not esc:
                raise HTTPException(status_code=404, detail="Your escort record was removed; ask admin")
            return esc
        # Path 2/3: proxy → escort_id mandatory.
        if not body_escort_id:
            raise HTTPException(status_code=400, detail="Pick an escort to check in")
        esc = await db.escorts.find_one({"id": body_escort_id}, {"_id": 0})
        if not esc:
            raise HTTPException(status_code=404, detail="Escort not found")
        if esc.get("status") != "active":
            raise HTTPException(status_code=400, detail=f"Escort is {esc.get('status')}, can't check in")
        return esc

    @router.post("/escort-attendance/checkin")
    async def escort_checkin(body: EscortCheckInIn, user: dict = Depends(get_current_user)):
        escort = await _resolve_escort(body.escort_id, user)
        _enforce_selfie_size(body.selfie)
        office = await db.config.find_one({"id": "office"})
        today = local_date_str(office)
        # Idempotent on (escort_id, date) — if today's row exists, refresh
        # the in-photo + athlete list, don't double-create.
        existing = await db.escort_attendance.find_one(
            {"escort_id": escort["id"], "date": today}, {"_id": 0}
        )
        proxied_by = None if (user.get("is_escort") and user.get("escort_id") == escort["id"]) else {
            "id": user.get("id"), "name": user.get("full_name") or user.get("email")
        }
        if existing:
            await db.escort_attendance.update_one(
                {"id": existing["id"]},
                {"$set": {
                    "check_in_selfie": body.selfie or existing.get("check_in_selfie"),
                    "check_in_athlete_ids": list({*existing.get("check_in_athlete_ids", []), *body.athlete_ids}),
                }},
            )
            doc = await db.escort_attendance.find_one({"id": existing["id"]}, {"_id": 0})
            return doc
        doc = {
            "id": str(uuid.uuid4()),
            "escort_id": escort["id"],
            "escort_name": escort["name"],
            "institution": escort["institution"],
            "date": today,
            "check_in_at": now_utc().isoformat(),
            "check_in_selfie": body.selfie,
            "check_in_athlete_ids": list(body.athlete_ids or []),
            "check_in_proxied_by": proxied_by,
            "check_out_at": None,
            "check_out_selfie": None,
            "check_out_athlete_ids": [],
            "check_out_proxied_by": None,
            "excursions": [],
            "created_at": now_utc().isoformat(),
        }
        await db.escort_attendance.insert_one(doc)
        doc.pop("_id", None)
        return doc

    @router.post("/escort-attendance/checkout")
    async def escort_checkout(body: EscortCheckOutIn, user: dict = Depends(get_current_user)):
        escort = await _resolve_escort(body.escort_id, user)
        _enforce_selfie_size(body.selfie)
        office = await db.config.find_one({"id": "office"})
        today = local_date_str(office)
        existing = await db.escort_attendance.find_one(
            {"escort_id": escort["id"], "date": today}, {"_id": 0}
        )
        if not existing:
            raise HTTPException(status_code=400, detail="Check in first before checking out")
        proxied_by = None if (user.get("is_escort") and user.get("escort_id") == escort["id"]) else {
            "id": user.get("id"), "name": user.get("full_name") or user.get("email")
        }
        await db.escort_attendance.update_one(
            {"id": existing["id"]},
            {"$set": {
                "check_out_at": now_utc().isoformat(),
                "check_out_selfie": body.selfie,
                "check_out_athlete_ids": list(body.athlete_ids or []),
                "check_out_proxied_by": proxied_by,
            }},
        )
        return await db.escort_attendance.find_one({"id": existing["id"]}, {"_id": 0})

    @router.post("/escort-attendance/temp-exit")
    async def escort_temp_exit(body: EscortTempExitIn, user: dict = Depends(get_current_user)):
        escort = await _resolve_escort(body.escort_id, user)
        office = await db.config.find_one({"id": "office"})
        today = local_date_str(office)
        existing = await db.escort_attendance.find_one(
            {"escort_id": escort["id"], "date": today}, {"_id": 0}
        )
        if not existing or not existing.get("check_in_at") or existing.get("check_out_at"):
            raise HTTPException(status_code=400, detail="Escort isn't currently on campus")
        # Reject if there's an open excursion (no return_at) — they need
        # to "Return" the last one before stepping out again.
        last_open = next((e for e in (existing.get("excursions") or [])
                          if not e.get("return_at")), None)
        if last_open:
            raise HTTPException(status_code=400, detail="Already on a step-out — return first")
        ex = {
            "out_at": now_utc().isoformat(),
            "expected_return": body.expected_return,
            "return_at": None,
            "reason": body.reason.strip() or "Step out",
        }
        await db.escort_attendance.update_one(
            {"id": existing["id"]},
            {"$push": {"excursions": ex}},
        )
        return await db.escort_attendance.find_one({"id": existing["id"]}, {"_id": 0})

    @router.post("/escort-attendance/return")
    async def escort_return(body: EscortReturnIn, user: dict = Depends(get_current_user)):
        escort = await _resolve_escort(body.escort_id, user)
        office = await db.config.find_one({"id": "office"})
        today = local_date_str(office)
        existing = await db.escort_attendance.find_one(
            {"escort_id": escort["id"], "date": today}, {"_id": 0}
        )
        if not existing:
            raise HTTPException(status_code=400, detail="No attendance row for today")
        exs = list(existing.get("excursions") or [])
        # Close the last open excursion (index-wise) — mirrors the member
        # SelfCheckIn temp-exit behaviour.
        idx = next((i for i in range(len(exs) - 1, -1, -1)
                    if not exs[i].get("return_at")), None)
        if idx is None:
            raise HTTPException(status_code=400, detail="Not currently stepped out")
        exs[idx]["return_at"] = now_utc().isoformat()
        await db.escort_attendance.update_one(
            {"id": existing["id"]},
            {"$set": {"excursions": exs}},
        )
        return await db.escort_attendance.find_one({"id": existing["id"]}, {"_id": 0})

    @router.get("/escort-attendance/today")
    async def todays_escort_attendance(user: dict = Depends(get_current_user)):
        """Used by the kiosk page (to show the live status of every active
        escort) AND the Admin Console dashboard banner ("X escorts expected,
        Y not yet in"). Strips selfies — list views never need the heavy
        base64 fields — but surfaces `has_check_in_selfie` /
        `has_check_out_selfie` flags so the kiosk can decide whether to
        lazy-fetch the thumbnail for the picked escort.
        """
        office = await db.config.find_one({"id": "office"})
        today = local_date_str(office)
        # Pull active escorts and today's attendance rows in parallel —
        # the page composes them client-side.
        escorts = await db.escorts.find(
            {"status": "active"}, {"_id": 0}
        ).sort([("institution", 1), ("name", 1)]).to_list(500)
        rows = await db.escort_attendance.find(
            {"date": today}, {"_id": 0}
        ).to_list(500)
        return {
            "date": today,
            "escorts": escorts,
            "attendance": [_strip_selfies(r) for r in rows],
        }

    @router.get("/escort-attendance/{att_id}/selfie")
    async def get_escort_attendance_selfie(
        att_id: str,
        kind: Literal["in", "out"] = "in",
        user: dict = Depends(get_current_user),
    ):
        """Lazy-load one selfie (data URL) for an attendance row. The
        kiosk uses this to render a thumbnail on the post-check-in screen
        without bloating the `/today` list response. Access: admin, coach,
        or the escort whose row this is."""
        row = await db.escort_attendance.find_one({"id": att_id}, {"_id": 0})
        if not row:
            raise HTTPException(status_code=404, detail="Attendance row not found")
        # Authorisation: admin / coach / the escort themselves.
        is_admin = user.get("role") == "admin"
        is_coach = user.get("category") == "coach"
        is_owner = user.get("is_escort") and user.get("escort_id") == row.get("escort_id")
        if not (is_admin or is_coach or is_owner):
            raise HTTPException(status_code=403, detail="Not allowed to view this selfie")
        field = "check_in_selfie" if kind == "in" else "check_out_selfie"
        url = row.get(field)
        if not url:
            raise HTTPException(status_code=404, detail="No selfie on file for this row")
        return {"data_url": url}

    @router.get("/escort-attendance")
    async def list_escort_attendance(
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        escort_id: Optional[str] = None,
        admin: dict = Depends(require_admin),
    ):
        """Admin: list attendance rows, optionally filtered. Selfies are
        stripped — use the per-id endpoint to load with the photo."""
        q: dict = {}
        if date_from:
            q.setdefault("date", {})["$gte"] = date_from
        if date_to:
            q.setdefault("date", {})["$lte"] = date_to
        if escort_id:
            q["escort_id"] = escort_id
        rows = await db.escort_attendance.find(q, {"_id": 0}).sort("date", -1).to_list(2000)
        office = await db.config.find_one({"id": "office"})
        today = local_date_str(office)
        return [{**_strip_selfies(r), "purge_ready": _purge_ready(r, today)} for r in rows]

    @router.get("/escort-attendance/{att_id}")
    async def get_escort_attendance(att_id: str, admin: dict = Depends(require_admin)):
        row = await db.escort_attendance.find_one({"id": att_id}, {"_id": 0})
        if not row:
            raise HTTPException(status_code=404, detail="Attendance row not found")
        office = await db.config.find_one({"id": "office"})
        today = local_date_str(office)
        row["purge_ready"] = _purge_ready(row, today)
        return row

    # ════════════════════════════════════════════════════════════════
    # PHOTO RETENTION (6c) — admin curated purge
    # ════════════════════════════════════════════════════════════════
    @router.get("/escort-attendance/photos/purge-candidates")
    async def list_purge_candidates(admin: dict = Depends(require_admin)):
        """Attendance rows that carry a selfie AND are older than the
        retention window. Returns the strip-list form (no base64). The
        admin curation UI walks this list and decides what to delete."""
        office = await db.config.find_one({"id": "office"})
        today = local_date_str(office)
        cutoff = (date.fromisoformat(today) - timedelta(days=PHOTO_RETENTION_DAYS)).isoformat()
        q = {"date": {"$lte": cutoff},
             "$or": [{"check_in_selfie": {"$ne": None, "$exists": True}},
                     {"check_out_selfie": {"$ne": None, "$exists": True}}]}
        rows = await db.escort_attendance.find(q, {"_id": 0}).sort("date", 1).to_list(2000)
        # Only return rows that ACTUALLY still have a selfie (the $or
        # check on nullable fields can be loose with older Mongo drivers).
        out = []
        for r in rows:
            if r.get("check_in_selfie") or r.get("check_out_selfie"):
                out.append({**_strip_selfies(r), "purge_ready": True})
        return out

    @router.delete("/escort-attendance/{att_id}/photos")
    async def purge_one_row(att_id: str, admin: dict = Depends(require_admin)):
        row = await db.escort_attendance.find_one({"id": att_id}, {"_id": 0})
        if not row:
            raise HTTPException(status_code=404, detail="Attendance row not found")
        await db.escort_attendance.update_one(
            {"id": att_id},
            {"$set": {"check_in_selfie": None, "check_out_selfie": None,
                      "photos_purged_at": now_utc().isoformat(),
                      "photos_purged_by": admin.get("full_name") or admin.get("email")}},
        )
        return {"ok": True}

    class PurgeBulkIn(BaseModel):
        att_ids: List[str]

    @router.post("/escort-attendance/photos/purge-bulk")
    async def purge_many(body: PurgeBulkIn, admin: dict = Depends(require_admin)):
        if not body.att_ids:
            return {"ok": True, "purged": 0}
        stamp_by = admin.get("full_name") or admin.get("email")
        res = await db.escort_attendance.update_many(
            {"id": {"$in": body.att_ids}},
            {"$set": {"check_in_selfie": None, "check_out_selfie": None,
                      "photos_purged_at": now_utc().isoformat(),
                      "photos_purged_by": stamp_by}},
        )
        return {"ok": True, "purged": int(res.modified_count)}

    @router.get("/escorts/{escort_id}/recent-visits")
    async def recent_visits(escort_id: str, limit: int = 5, user: dict = Depends(get_current_user)):
        """Last N check-in dates for an escort. Used by the kiosk row to
        give context ("was here last Monday too"). Visible to any logged
        in user — the data is just dates, no selfies."""
        rows = await db.escort_attendance.find(
            {"escort_id": escort_id, "check_in_at": {"$ne": None}},
            {"_id": 0, "date": 1, "check_in_at": 1, "check_out_at": 1},
        ).sort("date", -1).limit(max(1, min(20, limit))).to_list(20)
        return rows

    @router.post("/escorts/{escort_id}/invalidate")
    async def invalidate_escort(escort_id: str, admin: dict = Depends(require_admin)):
        """Admin one-shot terminal action — sets status='left' and stamps
        ended_at to today. Equivalent to a PATCH but exposed as its own
        verb so the UI can offer a single Invalidate button without
        opening the edit form."""
        escort = await db.escorts.find_one({"id": escort_id}, {"_id": 0})
        if not escort:
            raise HTTPException(status_code=404, detail="Escort not found")
        today = local_date_str(await db.config.find_one({"id": "office"}))
        await db.escorts.update_one(
            {"id": escort_id},
            {"$set": {"status": "left", "ended_at": today,
                      "invalidated_by": admin.get("full_name") or admin.get("email"),
                      "invalidated_at": now_utc().isoformat()}},
        )
        return await db.escorts.find_one({"id": escort_id}, {"_id": 0})

    return router
