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

import pathlib
from fastapi import APIRouter, Depends


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

    return router
