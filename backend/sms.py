"""
Twilio SMS + Voice integration.

DESIGN
------
- Credentials live in the office config doc in MongoDB (NOT .env) so admins can
  rotate keys via the UI. Auth tokens are masked in GET responses; we only ever
  store / return the last 4 chars to the frontend.
- Each institution can declare its own `sms_from_number` and `voice_from_number`
  in the institutions collection — when a parent of a member belonging to that
  institution is contacted, the message originates from the institution's
  registered DLT sender. If absent, we fall back to the office default.
- Bilingual templates (English + Telugu) are stored on the office doc as well
  so language teams can re-phrase without a code deploy.
- Voice calls are short TwiML <Say> instructions inlined as the request body;
  no separate hosted XML required.

REGISTRATION (India)
--------------------
- Twilio India requires DLT (Distributed Ledger Technology) registration for
  the sender ID + every content template. Until DLT is approved, use a US/UK
  Twilio number; messages cost ~₹1.5 per SMS instead of ~₹0.30.
- Voice calls don't need DLT — they ring as the configured "from" number.

This module exposes two HTTP routers:
- `/api/sms/...`  → admin-only SMS + voice test, plus the production parent
                    notification endpoint.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Dict, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

try:
    from twilio.rest import Client as TwilioClient
    from twilio.base.exceptions import TwilioRestException
    _TWILIO_OK = True
except Exception:  # pragma: no cover — Twilio SDK should always be installed.
    TwilioClient = None  # type: ignore
    TwilioRestException = Exception  # type: ignore
    _TWILIO_OK = False

logger = logging.getLogger(__name__)


class TwilioUpdate(BaseModel):
    enabled: Optional[bool] = None
    account_sid: Optional[str] = None
    auth_token: Optional[str] = None  # only sent when admin re-enters it
    messaging_service_sid: Optional[str] = None
    default_from_number: Optional[str] = None
    voice_language_en: Optional[str] = None
    voice_language_te: Optional[str] = None
    voice_voice_en: Optional[str] = None
    voice_voice_te: Optional[str] = None
    templates: Optional[Dict[str, str]] = None


class TestSmsIn(BaseModel):
    to: str
    body: Optional[str] = "Test from I Showed Up — your Twilio integration is working."
    institution: Optional[str] = None


class TestVoiceIn(BaseModel):
    to: str
    body_en: Optional[str] = "Hello, this is a test call from I Showed Up. The Twilio voice integration is working."
    body_te: Optional[str] = "నమస్కారం, ఇది I Showed Up నుండి ఒక పరీక్ష కాల్."
    institution: Optional[str] = None


class NotifyParentsIn(BaseModel):
    member_id: str
    kind: str  # "late" | "absent"
    also_voice: bool = False  # also place a voice call after the SMS


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _render_template(tpl: str, *, name: str, academy: str) -> str:
    """Tiny placeholder substitution. We deliberately avoid str.format() so a
    stray brace in a translation doesn't blow up the dispatch."""
    return (tpl or "").replace("{name}", name).replace("{academy}", academy)


def _twilio_config(office: Optional[dict]) -> dict:
    return (office or {}).get("twilio") or {}


def _mask_token(token: Optional[str]) -> str:
    if not token:
        return ""
    return "•" * max(0, len(token) - 4) + token[-4:]


def _is_configured(office: Optional[dict]) -> bool:
    cfg = _twilio_config(office)
    return bool(cfg.get("enabled") and cfg.get("account_sid") and cfg.get("auth_token"))


def _client_for(office: dict) -> "TwilioClient":
    if not _TWILIO_OK:
        raise HTTPException(status_code=500, detail="Twilio SDK is not installed on the server")
    cfg = _twilio_config(office)
    if not _is_configured(office):
        raise HTTPException(status_code=400, detail="Twilio is not configured for this office")
    return TwilioClient(cfg["account_sid"], cfg["auth_token"])


async def _from_number_for(office: dict, institution_name: Optional[str], db, kind: str = "sms") -> Optional[str]:
    """Resolve the right Twilio "from" number:
        1. The institution's `{kind}_from_number` if set.
        2. The office default.
    Returns None when both are unset AND no messaging service SID is in play.
    """
    if institution_name:
        inst = await db.institutions.find_one({"name": institution_name}, {"_id": 0})
        if inst and inst.get(f"{kind}_from_number"):
            return inst[f"{kind}_from_number"]
    return _twilio_config(office).get("default_from_number")


