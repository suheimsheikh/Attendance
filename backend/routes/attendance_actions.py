"""Attendance write routes: check-in/out (geo-toggle), stale-session resolve, step-out/return,
admin mark/scan/toggle/remove. Phase 2 of the attendance split out of server.py (Oct 2026) —
paths and behaviour unchanged."""
from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from config import AUTO_APPROVAL_LATE_CHECKINS
from routes.admin_audit import write_audit
from services.attendance_calc import (
    compute_late, compute_overtime_in, compute_overtime_out,
    excursion_seconds as _excursion_seconds, open_excursion as _open_excursion,
    parse_expected_return as _parse_expected_return,
)
from services.attendance_helpers import _compute_early_out_at_checkout
from services.dar import dar_missing_for_session, dar_required_for, get_dar_policy, validate_dar_text
from services.geocode import reverse_geocode_area
from services.permissions import is_ex_member, is_super_admin
from services.photo import check_photo_size as _check_photo_size, make_thumbnail as _make_thumbnail
from services.time_utils import local_date_str, now_utc, office_tz

logger = logging.getLogger("server")


class GeoToggleIn(BaseModel):
    latitude: float
    longitude: float
    reason: Optional[str] = None
    overtime_reason: Optional[str] = None
    early_out_reason: Optional[str] = None
    dar_text: Optional[str] = None
    # Off-geofence proof selfie (Jun 2026). When a check-in resolves OUTSIDE
    # every geofence, the app forces a fresh selfie + reason; this holds that
    # selfie (data-URL). Stored on the attendance row as `check_in_photo`
    # (NOT the profile photo) so an off-site pic never becomes the muster photo.
    check_in_photo: Optional[str] = None


class MarkMemberIn(BaseModel):
    member_id: str
    latitude: float
    longitude: float
    reason: Optional[str] = None


class ScanCardIn(BaseModel):
    personal_qr: str
    latitude: float
    longitude: float
    photo: Optional[str] = None
    reason: Optional[str] = None


class TempExitIn(BaseModel):
    reason: str = Field(min_length=1)
    expected_return: Optional[str] = None  # ISO datetime OR HH:MM (office local)
    latitude: Optional[float] = None
    longitude: Optional[float] = None


class TempReturnIn(BaseModel):
    latitude: Optional[float] = None
    longitude: Optional[float] = None


class ResolveStaleIn(BaseModel):
    session_id: str
    # One of: ISO datetime (close at this time) | "work_end" | "skip"
    action: str
    dar_text: Optional[str] = None


class RecalcLateIn(BaseModel):
    user_id: Optional[str] = None       # None → everyone
    start: str                           # YYYY-MM-DD inclusive
    end: str                             # YYYY-MM-DD inclusive
    dry_run: bool = True                 # preview by default


