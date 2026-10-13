"""Platform-cron endpoints. Secured by a bearer secret (WEBHOOK_CRON_SECRET);
the schedule lives in .emergent/crons.yml.

Cron endpoints must ack 2xx immediately; enqueue/background the actual work.
"""
from __future__ import annotations

import hmac
import logging
import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException

from routes.admin_tools import run_auto_backup
from services.time_utils import office_tz, local_date_str

logger = logging.getLogger(__name__)


def make_router(db) -> APIRouter:
    router = APIRouter(prefix="/api")

    def _check_auth(authorization: str | None) -> None:
        secret = os.environ.get("WEBHOOK_CRON_SECRET") or ""
        token = ""
        if authorization and authorization.lower().startswith("bearer "):
            token = authorization[7:].strip()
        if not secret or not token or not hmac.compare_digest(token, secret):
            raise HTTPException(status_code=401, detail="Unauthorized")

    async def _do_auto_backup(run_id: str) -> None:
        try:
            await run_auto_backup(db)
        except Exception as e:  # never crash the worker — just log
            logger.exception("Auto-backup run %s failed: %s", run_id, e)

    async def _do_close_stale(run_id: str) -> None:
        """Close attendance sessions left open from a previous office-local
        day so a forgotten check-out doesn't balloon into a 16h+/stale record
        (exactly the Data Quality findings). Each session is closed at that
        day's work-end (member override → office default → 18:00); if that is
        not after the check-in we fall back to check-in + 9h. Flags the row so
        it reads as an auto-closed forgotten checkout and stays reversible."""
        try:
            office = await db.config.find_one({"id": "office"}) or {}
            tz = office_tz(office)
            today = local_date_str(office)
            default_end = office.get("default_work_end") or "18:00"
            cursor = db.attendance.find({"check_out_at": None, "date": {"$lt": today}})
            closed = 0
            async for s in cursor:
                try:
                    cin = datetime.fromisoformat(s["check_in_at"])
                except Exception:
                    continue
                if cin.tzinfo is None:
                    cin = cin.replace(tzinfo=timezone.utc)
                cin_local = cin.astimezone(tz)
                member = await db.users.find_one({"id": s.get("user_id")}, {"_id": 0, "work_end": 1}) or {}
                hm = member.get("work_end") or default_end
                try:
                    h, m = (int(x) for x in str(hm).split(":")[:2])
                except Exception:
                    h, m = 18, 0
                close_local = cin_local.replace(hour=h, minute=m, second=0, microsecond=0)
                if close_local <= cin_local:
                    close_local = cin_local + timedelta(hours=9)
                close_utc = close_local.astimezone(timezone.utc)
                hours = round(max(0.0, (close_utc - cin).total_seconds() / 3600.0), 2)
                await db.attendance.update_one({"id": s["id"]}, {"$set": {
                    "check_out_at": close_utc.isoformat(),
                    "hours": hours,
                    "forgot_checkout": True,
                    "auto_closed_by_cron": True,
                    "exit_method": "auto_close_cron",
                }})
                closed += 1
            logger.info("close-stale-sessions run %s closed %d session(s)", run_id, closed)
        except Exception as e:
            logger.exception("close-stale-sessions run %s failed: %s", run_id, e)

    @router.post("/cron/daily-backup")
    async def cron_daily_backup(
        background_tasks: BackgroundTasks,
        authorization: str | None = Header(default=None),
        x_webhook_id: str | None = Header(default=None),
    ):
        # Cron endpoints must ack 2xx immediately; enqueue/background the actual work.
        _check_auth(authorization)
        run_id = x_webhook_id or "manual"
        # Idempotency: skip if we've already handled this delivery id.
        if run_id != "manual":
            existing = await db.cron_runs.find_one({"run_id": run_id, "job": "daily-backup"})
            if existing:
                return {"ok": True, "duplicate": True}
            await db.cron_runs.insert_one({"run_id": run_id, "job": "daily-backup"})
        background_tasks.add_task(_do_auto_backup, run_id)
        return {"ok": True, "queued": True}

    @router.post("/cron/close-stale-sessions")
    async def cron_close_stale_sessions(
        background_tasks: BackgroundTasks,
        authorization: str | None = Header(default=None),
        x_webhook_id: str | None = Header(default=None),
    ):
        # Cron endpoints must ack 2xx immediately; enqueue/background the actual work.
        _check_auth(authorization)
        run_id = x_webhook_id or "manual"
        if run_id != "manual":
            existing = await db.cron_runs.find_one({"run_id": run_id, "job": "close-stale-sessions"})
            if existing:
                return {"ok": True, "duplicate": True}
            await db.cron_runs.insert_one({"run_id": run_id, "job": "close-stale-sessions"})
        background_tasks.add_task(_do_close_stale, run_id)
        return {"ok": True, "queued": True}

    return router
