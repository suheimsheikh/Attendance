"""Platform-cron endpoints. Secured by a bearer secret (WEBHOOK_CRON_SECRET);
the schedule lives in .emergent/crons.yml.

Cron endpoints must ack 2xx immediately; enqueue/background the actual work.
"""
from __future__ import annotations

import hmac
import logging
import os

from fastapi import APIRouter, BackgroundTasks, Header, HTTPException

from routes.admin_tools import run_auto_backup

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

    return router