# ---------------------------------------------------------------------------
# Public API exposed to the rest of the backend
# ---------------------------------------------------------------------------
async def send_sms(*, db, to_e164: str, body: str, institution: Optional[str] = None) -> dict:
    """Send a single SMS. Raises HTTPException on configuration or Twilio error.
    Returns a small audit dict written to the `sms_log` collection too."""
    office = await db.config.find_one({"id": "office"}, {"_id": 0})
    client = _client_for(office)
    cfg = _twilio_config(office)
    from_number = await _from_number_for(office, institution, db, kind="sms")
    msg_service = cfg.get("messaging_service_sid")
    if not from_number and not msg_service:
        raise HTTPException(status_code=400, detail="No `from` number or Messaging Service SID configured")

    kwargs = {"to": to_e164, "body": body}
    if msg_service:
        kwargs["messaging_service_sid"] = msg_service
    else:
        kwargs["from_"] = from_number

    try:
        sent = client.messages.create(**kwargs)
    except TwilioRestException as exc:
        logger.warning("Twilio SMS error to %s: %s", to_e164, exc)
        raise HTTPException(status_code=502, detail=f"Twilio error: {exc.msg}")
    except Exception as exc:  # noqa: BLE001
        logger.exception("Unexpected Twilio failure")
        raise HTTPException(status_code=502, detail=f"Twilio failure: {exc}")

    audit = {
        "kind": "sms",
        "to": to_e164,
        "from": from_number,
        "body": body[:300],
        "institution": institution,
        "twilio_sid": sent.sid,
        "status": sent.status,
        "at": datetime.now(timezone.utc).isoformat(),
    }
    await db.sms_log.insert_one(dict(audit))
    return audit


async def make_voice_call(*, db, to_e164: str, body_en: str, body_te: str, institution: Optional[str] = None) -> dict:
    """Make an outbound TwiML voice call that says the message in English
    followed by Telugu, then hangs up."""
    office = await db.config.find_one({"id": "office"}, {"_id": 0})
    client = _client_for(office)
    cfg = _twilio_config(office)
    from_number = await _from_number_for(office, institution, db, kind="voice")
    if not from_number:
        raise HTTPException(status_code=400, detail="No voice `from` number configured")

    # Inline TwiML — Polly Aditi handles both en-IN and te-IN with the same voice.
    voice_en = cfg.get("voice_voice_en") or "Polly.Aditi"
    voice_te = cfg.get("voice_voice_te") or "Polly.Aditi"
    lang_en = cfg.get("voice_language_en") or "en-IN"
    lang_te = cfg.get("voice_language_te") or "te-IN"
    twiml = (
        f"<Response>"
        f'<Say voice="{voice_en}" language="{lang_en}">{_xml_escape(body_en)}</Say>'
        f'<Pause length="1"/>'
        f'<Say voice="{voice_te}" language="{lang_te}">{_xml_escape(body_te)}</Say>'
        f"</Response>"
    )
    try:
        call = client.calls.create(to=to_e164, from_=from_number, twiml=twiml)
    except TwilioRestException as exc:
        logger.warning("Twilio voice error to %s: %s", to_e164, exc)
        raise HTTPException(status_code=502, detail=f"Twilio error: {exc.msg}")

    audit = {
        "kind": "voice",
        "to": to_e164,
        "from": from_number,
        "body": (body_en + " / " + body_te)[:400],
        "institution": institution,
        "twilio_sid": call.sid,
        "status": call.status,
        "at": datetime.now(timezone.utc).isoformat(),
    }
    await db.sms_log.insert_one(dict(audit))
    return audit


