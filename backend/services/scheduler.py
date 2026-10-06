"""Background daily jobs: midnight auto-checkout + "forgot to check out" SMS reminder.
Moved out of server.py (Oct 2026) — behaviour unchanged."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from services.time_utils import local_date_str, now_utc, office_tz

logger = logging.getLogger("server")


# ----------------------------------------------------------------------------
# Midnight auto-checkout
# Members who forget to check out leave open sessions hanging across days.
# A background task closes any open session whose date < today (office-local)
# every midnight, stamping it as auto_checkout and setting hours from
# check_in_at to 23:59:59 of the original day.
# ----------------------------------------------------------------------------
async def close_stale_open_sessions(db, reason: str) -> int:
    """Close every attendance session with check_out_at=None whose `date` is
    before today in office-local time. Returns count of sessions closed.

    Jun 2026 (user request — "members leave in 2h without checking out, so
    hours are wrong"): a forgotten checkout must NOT credit inflated hours.
    We close the session so the member stops showing on-campus, but stamp it
    `missing_checkout` / `needs_correction` with **hours=None** so payroll
    excludes it until an admin or the member fixes the real checkout time.
    `check_out_at` is set to the member's scheduled `work_end` for that day
    (falling back to the office default, then end-of-day) purely so the row
    is closed and shows a plausible boundary — the hours stay uncredited.
    """
    office = await db.config.find_one({"id": "office"}, {"_id": 0})
    today_str = local_date_str(office)
    tz = office_tz(office)
    default_end = (office or {}).get("default_work_end") or "17:00"
    cur = db.attendance.find({"check_out_at": None, "date": {"$lt": today_str}}, {"_id": 0})
    count = 0
    async for sess in cur:
        try:
            ci = datetime.fromisoformat(sess["check_in_at"])
            # Prefer the member's own work_end, else office default.
            u = await db.users.find_one({"id": sess.get("user_id")}, {"_id": 0, "work_end": 1})
            end_hm = (u or {}).get("work_end") or default_end
            hh, mm = (int(x) for x in str(end_hm).split(":"))
            close_local = datetime.fromisoformat(sess["date"] + f"T{hh:02d}:{mm:02d}:00").replace(tzinfo=tz)
            close_utc = close_local.astimezone(timezone.utc)
            # Never let the boundary precede check-in (e.g. an evening session
            # started after work_end) — fall back to end-of-day.
            if close_utc <= ci:
                eod_local = datetime.fromisoformat(sess["date"] + "T23:59:59").replace(tzinfo=tz)
                close_utc = eod_local.astimezone(timezone.utc)
        except Exception:
            close_utc = now_utc()
        await db.attendance.update_one(
            {"id": sess["id"]},
            {"$set": {
                "check_out_at": close_utc.isoformat(),
                "auto_checkout": True,
                "auto_checkout_reason": reason,
                "missing_checkout": True,
                "needs_correction": True,
                # Uncredited — a forgotten checkout adds ZERO hours to payroll
                # until corrected. (All hour sums use `(hours or 0)`.)
                "hours": None,
            }},
        )
        count += 1
    return count


async def schedule_daily(db, label: str, get_target_hm, fn) -> None:
    """Run `fn()` once per office-local day at the HH:MM returned by
    `get_target_hm(office)`. `get_target_hm` is recalled on each tick so
    a config change (e.g. admin moves the reminder time) is picked up
    without a server restart.

    `label` is purely for log messages. Resilient — caught exceptions log
    and retry in 1h instead of killing the loop.
    """
    while True:
        try:
            office = await db.config.find_one({"id": "office"}, {"_id": 0}) or {}
            tz = office_tz(office)
            now_local = datetime.now(tz)
            hh, mm = get_target_hm(office)
            target = now_local.replace(hour=hh, minute=mm, second=10, microsecond=0)
            if target <= now_local:
                target += timedelta(days=1)
            wait = max(60, (target - now_local).total_seconds())
            await asyncio.sleep(wait)
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("%s scheduler tick failed; retrying in 1h", label)
            await asyncio.sleep(3600)
            continue
        try:
            n = await fn()
            if n:
                logger.info("%s: ran with result=%s", label, n)
        except Exception:
            logger.exception("%s job failed", label)


async def midnight_auto_checkout_loop(db):
    """Sleep until office-local midnight (+10s), then close yesterday's
    open sessions. Wrapper kept for readability of the cron intent."""
    async def _run():
        return await close_stale_open_sessions(db, "midnight_cron")
    await schedule_daily(db, "midnight-auto-checkout", lambda _office: (0, 0), _run)


# ----------------------------------------------------------------------------
# "Forgot to check out" SMS reminder
# Daily, at the office-local `checkout_reminder_time`, send one SMS to every
# member who has an open session for today AND hasn't already been reminded.
# Idempotent: writes `reminder_sent_at` on the attendance doc.
# ----------------------------------------------------------------------------
async def send_checkout_reminders(db) -> int:
    """Find every open session for today and ping the member's own phone.
    Returns the count of reminders actually sent."""
    office = await db.config.find_one({"id": "office"}, {"_id": 0}) or {}
    if not office.get("checkout_reminder_enabled", True):
        return 0
    today = local_date_str(office)
    open_sessions = await db.attendance.find(
        {"date": today, "check_out_at": None, "reminder_sent_at": None},
        {"_id": 0, "id": 1, "user_id": 1},
    ).to_list(2000)
    if not open_sessions:
        return 0

    user_ids = [s["user_id"] for s in open_sessions]
    users = await db.users.find(
        {"id": {"$in": user_ids}}, {"_id": 0, "id": 1, "full_name": 1, "mobile": 1, "institution": 1},
    ).to_list(2000)
    umap = {u["id"]: u for u in users}

    template = (office.get("checkout_reminder_template")
                or "Hi {name}, looks like you're still checked in at {academy}. Please check out via the app when you leave.")
    academy = office.get("name") or "the academy"

    # Import lazily to avoid circular imports during module load.
    import sms as _sms

    sent = 0
    for s in open_sessions:
        u = umap.get(s["user_id"])
        if not u or not u.get("mobile"):
            continue
        body = template.format(name=u.get("full_name") or "there", academy=academy)
        try:
            await _sms.send_sms(db=db, to_e164=u["mobile"], body=body, institution=u.get("institution"))
            sent += 1
            await db.attendance.update_one(
                {"id": s["id"]},
                {"$set": {"reminder_sent_at": now_utc().isoformat()}},
            )
        except Exception:
            logger.exception("checkout-reminder SMS failed for user %s", s["user_id"])
    return sent


async def checkout_reminder_loop(db):
    """Sleep until the configured office-local reminder time, fire the
    batch, repeat. Time is re-read from config each tick so admin edits
    in the UI take effect on the next cycle."""
    def _hm_from(office):
        t = (office.get("checkout_reminder_time") or "20:00").split(":")
        try:
            return int(t[0]), int(t[1])
        except (ValueError, IndexError):
            return 20, 0
    await schedule_daily(db, "checkout-reminder", _hm_from, lambda: send_checkout_reminders(db))
