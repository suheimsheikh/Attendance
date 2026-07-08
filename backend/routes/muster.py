"""
Muster roll endpoints — bulk check-in / check-out for athletes performed
by a coach, admin, or institution-scoped active escort. Athletes typically
don't have phones; a coach physically musters them and ticks who's present
(or who's departing).

Split out of `server.py` during the 06/2026 modularisation pass.

Covers:
  • GET  /api/muster/athletes        — list eligible athletes for the
                                       given mode (checkin | checkout).
  • POST /api/muster/checkin-bulk    — record presence for many athletes
                                       in one shot.
  • POST /api/muster/checkout-bulk   — close many open sessions in one
                                       shot.

Institutional scoping: active escort tokens (`is_escort=True`) are
silently restricted to their assigned institution; non-matching ids
are skipped, never 403-ing the whole batch.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from services.time_utils import now_utc, local_date_str
from services.attendance_calc import compute_late, excursion_seconds


def _auto_approval_late_checkins() -> bool:
    """Read the AUTO_APPROVAL_LATE_CHECKINS flag from server.py at call
    time (not import time) so muster and server share a single toggle
    without needing a circular import at module init.
    """
    try:
        import server  # local import — server has already imported this module by now
        return bool(getattr(server, "AUTO_APPROVAL_LATE_CHECKINS", False))
    except Exception:
        return False


# -------------------- Pydantic bodies --------------------
class MusterBulkIn(BaseModel):
    athlete_ids: List[str]
    # Coach's GPS at submit time (24 Jul 2026). Stamped on every
    # attendance row so each check-in captures WHERE the coach mustered
    # the members. Optional so older clients without the coach-GPS wiring
    # keep working (they end up with lat/lng=None as before).
    latitude: Optional[float] = None
    longitude: Optional[float] = None


def _can_muster(user: dict) -> bool:
    # Active escorts (session-bound to a single institution) may also muster,
    # but only within their own institution. The institution-scoping is
    # enforced downstream in `muster_athletes` and the bulk endpoints —
    # this gate only controls "can they touch the muster surface at all".
    return (
        user.get("role") == "admin"
        or user.get("category") == "coach"
        or bool(user.get("is_escort"))
    )


def _require_muster(user: dict) -> None:
    if not _can_muster(user):
        raise HTTPException(
            status_code=403,
            detail="Only coaches, admins, and active escorts can run muster",
        )


def make_router(db, get_current_user, active_camp_for, resolve_site_for) -> APIRouter:
    router = APIRouter(prefix="/api")

    async def _enforce_escort_window(user: dict) -> None:
        """If the caller is an escort-token, refuse the request when the
        underlying escort row is now outside its [valid_from, valid_until]
        window. Catches the case where an admin revoked the validity AFTER
        the escort signed in — the JWT is still cryptographically valid
        but the authorisation behind it has been pulled."""
        if not user.get("is_escort") or not user.get("escort_id"):
            return
        esc = await db.escorts.find_one(
            {"id": user["escort_id"]}, {"_id": 0, "valid_from": 1, "valid_until": 1, "status": 1}
        )
        if not esc or esc.get("status") != "active":
            raise HTTPException(status_code=403, detail="Your escort access has been revoked")
        today_iso = now_utc().date().isoformat()
        if esc.get("valid_from") and today_iso < esc["valid_from"]:
            raise HTTPException(status_code=403, detail="Your escort access starts on " + esc["valid_from"])
        if esc.get("valid_until") and today_iso > esc["valid_until"]:
            raise HTTPException(status_code=403, detail="Your escort access expired on " + esc["valid_until"])

    @router.get("/muster/athletes")
    async def muster_athletes(mode: str = "checkin", user: dict = Depends(get_current_user)):
        """List athletes eligible for the given muster mode:
           checkin  → athletes not currently on-campus AND not on leave/tour AND not
                      already closed-out today
           checkout → athletes currently checked in (open session)
        """
        _require_muster(user)
        await _enforce_escort_window(user)
        if mode not in ("checkin", "checkout"):
            raise HTTPException(status_code=400, detail="mode must be 'checkin' or 'checkout'")

        office = await db.config.find_one({"id": "office"})
        today = local_date_str(office)

        # Escorts can only muster athletes from their own institution. Coaches
        # and admins see the full roster.
        athlete_query: dict = {"category": "athlete"}
        if user.get("is_escort"):
            inst = (user.get("institution") or "").strip()
            if not inst:
                raise HTTPException(status_code=400, detail="Escort has no institution assigned")
            athlete_query["institution"] = inst

        athletes = await db.users.find(athlete_query, {"_id": 0}).to_list(2000)

        # Pull today's open sessions WITH their check_in_at timestamps so the
        # UI can show "already checked in at HH:MM" for the greyed-out rows
        # (was: ids-only set, which forced the frontend to hide them entirely
        # — a coach searching for an already-checked-in athlete couldn't find
        # them at all).
        open_sessions = await db.attendance.find(
            {"check_out_at": None}, {"_id": 0, "user_id": 1, "check_in_at": 1}
        ).to_list(2000)
        open_map = {s["user_id"]: s for s in open_sessions}
        open_ids = set(open_map.keys())

        # Members on Leave or Tour are excluded from muster (they can't
        # be checked in). Postings are NOT in this list — R2 (30 Jun 2026)
        # says posted members check in normally (the "POSTED" label on
        # the Presence board is informational only, not a hard block).
        on_leave = await db.leaves.find(
            {"status": "approved",
             "type": {"$in": ["leave", "tour"]},
             "start_date": {"$lte": today}, "end_date": {"$gte": today}},
            {"_id": 0, "user_id": 1},
        ).to_list(2000)
        on_leave_ids = {leave["user_id"] for leave in on_leave}

        out: List[dict] = []
        for s in athletes:
            sid = s["id"]
            already_in = sid in open_ids
            if mode == "checkin":
                # On leave or tour → skip entirely (they're not eligible at all).
                if sid in on_leave_ids:
                    continue
                # Already on campus → keep them in the response but mark them
                # so the frontend can render the row in a disabled / greyed
                # state. Prevents double check-in while still giving the
                # operator visibility into who's already present.
            else:  # checkout
                if not already_in:
                    continue
            sess = open_map.get(sid)
            out.append({
                "id": sid,
                "full_name": s["full_name"],
                "rank": s.get("rank"),
                "photo": s.get("photo_thumb") or s.get("photo"),
                "institution": s.get("institution"),
                "gender": s.get("gender"),
                "father_mobile": s.get("father_mobile"),
                "mother_mobile": s.get("mother_mobile"),
                "guardian_mobile": s.get("guardian_mobile"),
                # New: the frontend uses these two to render a disabled
                # "Already checked in · HH:MM" pill instead of a tickable row.
                "already_checked_in": bool(already_in) if mode == "checkin" else False,
                "check_in_at": sess.get("check_in_at") if (mode == "checkin" and sess) else None,
            })

        out.sort(key=lambda x: (x["full_name"] or "").lower())
        return {"mode": mode, "date": today, "athletes": out, "count": len(out)}

    @router.post("/muster/checkin-bulk")
    async def muster_checkin_bulk(body: MusterBulkIn, user: dict = Depends(get_current_user)):
        _require_muster(user)
        await _enforce_escort_window(user)
        office = await db.config.find_one({"id": "office"})
        today = local_date_str(office)
        now = now_utc()

        # Coach's GPS → resolve which training location the muster is
        # happening at. Fields are stamped on every attendance row so
        # each check-in records the coach's physical spot (24 Jul 2026).
        # Missing lat/lng or (0, 0) → geo_unavailable=True, no site.
        has_gps = (body.latitude is not None and body.longitude is not None
                   and not (body.latitude == 0 and body.longitude == 0))
        if has_gps:
            site_id, site_name, distance_m, out_of_geofence = await resolve_site_for(
                office, body.latitude, body.longitude,
            )
            stamped_lat, stamped_lng = body.latitude, body.longitude
            geo_unavailable = False
        else:
            site_id, site_name, distance_m, out_of_geofence = None, None, None, False
            stamped_lat, stamped_lng = None, None
            geo_unavailable = True

        done, skipped = [], []
        # Escorts may only muster within their assigned institution. We
        # silently skip athletes outside that institution rather than 403
        # the whole batch — keeps the muster UX forgiving if a stale id
        # slips into the request.
        escort_inst = (user.get("institution") or "").strip() if user.get("is_escort") else None
        for sid in body.athlete_ids:
            athlete = await db.users.find_one({"id": sid, "category": "athlete"}, {"_id": 0})
            if not athlete:
                skipped.append({"id": sid, "reason": "not an athlete"})
                continue
            if escort_inst and (athlete.get("institution") or "").strip() != escort_inst:
                skipped.append({"id": sid, "name": athlete["full_name"],
                                "reason": "outside your institution"})
                continue
            if await db.attendance.find_one({"user_id": sid, "check_out_at": None}):
                skipped.append({"id": sid, "name": athlete["full_name"], "reason": "already checked in"})
                continue
            late, late_min = compute_late(
                office, athlete, now, camp=await active_camp_for(athlete, now, office),
            )
            att = {
                "id": str(uuid.uuid4()),
                "user_id": sid,
                "date": today,
                "check_in_at": now.isoformat(),
                "check_in_photo": None,
                "check_out_at": None,
                "method": "muster",
                "checked_in_by": user["full_name"],
                "checked_in_by_id": user["id"],
                "latitude": stamped_lat,
                "longitude": stamped_lng,
                "out_of_geofence": bool(out_of_geofence),
                "distance_m": distance_m if distance_m is not None else 0,
                "site_id": site_id,
                "site_name": site_name,
                "geo_unavailable": geo_unavailable,
                "late": late,
                "late_minutes": late_min,
                "excursions": [],
                "created_at": now.isoformat(),
                # Approval workflow — muster check-ins are flagged when
                # late or off-geofence just like self check-ins so the
                # Approvals queue catches anomalies. Coaches are trusted
                # but audited (8 Jul 2026).
                # Gated by server.AUTO_APPROVAL_LATE_CHECKINS (currently
                # OFF while admin clears the pre-launch backlog manually).
                # `late` / `out_of_geofence` are still recorded on the row.
                "approval_status": (
                    "pending"
                    if _auto_approval_late_checkins() and (late or bool(out_of_geofence))
                    else None
                ),
                "approval_flags": {
                    "late": bool(late),
                    "out_of_geofence": bool(out_of_geofence),
                } if (late or bool(out_of_geofence)) else None,
            }
            await db.attendance.insert_one(att)
            done.append({"id": sid, "name": athlete["full_name"], "late": late})
        return {
            "checked_in_count": len(done),
            "skipped_count": len(skipped),
            "checked_in": done,
            "skipped": skipped,
            # Echo back what the batch was stamped with — powers the
            # "Mustered N athletes at Rowing Academy" toast on the client.
            "site_id": site_id,
            "site_name": site_name,
            "out_of_geofence": bool(out_of_geofence),
            "distance_m": distance_m,
        }

    @router.post("/muster/checkout-bulk")
    async def muster_checkout_bulk(body: MusterBulkIn, user: dict = Depends(get_current_user)):
        _require_muster(user)
        await _enforce_escort_window(user)
        now = now_utc()
        office = await db.config.find_one({"id": "office"})

        # Resolve coach location for the exit stamp (24 Jul 2026).
        has_gps = (body.latitude is not None and body.longitude is not None
                   and not (body.latitude == 0 and body.longitude == 0))
        if has_gps:
            site_id, site_name, distance_m, out_of_geofence = await resolve_site_for(
                office, body.latitude, body.longitude,
            )
            stamped_lat, stamped_lng = body.latitude, body.longitude
        else:
            site_id, site_name, distance_m, out_of_geofence = None, None, None, False
            stamped_lat, stamped_lng = None, None

        done, skipped = [], []
        escort_inst = (user.get("institution") or "").strip() if user.get("is_escort") else None
        for sid in body.athlete_ids:
            athlete = await db.users.find_one({"id": sid, "category": "athlete"}, {"_id": 0})
            if not athlete:
                skipped.append({"id": sid, "reason": "not an athlete"})
                continue
            if escort_inst and (athlete.get("institution") or "").strip() != escort_inst:
                skipped.append({"id": sid, "name": athlete["full_name"],
                                "reason": "outside your institution"})
                continue
            sess = await db.attendance.find_one({"user_id": sid, "check_out_at": None}, {"_id": 0})
            if not sess:
                skipped.append({"id": sid, "name": athlete["full_name"], "reason": "not checked in"})
                continue
            cin = datetime.fromisoformat(sess["check_in_at"])
            excursions = sess.get("excursions") or []
            for e in excursions:
                if e.get("out_at") and not e.get("in_at"):
                    e["in_at"] = now.isoformat()
                    e["auto_closed"] = True
            away_s = excursion_seconds(excursions)
            hours = round((now - cin).total_seconds() / 3600.0, 2)
            await db.attendance.update_one({"id": sess["id"]}, {"$set": {
                "check_out_at": now.isoformat(),
                "hours": hours,
                "away_minutes": int(away_s / 60),
                "excursions": excursions,
                "exit_method": "muster",
                "exit_out_of_geofence": bool(out_of_geofence),
                "exit_latitude": stamped_lat,
                "exit_longitude": stamped_lng,
                "exit_distance_m": distance_m if distance_m is not None else 0,
                "exit_site_id": site_id,
                "exit_site_name": site_name,
                "checked_out_by": user["full_name"],
                "checked_out_by_id": user["id"],
            }})
            done.append({"id": sid, "name": athlete["full_name"], "hours": hours})
        return {
            "checked_out_count": len(done),
            "skipped_count": len(skipped),
            "checked_out": done,
            "skipped": skipped,
            "site_id": site_id,
            "site_name": site_name,
            "out_of_geofence": bool(out_of_geofence),
            "distance_m": distance_m,
        }

    return router