def make_router(db, get_current_user, require_admin, open_session_for, _late_days_in_month,
                _resolve_site_for, _cancel_stale_missed_checkin, _has_checkin_today,
                _active_camp_for, _ensure_reason_in_bank) -> APIRouter:
    router = APIRouter(prefix="/api")


    @router.post("/attendance/resolve-stale")
    async def resolve_stale(body: ResolveStaleIn, user: dict = Depends(get_current_user)):
        sess = await db.attendance.find_one({"id": body.session_id, "user_id": user["id"]}, {"_id": 0})
        if not sess:
            raise HTTPException(status_code=404, detail="Session not found")
        if sess.get("check_out_at"):
            raise HTTPException(status_code=400, detail="Already closed")

        if body.action == "skip":
            await db.attendance.update_one({"id": sess["id"]}, {"$set": {
                "forgot_checkout_skipped": True,
                "forgot_checkout_skipped_at": now_utc().isoformat(),
            }})
            return {"ok": True, "action": "skipped"}

        office = await db.config.find_one({"id": "office"})
        cin = datetime.fromisoformat(sess["check_in_at"])
        cin_local = cin.astimezone(office_tz(office))

        # DAR gate (Sep 2026): a DAR-required member cannot silently close a
        # forgotten session without filing the DAR either — same rule as the
        # normal self check-out, keyed to the session's (past) date.
        dar_saved = None
        if dar_required_for(user):
            _today = local_date_str(office)
            policy = await get_dar_policy(db, _today)
            dar_date = sess.get("date") or _today
            if policy.get("enabled", True) and dar_date >= policy["effective_from"]:
                has_dar = await db.dars.find_one(
                    {"user_id": user["id"], "date": dar_date}, {"_id": 0, "id": 1})
                if not has_dar:
                    if not (body.dar_text or "").strip():
                        raise HTTPException(status_code=400, detail="DAR_REQUIRED: Please enter your Daily Activity Report before closing this session")
                    clean = validate_dar_text(body.dar_text, policy["min_chars"])
                    _iso = now_utc().isoformat()
                    dar_saved = {
                        "id": str(uuid.uuid4()), "user_id": user["id"],
                        "user_name": user.get("full_name"), "category": user.get("category"),
                        "rank": user.get("rank"), "date": dar_date, "text": clean,
                        "submitted_at": _iso, "updated_at": _iso,
                        "attendance_id": sess["id"], "check_in_at": sess["check_in_at"],
                        "site_name": sess.get("site_name") or office.get("name"),
                        "check_out_at": None, "filed_late": True, "source": "resolve_stale",
                    }

        # Decide the close time
        if body.action == "work_end":
            target_hm = user.get("work_end") or "18:00"
        else:
            # body.action should be an ISO datetime OR HH:MM
            target_hm = body.action

        close_dt: Optional[datetime] = None
        if re.match(r"^\d{1,2}:\d{2}$", target_hm):
            h, m = (int(x) for x in target_hm.split(":"))
            close_dt = cin_local.replace(hour=h, minute=m, second=0, microsecond=0)
            # Must be after check-in
            if close_dt <= cin_local:
                close_dt = close_dt + timedelta(days=1)
        else:
            try:
                close_dt = datetime.fromisoformat(target_hm)
            except Exception:
                raise HTTPException(status_code=400, detail="Invalid close time")
            # A tz-naive ISO string means an office-local wall-clock time, not the
            # server host's zone — anchor it to the office tz before converting.
            if close_dt.tzinfo is None:
                close_dt = close_dt.replace(tzinfo=office_tz(office))

        close_utc = close_dt.astimezone(timezone.utc)
        # Close any open excursion at the close-time as well
        excursions = sess.get("excursions") or []
        for e in excursions:
            if e.get("out_at") and not e.get("in_at"):
                e["in_at"] = close_utc.isoformat()
                e["auto_closed"] = True
        away_s = _excursion_seconds(excursions)
        hours = round(max(0.0, (close_utc - cin).total_seconds() / 3600.0), 2)
        await db.attendance.update_one({"id": sess["id"]}, {"$set": {
            "check_out_at": close_utc.isoformat(),
            "hours": hours,
            "away_minutes": int(away_s / 60),
            "excursions": excursions,
            "exit_method": "user_late_resolve",
            "forgot_checkout": True,
            "checked_out_by": user["full_name"],
        }})
        if dar_saved:
            dar_saved["check_out_at"] = close_utc.isoformat()
            await db.dars.insert_one(dict(dar_saved))
        return {"ok": True, "action": "closed", "hours": hours, "close_at": close_utc.isoformat()}


    @router.post("/attendance/temp-exit")
    async def temp_exit(body: TempExitIn, user: dict = Depends(get_current_user)):
        """Member temporarily steps off campus (e.g. lunch, errand) — does NOT close the
        session. Time spent away is deducted from logged hours at final check-out."""
        sess = await open_session_for(user["id"])
        if not sess:
            raise HTTPException(status_code=400, detail="You are not checked in")
        if _open_excursion(sess):
            raise HTTPException(status_code=400, detail="You are already on a temporary exit")
        office = await db.config.find_one({"id": "office"})
        now = now_utc()
        exc = {
            "id": str(uuid.uuid4()),
            "out_at": now.isoformat(),
            "in_at": None,
            "reason": body.reason.strip(),
            "expected_return": _parse_expected_return(body.expected_return, office, now),
            "out_latitude": body.latitude,
            "out_longitude": body.longitude,
        }
        await db.attendance.update_one({"id": sess["id"]}, {"$push": {"excursions": exc}})
        return {"ok": True, "excursion": exc}


    @router.post("/attendance/temp-return")
    async def temp_return(body: TempReturnIn, user: dict = Depends(get_current_user)):
        """Member returns from a temporary exit and resumes the same session."""
        sess = await open_session_for(user["id"])
        if not sess:
            raise HTTPException(status_code=400, detail="You are not checked in")
        excursions = sess.get("excursions") or []
        target = None
        for e in reversed(excursions):
            if e.get("out_at") and not e.get("in_at"):
                target = e
                break
        if not target:
            raise HTTPException(status_code=400, detail="No active temporary exit found")
        now = now_utc()
        target["in_at"] = now.isoformat()
        target["in_latitude"] = body.latitude
        target["in_longitude"] = body.longitude
        if target.get("expected_return"):
            try:
                target["overdue_minutes"] = max(0, int((now - datetime.fromisoformat(target["expected_return"])).total_seconds() // 60))
            except Exception as e:
                logger.debug("temp_return: ignoring bad expected_return %r: %s", target.get("expected_return"), e)
        await db.attendance.update_one({"id": sess["id"]}, {"$set": {"excursions": excursions}})
        return {"ok": True, "excursion": target}


    async def perform_toggle(target, office, lat, lng, photo, reason, method, scanned_by):
        """Check a member in (if no open session) or out (if open). Stores location + reason."""
        # Ex-member cutoff: once a member's leaving_date is in the past,
        # new attendance is blocked so ex-employees can't accidentally
        # clock in from a lingering session (24 Feb 2026). History stays
        # intact so payroll for their tenure still reconciles.
        if is_ex_member(target):
            raise HTTPException(
                status_code=403,
                detail=f"{target.get('full_name') or 'This member'} has exited — check-in blocked from {target.get('leaving_date')}.",
            )
        site_id, site_name, dist, out, nearest_label = await _resolve_site_for(office, lat, lng)
        sess = await open_session_for(target["id"])
        ts = now_utc()
        if not sess and await _has_checkin_today(target["id"], local_date_str(office, ts)):
            raise HTTPException(
                status_code=400,
                detail=f"ALREADY_CHECKED_IN_TODAY: {target.get('full_name') or 'This member'} has already checked in today. Use Step Out for breaks; once checked out, they're done for the day.")
        # Build a small thumbnail of the verification photo so the Presence board
        # can render it without pulling the full ~30 KB JPEG per member.
        photo_thumb = _make_thumbnail(photo) if photo else None
        if sess:
            # DAR gate on proxy check-outs too (Sep 2026 user rule: no check-out
            # without the DAR when it's required) — console / card operators
            # see who's blocked and can ask the member to file it first.
            if await dar_missing_for_session(db, target, sess, local_date_str(office)):
                raise HTTPException(
                    status_code=400,
                    detail=f"DAR_REQUIRED: {target.get('full_name') or 'This member'} must file today's Daily Activity Report before check-out",
                )
            cin = datetime.fromisoformat(sess["check_in_at"])
            excursions = sess.get("excursions") or []
            # Auto-close a still-open excursion at this moment for clean records.
            for e in excursions:
                if e.get("out_at") and not e.get("in_at"):
                    e["in_at"] = ts.isoformat()
                    e["in_latitude"] = lat
                    e["in_longitude"] = lng
                    e["auto_closed"] = True
            away_s = _excursion_seconds(excursions)
            # Excursions are on office hours — count the full session toward logged hours.
            hours = round((ts - cin).total_seconds() / 3600.0, 2)
            await db.attendance.update_one({"id": sess["id"]}, {"$set": {
                "check_out_at": ts.isoformat(),
                "check_out_photo": photo,
                "check_out_photo_thumb": photo_thumb,
                "hours": hours,
                "away_minutes": int(away_s / 60),
                "excursions": excursions,
                "exit_latitude": lat,
                "exit_longitude": lng,
                "exit_distance_m": dist,
                "exit_out_of_geofence": out,
                "exit_site_id": site_id,
                "exit_site_name": site_name,
                "exit_nearest_site_name": nearest_label,
                "exit_reason": (reason or None),
                "checked_out_by": scanned_by,
            }})
            return {"ok": True, "action": "checkout", "member": target["full_name"],
                    "hours": hours, "out_of_geofence": out, "distance_m": dist,
                    "site_id": site_id, "site_name": site_name, "site_label": nearest_label}
        late, late_minutes = compute_late(office, target, ts, camp=await _active_camp_for(target, ts, office))
        doc = {
            "id": str(uuid.uuid4()),
            "user_id": target["id"],
            "date": local_date_str(office, ts),
            "check_in_at": ts.isoformat(),
            "check_out_at": None,
            "check_in_photo": photo,
            "check_in_photo_thumb": photo_thumb,
            "check_out_photo": None,
            "check_out_photo_thumb": None,
            "hours": None,
            "latitude": lat,
            "longitude": lng,
            "distance_m": dist,
            "out_of_geofence": out,
            "site_id": site_id,
            "site_name": site_name,
            "nearest_site_name": nearest_label,
            "geo_reason": (reason or None),
            "late": late,
            "late_minutes": late_minutes,
            "method": method,
            "checked_in_by": scanned_by,
            # Approval workflow (8 Jul 2026): late OR off-geofence check-ins
            # go through immediately but were flagged for admin review so
            # the Approvals queue could catch anomalies without blocking the
            # member. Currently OFF (see AUTO_APPROVAL_LATE_CHECKINS at top
            # of file) while admin clears the pre-launch backlog manually.
            # The `late` / `out_of_geofence` flags below are still stored so
            # nothing is lost — we just don't route the row to the queue.
            "approval_status": ("pending" if AUTO_APPROVAL_LATE_CHECKINS and (late or out) else None),
            "approval_flags": {
                "late": bool(late),
                "out_of_geofence": bool(out),
            } if (late or out) else None,
        }
        await db.attendance.insert_one(doc)
        await _cancel_stale_missed_checkin(doc["user_id"], doc["date"])
        return {"ok": True, "action": "checkin", "member": target["full_name"],
                "out_of_geofence": out, "distance_m": dist,
                "site_id": site_id, "site_name": site_name, "site_label": nearest_label,
                "late": late, "late_minutes": late_minutes}


    async def _geo_toggle(target: dict, office: dict, lat: float, lng: float,
                          reason: Optional[str], by: Optional[str],
                          overtime_reason: Optional[str] = None,
                          early_out_reason: Optional[str] = None,
                          dar_text: Optional[str] = None,
                          check_in_photo: Optional[str] = None) -> dict:
        """GPS-based check in/out (no QR). Distance from the office is recorded but
        NOT enforced — a check-in always succeeds. If the caller could not obtain
        a GPS fix they pass (0, 0) and we mark the row as `geo_unavailable`."""
        # Ex-member cutoff — mirror of the guard in `perform_toggle`; both
        # surfaces share the same policy (24 Feb 2026 user request).
        if is_ex_member(target):
            raise HTTPException(
                status_code=403,
                detail=f"{target.get('full_name') or 'This member'} has exited — check-in blocked from {target.get('leaving_date')}.",
            )
        geo_unavailable = (lat == 0 and lng == 0)
        if check_in_photo:
            _check_photo_size(check_in_photo)
        if geo_unavailable:
            dist = None
            out = False
            stored_lat, stored_lng = None, None
            site_id, site_name = None, None
            nearest_label = office.get("name") or "Office"
        else:
            site_id, site_name, dist, out, nearest_label = await _resolve_site_for(office, lat, lng)
            stored_lat, stored_lng = lat, lng
        sess = await open_session_for(target["id"])
        ts = now_utc()
        if not sess and await _has_checkin_today(target["id"], local_date_str(office, ts)):
            raise HTTPException(
                status_code=400,
                detail="ALREADY_CHECKED_IN_TODAY: You've already checked in today. Use Step Out for breaks; once you check out, you're done for the day. If this is a mistake, please ask an admin.")
        if sess:
            # DAR gate (Sep 2026): payroll employees must file a Daily Activity
            # Report before their self check-out completes. Proxy paths
            # (admin console / muster / card) pass by=<admin id> and skip it.
            dar_saved = None
            if by is None and dar_required_for(target):
                _today = local_date_str(office)
                policy = await get_dar_policy(db, _today)
                if policy.get("enabled", True) and _today >= policy["effective_from"]:
                    dar_date = sess.get("date") or _today
                    has_dar = await db.dars.find_one({"user_id": target["id"], "date": dar_date}, {"_id": 0, "id": 1})
                    if not has_dar:
                        if not (dar_text or "").strip():
                            raise HTTPException(status_code=400, detail="DAR_REQUIRED: Please enter your Daily Activity Report before checking out")
                        clean = validate_dar_text(dar_text, policy["min_chars"])
                        ts_iso = ts.isoformat()
                        dar_saved = {
                            "id": str(uuid.uuid4()), "user_id": target["id"],
                            "user_name": target.get("full_name"), "category": target.get("category"),
                            "rank": target.get("rank"), "date": dar_date, "text": clean,
                            "submitted_at": ts_iso, "updated_at": ts_iso,
                            "attendance_id": sess["id"], "check_in_at": sess["check_in_at"],
                            "site_name": sess.get("site_name") or office.get("name"),
                            "check_out_at": None, "filed_late": False, "source": "checkout",
                        }
            cin = datetime.fromisoformat(sess["check_in_at"])
            excursions = sess.get("excursions") or []
            for e in excursions:
                if e.get("out_at") and not e.get("in_at"):
                    e["in_at"] = ts.isoformat()
                    e["in_latitude"] = stored_lat
                    e["in_longitude"] = stored_lng
                    e["auto_closed"] = True
            away_s = _excursion_seconds(excursions)
            # Excursions are on office hours — count the full session toward logged hours.
            hours = round((ts - cin).total_seconds() / 3600.0, 2)
            # Compute late-checkout overtime (staff only).
            late_min, work_end_hm = compute_overtime_out(office, target, ts)
            ot_updates: dict = {}
            if late_min > 0:
                existing_early = int(sess.get("overtime_early_min") or 0)
                existing_reason = sess.get("overtime_reason") or ""
                _late_reason = (overtime_reason or "").strip() or None
                ot_updates = {
                    "overtime_late_min": late_min,
                    "overtime_total_min": existing_early + late_min,
                    # Auto-calculated OT — no approval workflow (15 Feb 2026
                    # user request: "no longer any such thing as pending
                    # and approved OT. Just OT as calculated by the system
                    # for extra hours served"). Reason is still stored as
                    # an audit note when the member supplied one.
                    "overtime_status": None,
                    "overtime_reason": (overtime_reason or existing_reason or "").strip() or None,
                    # Late-checkout OT gets its own reason field so the ledger
                    # can surface early-in vs late-out reasons separately
                    # (8 Jul 2026 user request). Preserves whatever
                    # `overtime_early_reason` was stamped at check-in.
                    "overtime_late_reason": _late_reason,
                    "work_end_at_session": work_end_hm,
                }
            elif overtime_reason and (sess.get("overtime_total_min") or 0) > 0:
                # No new late OT but member supplied a reason that supplements
                # the earlier OT session. Route it to whichever half is missing
                # a reason (early first — check-in tends to be the fast path).
                _sup = overtime_reason.strip()
                _updates: dict = {"overtime_reason": _sup}
                if not sess.get("overtime_early_reason") and int(sess.get("overtime_early_min") or 0) > 0:
                    _updates["overtime_early_reason"] = _sup
                elif not sess.get("overtime_late_reason") and int(sess.get("overtime_late_min") or 0) > 0:
                    _updates["overtime_late_reason"] = _sup
                ot_updates = _updates
            # If a reason was captured for OT (either fresh late-out OT or a
            # supplemental one), stash it in the member's personal reason
            # bank so it re-appears as a suggestion on their next OT prompt.
            if overtime_reason and overtime_reason.strip():
                await _ensure_reason_in_bank(target["id"], overtime_reason)
            # Early-out detection at checkout — mirror the /me/profile-details
            # detection so the number matches the Profile "Early Outs" list
            # (15-min grace before work_end). See _compute_early_out_at_checkout
            # for the arithmetic. When the member has no `work_end` set or
            # they're leaving on-time or later, this returns 0 and the row
            # gets a clean `early_out_minutes: 0` + `early_out_reason: None`.
            early_out_minutes = _compute_early_out_at_checkout(ts, target, office)
            _early_out_reason = (early_out_reason or "").strip() or None
            if early_out_minutes > 0 and _early_out_reason:
                await _ensure_reason_in_bank(target["id"], _early_out_reason)
            # OFF-SITE check-out: short area name from GPS for the WhatsApp copy.
            exit_place_name = await reverse_geocode_area(stored_lat, stored_lng) if (out and not geo_unavailable) else None
            update_fields = {
                "check_out_at": ts.isoformat(),
                "hours": hours,
                "away_minutes": int(away_s / 60),
                "excursions": excursions,
                "exit_latitude": stored_lat, "exit_longitude": stored_lng,
                "exit_distance_m": dist, "exit_out_of_geofence": out,
                "exit_site_id": site_id, "exit_site_name": site_name,
                "exit_nearest_site_name": nearest_label,
                "exit_geo_unavailable": geo_unavailable,
                "exit_place_name": exit_place_name,
                "exit_reason": (reason or None),
                "exit_method": "geo",
                "checked_out_by": by,
                # Early-out stamp — 0 when leaving on-time or later. Reason is
                # kept even if the reason was supplied but early_out_minutes==0
                # so admins can see the member intended to note something.
                "early_out_minutes": early_out_minutes,
                "early_out_reason": _early_out_reason if early_out_minutes > 0 else None,
            }
            update_fields.update(ot_updates)
            await db.attendance.update_one({"id": sess["id"]}, {"$set": update_fields})
            if dar_saved:
                dar_saved["check_out_at"] = ts.isoformat()
                await db.dars.insert_one(dict(dar_saved))
            else:
                await db.dars.update_one({"attendance_id": sess["id"]}, {"$set": {"check_out_at": ts.isoformat()}})
            return {"ok": True, "action": "checkout", "member": target["full_name"],
                    "hours": hours, "out_of_geofence": out, "distance_m": dist,
                    "site_id": site_id, "site_name": site_name,
                    "site_label": nearest_label,
                    "geo_unavailable": geo_unavailable,
                    "place_name": exit_place_name,
                    "check_in_at": sess["check_in_at"], "check_out_at": ts.isoformat(),
                    "dar": {k: dar_saved[k] for k in ("id", "date", "text")} if dar_saved else None,
                    "overtime_minutes": ot_updates.get("overtime_total_min", 0)}
        if out:
            # Geofence never blocks a check-in, but a SELF check-in from outside
            # every fence must carry the proof selfie + reason the UI collects.
            # Proxy paths (admin/muster, by=<admin id>) are exempt.
            if by is None and not (check_in_photo and (reason or "").strip()):
                raise HTTPException(status_code=400, detail=f"OFFSITE_PROOF_REQUIRED:{int(dist)}")
        late, late_minutes = compute_late(office, target, ts, camp=await _active_camp_for(target, ts, office))
        early_min, work_start_hm = compute_overtime_in(office, target, ts)
        # OFF-SITE only: look up a short area name from the GPS fix so the
        # WhatsApp check-in message can say roughly WHERE they checked in from.
        # Best-effort — None on failure or when on-site / no GPS.
        place_name = await reverse_geocode_area(stored_lat, stored_lng) if (out and not geo_unavailable) else None
        doc = {
            "id": str(uuid.uuid4()),
            "user_id": target["id"],
            "date": local_date_str(office, ts),
            "check_in_at": ts.isoformat(),
            "check_out_at": None,
            "check_in_photo": check_in_photo if (out and check_in_photo) else None,
            "check_out_photo": None,
            "hours": None,
            "latitude": stored_lat, "longitude": stored_lng,
            "distance_m": dist, "out_of_geofence": out,
            "site_id": site_id, "site_name": site_name,
            "nearest_site_name": nearest_label,
            "geo_unavailable": geo_unavailable,
            "place_name": place_name,
            "geo_reason": (reason or None) if out else None,
            "late": late,
            "late_minutes": late_minutes,
            "method": "geo",
            "checked_in_by": by,
            # See parallel comment on the QR check-in path — same approval rule.
            # Currently OFF (AUTO_APPROVAL_LATE_CHECKINS at top of file).
            "approval_status": ("pending" if AUTO_APPROVAL_LATE_CHECKINS and (late or out) else None),
            "approval_flags": {
                "late": bool(late),
                "out_of_geofence": bool(out),
            } if (late or out) else None,
        }
        if early_min > 0:
            _early_reason = (overtime_reason or "").strip() or None
            doc.update({
                "overtime_early_min": early_min,
                "overtime_total_min": early_min,
                # Auto-calculated OT — no approval workflow (15 Feb 2026,
                # see check-out branch for context). Reason still stored
                # as an audit note.
                "overtime_status": None,
                "overtime_reason": _early_reason,
                # Early-in OT gets its own reason field so the OT ledger can
                # render early vs late reasons side-by-side (8 Jul 2026 user
                # request). Complements `overtime_late_reason` set on check-out.
                "overtime_early_reason": _early_reason,
                "work_start_at_session": work_start_hm,
            })
        await db.attendance.insert_one(doc)
        await _cancel_stale_missed_checkin(doc["user_id"], doc["date"])
        # Early-OT reason → personal bank (see notes on _ensure_reason_in_bank).
        if early_min > 0 and overtime_reason and overtime_reason.strip():
            await _ensure_reason_in_bank(target["id"], overtime_reason)
        return {"ok": True, "action": "checkin", "member": target["full_name"],
                "out_of_geofence": out, "distance_m": dist,
                "site_id": site_id, "site_name": site_name,
                "site_label": nearest_label,
                "geo_unavailable": geo_unavailable,
                "place_name": place_name,
                "late": late, "late_minutes": late_minutes,
                "late_days_this_month": (await _late_days_in_month(target["id"], doc["date"])) if late else 0,
                "overtime_minutes": early_min}


    @router.post("/attendance/geo-toggle")
    async def geo_toggle(body: GeoToggleIn, user: dict = Depends(get_current_user)):
        """Self check in/out by GPS — works in any phone browser (no camera/QR)."""
        office = await db.config.find_one({"id": "office"})
        if not office:
            raise HTTPException(status_code=500, detail="Office not configured")
        return await _geo_toggle(user, office, body.latitude, body.longitude,
                                 body.reason, None, body.overtime_reason,
                                 body.early_out_reason, body.dar_text,
                                 body.check_in_photo)


    @router.post("/attendance/mark-member")
    async def mark_member(body: MarkMemberIn, admin: dict = Depends(require_admin)):
        """Mark a person WITHOUT a phone present/absent by picking them from a list.
        Restricted to admins (designated people). Uses the marker's GPS; records who did it."""
        office = await db.config.find_one({"id": "office"})
        if not office:
            raise HTTPException(status_code=500, detail="Office not configured")
        target = await db.users.find_one({"id": body.member_id}, {"_id": 0})
        if not target:
            raise HTTPException(status_code=404, detail="Member not found")
        return await _geo_toggle(target, office, body.latitude, body.longitude, body.reason, admin["id"])


    @router.post("/attendance/recalc-late")
    async def recalc_late(body: RecalcLateIn, admin: dict = Depends(require_admin)):
        """Re-evaluate the stored `late` flag/minutes for existing attendance rows
        against the CURRENT schedule + grace (and any camp overlay), over a date
        range. Use after changing a member's work_start or the office grace, since
        `late` is stamped at check-in and never auto-recomputed. Super-admin only;
        defaults to a dry-run preview — pass dry_run=false to apply."""
        if not is_super_admin(admin):
            raise HTTPException(status_code=403, detail="Super-admin only")
        office = await db.config.find_one({"id": "office"}, {"_id": 0})
        if not office:
            raise HTTPException(status_code=500, detail="Office not configured")
        tz = office_tz(office)
        q = {"date": {"$gte": body.start, "$lte": body.end},
             "check_in_at": {"$ne": None}}
        if body.user_id:
            q["user_id"] = body.user_id
        rows = await db.attendance.find(
            q, {"_id": 0, "id": 1, "user_id": 1, "date": 1, "check_in_at": 1,
                "late": 1, "late_minutes": 1}).to_list(length=None)
        umap: Dict[str, dict] = {}
        changes = []
        for r in rows:
            uid = r.get("user_id")
            if uid not in umap:
                umap[uid] = await db.users.find_one({"id": uid}, {"_id": 0}) or {}
            member = umap[uid]
            ci = r.get("check_in_at")
            if not ci:
                continue
            try:
                ts = datetime.fromisoformat(ci)
            except Exception:
                continue
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=tz)
            camp = await _active_camp_for(member, ts, office)
            is_late, late_min = compute_late(office, member, ts, camp=camp)
            was_late = bool(r.get("late"))
            was_min = int(r.get("late_minutes") or 0)
            if was_late != bool(is_late) or was_min != int(late_min):
                changes.append({
                    "attendance_id": r["id"], "user_id": uid,
                    "name": member.get("full_name") or uid, "date": r["date"],
                    "was_late": was_late, "was_minutes": was_min,
                    "now_late": bool(is_late), "now_minutes": int(late_min),
                })
        applied = 0
        if not body.dry_run and changes:
            stamp = now_utc().isoformat()
            for ch in changes:
                await db.attendance.update_one({"id": ch["attendance_id"]}, {"$set": {
                    "late": ch["now_late"], "late_minutes": ch["now_minutes"],
                    "late_recalc_at": stamp, "late_recalc_by": admin.get("full_name"),
                }})
                applied += 1
        changes.sort(key=lambda c: (c["date"], c["name"]))
        return {
            "scanned": len(rows), "changed": len(changes), "applied": applied,
            "dry_run": body.dry_run, "start": body.start, "end": body.end,
            "changes": changes[:500], "truncated": len(changes) > 500,
        }


    @router.post("/attendance/scan-card")
    async def scan_card(body: ScanCardIn, admin: dict = Depends(require_admin)):
        """Proxy check-in/out for a person without a phone, via their personal QR card.
        Restricted to admins (designated gate operators). Auto-toggles the carded member's session."""
        office = await db.config.find_one({"id": "office"})
        if not office:
            raise HTTPException(status_code=500, detail="Office not configured")
        target = await db.users.find_one({"personal_qr": body.personal_qr}, {"_id": 0})
        if not target:
            raise HTTPException(status_code=404, detail="Card not recognised — unknown member")
        res = await perform_toggle(target, office, body.latitude, body.longitude,
                                   body.photo, body.reason, "card", admin["id"])
        res["proxy"] = True
        return res


    @router.post("/admin/attendance/toggle/{member_id}")
    async def admin_toggle_attendance(member_id: str, body: dict = None, admin: dict = Depends(require_admin)):
        """Front-desk override from the console: check a member in/out using office coords."""
        office = await db.config.find_one({"id": "office"})
        if not office:
            raise HTTPException(status_code=500, detail="Office not configured")
        target = await db.users.find_one({"id": member_id}, {"_id": 0})
        if not target:
            raise HTTPException(status_code=404, detail="Member not found")
        reason = (body or {}).get("reason")
        res = await perform_toggle(target, office, office["latitude"], office["longitude"],
                                   None, reason, "admin_console", admin["id"])
        res["override"] = True
        # Audit trail — retroactive check-ins and check-outs are the highest-
        # stakes admin overrides on the platform (they directly affect
        # attendance and OT payout). Log every one.
        await write_audit(
            db, actor=admin,
            action=f"attendance.{res.get('action', 'toggle')}",
            entity_type="member", entity_id=member_id,
            entity_name=target.get("full_name"),
            reason=reason,
            meta={"session_id": res.get("session_id"),
                  "check_in_at": res.get("check_in_at"),
                  "check_out_at": res.get("check_out_at")},
        )
        return res


    @router.delete("/admin/attendance/open-session/{member_id}")
    async def admin_remove_open_session(member_id: str, admin: dict = Depends(require_admin)):
        """Wipe today's OPEN attendance session for a member.

        Used by the Presence Board "Remove from On Campus" gesture — when a coach
        or admin sees a member that's mistakenly shown as on campus (wrong button,
        accidental muster scan, etc.), this clears the row entirely so the member
        can check in fresh via Self Check-In or Muster.

        Only the *open* session (no check_out_at) for *today* is removed. Closed
        sessions are left intact so historical reports stay correct.
        """
        target = await db.users.find_one({"id": member_id}, {"_id": 0, "id": 1, "full_name": 1})
        if not target:
            raise HTTPException(status_code=404, detail="Member not found")
        office = await db.config.find_one({"id": "office"})
        today = local_date_str(office)
        res = await db.attendance.delete_one({
            "user_id": member_id,
            "date": today,
            "check_out_at": None,
        })
        if res.deleted_count == 0:
            raise HTTPException(status_code=404, detail="No open session for today to remove")
        logger.info("Admin %s removed open session for %s (%s)", admin["id"], member_id, target.get("full_name"))
        return {"ok": True, "removed": 1, "member": target.get("full_name")}

    return router