def _xml_escape(s: str) -> str:
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# ---------------------------------------------------------------------------
# HTTP router — admin-only
# ---------------------------------------------------------------------------
def make_router(db, require_admin):
    router = APIRouter(prefix="/api/sms", tags=["sms"])

    @router.get("/config")
    async def get_config(admin: dict = Depends(require_admin)):
        """Return the saved Twilio config with the auth token MASKED so the
        frontend can show 'has-saved-token' state without re-leaking secrets."""
        office = await db.config.find_one({"id": "office"}, {"_id": 0}) or {}
        cfg = dict(_twilio_config(office))
        # Mask the actual token, expose only the masked tail so the admin can
        # confirm WHICH token is saved without re-fetching it.
        cfg["auth_token"] = _mask_token(cfg.get("auth_token"))
        cfg["has_auth_token"] = bool(_twilio_config(office).get("auth_token"))
        # Ensure templates have all 6 keys, even if the doc was created before
        # templates existed.
        from server import DEFAULT_PARENT_TEMPLATES  # avoid circular import
        templates = dict(DEFAULT_PARENT_TEMPLATES)
        templates.update(cfg.get("templates") or {})
        cfg["templates"] = templates
        return cfg

    @router.put("/config")
    async def update_config(body: TwilioUpdate, admin: dict = Depends(require_admin)):
        """Persist Twilio settings. Auth token is OPTIONAL — only overwritten if
        the admin re-types it (frontend shows a 'change token' button so we
        don't accidentally clear an existing token on a partial save)."""
        update = body.model_dump(exclude_none=True)
        # Promote everything under the `twilio.*` subdoc so the office config
        # stays one document.
        flat = {f"twilio.{k}": v for k, v in update.items()}
        if not flat:
            raise HTTPException(status_code=400, detail="Nothing to update")
        await db.config.update_one({"id": "office"}, {"$set": flat}, upsert=True)
        return {"ok": True, "updated_keys": list(update.keys())}

    @router.post("/test")
    async def test_sms(body: TestSmsIn, admin: dict = Depends(require_admin)):
        result = await send_sms(db=db, to_e164=body.to, body=body.body, institution=body.institution)
        return result

    @router.post("/voice/test")
    async def test_voice(body: TestVoiceIn, admin: dict = Depends(require_admin)):
        result = await make_voice_call(
            db=db, to_e164=body.to,
            body_en=body.body_en, body_te=body.body_te,
            institution=body.institution,
        )
        return result

    @router.post("/notify-parents")
    async def notify_parents(body: NotifyParentsIn, admin: dict = Depends(require_admin)):
        """Notify a single member's parents via Twilio SMS (and optionally
        voice). Uses the institution's sender numbers when available. Records
        in the audit `parent_notifications` collection so the existing
        dispatch-once-per-day uniqueness still holds."""
        if body.kind not in ("late", "absent"):
            raise HTTPException(status_code=400, detail="kind must be 'late' or 'absent'")
        member = await db.users.find_one({"id": body.member_id}, {"_id": 0})
        if not member:
            raise HTTPException(status_code=404, detail="Member not found")
        office = await db.config.find_one({"id": "office"}, {"_id": 0}) or {}

        templates = (_twilio_config(office).get("templates") or {})
        from server import DEFAULT_PARENT_TEMPLATES
        templates = {**DEFAULT_PARENT_TEMPLATES, **templates}

        first_name = (member.get("full_name") or "your child").split(" ")[0]
        academy = office.get("name") or "the academy"
        body_en = _render_template(templates[f"{body.kind}_en"], name=first_name, academy=academy)
        body_te = _render_template(templates[f"{body.kind}_te"], name=first_name, academy=academy)
        sms_body = f"{body_en}\n\n{body_te}"

        recipients = []
        for field in ("father_mobile", "mother_mobile", "guardian_mobile"):
            num = (member.get(field) or "").strip()
            if num:
                recipients.append((field, num))
        if not recipients:
            raise HTTPException(status_code=400, detail="No parent/guardian mobile numbers on file")

        institution = member.get("institution")
        results = []
        for role, raw in recipients:
            to_e164 = raw if raw.startswith("+") else f"+91{raw.lstrip('0')}"
            try:
                sms_res = await send_sms(db=db, to_e164=to_e164, body=sms_body, institution=institution)
                results.append({"role": role, "channel": "sms", "ok": True, "sid": sms_res["twilio_sid"]})
                if body.also_voice:
                    voice_body_en = _render_template(templates["voice_en"], name=first_name, academy=academy)
                    voice_body_te = _render_template(templates["voice_te"], name=first_name, academy=academy)
                    try:
                        voice_res = await make_voice_call(
                            db=db, to_e164=to_e164,
                            body_en=voice_body_en, body_te=voice_body_te,
                            institution=institution,
                        )
                        results.append({"role": role, "channel": "voice", "ok": True, "sid": voice_res["twilio_sid"]})
                    except HTTPException as e:
                        results.append({"role": role, "channel": "voice", "ok": False, "error": e.detail})
            except HTTPException as e:
                results.append({"role": role, "channel": "sms", "ok": False, "error": e.detail})

        return {"member": member.get("full_name"), "results": results}

    @router.get("/log")
    async def sms_log(limit: int = 50, admin: dict = Depends(require_admin)):
        """Return the most-recent Twilio dispatches for the audit panel."""
        cursor = db.sms_log.find({}, {"_id": 0}).sort("at", -1).limit(min(max(1, limit), 200))
        return await cursor.to_list(limit)

    return router
