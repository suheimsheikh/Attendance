"""
Presence Board endpoint (`GET /api/presence`).

Split out of server.py on 12 Oct 2026 (Refactor #5) into its own module.
This is the big live/historical roster view consumed by the Presence
Board screen. It is READ-ONLY — it never writes to the database — so the
split carries no state-mutation risk; the JSON shape and route path are
byte-for-byte unchanged (regression-anchored against fixed past-date
snapshots).

NOTE: the *other* `routes/presence.py` module is a different concern —
ephemeral in-memory heartbeat / row-focus signals. This file owns only
the Presence Board roster aggregation.

Implementation phases inside `presence()`:
  1. GATHER  — bulk-read users, sessions, leaves, late-coming notices,
     parent-notification log, camps, breaks, admin contacts, and the
     30-day lookback for the absent-streak counter.
  2. RESOLVE — single pass over users deciding each member's status and
     chips (late, days_remaining, excursion_count, streak, notify_due…).
  3. RENDER  — counts, escorts-present strip, by-location aggregate, ship.
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta, date
from typing import Optional

from fastapi import APIRouter, Depends

import camps as _camps_module
import breaks as _breaks_module
from services.time_utils import now_utc, office_tz, local_date_str, local_hm
from services.photo import member_photo_url
from services.attendance_calc import (
    ATHLETE_CATEGORIES,
    compute_late,
    open_excursion as _open_excursion,
    effective_hours as _effective_hours,
)
from services.scope import athlete_like_keys as _athlete_like_keys
from holidays import is_weekly_off_on as _is_weekly_off_on


_WEEKDAY_KEY = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


async def _make_absence_streak_computer(db, today: str):
    """Bulk-fetch attendance + approved leaves + breaks for the 30 days
    before `today`, then return a closure `(user) -> int` that counts a
    given member's consecutive-absent streak.

    Extracted from `presence()` on 14 Feb 2026 (item D of the medium-risk
    refactor pass). One factory call fires three bulk Mongo queries; the
    returned closure is then O(1) per member. Pulling this out cuts the
    top-level `presence` function from ~665 → ~600 LOC and makes the
    30-day-lookback logic testable in isolation.

    A "covered" day is one where the member had attendance, an approved
    leave/tour, or a break that applies to them. The streak stops at the
    first covered day walking backwards. Weekly-off days don't COUNT as
    absent but don't BREAK the streak either — the walker skips them.
    """
    today_d = date.fromisoformat(today)
    lookback_start = (today_d - timedelta(days=30)).isoformat()

    recent_atts = await db.attendance.find(
        {"date": {"$gte": lookback_start, "$lt": today}},
        {"_id": 0, "user_id": 1, "date": 1},
    ).to_list(50000)
    att_dates_by_user: dict = {}
    for a in recent_atts:
        att_dates_by_user.setdefault(a["user_id"], set()).add(a["date"])

    recent_leaves = await db.leaves.find(
        {"status": "approved",
         "start_date": {"$lte": today},
         "end_date":   {"$gte": lookback_start}},
        {"_id": 0, "user_id": 1, "start_date": 1, "end_date": 1},
    ).to_list(5000)
    leave_dates_by_user: dict = {}
    for L in recent_leaves:
        try:
            ls = max(date.fromisoformat(L["start_date"]), today_d - timedelta(days=30))
            le = min(date.fromisoformat(L["end_date"]), today_d)
        except Exception:
            continue
        cur = ls
        while cur <= le:
            leave_dates_by_user.setdefault(L["user_id"], set()).add(cur.isoformat())
            cur += timedelta(days=1)

    recent_breaks = await db.breaks.find(
        {"start_date": {"$lte": today},
         "end_date":   {"$gte": lookback_start}},
        {"_id": 0},
    ).to_list(500)

    def _consecutive_absent_days(u: dict) -> int:
        atts_set = att_dates_by_user.get(u["id"], set())
        leaves_set = leave_dates_by_user.get(u["id"], set())
        weekly_off = (u.get("weekly_off") or "").lower()
        n = 0
        d = today_d - timedelta(days=1)
        for _ in range(30):
            ds = d.isoformat()
            if ds in atts_set or ds in leaves_set:
                break
            covered_by_break = any(
                b.get("start_date") <= ds <= b.get("end_date")
                and _breaks_module.break_applies_to(b, u)
                for b in recent_breaks
            )
            if covered_by_break:
                break
            if _WEEKDAY_KEY[d.weekday()] != weekly_off:
                n += 1
            d -= timedelta(days=1)
        return n

    return _consecutive_absent_days


def make_router(db, get_current_user):
    """Build the Presence Board router. Depends only on the shared Mongo
    handle and the auth dependency — every other helper is a pure import."""
    router = APIRouter(prefix="/api", tags=["presence-board"])

    @router.get("/presence")
    async def presence(on: Optional[str] = None, user: dict = Depends(get_current_user)):
        """Live presence (live=today, view-only=historical).

        Pass `?on=YYYY-MM-DD` to view a past day. On past days everything
        "live" (overdue, notify_due, late recompute, late SMS dispatch) is
        suppressed — the view is read-only. Today is the default.
        """
        # ================== 1. GATHER =====================================
        office = await db.config.find_one({"id": "office"})
        today = local_date_str(office)
        is_historical = bool(on and on != today)
        target_date = on if on else today
        # Anchor for `days_remaining` maths in the per-member loop below.
        # Historical views (`?on=<date>`) compute residual leave relative to
        # that date, not today's; live views use today.
        today_d = date.fromisoformat(target_date)
        users = await db.users.find(
            {"archived": {"$ne": True}}, {"_id": 0, "id": 1, "full_name": 1, "role": 1, "category": 1, "rank": 1,
                 "photo_thumb": 1, "work_start": 1, "work_end": 1, "institution": 1,
                 "dow_hours": 1,  # per-DOW timing override (Jun 2026) → effective_hours
                 "weekly_off": 1,  # needed so the WO-not-absent rule reads the member's real off-day (Jun 2026 fix)
                 "fleet": 1,  # NOTE: needed by break_applies_to() for scope=fleet breaks
                 "leaving_date": 1,  # 24 Feb 2026 — feeds the ex-member filter/chip on the Presence Board
                 "father_mobile": 1, "mother_mobile": 1, "guardian_mobile": 1}
        ).sort("full_name", 1).to_list(2000)

        # Batch: sessions / leaves / last-checkout for the target date.
        # On historical views, all sessions are completed (midnight cron closes
        # them), so we route them through the "exited" path. On today, open
        # sessions go to sess_map; closed ones to last_map.
        if is_historical:
            all_sessions = await db.attendance.find({"date": target_date}, {"_id": 0}).to_list(5000)
            sess_map = {s["user_id"]: s for s in all_sessions if not s.get("check_out_at")}
            last_map = {s["user_id"]: s for s in all_sessions if s.get("check_out_at")}
            # Per-member session count for the day — surfaced as a chip on the
            # Presence Board so admins can spot members who logged a 2nd session
            # (split shift, or accidental double check-in to investigate).
            sessions_count_map: dict = {}
            for s in all_sessions:
                sessions_count_map[s["user_id"]] = sessions_count_map.get(s["user_id"], 0) + 1
        else:
            sessions = await db.attendance.find({"check_out_at": None}, {"_id": 0}).to_list(5000)
            sess_map = {s["user_id"]: s for s in sessions}
            last_outs = await db.attendance.aggregate([
                {"$match": {"check_out_at": {"$ne": None}, "date": target_date}},
                {"$sort": {"check_out_at": -1}},
                {"$group": {"_id": "$user_id", "doc": {"$first": "$$ROOT"}}},
            ]).to_list(5000)
            last_map = {d["_id"]: d["doc"] for d in last_outs}
            # Count today's attendance rows per member (live view). One agg call.
            sessions_count_cursor = await db.attendance.aggregate([
                {"$match": {"date": target_date}},
                {"$group": {"_id": "$user_id", "n": {"$sum": 1}}},
            ]).to_list(5000)
            sessions_count_map = {d["_id"]: d["n"] for d in sessions_count_cursor}

        leaves = await db.leaves.find({
            "status": "approved", "start_date": {"$lte": target_date}, "end_date": {"$gte": target_date},
        }, {"_id": 0}).to_list(5000)
        leave_map = {leave["user_id"]: leave for leave in leaves}
        # Bulk-fetch approved `late_coming` notices for the target date so the
        # per-member loop below doesn't run an N+1 query (one find_one per
        # absent athlete). One filtered scan → dict lookup.
        late_coming_leaves = await db.leaves.find({
            "status": "approved", "type": "late_coming",
            "start_date": {"$lte": target_date}, "end_date": {"$gte": target_date},
        }, {"_id": 0, "user_id": 1, "expected_arrival": 1, "reason": 1}).to_list(2000)
        late_coming_map = {leave["user_id"]: leave for leave in late_coming_leaves}

        # Today's parent-notification dispatches → keyed (user_id, type) for fast lookup.
        # Historical view doesn't show "notify due" so we skip the fetch when on a past day.
        notify_map: dict = {}
        if not is_historical:
            notified_today = await db.parent_notifications.find(
                {"date": target_date}, {"_id": 0, "user_id": 1, "type": 1}
            ).to_list(5000)
            for n in notified_today:
                notify_map.setdefault(n["user_id"], set()).add(n["type"])

        # Camps overlay — fetch all camps whose date range covers the target date.
        camps_today = await _camps_module.fetch_camps_active_on(db, target_date)
        target_dt = date.fromisoformat(target_date)
        DOW_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
        today_weekday = DOW_KEYS[target_dt.weekday()]
        def _camp_for(u: dict) -> Optional[dict]:
            return _camps_module.resolve_member_camp(u, camps_today, today_weekday, target_date)

        # Camps are the SOLE source of "expected" for athlete-like members
        # (user rule, Oct 2026). A camp-less athlete is hidden from the board
        # entirely — never shown as absent/not-due off a personal work_start or
        # a regatta. Employees are unaffected.
        _athlete_like_set = set(await _athlete_like_keys(db))
        def _is_athlete_like(u: dict) -> bool:
            return (u.get("category") or "") in _athlete_like_set

        # Breaks overlay — like an approved leave but applied to whole categories /
        # institutions / arbitrary member groups. Bulk-fetch, resolve per-member.
        breaks_today = await _breaks_module.fetch_breaks_active_on(db, target_date)
        def _break_for(u: dict) -> Optional[dict]:
            return _breaks_module.resolve_member_break(u, breaks_today)

        # Weekly-off / holiday context (employees only). A member with no
        # session on their weekly-off day or on an academy holiday is NOT
        # absent — they're simply not expected, so they render as `not_due`
        # (hidden from the board, excluded from the Absent count). Mirrors the
        # Grid's WO/HO treatment. Fixed Jun 2026 (user: "a lot of employees
        # show absent despite it being their weekly off").
        default_weekly_off = (office.get("default_weekly_off") or "sunday").lower()
        target_is_holiday = (await db.holidays.find_one({"date": target_date}, {"_id": 1})) is not None

        # Admin contacts to surface as the "call the academy" numbers in the SMS body.
        admin_docs = await db.users.find(
            {"role": "admin"},
            {"_id": 0, "id": 1, "full_name": 1, "mobile": 1},
        ).sort("full_name", 1).to_list(50)
        admin_contacts = [
            {"id": a["id"], "full_name": a["full_name"], "mobile": a.get("mobile")}
            for a in admin_docs if a.get("mobile")
        ]
        notify_grace = int(office.get("parent_notify_grace_minutes") or 30)

        # --- 30-day lookback for "consecutive days absent" counter ----------------
        # Bulk-fetches attendance/leaves/breaks for the past 30 days in three
        # queries, then returns a closure that walks backwards per absent
        # member to count their streak. Extracted 14 Feb 2026 (item D of the
        # medium-risk refactor pass) — this ~65 line block is one of the
        # biggest cognitive-load segments of the 665-LOC `presence` function.
        _consecutive_absent_days = await _make_absence_streak_computer(db, today)

        # ================== 2. RESOLVE ====================================
        # Single pass over the roster. Each iteration consumes the bulk-fetched
        # maps from the GATHER phase, applies the camp/break overlays, and
        # emits one fully-populated row for the RENDER phase below.
        result = []
        for u in users:
            # Use a small photo URL in list responses so the Presence Board
            # payload stays tiny (~30 KB vs ~500 KB) regardless of head-count.
            # Browser caches each URL independently via the ?v=hash cache-buster
            # in member_photo_url. See the /api/members list endpoint for the
            # same trick + the /members/{id}/photo endpoint that serves them.
            u_thumb = member_photo_url(u)
            sess = sess_map.get(u["id"])
            leave = leave_map.get(u["id"])
            brk = _break_for(u)
            # Geo info for whichever session is "current" (open session for on-campus/temp-out;
            # last-completed session for exited members).
            geo_in: dict = {}
            geo_out: dict = {}
            if leave and leave["type"] == "tour":
                status_v = "on_tour"
                detail = leave.get("location") or "On tour"
                since = leave["start_date"]
                photo = u_thumb
            elif leave and leave["type"] == "posting":
                # R2 (30 Jun 2026): a posted member shows in the On Tour
                # column but with a "POSTED" label so coaches don't confuse
                # a deputation with a regular short tour. `leave_kind` is
                # forwarded so the frontend chip styling can switch.
                status_v = "on_tour"
                detail = "POSTED" + (f" · {leave.get('location')}" if leave.get("location") else "")
                since = leave["start_date"]
                photo = u_thumb
            elif leave and leave["type"] == "leave":
                status_v = "on_leave"
                end_iso = leave["end_date"]
                # Render as dd/mm/yyyy for the display string. Storage stays
                # ISO — only the human-visible detail is formatted.
                try:
                    y, m, d = end_iso.split("-")
                    end_disp = f"{d}/{m}/{y}"
                except Exception:
                    end_disp = end_iso
                if leave.get("half_day"):
                    detail = f"Half-day · {leave['half_day']} · Till {end_disp}"
                else:
                    detail = f"Till {end_disp}"
                since = leave["start_date"]
                photo = u_thumb
            elif sess:
                # Physical check-in ALWAYS wins over a scheduled break
                # (moved above the `brk` branch 9 Jul 2026 after a scope=all
                # break wiped the On Campus column even for members who'd
                # actually checked in). The break context is still preserved
                # in the detail string so coaches see the anomaly.
                open_exc = _open_excursion(sess)
                if open_exc:
                    status_v = "temp_out"
                    detail = (open_exc.get("reason") or "Stepped out") + " · since " + local_hm(office, open_exc.get("out_at"))
                    since = open_exc.get("out_at")
                    photo = u_thumb
                else:
                    status_v = "on_campus"
                    base_detail = "Since " + local_hm(office, sess["check_in_at"])
                    # Overlay: "…even though today is a break" — small nudge
                    # so admins notice someone came in on a rest day.
                    if brk:
                        detail = f"{base_detail} · on break: {brk.get('name', '').strip()}".rstrip(" :")
                    else:
                        detail = base_detail
                    since = sess["check_in_at"]
                    photo = sess.get("check_in_photo_thumb") or u_thumb
                geo_in = {
                    "method": sess.get("method"),
                    "distance_m": sess.get("distance_m"),
                    "out_of_geofence": bool(sess.get("out_of_geofence")),
                    "geo_unavailable": bool(sess.get("geo_unavailable")),
                    "by": sess.get("checked_in_by"),
                    # Which Training Location did they check in from?
                    # Stamped at check-in via _resolve_site_for — surfaces on
                    # the Presence Board so coaches can tell rowing-boathouse
                    # from gym at a glance (9 Jul 2026 user request).
                    "site_id": sess.get("site_id"),
                    "site_name": sess.get("site_name"),
                }
            elif brk:
                # On break — same precedence as an approved leave. Surfaces under
                # the Leave column with an "On break" tag so coaches can distinguish
                # group breaks from individual leaves at a glance.
                status_v = "on_leave"
                detail = f"On break · {brk.get('name', '')}".rstrip(" ·")
                since = brk.get("start_date")
                photo = u_thumb
            else:
                last = last_map.get(u["id"])
                # Has the member shown any session on the target date? `last`
                # could be from a previous day for live views (now scoped to
                # today's checkouts via the aggregate `$match: date`). Decide
                # between "exited" (closed session today), "absent" (no session,
                # past work_start), or "not_due" (not yet past work_start).
                last_today = bool(last)
                if last_today:
                    status_v = "exited"
                    detail = "Left " + local_hm(office, last["check_out_at"])
                    since = last["check_out_at"]
                    photo = last.get("check_out_photo_thumb") or u_thumb
                    geo_in = {
                        "method": last.get("method"),
                        "distance_m": last.get("distance_m"),
                        "out_of_geofence": bool(last.get("out_of_geofence")),
                        "geo_unavailable": bool(last.get("geo_unavailable")),
                        "by": last.get("checked_in_by"),
                    }
                    geo_out = {
                        "method": last.get("exit_method"),
                        "distance_m": last.get("exit_distance_m"),
                        "out_of_geofence": bool(last.get("exit_out_of_geofence")),
                        "geo_unavailable": bool(last.get("exit_geo_unavailable")),
                        "by": last.get("checked_out_by"),
                    }
                else:
                    # No session today — decide absent vs not_due via work_start.
                    # If an institutional camp is active for this member today, its
                    # times override; otherwise fall back to the member's personal
                    # work_start (or the office default).
                    camp_today = _camp_for(u)
                    off_reason = None  # weekly-off / holiday / left → not_due, not absent
                    # Camps-only rule: an athlete with no camp today isn't expected
                    # at all — hide them from the board (never absent/not-due off a
                    # personal work_start). Camp athletes fall through normally.
                    if _is_athlete_like(u) and not camp_today:
                        continue
                    if camp_today:
                        ws_hm = camp_today.get("start_time") or "09:00"
                        cg = camp_today.get("late_grace_minutes")
                        grace = int(cg if cg is not None else (office.get("late_grace_minutes") or 0))
                        is_expected_today = True
                    else:
                        # Only non-athletes reach here (camp-less athletes skipped
                        # above). Employees are expected on a working day — their
                        # effective start honors any per-DOW timing override. BUT
                        # they're NOT expected (never 'absent') on their weekly-off,
                        # an academy holiday, or after they've left — those render
                        # as not_due with an explanatory chip.
                        is_ex = bool(u.get("leaving_date")) and u["leaving_date"] < target_date
                        if is_ex:
                            off_reason = "Left"
                        elif target_is_holiday:
                            off_reason = "Holiday"
                        elif _is_weekly_off_on(u, default_weekly_off, target_date):
                            off_reason = "Weekly off"
                        ws_hm = _effective_hours(u, office, target_date)[0]
                        grace = int(office.get("late_grace_minutes") or 0)
                        is_expected_today = off_reason is None
                    try:
                        ws_h, ws_m = (int(x) for x in ws_hm.split(":")[:2])
                        if is_historical:
                            # Past day: the workday is fully over; absent decision
                            # doesn't depend on "now". Default past_start=True.
                            past_start = True
                        else:
                            local_now = now_utc().astimezone(office_tz(office))
                            threshold = local_now.replace(hour=ws_h, minute=ws_m, second=0, microsecond=0) + timedelta(minutes=grace)
                            past_start = local_now > threshold
                    except Exception:
                        past_start = True
                    if past_start and is_expected_today:
                        # Approved late-coming notice covering today → softer treatment
                        late_today = late_coming_map.get(u["id"])
                        status_v = "absent"
                        if late_today:
                            ea = late_today.get("expected_arrival")
                            detail = f"Notified late — expected by {ea or 'today'}"
                        elif camp_today:
                            detail = f"Camp “{camp_today['name']}” started {ws_hm}"
                        else:
                            detail = f"Expected by {ws_hm}"
                    else:
                        status_v = "not_due"
                        if off_reason:
                            detail = off_reason
                        elif camp_today:
                            detail = f"Camp “{camp_today['name']}” starts {ws_hm}"
                        elif is_expected_today:
                            detail = f"Shift starts {ws_hm}"
                        else:
                            detail = "Not expected today"
                    since = None
                    photo = u_thumb
            # Open excursion: how many minutes overdue (if expected_return is in the past)?
            # Historical view: no live overdue tracking.
            open_exc_v = _open_excursion(sess) if (sess and not is_historical) else None
            overdue_minutes = 0
            if open_exc_v and open_exc_v.get("expected_return"):
                try:
                    er = datetime.fromisoformat(open_exc_v["expected_return"])
                    overdue_minutes = max(0, int((now_utc() - er).total_seconds() // 60))
                except Exception:
                    overdue_minutes = 0

            # Parent-notification eligibility: "not_arrived" if athlete is absent AND
            # now is past their work_start + notify_grace; "late" if they've checked
            # in late today. Either is suppressed once already dispatched.
            # Suppressed entirely for historical views (no live "notify" action).
            sent_types = notify_map.get(u["id"], set())
            notify_due_not_arrived = False
            notify_due_late = False
            if u.get("category") in ATHLETE_CATEGORIES and not is_historical:
                if status_v == "absent":
                    ws_hm2 = u.get("work_start") or office.get("default_work_start") or "09:00"
                    try:
                        h2, m2 = (int(x) for x in ws_hm2.split(":")[:2])
                        nthr = now_utc().astimezone(office_tz(office)).replace(
                            hour=h2, minute=m2, second=0, microsecond=0
                        ) + timedelta(minutes=notify_grace)
                        if now_utc().astimezone(office_tz(office)) > nthr and "not_arrived" not in sent_types:
                            notify_due_not_arrived = True
                    except Exception:
                        pass
                if status_v == "on_campus" and bool(sess and sess.get("late")) and "late" not in sent_types:
                    notify_due_late = True
            has_parent = bool(u.get("father_mobile") or u.get("mother_mobile") or u.get("guardian_mobile"))

            # Recompute "late" at read-time using current office grace settings.
            # Stored `late` on the session reflects the grace value at check-in time;
            # by recomputing here we let admins drop late_grace_minutes (e.g. 15 → 0)
            # and see the badge update immediately without a session-rewrite migration.
            recomputed_late = False
            if sess and status_v == "on_campus" and sess.get("check_in_at"):
                try:
                    ci = datetime.fromisoformat(sess["check_in_at"])
                    recomputed_late, _ = compute_late(office, u, ci, camp=_camp_for(u))
                except Exception:
                    recomputed_late = bool(sess.get("late"))

            # Extras requested for the Presence Board: excursion count for today's
            # session, days remaining on leave/tour, and consecutive absent streak.
            primary_session = sess or last_map.get(u["id"])
            excursions_today = (primary_session or {}).get("excursions") or []
            excursion_count = len(excursions_today)
            # Detailed timeline for the expand-on-click panel. Each excursion is
            # decorated with derived duration / overdue minutes so the frontend
            # can render without further math.
            ts_now = now_utc()
            excs_detailed = []
            for e in excursions_today:
                out_iso = e.get("out_at")
                in_iso = e.get("in_at")
                duration_min = None
                if out_iso and in_iso:
                    try:
                        duration_min = max(0, int((datetime.fromisoformat(in_iso) - datetime.fromisoformat(out_iso)).total_seconds() // 60))
                    except Exception:
                        pass
                overdue_min = None
                if e.get("expected_return"):
                    try:
                        er = datetime.fromisoformat(e["expected_return"])
                        ref = datetime.fromisoformat(in_iso) if in_iso else ts_now
                        overdue_min = max(0, int((ref - er).total_seconds() // 60))
                    except Exception:
                        pass
                excs_detailed.append({
                    "id": e.get("id"),
                    "out_at": out_iso,
                    "out_time": local_hm(office, out_iso) if out_iso else "",
                    "in_at": in_iso,
                    "in_time": local_hm(office, in_iso) if in_iso else "",
                    "reason": e.get("reason"),
                    "expected_return": e.get("expected_return"),
                    "expected_return_time": local_hm(office, e.get("expected_return")) if e.get("expected_return") else "",
                    "duration_min": duration_min,
                    "overdue_min": overdue_min,
                    "open": not bool(in_iso),
                })
            days_remaining = None
            if status_v in ("on_leave", "on_tour") and leave and leave.get("end_date"):
                try:
                    end_d = date.fromisoformat(leave["end_date"])
                    days_remaining = max(0, (end_d - today_d).days + 1)
                except Exception:
                    days_remaining = None
            elif status_v == "on_leave" and brk and brk.get("end_date"):
                # Member is "on break" (not an individual leave) — show how many
                # more days the break covers them.
                try:
                    end_d = date.fromisoformat(brk["end_date"])
                    days_remaining = max(0, (end_d - today_d).days + 1)
                except Exception:
                    days_remaining = None
            days_absent_streak = _consecutive_absent_days(u) if (status_v == "absent" and not is_historical) else 0

            result.append({
                "id": u["id"],
                "full_name": u["full_name"],
                "role": u["role"],
                "category": u["category"],
                "rank": u.get("rank"),
                "institution": u.get("institution"),
                "fleet": u.get("fleet"),
                "leaving_date": u.get("leaving_date"),
                "status": status_v,
                "detail": detail,
                # Training-location tag (where they were tapped into today).
                # Only meaningful for on_campus + temp_out states — for
                # exited/absent/on_leave/on_tour it stays None. Powers the
                # location filter on the Presence board and the by-location
                # widget on the Admin Dashboard.
                "site_id": (sess or {}).get("site_id") if status_v in ("on_campus", "temp_out") else None,
                "site_name": (sess or {}).get("site_name") if status_v in ("on_campus", "temp_out") else None,
                "since": since,
                "photo": photo,
                "flagged": bool(sess and sess.get("out_of_geofence") and status_v == "on_campus"),
                "late": recomputed_late,
                "expected_return": open_exc_v.get("expected_return") if open_exc_v else None,
                "expected_return_time": local_hm(office, open_exc_v["expected_return"]) if (open_exc_v and open_exc_v.get("expected_return")) else None,
                "overdue_minutes": overdue_minutes,
                "geo_in": geo_in or None,
                "geo_out": geo_out or None,
                "father_mobile": u.get("father_mobile"),
                "mother_mobile": u.get("mother_mobile"),
                "guardian_mobile": u.get("guardian_mobile"),
                "work_start": u.get("work_start"),
                "notified_today": {
                    "not_arrived": "not_arrived" in sent_types,
                    "late": "late" in sent_types,
                },
                "notify_due": {
                    "not_arrived": notify_due_not_arrived and has_parent,
                    "late": notify_due_late and has_parent,
                },
                "excursion_count": excursion_count,
                "excursions": excs_detailed,
                # Count of attendance docs for this member on the target date.
                # >1 means the member ended a session and started a new one
                # (split shift OR an accidental double check-in worth a glance).
                "sessions_today_count": sessions_count_map.get(u["id"], 0),
                # R2: surface the underlying leave row's type so the frontend
                # can differentiate "POSTED" from a regular tour chip even
                # though both render in the on_tour column.
                "leave_kind": (leave or {}).get("type"),
                # Half-day flag (30 Jun 2026): "FN"/"PN" or None. Drives a
                # small chip on the member card so a coach can see at a
                # glance who is only half-day out.
                "half_day": (leave or {}).get("half_day"),
                "days_remaining": days_remaining,
                "days_absent_streak": days_absent_streak,
                "check_in_at": primary_session.get("check_in_at") if primary_session else None,
                "check_in_time": local_hm(office, primary_session["check_in_at"]) if primary_session and primary_session.get("check_in_at") else "",
                "check_out_at": primary_session.get("check_out_at") if primary_session else None,
                "check_out_time": local_hm(office, primary_session["check_out_at"]) if primary_session and primary_session.get("check_out_at") else "",
                "stored_hours": (primary_session or {}).get("hours"),
                "auto_checkout": bool((primary_session or {}).get("auto_checkout")),
                "auto_checkout_reason": (primary_session or {}).get("auto_checkout_reason"),
                "late_minutes": (primary_session or {}).get("late_minutes") or 0,
            })
        # ================== 3. RENDER =====================================
        # Sort, count, and ship. Counts feed the column-header pills on the
        # Presence Board; admin_contacts powers the parent-notify SMS body.
        order = {"on_campus": 0, "temp_out": 1, "on_tour": 2, "on_leave": 3, "absent": 4, "exited": 5, "not_due": 6}
        result.sort(key=lambda r: (order.get(r["status"], 9), r["full_name"]))
        counts = {"on_campus": 0, "temp_out": 0, "exited": 0, "on_tour": 0, "on_leave": 0,
                  "absent": 0, "not_due": 0, "late": 0, "total": len(result)}
        for r in result:
            counts[r["status"]] = counts.get(r["status"], 0) + 1
            if r.get("late"):
                counts["late"] += 1
        # Escorts who are currently on campus (checked in via /escort-checkin
        # but not yet checked out). Surfaced as a small strip above the
        # columns on the Presence Board — escorts aren't in `users` so they
        # never appear in column data. Skip on historical views since escort
        # attendance isn't carried into past-day reconciliation.
        escorts_present: list = []
        if not is_historical:
            # All escort attendance for today — including checked-out rows so
            # they surface in the "Exited" column. Status is derived below:
            #   exited     → check_out_at set
            #   temp_out   → open excursion (return_at unset on any excursion)
            #   on_campus  → checked in, not stepped out, not checked out
            rows = await db.escort_attendance.find(
                {"date": today},
                # Exclusion-only projection — keep all fields except heavy
                # base64 selfies. (Mongo refuses mixed inclusion+exclusion in
                # one projection.)
                {"_id": 0, "check_in_selfie": 0, "check_out_selfie": 0},
            ).to_list(500)
            # Hydrate from `escorts` collection in case the row stored a stale
            # name (admin renamed the escort post check-in).
            escort_ids = [r["escort_id"] for r in rows]
            escort_docs = {
                e["id"]: e for e in await db.escorts.find(
                    {"id": {"$in": escort_ids}},
                    {"_id": 0, "id": 1, "name": 1, "institution": 1,
                     "photo_thumb": 1, "valid_until": 1},
                ).to_list(500)
            }
            for r in rows:
                ed = escort_docs.get(r["escort_id"], {})
                open_excursion = next((x for x in (r.get("excursions") or []) if not x.get("return_at")), None)
                # Status derivation — drives which Presence column the row
                # appears in. `exited` takes precedence over `temp_out`
                # (a row can't be both checked-out and stepped-out).
                if r.get("check_out_at"):
                    status = "exited"
                elif open_excursion:
                    status = "temp_out"
                else:
                    status = "on_campus"
                # If the escort has an open step-out, surface the same overdue
                # signal we compute for members so the frontend can render
                # a colour-coded "Due HH:MM" pill in both surfaces.
                expected_return_iso = None
                expected_return_local = None
                overdue_min = None
                if open_excursion and open_excursion.get("expected_return"):
                    raw_er = open_excursion["expected_return"]
                    # Escort excursions store `expected_return` as raw HH:MM
                    # (no date — assumed same day), member excursions store
                    # it as an ISO datetime. Handle both.
                    try:
                        if "T" in raw_er:
                            er_dt = datetime.fromisoformat(raw_er)
                            expected_return_local = local_hm(office, raw_er)
                        else:
                            # Raw HH:MM — anchor to today in office tz.
                            hh, mm = raw_er.split(":")
                            tz = office_tz(office)
                            today_local = datetime.now(tz)
                            er_dt = today_local.replace(
                                hour=int(hh), minute=int(mm), second=0, microsecond=0,
                            )
                            expected_return_local = raw_er
                        expected_return_iso = er_dt.isoformat()
                        overdue_min = max(0, int((now_utc() - er_dt.astimezone(timezone.utc)).total_seconds() // 60))
                    except (TypeError, ValueError):
                        expected_return_iso = raw_er
                        expected_return_local = raw_er if ":" in (raw_er or "") and "T" not in raw_er else None
                        overdue_min = None
                escorts_present.append({
                    "attendance_id": r["id"],
                    "escort_id": r["escort_id"],
                    "name": ed.get("name") or r.get("escort_name"),
                    "institution": ed.get("institution") or r.get("institution"),
                    "photo": ed.get("photo_thumb") or ed.get("photo"),
                    "check_in_at": r["check_in_at"],
                    "check_out_at": r.get("check_out_at"),
                    "status": status,
                    "athletes_count": len(r.get("check_in_athlete_ids") or []),
                    "temp_out": status == "temp_out",
                    "temp_out_reason": open_excursion.get("reason") if open_excursion else None,
                    "expected_return": expected_return_iso,
                    "expected_return_time": expected_return_local,
                    "overdue_minutes": overdue_min,
                    # Enhancement (30 Jun 2026): forward the escort's access
                    # window-end so the Presence chip can render an amber
                    # dot when expiry is within the next 7 days. Frontend
                    # computes the diff; backend just supplies the raw date.
                    "valid_until": ed.get("valid_until"),
                })
            escorts_present.sort(key=lambda e: ((e.get("institution") or "").lower(), (e.get("name") or "").lower()))

        # ── LOCATION AGGREGATE ────────────────────────────────────────────
        # Group presently-on-campus members by the training location they
        # tapped into today. Members whose session predates the sites
        # feature (or checked in at the main office) end up in "Main Club".
        # `None` site_id + no site_name → also folded into "Main Club".
        by_location_map: dict = {}
        for m in result:
            if m["status"] not in ("on_campus", "temp_out"):
                continue
            sid = m.get("site_id")
            sname = m.get("site_name") or "Main Club"
            key = sid or "__main__"
            bucket = by_location_map.setdefault(key, {
                "site_id": sid,
                "site_name": sname,
                "count": 0,
                "by_category": {"athlete": 0, "elite": 0, "coach": 0, "staff": 0, "executive": 0},
            })
            bucket["count"] += 1
            cat = m.get("category")
            if cat in bucket["by_category"]:
                bucket["by_category"][cat] += 1
        by_location = sorted(
            by_location_map.values(),
            key=lambda b: (-b["count"], (b["site_name"] or "").lower()),
        )

        return {
            "members": result,
            "counts": counts,
            "by_location": by_location,
            "date": target_date,
            "is_historical": is_historical,
            "admin_contacts": admin_contacts,
            "notify_grace_minutes": notify_grace,
            "escorts_present": escorts_present,
        }

    return router
