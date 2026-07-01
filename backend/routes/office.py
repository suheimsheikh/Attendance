"""
Office config + lightweight admin tools — split out of `server.py`
during the 06/2026 modularisation pass.

Covers:
  • GET  /api/office                                  — read office config
                                                        (Twilio token masked).
  • PUT  /api/office                                  — admin save geofence,
                                                        hours, timezone.
  • POST /api/admin/checkout-reminder/send-now        — trigger the
                                                        forgot-to-checkout
                                                        SMS batch immediately.
  • GET  /api/changelog                               — repo CHANGELOG.md
                                                        for the in-app
                                                        "What's new" page.

`OfficeConfig` lives in server.py (the full model has the Twilio sub-doc
which is tied to the SMS module setup). The factory accepts the class so
this module doesn't need a back-import.
"""

import os
import pathlib
import subprocess
import time
from functools import lru_cache
from fastapi import APIRouter, Depends


@lru_cache(maxsize=1)
def _cached_version() -> str:
    """Resolve the app version once per process.

    Precedence:
      1. `APP_VERSION` env var — set by the deploy script (e.g. to the
         git SHA at build time). Preferred because it survives cache
         layers and container restarts identically.
      2. `git rev-parse --short HEAD` executed against the repo the
         container was built from. Works in-place when the .git dir
         is present.
      3. Container-start timestamp (fallback). Guarantees the endpoint
         always returns a stable string per-restart, so at worst the
         version-poller triggers a refresh on the first backend restart
         after a stale-cached tab reconnects.
    """
    env = os.environ.get("APP_VERSION", "").strip()
    if env:
        return env
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=pathlib.Path(__file__).resolve().parent.parent.parent,
            capture_output=True, text=True, timeout=2,
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip()
    except Exception:
        pass
    return f"boot-{int(time.time())}"


def make_router(db, require_admin, get_current_user, send_checkout_reminders, OfficeConfig) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/office")
    async def get_office(user: dict = Depends(get_current_user)):
        office = await db.config.find_one({"id": "office"}, {"_id": 0})
        if not office:
            return office
        # QR-based check-in was removed in favour of GPS — strip the now-dead
        # `qr_token` so it never leaks to authenticated members.
        office.pop("qr_token", None)
        # Mask the Twilio auth token so it's never sent back in plaintext over the
        # wire. The frontend renders a "Change token" button instead of exposing it.
        if (office.get("twilio") or {}).get("auth_token"):
            tok = office["twilio"]["auth_token"]
            office["twilio"] = {
                **office["twilio"],
                "auth_token": "•" * max(0, len(tok) - 4) + tok[-4:],
                "has_auth_token": True,
            }
        elif "twilio" in office:
            office["twilio"] = {**office["twilio"], "has_auth_token": False}
        return office

    @router.put("/office")
    async def update_office(body: OfficeConfig, admin: dict = Depends(require_admin)):
        # The Office page only edits geofence / hours / timezone — Twilio settings
        # use the dedicated /api/sms/config endpoint so a partial save here never
        # wipes credentials. We drop the twilio subdoc to prevent accidental nuke.
        payload = body.model_dump()
        payload.pop("twilio", None)
        await db.config.update_one({"id": "office"}, {"$set": payload})
        return await db.config.find_one({"id": "office"}, {"_id": 0})

    @router.post("/admin/checkout-reminder/send-now")
    async def admin_send_checkout_reminders_now(admin: dict = Depends(require_admin)):
        """Trigger the forgot-to-checkout SMS batch immediately. Same idempotency
        rules apply — members already pinged today won't be re-pinged."""
        n = await send_checkout_reminders()
        return {"sent": n}

    @router.get("/changelog")
    async def get_changelog():
        """Read the repo CHANGELOG.md so the in-app "What's new" page can render
        it. Available to anyone who can reach the API — coaches and athletes get
        to see what's new too. Returns plain markdown text."""
        path = pathlib.Path(__file__).resolve().parent.parent.parent / "CHANGELOG.md"
        if not path.exists():
            return {"markdown": "# Changelog\n\n_Not available yet._"}
        return {"markdown": path.read_text(encoding="utf-8")}

    @router.get("/version")
    async def app_version():
        """Return the currently deployed app version.

        Public — no auth needed — because the frontend polls this every
        60 s (even on the login screen) to detect deploys and prompt
        users to reload for the new bundle. Returns a stable string:
        preferred is the git SHA set via the `APP_VERSION` env var; the
        boot-timestamp fallback still guarantees a fresh value per
        container start. Cached at import time so the endpoint stays
        cheap even under aggressive polling.
        """
        return {"version": _cached_version()}

    return router
