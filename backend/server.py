from fastapi import FastAPI, APIRouter, HTTPException, Depends, UploadFile, File, Query
from fastapi.responses import Response
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import DuplicateKeyError
from fastapi.security import OAuth2PasswordBearer
import os
import io
import math
import uuid
import logging
import bcrypt
import jwt
import re
import openpyxl
from openpyxl.utils import get_column_letter
import base64
from PIL import Image
from pathlib import Path
from pydantic import BaseModel, Field, EmailStr
from typing import List, Optional, Literal, Tuple, Dict
from datetime import datetime, timezone, timedelta, date
from zoneinfo import ZoneInfo
from contextlib import asynccontextmanager

# Local modules — imported up-top so `_active_camp_for` (used during request
# handling for check-in late computation) can reference them.
import camps as _camps_module
import regattas as _regattas_module
import breaks as _breaks_module
# Re-export shared SMS template constants from the SMS module so any legacy
# `from server import DEFAULT_PARENT_TEMPLATES` callers keep working.
from sms import DEFAULT_PARENT_TEMPLATES  # noqa: F401

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# ----------------------------------------------------------------------------
# Config & DB
# ----------------------------------------------------------------------------
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

JWT_SECRET = os.environ['JWT_SECRET_KEY']
JWT_ALGO = os.environ['JWT_ALGORITHM']
JWT_EXPIRES_MINUTES = int(os.environ['JWT_EXPIRES_MINUTES'])
ADMIN_EMAIL = os.environ['ADMIN_SEED_EMAIL']
ADMIN_PASSWORD = os.environ['ADMIN_SEED_PASSWORD']

def _lifespan_factory(app):
    # Resolved at startup, not at module-import time, so the actual
    # @asynccontextmanager body can be defined further down the file.
    return _lifespan(app)

app = FastAPI(lifespan=_lifespan_factory)
api_router = APIRouter(prefix="/api")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------------
# Soft pagination caps — the Mongo `to_list(N)` calls scattered through this
# file all use one of these limits. Centralising makes the implicit
# truncation behaviour visible at a glance and easy to scale up later.
# ----------------------------------------------------------------------------
MAX_USERS = 5000          # roster + dropdowns. Academy is <500 today.
MAX_SESSIONS = 100000     # attendance rows in a single report window.
MAX_LEAVES = 20000
MAX_DEVICES = 2000
MAX_LOG_ROWS = 200


# ----------------------------------------------------------------------------
# Pure helpers (time, geo, photo, phone, auth, attendance math) live in
# `services/`. Re-exported from `server.py` so existing handlers continue to
# work unchanged, and so external imports (`from server import compute_late`)
# remain valid until callers are migrated to the new locations.
# ----------------------------------------------------------------------------
from services.time_utils import (  # noqa: E402
    DEFAULT_TZ, now_utc, iso, office_tz, local_now, local_date_str, local_hm,
)
from services.geo import haversine_m  # noqa: E402
from services.phone import normalize_phone, phone_key  # noqa: E402
from services.photo import (  # noqa: E402
    MAX_PHOTO_BYTES, THUMB_MAX_PX, THUMB_QUALITY,
    check_photo_size as _check_photo_size,
    make_thumbnail as _make_thumbnail,
)
from services.auth_utils import (  # noqa: E402
    hash_password, verify_password, create_token,
)
from services.attendance_calc import (  # noqa: E402
    OVERTIME_THRESHOLD_MIN, OVERTIME_CATEGORIES,
    compute_late,
    hm_to_minutes as _hm_to_minutes,
    compute_overtime_in, compute_overtime_out,
    excursion_seconds as _excursion_seconds,
    open_excursion as _open_excursion,
    parse_expected_return as _parse_expected_return,
)


async def _active_camp_for(target: dict, ts: datetime, office: dict) -> Optional[dict]:
    """Look up the camp that applies to `target` at timestamp `ts` (used at
    check-in time so the stored late/late_minutes reflect the camp overlay)."""
    today_str = local_date_str(office, ts)
    weekday = _camps_module.weekday_key(ts.astimezone(office_tz(office)))
    camps_today = await _camps_module.fetch_camps_active_on(db, today_str)
    return _camps_module.resolve_member_camp(target, camps_today, weekday, today_str)


# Long-lived tokens for approved devices (passwordless phone login)
DEVICE_TOKEN_MINUTES = 60 * 24 * 365 * 2  # ~2 years


async def get_current_user(token: str = Depends(oauth2_scheme)) -> dict:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
        user_id = payload.get("sub")
        device_id = payload.get("device_id")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token has expired")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Could not validate token")
    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    # Device-bound tokens (passwordless phone login) must reference an approved device.
    if device_id:
        device = await db.devices.find_one({"device_id": device_id, "user_id": user_id}, {"_id": 0})
        if not device or device.get("status") != "approved":
            raise HTTPException(status_code=401, detail="This device is no longer authorised")
    return user


async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin privileges required")
    return user


async def require_coach_or_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") == "admin":
        return user
    if user.get("category") == "coach":
        return user
    raise HTTPException(status_code=403, detail="Coach or admin privileges required")


# ----------------------------------------------------------------------------
# Models
# ----------------------------------------------------------------------------
class LoginIn(BaseModel):
    email: EmailStr
    password: str


class UserPublic(BaseModel):
    id: str
    email: str  # plain str on output — validated on input via MemberCreate.email: EmailStr
    full_name: str
    role: str
    category: str
    rank: Optional[str] = None
    mobile: Optional[str] = None
    work_start: Optional[str] = None
    work_end: Optional[str] = None
    photo: Optional[str] = None
    photo_captured_at: Optional[str] = None
    institution: Optional[str] = None
    gender: Optional[str] = None
    fleet: Optional[str] = None
    father_mobile: Optional[str] = None
    father_name: Optional[str] = None
    mother_mobile: Optional[str] = None
    mother_name: Optional[str] = None
    guardian_mobile: Optional[str] = None
    guardian_name: Optional[str] = None


class MemberCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=4)
    full_name: str
    category: Literal["athlete", "staff", "coach", "executive"] = "athlete"
    rank: Optional[str] = None
    mobile: Optional[str] = None
    work_start: Optional[str] = None
    work_end: Optional[str] = None
    role: Literal["admin", "member"] = "member"
    institution: Optional[str] = None
    gender: Optional[Literal["M", "F", "O"]] = None
    # Fleet = which boat class this athlete trains in (e.g. Optimist,
    # Laser 4.7, ILCA 6, 420). Free-text so academies can name fleets
    # however they like; used for filtering & bulk actions.
    fleet: Optional[str] = None
    weekly_off: Literal["monday","tuesday","wednesday","thursday","friday","saturday","sunday"] = "monday"
    father_mobile: Optional[str] = None
    father_name: Optional[str] = None
    mother_mobile: Optional[str] = None
    mother_name: Optional[str] = None
    guardian_mobile: Optional[str] = None
    guardian_name: Optional[str] = None


class MemberUpdate(BaseModel):
    full_name: Optional[str] = None
    category: Optional[Literal["athlete", "staff", "coach", "executive"]] = None
    rank: Optional[str] = None
    mobile: Optional[str] = None
    work_start: Optional[str] = None
    work_end: Optional[str] = None
    photo: Optional[str] = None
    password: Optional[str] = None
    role: Optional[Literal["admin", "member"]] = None
    institution: Optional[str] = None
    gender: Optional[Literal["M", "F", "O"]] = None
    fleet: Optional[str] = None
    weekly_off: Optional[Literal["monday","tuesday","wednesday","thursday","friday","saturday","sunday"]] = None
    leave_balance_opening: Optional[float] = None
    father_mobile: Optional[str] = None
    father_name: Optional[str] = None
    mother_mobile: Optional[str] = None
    mother_name: Optional[str] = None
    guardian_mobile: Optional[str] = None
    guardian_name: Optional[str] = None


class LeaveBalanceBulkRow(BaseModel):
    member_id: str
    opening: float


class LeaveBalanceBulkIn(BaseModel):
    rows: List[LeaveBalanceBulkRow]


class InstitutionIn(BaseModel):
    name: str
    short_name: Optional[str] = None
    active: bool = True
    # Per-institution Twilio "from" numbers. When a parent of an athlete in this
    # institution is notified, the SMS/voice call originates from this number
    # instead of the office default — gives each institution its own caller-ID
    # branding (MJPT parents see the MJPT number, YCH parents see YCH, etc.).
    sms_from_number: Optional[str] = None
    voice_from_number: Optional[str] = None


class FleetIn(BaseModel):
    # A "fleet" is a sailing boat class (e.g. Optimist, ILCA 6, 420). Stored
    # as a master so admins get a clean dropdown when editing athletes
    # instead of free-text drift ("420", "Four-twenty", "Dinghy 420"). The
    # `name` is the canonical label and is what's actually written onto
    # each athlete's `fleet` field — renaming the fleet master row
    # cascades the rename through every athlete record.
    name: str
    short_name: Optional[str] = None
    notes: Optional[str] = None
    active: bool = True


class TwilioConfig(BaseModel):
    """Stored in the office config doc — NOT in .env — so admins can rotate
    credentials from the UI without a deploy. The auth token is masked in
    GET responses (only the last 4 chars are returned)."""
    enabled: bool = False
    account_sid: Optional[str] = None
    auth_token: Optional[str] = None
    messaging_service_sid: Optional[str] = None   # alternative to per-number from
    default_from_number: Optional[str] = None      # E.164, e.g. "+15551234567"
    voice_language_en: str = "en-IN"
    voice_language_te: str = "te-IN"
    voice_voice_en: str = "Polly.Aditi"            # Polly.Aditi supports en-IN + te-IN
    voice_voice_te: str = "Polly.Aditi"
    # Bilingual message templates — kept here so admins can rephrase without code.
    templates: Dict[str, str] = Field(default_factory=lambda: dict(DEFAULT_PARENT_TEMPLATES))


class OfficeConfig(BaseModel):
    name: str = "Campus Office"
    latitude: float = 0.0
    longitude: float = 0.0
    radius_m: int = 100
    default_work_start: str = "09:00"
    default_work_end: str = "17:00"
    timezone: str = "Asia/Kolkata"
    late_grace_minutes: int = 0
    parent_notify_grace_minutes: int = 30
    # Daily reminder SMS to anyone still checked-in. The cron fires at
    # `checkout_reminder_time` (office-local HH:MM) and sends one SMS per
    # member who has an open session for today AND hasn't already been
    # reminded (idempotent via reminder_sent_at on the attendance doc).
    checkout_reminder_enabled: bool = True
    checkout_reminder_time: str = "20:00"
    checkout_reminder_template: str = "Hi {name}, looks like you're still checked in at {academy}. Please check out via the app when you leave."
    twilio: TwilioConfig = Field(default_factory=TwilioConfig)


class GeoToggleIn(BaseModel):
    latitude: float
    longitude: float
    reason: Optional[str] = None
    overtime_reason: Optional[str] = None


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


class PhoneLoginIn(BaseModel):
    phone: str
    device_id: str
    device_name: Optional[str] = None
    model: Optional[str] = None
    platform: Optional[str] = None
    # Self-introduction provided on first sign-in (used to pre-fill the
    # admin approval form for brand-new members).
    full_name: Optional[str] = None
    rank: Optional[str] = None
    category: Optional[Literal["athlete", "staff", "coach", "executive"]] = None


class DeviceApproveIn(BaseModel):
    full_name: Optional[str] = None
    role: Literal["admin", "member"] = "member"
    category: Literal["athlete", "staff", "coach", "executive"] = "athlete"
    rank: Optional[str] = None



class TempExitIn(BaseModel):
    """Temporary exit during an open attendance session (e.g. lunch, errand)."""
    reason: str = Field(min_length=1)
    expected_return: Optional[str] = None  # ISO datetime OR HH:MM (office local)
    latitude: Optional[float] = None
    longitude: Optional[float] = None


class TempReturnIn(BaseModel):
    latitude: Optional[float] = None
    longitude: Optional[float] = None



# Geo helpers — see services/geo.py (re-exported above).
# (PIL bomb guard is set in services/photo.py at import time.)


# ----------------------------------------------------------------------------
# Startup: seed admin + office config
# ----------------------------------------------------------------------------
async def _seed_database() -> None:
    """One-shot bootstrap: indexes, admin seed, office config, backfills.
    Called from the lifespan startup hook."""
    await db.users.create_index("email", unique=True)
    await db.users.create_index("id", unique=True)
    await db.devices.create_index("device_id", unique=True)
    # Prevent duplicate parent-notification dispatches per (user, day, type)
    # if two coaches tap "Notify parents" simultaneously.
    await db.parent_notifications.create_index(
        [("user_id", 1), ("date", 1), ("type", 1)], unique=True
    )
    # Hot-path indexes — added 06/2026 after a code review flagged that the
    # phone-login matcher and /presence aggregations were doing full collection
    # scans. With ~150 members today the wins are small; once attendance grows
    # past a few thousand sessions these matter a lot.
    await db.users.create_index("mobile")
    await db.users.create_index("mobile_last10")
    await db.attendance.create_index([("user_id", 1), ("date", -1)])
    await db.attendance.create_index("check_out_at")
    await db.leaves.create_index([("status", 1), ("start_date", 1), ("end_date", 1)])
    await db.leaves.create_index([("user_id", 1), ("status", 1)])
    existing = await db.users.find_one({"email": ADMIN_EMAIL})
    if not existing:
        await db.users.insert_one({
            "id": str(uuid.uuid4()),
            "email": ADMIN_EMAIL,
            "full_name": "Campus Administrator",
            "role": "admin",
            "category": "staff",
            "rank": "Admin",
            "photo": None,
            "hashed_password": hash_password(ADMIN_PASSWORD),
            "created_at": now_utc().isoformat(),
        })
        logger.info("Seeded admin user")
    office = await db.config.find_one({"id": "office"})
    if not office:
        await db.config.insert_one({
            "id": "office",
            "name": "Campus Office",
            "latitude": 19.0760,
            "longitude": 72.8777,
            "radius_m": 100,
        })
        logger.info("Seeded office config")
    # Backfill personal QR cards for any user missing one
    async for u in db.users.find({"personal_qr": {"$exists": False}}, {"_id": 0, "id": 1}):
        await db.users.update_one(
            {"id": u["id"]},
            {"$set": {"personal_qr": "CARD-" + uuid.uuid4().hex[:12].upper()}},
        )
    # Backfill photo thumbnails for any user with a profile photo but no thumb.
    # Keeps existing members shrunk in /presence the first time the server boots
    # after this change ships — no admin re-upload needed.
    backfilled = 0
    async for u in db.users.find(
        {"photo": {"$nin": [None, ""]}, "photo_thumb": {"$in": [None, ""]}},
        {"_id": 0, "id": 1, "photo": 1},
    ):
        thumb = _make_thumbnail(u.get("photo"))
        if thumb:
            await db.users.update_one({"id": u["id"]}, {"$set": {"photo_thumb": thumb}})
            backfilled += 1
    if backfilled:
        logger.info("Backfilled %d photo thumbnails", backfilled)
    # Backfill mobile_last10 for fast phone-login lookup. Computed lazily for
    # any user missing the field — covers legacy rows from before the index.
    last10_filled = 0
    async for u in db.users.find(
        {"mobile_last10": {"$exists": False}, "mobile": {"$nin": [None, ""]}},
        {"_id": 0, "id": 1, "mobile": 1},
    ):
        k = phone_key(u.get("mobile") or "")
        if k:
            await db.users.update_one({"id": u["id"]}, {"$set": {"mobile_last10": k}})
            last10_filled += 1
    if last10_filled:
        logger.info("Backfilled mobile_last10 on %d user(s)", last10_filled)
    # Backfill default office timings
    await db.config.update_one(
        {"id": "office", "default_work_start": {"$exists": False}},
        {"$set": {"default_work_start": "09:00", "default_work_end": "17:00"}},
    )
    # Backfill office timezone + late grace defaults
    await db.config.update_one(
        {"id": "office", "timezone": {"$exists": False}},
        {"$set": {"timezone": DEFAULT_TZ, "late_grace_minutes": 0}},
    )
    # Backfill parent-notify grace (default 30 min after work_start before
    # the "Notify parents" button appears on the Presence Board).
    await db.config.update_one(
        {"id": "office", "parent_notify_grace_minutes": {"$exists": False}},
        {"$set": {"parent_notify_grace_minutes": 30}},
    )
    # Seed institutions master from any existing distinct institution strings on users
    await db.institutions.create_index("name", unique=True)
    seeded = await db.institutions.count_documents({})
    if seeded == 0:
        distinct = await db.users.distinct("institution")
        for name in distinct:
            if not name or not str(name).strip():
                continue
            try:
                await db.institutions.insert_one({
                    "id": str(uuid.uuid4()),
                    "name": str(name).strip(),
                    "short_name": None,
                    "active": True,
                    "created_at": now_utc().isoformat(),
                })
            except Exception as e:
                logger.debug("institution seed skipped %r: %s", name, e)
        logger.info("Seeded institutions master from existing users")


# ----------------------------------------------------------------------------
# Midnight auto-checkout
# Members who forget to check out leave open sessions hanging across days.
# A background task closes any open session whose date < today (office-local)
# every midnight, stamping it as auto_checkout and setting hours from
# check_in_at to 23:59:59 of the original day.
# ----------------------------------------------------------------------------
async def _close_stale_open_sessions(reason: str) -> int:
    """Close every attendance session with check_out_at=None whose `date` is
    before today in office-local time. Returns count of sessions closed."""
    office = await db.config.find_one({"id": "office"}, {"_id": 0})
    today_str = local_date_str(office)
    tz = office_tz(office)
    cur = db.attendance.find({"check_out_at": None, "date": {"$lt": today_str}}, {"_id": 0})
    count = 0
    async for sess in cur:
        try:
            close_local = datetime.fromisoformat(sess["date"] + "T23:59:59").replace(tzinfo=tz)
            close_utc = close_local.astimezone(timezone.utc)
            ci = datetime.fromisoformat(sess["check_in_at"])
            hours = round(max(0.0, (close_utc - ci).total_seconds() / 3600), 2)
        except Exception:
            close_utc = now_utc()
            hours = 0
        await db.attendance.update_one(
            {"id": sess["id"]},
            {"$set": {
                "check_out_at": close_utc.isoformat(),
                "auto_checkout": True,
                "auto_checkout_reason": reason,
                "hours": hours,
            }},
        )
        count += 1
    return count


async def _schedule_daily(label: str, get_target_hm, fn) -> None:
    """Run `fn()` once per office-local day at the HH:MM returned by
    `get_target_hm(office)`. `get_target_hm` is recalled on each tick so
    a config change (e.g. admin moves the reminder time) is picked up
    without a server restart.

    `label` is purely for log messages. Resilient — caught exceptions log
    and retry in 1h instead of killing the loop.
    """
    import asyncio
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


async def _midnight_auto_checkout_loop():
    """Sleep until office-local midnight (+10s), then close yesterday's
    open sessions. Wrapper kept for readability of the cron intent."""
    async def _run():
        return await _close_stale_open_sessions("midnight_cron")
    await _schedule_daily("midnight-auto-checkout", lambda _office: (0, 0), _run)


@asynccontextmanager
async def _lifespan(_app):
    """Startup: seed + catch-up + spawn background loops.
    Shutdown: cancel loops + close Mongo client."""
    import asyncio
    await _seed_database()
    try:
        n = await _close_stale_open_sessions("startup_catchup")
        if n:
            logger.info("startup catch-up auto-checkout: closed %d stale session(s)", n)
    except Exception:
        logger.exception("startup catch-up auto-checkout failed")
    tasks = [
        asyncio.create_task(_midnight_auto_checkout_loop()),
        asyncio.create_task(_checkout_reminder_loop()),
    ]
    try:
        yield
    finally:
        for t in tasks:
            t.cancel()
        for t in tasks:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        client.close()


# ----------------------------------------------------------------------------
# "Forgot to check out" SMS reminder
# Daily, at the office-local `checkout_reminder_time`, send one SMS to every
# member who has an open session for today AND hasn't already been reminded.
# Idempotent: writes `reminder_sent_at` on the attendance doc.
# ----------------------------------------------------------------------------
async def _send_checkout_reminders() -> int:
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


async def _checkout_reminder_loop():
    """Sleep until the configured office-local reminder time, fire the
    batch, repeat. Time is re-read from config each tick so admin edits
    in the UI take effect on the next cycle."""
    def _hm_from(office):
        t = (office.get("checkout_reminder_time") or "20:00").split(":")
        try:
            return int(t[0]), int(t[1])
        except (ValueError, IndexError):
            return 20, 0
    await _schedule_daily("checkout-reminder", _hm_from, _send_checkout_reminders)


# ----------------------------------------------------------------------------
# Auth routes
# ----------------------------------------------------------------------------
@api_router.post("/auth/login")
async def login(body: LoginIn):
    user = await db.users.find_one({"email": body.email})
    if not user or not verify_password(body.password, user["hashed_password"]):
        raise HTTPException(status_code=401, detail="Incorrect email or password")
    token = create_token(user["id"], user.get("role", "member"))
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": UserPublic(**{k: user.get(k) for k in UserPublic.model_fields}),
    }


@api_router.get("/auth/me", response_model=UserPublic)
async def me(user: dict = Depends(get_current_user)):
    return UserPublic(**{k: user.get(k) for k in UserPublic.model_fields})


# ----------------------------------------------------------------------------
# Passwordless phone login + device registration / admin approval
# ----------------------------------------------------------------------------
def _user_public(u: dict) -> UserPublic:
    return UserPublic(**{k: u.get(k) for k in UserPublic.model_fields})


def _device_token_response(user: dict, device_id: str) -> dict:
    token = create_token(user["id"], user.get("role", "member"),
                         device_id=device_id, expires_minutes=DEVICE_TOKEN_MINUTES)
    return {"status": "approved", "access_token": token, "token_type": "bearer",
            "user": _user_public(user)}


async def _match_user_by_phone(digits: str) -> Optional[dict]:
    key = phone_key(digits)
    if not key:
        return None
    # Fast path: lookup by the indexed denormalised last-10-digit key,
    # populated at user-create time and backfilled at startup. Falls back
    # to the legacy full-scan match for any users not yet backfilled
    # (handles a freshly-restored DB without the index field).
    match = await db.users.find_one(
        {"mobile_last10": key}, {"_id": 0, "hashed_password": 0}
    )
    if match:
        return match
    async for u in db.users.find({"mobile": {"$ne": None}}, {"_id": 0, "id": 1, "mobile": 1}):
        if phone_key(u.get("mobile") or "") == key:
            return await db.users.find_one({"id": u["id"]}, {"_id": 0, "hashed_password": 0})
    return None


@api_router.post("/auth/phone")
async def phone_login(body: PhoneLoginIn):
    digits = normalize_phone(body.phone)
    if len(digits) < 6:
        raise HTTPException(status_code=400, detail="Enter a valid phone number")
    now = now_utc().isoformat()
    matched = await _match_user_by_phone(digits)
    device = await db.devices.find_one({"device_id": body.device_id}, {"_id": 0})
    meta = {
        "phone": digits,
        "device_name": body.device_name,
        "model": body.model,
        "platform": body.platform,
        "updated_at": now,
    }
    # Self-introduction (only meaningful for unmatched / first-time users — never
    # overwrite a real member's stored profile).
    if not matched:
        if body.full_name and body.full_name.strip():
            meta["proposed_full_name"] = body.full_name.strip()
        if body.rank and body.rank.strip():
            meta["proposed_rank"] = body.rank.strip()
        if body.category:
            meta["proposed_category"] = body.category
    if device is None:
        device = {
            "id": str(uuid.uuid4()),
            "device_id": body.device_id,
            "status": "pending",
            "user_id": matched["id"] if matched else None,
            "created_at": now,
            "approved_by": None,
            **meta,
        }
        await db.devices.insert_one(device)
    else:
        upd = dict(meta)
        if matched and not device.get("user_id"):
            upd["user_id"] = matched["id"]
        # If this device was previously REJECTED and the user is trying again
        # (e.g. admin rejected by mistake, or member's circumstances changed),
        # flip the status back to "pending" so the new attempt re-appears in
        # the admin Access Requests queue. Without this, the rejected record
        # silently keeps every retry invisible to the admin.
        if device.get("status") == "rejected":
            upd["status"] = "pending"
            upd["last_action"] = "re-requested"
            upd["last_action_at"] = now
        await db.devices.update_one({"device_id": body.device_id}, {"$set": upd})
        device = await db.devices.find_one({"device_id": body.device_id}, {"_id": 0})

    if device["status"] == "revoked":
        raise HTTPException(status_code=403, detail="This device was revoked. Contact your admin.")

    # Already approved & linked -> straight in
    if device["status"] == "approved" and device.get("user_id"):
        u = await db.users.find_one({"id": device["user_id"]}, {"_id": 0})
        if u:
            await db.devices.update_one({"device_id": body.device_id}, {"$set": {"last_login_at": now}})
            return _device_token_response(u, body.device_id)

    # Pre-designated admin -> instant approve + login (the original "cinch")
    if matched and matched.get("role") == "admin":
        await db.devices.update_one({"device_id": body.device_id}, {"$set": {
            "status": "approved", "user_id": matched["id"],
            "approved_by": "auto-admin", "approved_at": now, "last_login_at": now,
        }})
        return _device_token_response(matched, body.device_id)

    # Trusted-phone cinch: if the matched member ALREADY has another approved
    # device, auto-approve this new device too. This covers the very common
    # case where a member's browser cache / PWA install creates a fresh
    # device_id — without this they'd be stuck on "Awaiting approval" forever
    # while their phone is shown as already approved in the admin queue.
    if matched and device["status"] != "approved":
        prior = await db.devices.find_one({
            "user_id": matched["id"],
            "status": "approved",
            "device_id": {"$ne": body.device_id},
        }, {"_id": 0, "id": 1})
        if prior:
            await db.devices.update_one({"device_id": body.device_id}, {"$set": {
                "status": "approved", "user_id": matched["id"],
                "approved_by": "auto-trusted-phone", "approved_at": now, "last_login_at": now,
                "last_action": "approved", "last_action_by": "auto-trusted-phone", "last_action_at": now,
            }})
            return _device_token_response(matched, body.device_id)

    return {
        "status": "pending",
        "device_id": body.device_id,
        "matched_member": matched["full_name"] if matched else None,
        "needs_profile": not matched and not (device.get("proposed_full_name") or "").strip(),
    }


@api_router.get("/auth/phone/status")
async def phone_status(device_id: str):
    device = await db.devices.find_one({"device_id": device_id}, {"_id": 0})
    if not device:
        return {"status": "unknown"}
    if device["status"] == "revoked":
        return {"status": "revoked"}
    if device["status"] == "approved" and device.get("user_id"):
        u = await db.users.find_one({"id": device["user_id"]}, {"_id": 0})
        if u:
            await db.devices.update_one({"device_id": device_id},
                                        {"$set": {"last_login_at": now_utc().isoformat()}})
            return _device_token_response(u, device_id)
    return {"status": "pending"}


async def _enrich_devices(devices: List[dict]) -> List[dict]:
    uids = list({d["user_id"] for d in devices if d.get("user_id")})
    # Also resolve admin display names for the audit-trail line.
    actor_ids = list({d["last_action_by"] for d in devices if d.get("last_action_by")})
    lookup_ids = list(set(uids + actor_ids))
    users = await db.users.find({"id": {"$in": lookup_ids}}, {"_id": 0}).to_list(2000)
    umap = {u["id"]: u for u in users}
    for d in devices:
        u = umap.get(d.get("user_id"))
        d["member_name"] = u["full_name"] if u else None
        d["member_role"] = u["role"] if u else None
        d["member_category"] = u["category"] if u else None
        d["member_rank"] = u.get("rank") if u else None
        actor = umap.get(d.get("last_action_by"))
        d["last_action_by_name"] = actor["full_name"] if actor else None
    return devices


async def _stamp_action(device_pk: str, new_status: str, admin_id: str, extra: Optional[dict] = None) -> int:
    """Update a device's status AND the audit trail in one shot. Returns
    matched_count so callers can 404 on missing devices."""
    payload = {
        "status": new_status,
        "last_action": new_status,
        "last_action_by": admin_id,
        "last_action_at": now_utc().isoformat(),
    }
    if extra:
        payload.update(extra)
    res = await db.devices.update_one({"id": device_pk}, {"$set": payload})
    return res.matched_count


@api_router.get("/admin/devices")
async def list_devices(status_filter: Optional[str] = None, admin: dict = Depends(require_admin)):
    q = {}
    if status_filter:
        q["status"] = status_filter
    devices = await db.devices.find(q, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return await _enrich_devices(devices)


@api_router.post("/admin/devices/{device_pk}/approve")
async def approve_device(device_pk: str, body: DeviceApproveIn, admin: dict = Depends(require_admin)):
    device = await db.devices.find_one({"id": device_pk}, {"_id": 0})
    if not device:
        raise HTTPException(status_code=404, detail="Device request not found")
    now = now_utc().isoformat()
    user_id = device.get("user_id")
    if not user_id:
        digits = device.get("phone") or ""
        email = f"{digits}@attendance.app"
        if await db.users.find_one({"email": email}):
            email = f"{digits}-{uuid.uuid4().hex[:4]}@attendance.app"
        new_user = {
            "id": str(uuid.uuid4()),
            "email": email,
            "full_name": (body.full_name or "New Member").strip(),
            "role": body.role,
            "category": body.category,
            "rank": body.rank,
            "mobile": digits,
            "mobile_last10": phone_key(digits) or None,
            "work_start": None,
            "work_end": None,
            "photo": None,
            "personal_qr": "CARD-" + uuid.uuid4().hex[:12].upper(),
            "hashed_password": hash_password(digits or uuid.uuid4().hex[:8]),
            "created_at": now,
        }
        await db.users.insert_one(new_user)
        user_id = new_user["id"]
    await db.devices.update_one({"id": device_pk}, {"$set": {
        "status": "approved", "user_id": user_id,
        "approved_by": admin["id"], "approved_at": now,
        "last_action": "approved", "last_action_by": admin["id"], "last_action_at": now,
    }})
    return {"ok": True}


@api_router.post("/admin/devices/{device_pk}/reject")
async def reject_device(device_pk: str, admin: dict = Depends(require_admin)):
    if await _stamp_action(device_pk, "rejected", admin["id"]) == 0:
        raise HTTPException(status_code=404, detail="Device request not found")
    return {"ok": True}


@api_router.post("/admin/devices/{device_pk}/revoke")
async def revoke_device(device_pk: str, admin: dict = Depends(require_admin)):
    if await _stamp_action(device_pk, "revoked", admin["id"]) == 0:
        raise HTTPException(status_code=404, detail="Device not found")
    return {"ok": True}


@api_router.post("/admin/devices/{device_pk}/reinstate")
async def reinstate_device(device_pk: str, admin: dict = Depends(require_admin)):
    """Bring a revoked or rejected device back to approved. The device retains
    its existing user_id; if it never had one (a rejected new-signup), the
    admin must re-run the regular approve flow which prompts for a name."""
    device = await db.devices.find_one({"id": device_pk}, {"_id": 0})
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")
    if device.get("status") not in ("revoked", "rejected"):
        raise HTTPException(status_code=400, detail="Only revoked or rejected devices can be re-enabled")
    if not device.get("user_id"):
        raise HTTPException(status_code=400, detail="This device was never linked to a member — use the regular Approve flow")
    await _stamp_action(device_pk, "approved", admin["id"], extra={
        "approved_by": admin["id"],
        "approved_at": now_utc().isoformat(),
    })
    return {"ok": True}


# ----------------------------------------------------------------------------
# Office config routes
# ----------------------------------------------------------------------------
@api_router.get("/office")
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
        office["twilio"] = {**office["twilio"], "auth_token": "•" * max(0, len(tok) - 4) + tok[-4:], "has_auth_token": True}
    elif "twilio" in office:
        office["twilio"] = {**office["twilio"], "has_auth_token": False}
    return office


@api_router.put("/office")
async def update_office(body: OfficeConfig, admin: dict = Depends(require_admin)):
    # The Office page only edits geofence / hours / timezone — Twilio settings
    # use the dedicated /api/sms/config endpoint so a partial save here never
    # wipes credentials. We drop the twilio subdoc to prevent accidental nuke.
    payload = body.model_dump()
    payload.pop("twilio", None)
    await db.config.update_one({"id": "office"}, {"$set": payload})
    return await db.config.find_one({"id": "office"}, {"_id": 0})


@api_router.post("/admin/checkout-reminder/send-now")
async def admin_send_checkout_reminders_now(admin: dict = Depends(require_admin)):
    """Trigger the forgot-to-checkout SMS batch immediately. Same idempotency
    rules apply — members already pinged today won't be re-pinged."""
    n = await _send_checkout_reminders()
    return {"sent": n}


@api_router.get("/changelog")
async def get_changelog():
    """Read the repo CHANGELOG.md so the in-app "What's new" page can render
    it. Available to anyone who can reach the API — coaches and athletes get
    to see what's new too. Returns plain markdown text."""
    import pathlib
    path = pathlib.Path(__file__).resolve().parent.parent / "CHANGELOG.md"
    if not path.exists():
        return {"markdown": "# Changelog\n\n_Not available yet._"}
    return {"markdown": path.read_text(encoding="utf-8")}


# ----------------------------------------------------------------------------
# Member management (admin)
# ----------------------------------------------------------------------------
@api_router.post("/members", response_model=UserPublic)
async def create_member(body: MemberCreate, admin: dict = Depends(require_admin)):
    if await db.users.find_one({"email": body.email}):
        raise HTTPException(status_code=400, detail="Email already registered")
    doc = {
        "id": str(uuid.uuid4()),
        "email": body.email,
        "full_name": body.full_name,
        "role": body.role,
        "category": body.category,
        "rank": body.rank,
        "mobile": body.mobile,
        "mobile_last10": phone_key(body.mobile or "") or None,
        "work_start": body.work_start,
        "work_end": body.work_end,
        "institution": body.institution,
        "gender": body.gender,
        "weekly_off": body.weekly_off,
        "father_mobile": body.father_mobile,
        "father_name": body.father_name,
        "mother_mobile": body.mother_mobile,
        "mother_name": body.mother_name,
        "guardian_mobile": body.guardian_mobile,
        "guardian_name": body.guardian_name,
        "photo": None,
        "personal_qr": "CARD-" + uuid.uuid4().hex[:12].upper(),
        "hashed_password": hash_password(body.password),
        "created_at": now_utc().isoformat(),
    }
    await db.users.insert_one(doc)
    return UserPublic(**{k: doc.get(k) for k in UserPublic.model_fields})


@api_router.get("/members", response_model=List[UserPublic])
async def list_members(user: dict = Depends(get_current_user)):
    """List all members. For bandwidth reasons we substitute the small
    `photo_thumb` into the `photo` field — callers needing the full original
    fetch `/members/{id}` (admin) or `/members/{id}/card` (printable)."""
    users = await db.users.find({}, {"_id": 0, "hashed_password": 0}).sort("full_name", 1).to_list(2000)
    out: List[UserPublic] = []
    for u in users:
        thumb = u.get("photo_thumb") or u.get("photo")
        # Swap photo → thumb just on the way out so DB stays the source of truth.
        u_swapped = {**u, "photo": thumb}
        out.append(UserPublic(**{k: u_swapped.get(k) for k in UserPublic.model_fields}))
    return out


@api_router.patch("/members/{member_id}", response_model=UserPublic)
async def update_member(member_id: str, body: MemberUpdate, admin: dict = Depends(require_admin)):
    if body.role is not None and body.role == "member" and member_id == admin["id"]:
        raise HTTPException(status_code=400, detail="You cannot remove your own admin access")
    if body.photo is not None:
        _check_photo_size(body.photo)
    update = {k: v for k, v in body.model_dump().items() if v is not None and k != "password"}
    if body.password:
        update["hashed_password"] = hash_password(body.password)
    # Keep the denormalised phone key in sync when mobile changes.
    if "mobile" in update:
        update["mobile_last10"] = phone_key(update.get("mobile") or "") or None
    # Keep `photo_thumb` in sync ONLY when the photo bytes actually changed.
    # The MemberForm always submits its current `photo` value (even when the
    # admin didn't touch it), so blindly regenerating would reset the 365-day
    # yearly-refresh timer on every member edit.
    if body.photo is not None:
        existing = await db.users.find_one({"id": member_id}, {"_id": 0, "photo": 1})
        if existing is not None and (existing.get("photo") or "") != (body.photo or ""):
            update["photo_thumb"] = _make_thumbnail(body.photo) if body.photo else None
            update["photo_captured_at"] = now_utc().isoformat()
        else:
            # No-op: drop the photo field so we don't touch it at all.
            update.pop("photo", None)
    if update:
        await db.users.update_one({"id": member_id}, {"$set": update})
    u = await db.users.find_one({"id": member_id}, {"_id": 0})
    if not u:
        raise HTTPException(status_code=404, detail="Member not found")
    return UserPublic(**{k: u.get(k) for k in UserPublic.model_fields})


@api_router.get("/members/{member_id}", response_model=UserPublic)
async def get_member(member_id: str, admin: dict = Depends(require_admin)):
    """Single-member fetch used by double-click edit on the Presence Board."""
    u = await db.users.find_one({"id": member_id}, {"_id": 0})
    if not u:
        raise HTTPException(status_code=404, detail="Member not found")
    return UserPublic(**{k: u.get(k) for k in UserPublic.model_fields})


@api_router.delete("/members/{member_id}")
async def delete_member(member_id: str, admin: dict = Depends(require_admin)):
    if member_id == admin["id"]:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")
    await db.users.delete_one({"id": member_id})
    await db.attendance.delete_many({"user_id": member_id})
    await db.leaves.delete_many({"user_id": member_id})
    return {"ok": True}



@api_router.get("/leave-balances")
async def list_leave_balances(admin: dict = Depends(require_admin)):
    """Return every STAFF member with their opening leave balance and current
    usage, used by the spreadsheet-style admin editor.

    Leave-balance tracking applies only to staff — athletes / coaches /
    executives don't accrue or consume a numeric leave quota, so they're
    excluded from the listing."""
    users = await db.users.find(
        {"category": "staff"},
        {"_id": 0, "id": 1, "full_name": 1, "category": 1,
         "rank": 1, "institution": 1,
         "leave_balance_opening": 1, "weekly_off": 1},
    ).sort("full_name", 1).to_list(2000)
    office = await db.config.find_one({"id": "office"})
    today = local_date_str(office)
    year = today[:4]
    leaves = await db.leaves.find({
        "status": "approved", "type": "leave",
        "start_date": {"$gte": f"{year}-01-01", "$lte": f"{year}-12-31"},
    }, {"_id": 0, "user_id": 1, "start_date": 1, "end_date": 1}).to_list(20000)
    used: dict = {}
    for leave in leaves:
        try:
            sd = date.fromisoformat(leave["start_date"])
            ed = date.fromisoformat(leave["end_date"])
            n = (ed - sd).days + 1
        except Exception:
            n = 1
        used[leave["user_id"]] = used.get(leave["user_id"], 0) + n
    out = []
    for u in users:
        opening = float(u.get("leave_balance_opening") or 0)
        taken = float(used.get(u["id"], 0))
        out.append({
            "id": u["id"],
            "full_name": u["full_name"],
            "category": u.get("category"),
            "rank": u.get("rank"),
            "institution": u.get("institution"),
            "opening": opening,
            "taken_this_year": taken,
            "balance": round(opening - taken, 1),
        })
    return {"year": int(year), "rows": out}


@api_router.post("/leave-balances/bulk")
async def bulk_set_leave_balances(body: LeaveBalanceBulkIn, admin: dict = Depends(require_admin)):
    updated = 0
    for row in body.rows:
        r = await db.users.update_one({"id": row.member_id}, {"$set": {"leave_balance_opening": float(row.opening)}})
        if r.modified_count or r.matched_count:
            updated += 1
    return {"ok": True, "updated": updated}


# ----------------------------------------------------------------------------
# Institutions master
# ----------------------------------------------------------------------------
@api_router.get("/institutions")
async def list_institutions(user: dict = Depends(get_current_user)):
    rows = await db.institutions.find({}, {"_id": 0}).sort("name", 1).to_list(500)
    pipeline = [{"$group": {"_id": "$institution", "n": {"$sum": 1}}}]
    counts = {c["_id"]: c["n"] async for c in db.users.aggregate(pipeline)}
    for r in rows:
        r["member_count"] = counts.get(r["name"], 0)
    return rows


@api_router.post("/institutions")
async def create_institution(body: InstitutionIn, admin: dict = Depends(require_admin)):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name required")
    if await db.institutions.find_one({"name": name}):
        raise HTTPException(status_code=409, detail="Institution already exists")
    doc = {
        "id": str(uuid.uuid4()),
        "name": name,
        "short_name": (body.short_name or "").strip() or None,
        "active": body.active,
        "sms_from_number": (body.sms_from_number or "").strip() or None,
        "voice_from_number": (body.voice_from_number or "").strip() or None,
        "created_at": now_utc().isoformat(),
    }
    await db.institutions.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api_router.patch("/institutions/{inst_id}")
async def update_institution(inst_id: str, body: InstitutionIn, admin: dict = Depends(require_admin)):
    inst = await db.institutions.find_one({"id": inst_id}, {"_id": 0})
    if not inst:
        raise HTTPException(status_code=404, detail="Not found")
    old_name = inst["name"]
    new_name = body.name.strip()
    await db.institutions.update_one({"id": inst_id}, {"$set": {
        "name": new_name,
        "short_name": (body.short_name or "").strip() or None,
        "active": body.active,
        "sms_from_number": (body.sms_from_number or "").strip() or None,
        "voice_from_number": (body.voice_from_number or "").strip() or None,
    }})
    if new_name != old_name:
        await db.users.update_many({"institution": old_name}, {"$set": {"institution": new_name}})
    return {"ok": True}


@api_router.delete("/institutions/{inst_id}")
async def delete_institution(inst_id: str, admin: dict = Depends(require_admin)):
    inst = await db.institutions.find_one({"id": inst_id}, {"_id": 0})
    if not inst:
        raise HTTPException(status_code=404, detail="Not found")
    in_use = await db.users.count_documents({"institution": inst["name"]})
    if in_use > 0:
        raise HTTPException(status_code=409, detail=f"{in_use} members still use this institution — reassign first.")
    await db.institutions.delete_one({"id": inst_id})
    return {"ok": True}


# ---------------------------------------------------------------------------
# Fleet master (boat classes). Same shape & lifecycle as Institutions —
# every athlete's `fleet` field points to one of these names.
# ---------------------------------------------------------------------------
@api_router.get("/fleets")
async def list_fleets(user: dict = Depends(get_current_user)):
    rows = await db.fleets.find({}, {"_id": 0}).sort("name", 1).to_list(500)
    pipeline = [{"$group": {"_id": "$fleet", "n": {"$sum": 1}}}]
    counts = {c["_id"]: c["n"] async for c in db.users.aggregate(pipeline) if c["_id"]}
    for r in rows:
        r["athlete_count"] = counts.get(r["name"], 0)
    return rows


@api_router.post("/fleets")
async def create_fleet(body: FleetIn, admin: dict = Depends(require_admin)):
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name required")
    if await db.fleets.find_one({"name": name}):
        raise HTTPException(status_code=409, detail="Fleet already exists")
    doc = {
        "id": str(uuid.uuid4()),
        "name": name,
        "short_name": (body.short_name or "").strip() or None,
        "notes": (body.notes or "").strip() or None,
        "active": body.active,
        "created_at": now_utc().isoformat(),
    }
    await db.fleets.insert_one(doc)
    doc.pop("_id", None)
    return doc


@api_router.patch("/fleets/{fleet_id}")
async def update_fleet(fleet_id: str, body: FleetIn, admin: dict = Depends(require_admin)):
    fleet = await db.fleets.find_one({"id": fleet_id}, {"_id": 0})
    if not fleet:
        raise HTTPException(status_code=404, detail="Not found")
    old_name = fleet["name"]
    new_name = body.name.strip()
    await db.fleets.update_one({"id": fleet_id}, {"$set": {
        "name": new_name,
        "short_name": (body.short_name or "").strip() or None,
        "notes": (body.notes or "").strip() or None,
        "active": body.active,
    }})
    # Cascade rename: every athlete with the old fleet name gets retagged.
    if new_name != old_name:
        await db.users.update_many({"fleet": old_name}, {"$set": {"fleet": new_name}})
        # Also retag any breaks that target the old fleet.
        await db.breaks.update_many({"fleet": old_name}, {"$set": {"fleet": new_name}})
    return {"ok": True}


@api_router.delete("/fleets/{fleet_id}")
async def delete_fleet(fleet_id: str, admin: dict = Depends(require_admin)):
    fleet = await db.fleets.find_one({"id": fleet_id}, {"_id": 0})
    if not fleet:
        raise HTTPException(status_code=404, detail="Not found")
    in_use = await db.users.count_documents({"fleet": fleet["name"]})
    if in_use > 0:
        raise HTTPException(status_code=409, detail=f"{in_use} athlete(s) still in this fleet — reassign first.")
    await db.fleets.delete_one({"id": fleet_id})
    return {"ok": True}


class FleetAssignIn(BaseModel):
    fleet: Optional[str] = None       # None / "" clears the fleet for the listed athletes
    member_ids: List[str]


@api_router.post("/fleets/assign")
async def assign_fleet(body: FleetAssignIn, admin: dict = Depends(require_admin)):
    """Bulk-set the fleet on a group of athletes from the Fleet master page.
    Pass `fleet: null` (or empty string) to UN-assign the picked athletes."""
    if not body.member_ids:
        raise HTTPException(status_code=400, detail="member_ids required")
    target = (body.fleet or "").strip() or None
    if target is not None:
        # Sanity check: the fleet must exist in master.
        exists = await db.fleets.find_one({"name": target}, {"_id": 1})
        if not exists:
            raise HTTPException(status_code=404, detail=f"Fleet '{target}' not in master — create it first.")
    res = await db.users.update_many(
        {"id": {"$in": body.member_ids}, "category": "athlete"},
        {"$set": {"fleet": target}},
    )
    return {"modified": res.modified_count}


# ----------------------------------------------------------------------------
# Group leave — file the same leave for many members in one shot
# ----------------------------------------------------------------------------
@api_router.get("/members/{member_id}/card")
async def member_card(member_id: str, admin: dict = Depends(require_admin)):
    u = await db.users.find_one({"id": member_id}, {"_id": 0})
    if not u:
        raise HTTPException(status_code=404, detail="Member not found")
    return {
        "id": u["id"],
        "full_name": u["full_name"],
        "rank": u.get("rank"),
        "category": u["category"],
        "personal_qr": u.get("personal_qr"),
        "photo": u.get("photo"),
    }


@api_router.get("/admin/cards")
async def all_cards(admin: dict = Depends(require_admin)):
    """Every member's personal QR — for batch printing of member ID cards."""
    users = await db.users.find(
        {}, {"_id": 0, "id": 1, "full_name": 1, "rank": 1, "category": 1, "personal_qr": 1}
    ).sort("full_name", 1).to_list(2000)
    return {
        "members": [
            {
                "id": u["id"],
                "full_name": u["full_name"],
                "rank": u.get("rank"),
                "category": u["category"],
                "personal_qr": u.get("personal_qr"),
            }
            for u in users
        ],
    }


@api_router.get("/members/import-template")
async def import_template(admin: dict = Depends(require_admin)):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Members"
    headers = ["full_name", "mobile", "email", "password", "rank", "category", "gender", "work_start", "work_end", "institution"]
    ws.append(headers)
    ws.append(["Arjun Nair", "9876543210", "arjun@academy.in", "secret123", "Petty Officer", "athlete", "M", "08:00", "17:00", "INS Hamla"])
    ws.append(["Meera Kapoor", "9876500001", "", "", "Leading Seaman", "athlete", "F", "", "", "Naval Sailing Academy"])
    ws.append(["Rohit Verma", "9876500002", "", "", "Head Coach", "coach", "M", "06:00", "14:00", "YCH Hyderabad"])
    for i in range(1, len(headers) + 1):
        ws.column_dimensions[get_column_letter(i)].width = 18
    # Notes sheet
    notes = wb.create_sheet("Instructions")
    for line in [
        ["Column", "Required?", "Notes"],
        ["full_name", "YES", "Person's full name"],
        ["mobile", "YES", "Mobile number (also used as login if email is blank)"],
        ["email", "No", "Login email. If blank, auto-generated as <mobile>@attendance.app"],
        ["password", "No", "If blank, the mobile number is used as the password"],
        ["rank", "No", "Rank / title, e.g. Petty Officer"],
        ["category", "No", "athlete | staff | coach  (default: athlete)"],
        ["gender", "No", "M | F | O   (Male / Female / Other)"],
        ["work_start", "No", "Custom start time HH:MM (blank = office default)"],
        ["work_end", "No", "Custom end time HH:MM (blank = office default)"],
        ["institution", "No", "School / unit / academy name"],
    ]:
        notes.append(line)
    for i in range(1, 4):
        notes.column_dimensions[get_column_letter(i)].width = 40
    buf = io.BytesIO()
    wb.save(buf)
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=members_template.xlsx"},
    )


@api_router.post("/members/import")
async def import_members(file: UploadFile = File(...), admin: dict = Depends(require_admin)):
    raw = await file.read()
    try:
        wb = openpyxl.load_workbook(io.BytesIO(raw), data_only=True)
    except Exception:
        raise HTTPException(status_code=400, detail="Could not read the Excel file. Use the provided template (.xlsx).")
    ws = wb["Members"] if "Members" in wb.sheetnames else wb.active
    rows = list(ws.iter_rows(values_only=True))
    if len(rows) < 2:
        return {"created": [], "errors": [], "created_count": 0, "error_count": 0}
    header = [str(c).strip().lower() if c is not None else "" for c in rows[0]]
    col = {name: i for i, name in enumerate(header)}

    def cell(row, name):
        i = col.get(name)
        if i is None or i >= len(row):
            return None
        v = row[i]
        if v is None:
            return None
        s = str(v).strip()
        return s or None

    valid_cats = {"athlete", "staff", "coach", "executive"}
    time_re = re.compile(r"^\d{1,2}:\d{2}$")
    created, errors = [], []
    # First pass: parse + validate every row, gather candidate emails so we
    # can do ONE existence check instead of N `find_one`s.
    candidates = []
    for n, row in enumerate(rows[1:], start=2):
        if row is None or all(c is None or str(c).strip() == "" for c in row):
            continue
        name = cell(row, "full_name")
        mobile = cell(row, "mobile")
        if not name:
            errors.append({"row": n, "reason": "Missing full_name"})
            continue
        if not mobile:
            errors.append({"row": n, "reason": "Missing mobile"})
            continue
        digits = re.sub(r"[^0-9]", "", mobile) or mobile
        email = (cell(row, "email") or f"{digits}@attendance.app").lower()
        password = cell(row, "password") or digits
        if len(password) < 4:
            password = (password + "0000")[:4]
        rank = cell(row, "rank")
        category = (cell(row, "category") or "athlete").lower()
        if category not in valid_cats:
            category = "athlete"
        ws_start = cell(row, "work_start")
        ws_end = cell(row, "work_end")
        institution = cell(row, "institution")
        raw_g = (cell(row, "gender") or "").upper()
        gender = raw_g[0] if raw_g and raw_g[0] in ("M", "F", "O") else None
        if ws_start and not time_re.match(ws_start):
            ws_start = None
        if ws_end and not time_re.match(ws_end):
            ws_end = None
        candidates.append({
            "_n": n, "_name": name, "_email": email, "_password": password,
            "_doc": {
                "id": str(uuid.uuid4()),
                "email": email,
                "full_name": name,
                "role": "member",
                "category": category,
                "rank": rank,
                "mobile": mobile,
                "mobile_last10": phone_key(mobile) or None,
                "work_start": ws_start,
                "work_end": ws_end,
                "institution": institution,
                "gender": gender,
                "photo": None,
                "personal_qr": "CARD-" + uuid.uuid4().hex[:12].upper(),
                "hashed_password": hash_password(password),
                "created_at": now_utc().isoformat(),
            },
        })

    # One bulk membership check vs. N find_one round trips. Also dedupe
    # within the file itself so a sheet with the same email twice doesn't
    # try to insert both rows.
    if candidates:
        existing_emails = set()
        emails_in_file = [c["_email"] for c in candidates]
        async for u in db.users.find({"email": {"$in": emails_in_file}}, {"_id": 0, "email": 1}):
            existing_emails.add(u["email"])
        seen_in_file: set = set()
        to_insert = []
        for c in candidates:
            if c["_email"] in existing_emails or c["_email"] in seen_in_file:
                errors.append({"row": c["_n"], "reason": f"Skipped — email already exists ({c['_email']})"})
                continue
            seen_in_file.add(c["_email"])
            to_insert.append(c["_doc"])
            created.append({"full_name": c["_name"], "email": c["_email"], "password": c["_password"]})
        if to_insert:
            try:
                await db.users.insert_many(to_insert, ordered=False)
            except Exception as e:
                logger.warning("import_members bulk insert partial: %s", e)
    return {"created": created, "errors": errors, "created_count": len(created), "error_count": len(errors)}


# Parents-import helpers live in their own module to keep this file focused.
from parents_import_utils import (
    norm_name as _norm_name,
    fuzzy_score as _fuzzy_score,
    norm_mobile as _norm_mobile,
    clean_name as _clean_name,
)


@api_router.post("/members/import-parents")
async def import_parents(
    file: UploadFile = File(...),
    mode: str = "preview",
    mappings: Optional[str] = None,
    admin: dict = Depends(require_admin),
):
    """Import parent / guardian names + contact numbers into existing members.

    Two-phase flow, controlled by the `mode` query parameter:
      • `mode=preview`  (default) — parse the file, categorize every row as
        exact-match / fuzzy-candidate / unmatched, return the result WITHOUT
        writing. The frontend uses this to render a review screen where the
        admin resolves spelling drift.
      • `mode=apply`    — actually persist. `mappings` is a JSON-encoded list
        of `{"row": <int>, "member_id": <str>, "use_name": "spreadsheet"|"member"}`.
        Any unresolved fuzzy rows (no `member_id`) are skipped silently.

    Exact-name matches are auto-applied in both modes (no admin step needed
    for the obvious cases).
    """
    raw = await file.read()
    try:
        wb = openpyxl.load_workbook(io.BytesIO(raw), data_only=True)
    except Exception:
        raise HTTPException(status_code=400, detail="Could not read the Excel file. Send an .xlsx.")
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    if len(rows) < 3:
        raise HTTPException(status_code=400, detail="File looks empty or missing a header row.")

    # Build name → member index for both exact and fuzzy lookups.
    members: list = []
    name_index: Dict[str, dict] = {}
    async for u in db.users.find({}, {"_id": 0, "id": 1, "full_name": 1}):
        members.append(u)
        key = _norm_name(u.get("full_name", ""))
        if key:
            name_index[key] = u

    # Parse mappings (apply mode only)
    resolved: Dict[int, dict] = {}
    if mode == "apply" and mappings:
        try:
            import json
            for m in json.loads(mappings):
                if m.get("row") is not None and m.get("member_id"):
                    resolved[int(m["row"])] = m
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid mappings JSON")

    FUZZY_THRESHOLD = 0.72  # show suggestions with similarity >= 72%
    matched, suggestions, unmatched, skipped = [], [], [], []

    for n, row in enumerate(rows[2:], start=3):
        cells = list(row) + [None] * (12 - len(row))
        sailor_name = cells[2]
        if not sailor_name or not str(sailor_name).strip():
            skipped.append({"row": n, "reason": "blank sailor name"})
            continue
        sailor_name_clean = str(sailor_name).strip()

        update = {
            "father_name":     _clean_name(cells[6]),
            "father_mobile":   _norm_mobile(cells[7]),
            "mother_name":     _clean_name(cells[8]),
            "mother_mobile":   _norm_mobile(cells[9]),
            "guardian_name":   _clean_name(cells[10]),
            "guardian_mobile": _norm_mobile(cells[11]),
        }

        # Pass 1 — exact normalized name match (auto-applied).
        member = name_index.get(_norm_name(sailor_name_clean))
        if member:
            if mode == "apply":
                # Exact matches always keep the existing DB name.
                await db.users.update_one({"id": member["id"]}, {"$set": update})
            matched.append({
                "row": n,
                "sailor_name": sailor_name_clean,
                "member_id": member["id"],
                "member_name": member["full_name"],
                **update,
            })
            continue

        # Pass 2 — admin-resolved mapping for this row (apply mode only).
        if mode == "apply" and n in resolved:
            choice = resolved[n]
            chosen = await db.users.find_one({"id": choice["member_id"]}, {"_id": 0, "id": 1, "full_name": 1})
            if chosen:
                set_doc = dict(update)
                # If admin picked "spreadsheet" spelling, also rename the
                # member to match the file. Otherwise keep the existing DB
                # spelling intact.
                if choice.get("use_name") == "spreadsheet":
                    set_doc["full_name"] = sailor_name_clean
                await db.users.update_one({"id": chosen["id"]}, {"$set": set_doc})
                matched.append({
                    "row": n,
                    "sailor_name": sailor_name_clean,
                    "member_id": chosen["id"],
                    "member_name": set_doc.get("full_name", chosen["full_name"]),
                    "resolved_by_admin": True,
                    **update,
                })
                continue

        # Pass 3 — fuzzy candidates for the review UI.
        scored = []
        for u in members:
            score = _fuzzy_score(sailor_name_clean, u["full_name"])
            if score >= FUZZY_THRESHOLD:
                scored.append({"member_id": u["id"], "member_name": u["full_name"], "score": round(score, 3)})
        scored.sort(key=lambda x: x["score"], reverse=True)
        scored = scored[:3]

        if scored:
            suggestions.append({
                "row": n,
                "sailor_name": sailor_name_clean,
                "candidates": scored,
                "parent_data": update,
            })
        else:
            unmatched.append({"row": n, "sailor_name": sailor_name_clean, "parent_data": update})

    return {
        "mode": mode,
        "matched_count": len(matched),
        "suggestion_count": len(suggestions),
        "unmatched_count": len(unmatched),
        "skipped_count": len(skipped),
        "matched": matched[:300],
        "suggestions": suggestions,
        "unmatched": unmatched,
        "skipped": skipped,
    }


# Threshold for forcing a photo refresh. Members re-capture once a year so
# coaches always see a current likeness on the muster.
PHOTO_REFRESH_DAYS = 365


@api_router.get("/me/photo-status")
async def my_photo_status(user: dict = Depends(get_current_user)):
    """Tells the SelfCheckIn page whether the member needs to (re)capture a
    selfie before checking in. A photo is "needed" if missing OR older than
    PHOTO_REFRESH_DAYS. Legacy timestamps that fail to parse are treated as
    fresh (no forced re-capture of pre-existing photos)."""
    photo = user.get("photo")
    captured_at = user.get("photo_captured_at")
    days_since = None
    needs = not photo  # no photo at all → always need one
    if photo and captured_at:
        try:
            dt = datetime.fromisoformat(captured_at)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            days_since = (now_utc() - dt).days
            if days_since >= PHOTO_REFRESH_DAYS:
                needs = True
        except Exception:
            pass
    reason = "missing" if not photo else ("expired" if needs else "ok")
    return {
        "has_photo": bool(photo),
        "captured_at": captured_at,
        "days_since": days_since,
        "refresh_after_days": PHOTO_REFRESH_DAYS,
        "needs_photo": needs,
        "reason": reason,
    }


@api_router.post("/members/me/photo", response_model=UserPublic)
async def set_my_photo(body: dict, user: dict = Depends(get_current_user)):
    photo = body.get("photo")
    _check_photo_size(photo)
    thumb = _make_thumbnail(photo) if photo else None
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {"photo": photo, "photo_thumb": thumb, "photo_captured_at": now_utc().isoformat()}},
    )
    u = await db.users.find_one({"id": user["id"]}, {"_id": 0})
    return UserPublic(**{k: u.get(k) for k in UserPublic.model_fields})


@api_router.post("/members/{member_id}/photo", response_model=UserPublic)
async def set_member_photo(member_id: str, body: dict, user: dict = Depends(get_current_user)):
    """Update another member's photo. Permitted when the caller is the member
    themselves, or an admin, or a coach (coaches run the muster roll and capture
    missing photos for athletes). Staff cannot edit other members' photos."""
    is_self = member_id == user["id"]
    is_admin = user.get("role") == "admin"
    is_coach = user.get("category") == "coach"
    if not (is_self or is_admin or is_coach):
        raise HTTPException(status_code=403, detail="Not allowed to set this member's photo")
    target = await db.users.find_one({"id": member_id}, {"_id": 0, "id": 1})
    if not target:
        raise HTTPException(status_code=404, detail="Member not found")
    photo = body.get("photo")
    _check_photo_size(photo)
    thumb = _make_thumbnail(photo) if photo else None
    await db.users.update_one(
        {"id": member_id},
        {"$set": {"photo": photo, "photo_thumb": thumb, "photo_captured_at": now_utc().isoformat()}},
    )
    u = await db.users.find_one({"id": member_id}, {"_id": 0})
    return UserPublic(**{k: u.get(k) for k in UserPublic.model_fields})


# ----------------------------------------------------------------------------
# Attendance: check-in / check-out
# ----------------------------------------------------------------------------
async def open_session_for(user_id: str) -> Optional[dict]:
    return await db.attendance.find_one({"user_id": user_id, "check_out_at": None}, {"_id": 0})


@api_router.get("/attendance/status")
async def my_attendance_status(user: dict = Depends(get_current_user)):
    sess = await open_session_for(user["id"])
    open_exc = _open_excursion(sess) if sess else None
    return {
        "checked_in": sess is not None,
        "on_temp_exit": open_exc is not None,
        "current_excursion": open_exc,
        "session": sess,
    }


@api_router.get("/attendance/stale-session")
async def stale_session(user: dict = Depends(get_current_user)):
    """If the user has an open session from a previous office-local day,
    surface it so the UI can prompt them to retroactively check out."""
    sess = await open_session_for(user["id"])
    if not sess or sess.get("forgot_checkout_skipped"):
        return {"stale": None}
    office = await db.config.find_one({"id": "office"})
    today = local_date_str(office)
    if sess.get("date") and sess["date"] >= today:
        return {"stale": None}
    return {"stale": {
        "session_id": sess["id"],
        "check_in_at": sess["check_in_at"],
        "date": sess.get("date"),
        "work_end": user.get("work_end") or "18:00",
    }}


class ResolveStaleIn(BaseModel):
    session_id: str
    # One of: ISO datetime (close at this time) | "work_end" | "skip"
    action: str


@api_router.post("/attendance/resolve-stale")
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
    return {"ok": True, "action": "closed", "hours": hours, "close_at": close_utc.isoformat()}


@api_router.post("/attendance/temp-exit")
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


@api_router.post("/attendance/temp-return")
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


def geo_check(office: dict, lat: float, lng: float, reason: Optional[str]):
    """Returns (distance_m, out_of_geofence). Raises if out and no reason given."""
    dist = round(haversine_m(lat, lng, office["latitude"], office["longitude"]), 1)
    out = dist > office["radius_m"]
    if out and not (reason and reason.strip()):
        raise HTTPException(status_code=400, detail=f"OUT_OF_GEOFENCE:{int(dist)}")
    return dist, out


async def perform_toggle(target, office, lat, lng, photo, reason, method, scanned_by):
    """Check a member in (if no open session) or out (if open). Stores location + reason."""
    dist, out = geo_check(office, lat, lng, reason)
    sess = await open_session_for(target["id"])
    ts = now_utc()
    # Build a small thumbnail of the verification photo so the Presence board
    # can render it without pulling the full ~30 KB JPEG per member.
    photo_thumb = _make_thumbnail(photo) if photo else None
    if sess:
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
            "exit_reason": (reason or None),
            "checked_out_by": scanned_by,
        }})
        return {"ok": True, "action": "checkout", "member": target["full_name"],
                "hours": hours, "out_of_geofence": out, "distance_m": dist}
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
        "geo_reason": (reason or None),
        "late": late,
        "late_minutes": late_minutes,
        "method": method,
        "checked_in_by": scanned_by,
    }
    await db.attendance.insert_one(doc)
    return {"ok": True, "action": "checkin", "member": target["full_name"],
            "out_of_geofence": out, "distance_m": dist,
            "late": late, "late_minutes": late_minutes}


async def _geo_toggle(target: dict, office: dict, lat: float, lng: float,
                      reason: Optional[str], by: Optional[str],
                      overtime_reason: Optional[str] = None) -> dict:
    """GPS-based check in/out (no QR). Distance from the office is recorded but
    NOT enforced — a check-in always succeeds. If the caller could not obtain
    a GPS fix they pass (0, 0) and we mark the row as `geo_unavailable`."""
    geo_unavailable = (lat == 0 and lng == 0)
    if geo_unavailable:
        dist = None
        out = False
        stored_lat, stored_lng = None, None
    else:
        dist = round(haversine_m(lat, lng, office["latitude"], office["longitude"]), 1)
        out = dist > office["radius_m"]
        stored_lat, stored_lng = lat, lng
    sess = await open_session_for(target["id"])
    ts = now_utc()
    if sess:
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
            ot_updates = {
                "overtime_late_min": late_min,
                "overtime_total_min": existing_early + late_min,
                "overtime_status": "pending",
                "overtime_reason": (overtime_reason or existing_reason or "").strip() or None,
                "work_end_at_session": work_end_hm,
            }
        elif overtime_reason and (sess.get("overtime_total_min") or 0) > 0:
            # No new late OT but member supplied a reason that supplements the early-OT one.
            ot_updates = {"overtime_reason": overtime_reason.strip()}
        update_fields = {
            "check_out_at": ts.isoformat(),
            "hours": hours,
            "away_minutes": int(away_s / 60),
            "excursions": excursions,
            "exit_latitude": stored_lat, "exit_longitude": stored_lng,
            "exit_distance_m": dist, "exit_out_of_geofence": out,
            "exit_geo_unavailable": geo_unavailable,
            "exit_reason": (reason or None),
            "exit_method": "geo",
            "checked_out_by": by,
        }
        update_fields.update(ot_updates)
        await db.attendance.update_one({"id": sess["id"]}, {"$set": update_fields})
        return {"ok": True, "action": "checkout", "member": target["full_name"],
                "hours": hours, "out_of_geofence": out, "distance_m": dist,
                "overtime_minutes": ot_updates.get("overtime_total_min", 0)}
    if out:
        # Geofence is informational only — distance is recorded on the
        # attendance row but does not block the check-in.
        pass
    late, late_minutes = compute_late(office, target, ts, camp=await _active_camp_for(target, ts, office))
    early_min, work_start_hm = compute_overtime_in(office, target, ts)
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": target["id"],
        "date": local_date_str(office, ts),
        "check_in_at": ts.isoformat(),
        "check_out_at": None,
        "check_in_photo": None,
        "check_out_photo": None,
        "hours": None,
        "latitude": stored_lat, "longitude": stored_lng,
        "distance_m": dist, "out_of_geofence": out,
        "geo_unavailable": geo_unavailable,
        "geo_reason": (reason or None) if out else None,
        "late": late,
        "late_minutes": late_minutes,
        "method": "geo",
        "checked_in_by": by,
    }
    if early_min > 0:
        doc.update({
            "overtime_early_min": early_min,
            "overtime_total_min": early_min,
            "overtime_status": "pending",
            "overtime_reason": (overtime_reason or "").strip() or None,
            "work_start_at_session": work_start_hm,
        })
    await db.attendance.insert_one(doc)
    return {"ok": True, "action": "checkin", "member": target["full_name"],
            "out_of_geofence": out, "distance_m": dist,
            "late": late, "late_minutes": late_minutes,
            "overtime_minutes": early_min}


@api_router.post("/attendance/geo-toggle")
async def geo_toggle(body: GeoToggleIn, user: dict = Depends(get_current_user)):
    """Self check in/out by GPS — works in any phone browser (no camera/QR)."""
    office = await db.config.find_one({"id": "office"})
    if not office:
        raise HTTPException(status_code=500, detail="Office not configured")
    return await _geo_toggle(user, office, body.latitude, body.longitude,
                             body.reason, None, body.overtime_reason)


@api_router.post("/attendance/mark-member")
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


@api_router.post("/attendance/scan-card")
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


@api_router.post("/admin/attendance/toggle/{member_id}")
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
    return res


@api_router.delete("/admin/attendance/open-session/{member_id}")
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


# ----------------------------------------------------------------------------
# Overtime — staff only, 30+ minutes outside their work_start/work_end window
# ----------------------------------------------------------------------------
class OvertimeDecisionIn(BaseModel):
    status: Literal["approved", "rejected"]
    admin_note: Optional[str] = None


@api_router.get("/admin/overtime/needs-review")
async def overtime_needs_review(admin: dict = Depends(require_admin)):
    """Counts pending OT entries from the previous office-local date — used
    to drive the "you have OT to review" banner that pops on admin login."""
    office = await db.config.find_one({"id": "office"})
    today = local_date_str(office)
    yesterday = (date.fromisoformat(today) - timedelta(days=1)).isoformat()
    cnt = await db.attendance.count_documents({
        "overtime_status": "pending",
        "date": yesterday,
    })
    total_pending = await db.attendance.count_documents({"overtime_status": "pending"})
    comp_off_pending = await db.leaves.count_documents({
        "type": "comp_off", "status": "pending",
    })
    return {"yesterday": yesterday, "yesterday_count": cnt,
            "total_pending": total_pending,
            "comp_off_pending": comp_off_pending}


@api_router.get("/admin/overtime")
async def overtime_list(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    status_filter: Optional[str] = Query("pending", alias="status"),
    admin: dict = Depends(require_admin),
):
    office = await db.config.find_one({"id": "office"})
    if not date_from and not date_to:
        today = local_date_str(office)
        yesterday = (date.fromisoformat(today) - timedelta(days=1)).isoformat()
        date_from = date_to = yesterday
    q: dict = {"overtime_total_min": {"$gt": 0}}
    if status_filter and status_filter != "all":
        q["overtime_status"] = status_filter
    if date_from or date_to:
        date_q: dict = {}
        if date_from:
            date_q["$gte"] = date_from
        if date_to:
            date_q["$lte"] = date_to
        q["date"] = date_q
    rows = await db.attendance.find(q, {"_id": 0}).sort("date", -1).to_list(2000)
    user_ids = list({r["user_id"] for r in rows})
    users = await db.users.find({"id": {"$in": user_ids}}, {"_id": 0}).to_list(2000)
    umap = {u["id"]: u for u in users}
    out = []
    for r in rows:
        u = umap.get(r["user_id"], {})
        out.append({
            "session_id": r["id"],
            "user_id": r["user_id"],
            "member_name": u.get("full_name", "Unknown"),
            "category": u.get("category"),
            "rank": u.get("rank"),
            "photo": u.get("photo_thumb") or u.get("photo"),
            "date": r.get("date"),
            "check_in_at": r.get("check_in_at"),
            "check_out_at": r.get("check_out_at"),
            "work_start": u.get("work_start"),
            "work_end": u.get("work_end"),
            "early_min": int(r.get("overtime_early_min") or 0),
            "late_min": int(r.get("overtime_late_min") or 0),
            "total_min": int(r.get("overtime_total_min") or 0),
            "reason": r.get("overtime_reason"),
            "status": r.get("overtime_status") or "pending",
            "admin_note": r.get("overtime_admin_note"),
            "decided_by": r.get("overtime_decided_by"),
            "decided_at": r.get("overtime_decided_at"),
        })
    return {"date_from": date_from, "date_to": date_to, "rows": out}


@api_router.post("/admin/overtime/{session_id}/decide")
async def overtime_decide(session_id: str, body: OvertimeDecisionIn, admin: dict = Depends(require_admin)):
    sess = await db.attendance.find_one({"id": session_id}, {"_id": 0})
    if not sess:
        raise HTTPException(status_code=404, detail="Session not found")
    if int(sess.get("overtime_total_min") or 0) <= 0:
        raise HTTPException(status_code=400, detail="No overtime on this session")
    await db.attendance.update_one({"id": session_id}, {"$set": {
        "overtime_status": body.status,
        "overtime_admin_note": (body.admin_note or "").strip() or None,
        "overtime_decided_by": admin["full_name"],
        "overtime_decided_at": now_utc().isoformat(),
    }})
    return {"ok": True, "status": body.status}




# ----------------------------------------------------------------------------
# Presence board
# ----------------------------------------------------------------------------
async def active_leave_for(user_id: str, on: str) -> Optional[dict]:
    return await db.leaves.find_one({
        "user_id": user_id,
        "status": "approved",
        "start_date": {"$lte": on},
        "end_date": {"$gte": on},
    }, {"_id": 0})


@api_router.get("/presence")
async def presence(on: Optional[str] = None, user: dict = Depends(get_current_user)):
    """Live presence (live=today, view-only=historical).

    Pass `?on=YYYY-MM-DD` to view a past day. On past days everything
    "live" (overdue, notify_due, late recompute, late SMS dispatch) is
    suppressed — the view is read-only. Today is the default.

    Implementation phases (search for the banner comments below):
      1. **GATHER** — bulk-read users, sessions, leaves, late-coming
         notices, parent-notification log, camps, breaks, admin contacts,
         and 30-day lookback for absent-streak.
      2. **RESOLVE** — single pass over users that determines each
         member's status (on_campus / exited / temp_out / on_tour /
         on_leave / absent / not_due) plus chips (late, days_remaining,
         excursion_count, days_absent_streak, notify_due, geo).
      3. **RENDER** — assemble counts, attach the active camps strip,
         and return the JSON shape consumed by the Presence Board.
    """
    # ================== 1. GATHER =====================================
    office = await db.config.find_one({"id": "office"})
    today = local_date_str(office)
    is_historical = bool(on and on != today)
    target_date = on if on else today
    users = await db.users.find(
        {}, {"_id": 0, "id": 1, "full_name": 1, "role": 1, "category": 1, "rank": 1,
             "photo_thumb": 1, "photo": 1, "work_start": 1, "work_end": 1, "institution": 1,
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
    else:
        sessions = await db.attendance.find({"check_out_at": None}, {"_id": 0}).to_list(5000)
        sess_map = {s["user_id"]: s for s in sessions}
        last_outs = await db.attendance.aggregate([
            {"$match": {"check_out_at": {"$ne": None}, "date": target_date}},
            {"$sort": {"check_out_at": -1}},
            {"$group": {"_id": "$user_id", "doc": {"$first": "$$ROOT"}}},
        ]).to_list(5000)
        last_map = {d["_id"]: d["doc"] for d in last_outs}

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

    # Breaks overlay — like an approved leave but applied to whole categories /
    # institutions / arbitrary member groups. Bulk-fetch, resolve per-member.
    breaks_today = await _breaks_module.fetch_breaks_active_on(db, target_date)
    def _break_for(u: dict) -> Optional[dict]:
        return _breaks_module.resolve_member_break(u, breaks_today)

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
    # We pre-fetch attendance + approved leave dates for the past 30 days
    # in two bulk queries, then walk backwards per absent member to find their
    # last covered day. Days falling on the member's weekly_off don't count.
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

    WEEKDAY_KEY = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]

    def _consecutive_absent_days(u: dict) -> int:
        """Count consecutive days (max 30) before today where the member had
        no attendance, no approved leave/tour, no covering break, and the day
        is not their weekly_off. Stops at the first 'covered' day."""
        atts_set = att_dates_by_user.get(u["id"], set())
        leaves_set = leave_dates_by_user.get(u["id"], set())
        weekly_off = (u.get("weekly_off") or "").lower()
        n = 0
        d = today_d - timedelta(days=1)
        for _ in range(30):
            ds = d.isoformat()
            if ds in atts_set or ds in leaves_set:
                break
            # Is this day covered by a break that applies to this member?
            covered_by_break = any(
                b.get("start_date") <= ds <= b.get("end_date")
                and _breaks_module.break_applies_to(b, u)
                for b in recent_breaks
            )
            if covered_by_break:
                break
            # Weekly off doesn't COUNT as absent but doesn't BREAK the streak —
            # skip it (move further back).
            if WEEKDAY_KEY[d.weekday()] != weekly_off:
                n += 1
            d -= timedelta(days=1)
        return n

    # ================== 2. RESOLVE ====================================
    # Single pass over the roster. Each iteration consumes the bulk-fetched
    # maps from the GATHER phase, applies the camp/break overlays, and
    # emits one fully-populated row for the RENDER phase below.
    result = []
    for u in users:
        # Use a small thumbnail in list responses so the Presence Board payload
        # stays under a couple hundred KB regardless of head-count. Falls back to
        # the full photo for legacy members who haven't been backfilled yet.
        u_thumb = u.get("photo_thumb") or u.get("photo")
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
        elif leave and leave["type"] == "leave":
            status_v = "on_leave"
            detail = f"Till {leave['end_date']}"
            since = leave["start_date"]
            photo = u_thumb
        elif brk:
            # On break — same precedence as an approved leave. Surfaces under
            # the Leave column with an "On break" tag so coaches can distinguish
            # group breaks from individual leaves at a glance.
            status_v = "on_leave"
            detail = f"On break · {brk.get('name', '')}".rstrip(" ·")
            since = brk.get("start_date")
            photo = u_thumb
        elif sess:
            open_exc = _open_excursion(sess)
            if open_exc:
                status_v = "temp_out"
                detail = (open_exc.get("reason") or "Stepped out") + " · since " + local_hm(office, open_exc.get("out_at"))
                since = open_exc.get("out_at")
                photo = u_thumb
            else:
                status_v = "on_campus"
                detail = "Since " + local_hm(office, sess["check_in_at"])
                since = sess["check_in_at"]
                photo = sess.get("check_in_photo_thumb") or u_thumb
            geo_in = {
                "method": sess.get("method"),
                "distance_m": sess.get("distance_m"),
                "out_of_geofence": bool(sess.get("out_of_geofence")),
                "geo_unavailable": bool(sess.get("geo_unavailable")),
                "by": sess.get("checked_in_by"),
            }
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
                if camp_today:
                    ws_hm = camp_today.get("start_time") or "09:00"
                    cg = camp_today.get("late_grace_minutes")
                    grace = int(cg if cg is not None else (office.get("late_grace_minutes") or 0))
                    is_expected_today = True
                else:
                    ws_hm = u.get("work_start") or office.get("default_work_start") or "09:00"
                    grace = int(office.get("late_grace_minutes") or 0)
                    # Athletes with no personal work_start AND no camp today
                    # aren't expected on campus. Skip the "absent" branch so
                    # we don't slander camp-only kids on weekdays.
                    is_expected_today = bool(u.get("work_start")) or u.get("category") != "athlete"
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
                    if camp_today:
                        detail = f"Camp “{camp_today['name']}” starts {ws_hm}"
                    elif is_expected_today:
                        detail = f"Shift starts {ws_hm}"
                    else:
                        detail = "No camp scheduled today"
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
        if u.get("category") == "athlete" and not is_historical:
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
            "status": status_v,
            "detail": detail,
            "since": since,
            "photo": photo,
            "flagged": bool(sess and sess.get("out_of_geofence") and status_v == "on_campus"),
            "late": recomputed_late,
            "expected_return": open_exc_v.get("expected_return") if open_exc_v else None,
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
    return {
        "members": result,
        "counts": counts,
        "date": target_date,
        "is_historical": is_historical,
        "admin_contacts": admin_contacts,
        "notify_grace_minutes": notify_grace,
    }


# ----------------------------------------------------------------------------
# Parent-notification dispatches
# ----------------------------------------------------------------------------
class ParentNotifyDispatchIn(BaseModel):
    user_id: str
    type: Literal["not_arrived", "late"]


@api_router.post("/parent-notify/dispatch")
async def parent_notify_dispatch(body: ParentNotifyDispatchIn, user: dict = Depends(get_current_user)):
    """Record that the current operator has dispatched a parent-notification SMS
    (via the device's native SMS composer). One record per (user, date, type)
    so the UI suppresses the button after the first send. This endpoint does
    not actually send any SMS — the device's messaging app does."""
    office = await db.config.find_one({"id": "office"})
    today = local_date_str(office)
    target = await db.users.find_one({"id": body.user_id}, {"_id": 0, "full_name": 1})
    if not target:
        raise HTTPException(status_code=404, detail="Member not found")
    existing = await db.parent_notifications.find_one(
        {"user_id": body.user_id, "date": today, "type": body.type}, {"_id": 0}
    )
    if existing:
        return {"already_sent": True, "sent_at": existing.get("sent_at"), "sent_by": existing.get("sent_by_name")}
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": body.user_id,
        "date": today,
        "type": body.type,
        "sent_at": now_utc().isoformat(),
        "sent_by_id": user["id"],
        "sent_by_name": user.get("full_name"),
    }
    try:
        await db.parent_notifications.insert_one(doc)
    except DuplicateKeyError:
        # Concurrent coaches both clicked Notify at the same moment — the
        # unique (user_id,date,type) index won the race for us. Re-read and
        # report the winner.
        existing = await db.parent_notifications.find_one(
            {"user_id": body.user_id, "date": today, "type": body.type}, {"_id": 0}
        )
        return {"already_sent": True, "sent_at": existing.get("sent_at"), "sent_by": existing.get("sent_by_name")}
    return {"already_sent": False, "sent_at": doc["sent_at"], "sent_by": doc["sent_by_name"]}


# ----------------------------------------------------------------------------
# Leave / Tour endpoints moved to routes/leaves.py — see app.include_router
# call near the bottom of this file.
# ----------------------------------------------------------------------------


# ----------------------------------------------------------------------------
# Member self stats
# ----------------------------------------------------------------------------
@api_router.get("/me/stats")
async def my_stats(user: dict = Depends(get_current_user)):
    office = await db.config.find_one({"id": "office"})
    today = local_now(office).date()
    week_start = (today - timedelta(days=today.weekday())).isoformat()
    month_start = today.replace(day=1).isoformat()
    sessions = await db.attendance.find(
        {"user_id": user["id"], "hours": {"$ne": None}}, {"_id": 0}
    ).sort("check_in_at", -1).to_list(500)
    week_hours = round(sum((s["hours"] or 0) for s in sessions if s["date"] >= week_start), 2)
    month_hours = round(sum((s["hours"] or 0) for s in sessions if s["date"] >= month_start), 2)
    days_this_week = len({s["date"] for s in sessions if s["date"] >= week_start})
    late_days_this_week = len({s["date"] for s in sessions if s.get("late") and s["date"] >= week_start})
    open_sess = await open_session_for(user["id"])
    pending_leaves = await db.leaves.count_documents({"user_id": user["id"], "status": "pending"})
    recent = sessions[:10]
    return {
        "week_hours": week_hours,
        "month_hours": month_hours,
        "days_this_week": days_this_week,
        "late_days_this_week": late_days_this_week,
        "checked_in": open_sess is not None,
        "open_session": open_sess,
        "pending_leaves": pending_leaves,
        "recent": recent,
    }


# ----------------------------------------------------------------------------


# ----------------------------------------------------------------------------
# Muster roll — bulk check-in/out for athletes performed by a coach or admin.
# Athletes typically don't have phones; a coach physically musters them and
# ticks who's present (or who's departing).
# ----------------------------------------------------------------------------
def _can_muster(user: dict) -> bool:
    return user.get("role") == "admin" or user.get("category") == "coach"


def _require_muster(user: dict) -> None:
    if not _can_muster(user):
        raise HTTPException(status_code=403, detail="Only coaches and admins can run muster")


class MusterBulkIn(BaseModel):
    athlete_ids: List[str]


@api_router.get("/muster/athletes")
async def muster_athletes(mode: str = "checkin", user: dict = Depends(get_current_user)):
    """List athletes eligible for the given muster mode:
       checkin  → athletes not currently on-campus AND not on leave/tour AND not
                  already closed-out today
       checkout → athletes currently checked in (open session)
    """
    _require_muster(user)
    if mode not in ("checkin", "checkout"):
        raise HTTPException(status_code=400, detail="mode must be 'checkin' or 'checkout'")

    office = await db.config.find_one({"id": "office"})
    today = local_date_str(office)

    athletes = await db.users.find({"category": "athlete"}, {"_id": 0}).to_list(2000)

    open_sessions = await db.attendance.find({"check_out_at": None}, {"_id": 0, "user_id": 1}).to_list(2000)
    open_ids = {s["user_id"] for s in open_sessions}

    on_leave = await db.leaves.find(
        {"status": "approved", "start_date": {"$lte": today}, "end_date": {"$gte": today}},
        {"_id": 0, "user_id": 1},
    ).to_list(2000)
    on_leave_ids = {leave["user_id"] for leave in on_leave}

    out: List[dict] = []
    for s in athletes:
        sid = s["id"]
        if mode == "checkin":
            # Athlete is eligible to check in if NOT currently on-campus and NOT on leave/tour.
            # (Athletes who already checked out today CAN check in again for a second session.)
            if sid in open_ids or sid in on_leave_ids:
                continue
        else:  # checkout
            if sid not in open_ids:
                continue
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
        })

    out.sort(key=lambda x: (x["full_name"] or "").lower())
    return {"mode": mode, "date": today, "athletes": out, "count": len(out)}


@api_router.post("/muster/checkin-bulk")
async def muster_checkin_bulk(body: MusterBulkIn, user: dict = Depends(get_current_user)):
    _require_muster(user)
    office = await db.config.find_one({"id": "office"})
    today = local_date_str(office)
    now = now_utc()
    done, skipped = [], []
    for sid in body.athlete_ids:
        athlete = await db.users.find_one({"id": sid, "category": "athlete"}, {"_id": 0})
        if not athlete:
            skipped.append({"id": sid, "reason": "not an athlete"})
            continue
        if await db.attendance.find_one({"user_id": sid, "check_out_at": None}):
            skipped.append({"id": sid, "name": athlete["full_name"], "reason": "already checked in"})
            continue
        late, late_min = compute_late(office, athlete, now, camp=await _active_camp_for(athlete, now, office))
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
            "latitude": None,
            "longitude": None,
            "out_of_geofence": False,
            "distance_m": 0,
            "late": late,
            "late_minutes": late_min,
            "excursions": [],
            "created_at": now.isoformat(),
        }
        await db.attendance.insert_one(att)
        done.append({"id": sid, "name": athlete["full_name"], "late": late})
    return {"checked_in_count": len(done), "skipped_count": len(skipped), "checked_in": done, "skipped": skipped}


@api_router.post("/muster/checkout-bulk")
async def muster_checkout_bulk(body: MusterBulkIn, user: dict = Depends(get_current_user)):
    _require_muster(user)
    now = now_utc()
    done, skipped = [], []
    for sid in body.athlete_ids:
        athlete = await db.users.find_one({"id": sid, "category": "athlete"}, {"_id": 0})
        if not athlete:
            skipped.append({"id": sid, "reason": "not an athlete"})
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
        away_s = _excursion_seconds(excursions)
        hours = round((now - cin).total_seconds() / 3600.0, 2)
        await db.attendance.update_one({"id": sess["id"]}, {"$set": {
            "check_out_at": now.isoformat(),
            "hours": hours,
            "away_minutes": int(away_s / 60),
            "excursions": excursions,
            "exit_method": "muster",
            "exit_out_of_geofence": False,
            "exit_latitude": None,
            "exit_longitude": None,
            "exit_distance_m": 0,
            "checked_out_by": user["full_name"],
            "checked_out_by_id": user["id"],
        }})
        done.append({"id": sid, "name": athlete["full_name"], "hours": hours})
    return {"checked_out_count": len(done), "skipped_count": len(skipped), "checked_out": done, "skipped": skipped}


# Daily sessions table — one row per member per day with full excursion timeline
# ----------------------------------------------------------------------------
@api_router.get("/admin/sessions")
async def admin_sessions(on: Optional[str] = None, admin: dict = Depends(require_admin)):
    office = await db.config.find_one({"id": "office"})
    if not on:
        on = local_date_str(office)

    sessions = await db.attendance.find({"date": on}, {"_id": 0}).sort("check_in_at", 1).to_list(2000)
    user_ids = list({s["user_id"] for s in sessions})
    users = await db.users.find({"id": {"$in": user_ids}}, {"_id": 0}).to_list(2000)
    umap = {u["id"]: u for u in users}
    now = now_utc()

    rows: List[dict] = []
    for s in sessions:
        u = umap.get(s["user_id"], {})
        excursions = s.get("excursions") or []
        # Decorate excursions with derived fields.
        excs_out: List[dict] = []
        for e in excursions:
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
                    ref = datetime.fromisoformat(in_iso) if in_iso else now
                    diff = int((ref - er).total_seconds() // 60)
                    overdue_min = max(0, diff)
                except Exception:
                    pass
            excs_out.append({
                "id": e.get("id"),
                "out_at": out_iso,
                "out_time": local_hm(office, out_iso),
                "in_at": in_iso,
                "in_time": local_hm(office, in_iso) if in_iso else "",
                "reason": e.get("reason"),
                "expected_return": e.get("expected_return"),
                "expected_return_time": local_hm(office, e.get("expected_return")) if e.get("expected_return") else "",
                "duration_min": duration_min,
                "overdue_min": overdue_min,
                "open": not bool(in_iso),
            })

        # Hours logged = full session duration (excursions are on office hours).
        cin = datetime.fromisoformat(s["check_in_at"])
        cout = datetime.fromisoformat(s["check_out_at"]) if s.get("check_out_at") else None
        end_ref = cout or now
        away_s = _excursion_seconds(excursions, up_to=end_ref if not cout else None)
        hours = round(max(0.0, (end_ref - cin).total_seconds()) / 3600.0, 2)

        rows.append({
            "session_id": s["id"],
            "member_id": s["user_id"],
            "member_name": u.get("full_name", "Unknown"),
            "member_category": u.get("category"),
            "member_rank": u.get("rank"),
            "photo": u.get("photo_thumb") or u.get("photo"),
            "check_in_at": s["check_in_at"],
            "check_in_time": local_hm(office, s["check_in_at"]),
            "check_out_at": s.get("check_out_at"),
            "check_out_time": local_hm(office, s["check_out_at"]) if s.get("check_out_at") else "",
            "method": s.get("method"),
            "late": bool(s.get("late")),
            "late_minutes": s.get("late_minutes") or 0,
            "out_of_geofence": bool(s.get("out_of_geofence")),
            "open": s.get("check_out_at") is None,
            "on_temp_exit": s.get("check_out_at") is None and any(e["open"] for e in excs_out),
            "excursions": excs_out,
            "excursion_count": len(excs_out),
            "away_minutes": int(away_s / 60),
            "hours": hours,
            "stored_hours": s.get("hours"),
            "auto_checkout": bool(s.get("auto_checkout")),
            "auto_checkout_reason": s.get("auto_checkout_reason"),
            "reminder_sent_at": s.get("reminder_sent_at"),
        })

    rows.sort(key=lambda r: (not r["open"], r["check_in_at"]))
    counts = {
        "members": len(rows),
        "open": sum(1 for r in rows if r["open"]),
        "on_temp_exit": sum(1 for r in rows if r["on_temp_exit"]),
        "closed": sum(1 for r in rows if not r["open"]),
        "auto_closed": sum(1 for r in rows if r.get("auto_checkout")),
        "total_excursions": sum(r["excursion_count"] for r in rows),
    }
    return {"date": on, "timezone": (office or {}).get("timezone") or DEFAULT_TZ, "rows": rows, "counts": counts}




# ----------------------------------------------------------------------------
# Admin dashboard summary
# ----------------------------------------------------------------------------
@api_router.post("/admin/attendance/wipe")
async def admin_wipe_attendance(admin: dict = Depends(require_admin)):
    """Danger zone: delete ALL attendance records. Useful when starting a
    fresh term or restoring from a master-only backup. Leaves users,
    leaves, institutions, and office config untouched."""
    before = await db.attendance.count_documents({})
    res = await db.attendance.delete_many({})
    return {
        "before": before,
        "deleted": res.deleted_count,
        "remaining": await db.attendance.count_documents({}),
    }


@api_router.get("/admin/backup")
async def admin_backup(admin: dict = Depends(require_admin)):
    """Download a FULL database snapshot — every collection (users, attendance,
    leaves, institutions, config, devices, parent_notifications, camps,
    regattas, guests, daily_content, sms_log) as a single tar.gz. Designed
    for moving data back and forth between prod ↔ preview environments.

    Streams each collection in batches of 500 docs so memory stays bounded
    even when attendance grows to tens of thousands of rows.
    """
    import tarfile
    import io as _io
    import json as _json
    from datetime import datetime as _dt, timezone as _tz

    buf = _io.BytesIO()
    tf = tarfile.open(fileobj=buf, mode="w:gz")

    collections = [
        "users", "institutions", "config", "attendance", "leaves",
        "devices", "parent_notifications", "camps", "regattas",
        "guests", "daily_content", "sms_log", "breaks", "fleets",
    ]
    manifest = {
        "created_at": _dt.now(_tz.utc).isoformat(),
        "kind": "ych-full",
        "collections": {},
    }
    BATCH = 500
    for name in collections:
        # Stream the collection in chunks so we don't hold the whole list
        # in memory. Each JSON file written to the tar is built incrementally.
        chunks: list[bytes] = [b"[\n"]
        total = 0
        first = True
        cursor = db[name].find({}, {"_id": 0})
        async for d in cursor:
            if not first:
                chunks.append(b",\n")
            chunks.append(_json.dumps(d, default=str).encode("utf-8"))
            first = False
            total += 1
            # Periodically flush the chunk list into a single bytes blob to
            # keep Python list overhead small (still in-memory, but compacted).
            if total % BATCH == 0:
                chunks = [b"".join(chunks)]
        chunks.append(b"\n]")
        payload = b"".join(chunks)
        info = tarfile.TarInfo(f"ych-full/{name}.json")
        info.size = len(payload)
        tf.addfile(info, _io.BytesIO(payload))
        manifest["collections"][name] = total

    mpayload = _json.dumps(manifest, indent=2).encode("utf-8")
    info = tarfile.TarInfo("ych-full/manifest.json")
    info.size = len(mpayload)
    tf.addfile(info, _io.BytesIO(mpayload))
    tf.close()

    fname = f"ych-full-{_dt.now().strftime('%Y%m%d-%H%M')}.tar.gz"
    return Response(
        content=buf.getvalue(),
        media_type="application/gzip",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@api_router.post("/admin/restore")
async def admin_restore(
    file: UploadFile = File(...),
    mode: str = "merge",
    admin: dict = Depends(require_admin),
):
    """Restore FULL database from a backup tar.gz.
    mode='merge'   → insert only docs whose `id` isn't already present
                     (safe — existing records stay intact)
    mode='replace' → wipe every restored collection first, then reload
                     (DANGEROUS — clears current data including admins)"""
    import tarfile
    import io as _io
    import json as _json

    raw = await file.read()
    try:
        tf = tarfile.open(fileobj=_io.BytesIO(raw), mode="r:gz")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not open archive: {e}")

    counts: dict = {}
    collections = [
        "users", "institutions", "config", "attendance", "leaves",
        "devices", "parent_notifications", "camps", "regattas",
        "guests", "daily_content", "sms_log", "breaks", "fleets",
    ]
    from pymongo import InsertOne
    BATCH = 500
    for tname in collections:
        member = None
        for m in tf.getmembers():
            if m.name.endswith(f"/{tname}.json") or m.name == f"{tname}.json":
                member = m
                break
        if not member:
            counts[tname] = 0
            continue
        fh = tf.extractfile(member)
        if not fh:
            counts[tname] = 0
            continue
        try:
            docs = _json.loads(fh.read().decode("utf-8"))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"{tname}.json parse failed: {e}")
        if not isinstance(docs, list):
            raise HTTPException(status_code=400, detail=f"{tname}.json must be a JSON list")
        col = db[tname]
        if mode == "replace":
            await col.delete_many({})
        added = 0
        # Process in BATCH-sized chunks: one $in lookup for existing IDs +
        # a single bulk_write per chunk → O(docs/BATCH) DB round trips
        # instead of O(docs).
        for i in range(0, len(docs), BATCH):
            chunk = docs[i:i + BATCH]
            for d in chunk:
                d.pop("_id", None)
            existing_ids: set = set()
            if mode == "merge":
                ids_in_chunk = [d.get("id") for d in chunk if d.get("id")]
                if ids_in_chunk:
                    async for row in col.find({"id": {"$in": ids_in_chunk}}, {"_id": 0, "id": 1}):
                        existing_ids.add(row["id"])
            ops = [InsertOne(d) for d in chunk
                   if not (mode == "merge" and d.get("id") and d["id"] in existing_ids)]
            if not ops:
                continue
            try:
                res = await col.bulk_write(ops, ordered=False)
                added += res.inserted_count
            except Exception as e:
                # Duplicate-key races: count the successes that did land,
                # surface a soft warning in the response instead of failing
                # the whole restore.
                logger.warning("bulk_write partial failure for %s: %s", tname, e)
                added += getattr(getattr(e, "details", {}), "get", lambda *_: 0)("nInserted") or 0
        counts[tname] = added
    return {"mode": mode, "inserted": counts}


@api_router.get("/admin/summary")
async def admin_summary(admin: dict = Depends(require_admin)):
    office = await db.config.find_one({"id": "office"})
    today = local_date_str(office)
    total_members = await db.users.count_documents({})
    on_campus = await db.attendance.count_documents({"check_out_at": None})
    pending_leaves = await db.leaves.count_documents({"status": "pending"})
    on_leave_tour = await db.leaves.count_documents({
        "status": "approved",
        "start_date": {"$lte": today},
        "end_date": {"$gte": today},
    })
    late_today = await db.attendance.count_documents({"date": today, "late": True})
    return {
        "total_members": total_members,
        "on_campus": on_campus,
        "pending_leaves": pending_leaves,
        "on_leave_tour": on_leave_tour,
        "late_today": late_today,
    }


# ----------------------------------------------------------------------------
# Live activity feed (today only — auto-resets each midnight in office tz)
# ----------------------------------------------------------------------------
@api_router.get("/admin/activity")
async def admin_activity(admin: dict = Depends(require_admin)):
    """Today's events in the office timezone: check-ins, check-outs, leave/tour
    applications, and device access requests. Sorted newest-first."""
    office = await db.config.find_one({"id": "office"})
    today_local = local_date_str(office)  # YYYY-MM-DD in office tz

    # Office tz start-of-today (UTC). We compare against UTC-ISO timestamps stored in DB.
    tz = office_tz(office)
    start_local = datetime.fromisoformat(today_local + "T00:00:00").replace(tzinfo=tz)
    start_utc = start_local.astimezone(timezone.utc).isoformat()

    # Pull today's attendance rows (already keyed by office-local date) — covers check-ins.
    atts = await db.attendance.find({"date": today_local}, {"_id": 0}).to_list(2000)
    # Plus any sessions that *checked out* today even if check-in was earlier (rare overnight case).
    extra_outs = await db.attendance.find(
        {"check_out_at": {"$gte": start_utc}, "date": {"$ne": today_local}},
        {"_id": 0}
    ).to_list(2000)
    all_atts = atts + extra_outs

    # Today's leave/tour submissions (regardless of approval state).
    leaves_today = await db.leaves.find(
        {"created_at": {"$gte": start_utc}}, {"_id": 0}
    ).to_list(2000)

    # Today's device sign-in requests.
    devices_today = await db.devices.find(
        {"created_at": {"$gte": start_utc}}, {"_id": 0}
    ).to_list(2000)

    # Resolve member names in one batch.
    user_ids = set()
    for a in all_atts:
        if a.get("user_id"):
            user_ids.add(a["user_id"])
    for leave in leaves_today:
        if leave.get("user_id"):
            user_ids.add(leave["user_id"])
    for d in devices_today:
        if d.get("user_id"):
            user_ids.add(d["user_id"])
    users = await db.users.find({"id": {"$in": list(user_ids)}}, {"_id": 0}).to_list(2000)
    umap = {u["id"]: u for u in users}

    events: List[dict] = []

    for a in all_atts:
        u = umap.get(a.get("user_id"), {})
        if a.get("check_in_at"):
            events.append({
                "id": f"checkin-{a['id']}",
                "type": "check_in",
                "at": a["check_in_at"],
                "member_id": a.get("user_id"),
                "member_name": u.get("full_name", "Unknown"),
                "member_category": u.get("category"),
                "member_rank": u.get("rank"),
                "photo": u.get("photo_thumb") or u.get("photo"),
                "detail": "Checked in" + (f" · Late {a.get('late_minutes')}m" if a.get("late") else "")
                          + (" · Off-site" if a.get("out_of_geofence") else ""),
                "method": a.get("method"),
            })
        if a.get("check_out_at"):
            events.append({
                "id": f"checkout-{a['id']}",
                "type": "check_out",
                "at": a["check_out_at"],
                "member_id": a.get("user_id"),
                "member_name": u.get("full_name", "Unknown"),
                "member_category": u.get("category"),
                "member_rank": u.get("rank"),
                "photo": u.get("photo_thumb") or u.get("photo"),
                "detail": f"Checked out · {a.get('hours', '?')}h"
                          + (" · Off-site" if a.get("exit_out_of_geofence") else ""),
                "method": a.get("exit_method") or a.get("method"),
            })
        # Temporary excursions (lunch / errand etc.)
        for e in (a.get("excursions") or []):
            if e.get("out_at"):
                events.append({
                    "id": f"tempout-{e.get('id', a['id'])}",
                    "type": "temp_exit",
                    "at": e["out_at"],
                    "member_id": a.get("user_id"),
                    "member_name": u.get("full_name", "Unknown"),
                    "member_category": u.get("category"),
                    "member_rank": u.get("rank"),
                    "photo": u.get("photo_thumb") or u.get("photo"),
                    "detail": "Temp exit · " + (e.get("reason") or "")
                              + (f" · expected {local_hm(office, e.get('expected_return'))}" if e.get("expected_return") else ""),
                })
            if e.get("in_at"):
                events.append({
                    "id": f"tempin-{e.get('id', a['id'])}",
                    "type": "temp_return",
                    "at": e["in_at"],
                    "member_id": a.get("user_id"),
                    "member_name": u.get("full_name", "Unknown"),
                    "member_category": u.get("category"),
                    "member_rank": u.get("rank"),
                    "photo": u.get("photo_thumb") or u.get("photo"),
                    "detail": "Returned" + (f" · {int((datetime.fromisoformat(e['in_at']) - datetime.fromisoformat(e['out_at'])).total_seconds() // 60)}m away" if e.get("out_at") else ""),
                })

    for leave in leaves_today:
        u = umap.get(leave.get("user_id"), {})
        events.append({
            "id": f"leave-{leave['id']}",
            "type": "application",
            "subtype": leave.get("type"),  # leave | tour
            "at": leave.get("created_at"),
            "member_id": leave.get("user_id"),
            "member_name": u.get("full_name", "Unknown"),
            "member_category": u.get("category"),
            "member_rank": u.get("rank"),
            "photo": u.get("photo_thumb") or u.get("photo"),
            "detail": f"Applied for {leave.get('type', 'leave')}"
                      + (f" · {leave.get('start_date')} → {leave.get('end_date')}" if leave.get("start_date") else "")
                      + (f" · {leave.get('location')}" if leave.get("location") else ""),
            "status": leave.get("status"),
        })

    for d in devices_today:
        u = umap.get(d.get("user_id"), {})
        events.append({
            "id": f"device-{d['id']}",
            "type": "access_request",
            "at": d.get("created_at"),
            "member_id": d.get("user_id"),
            "member_name": u.get("full_name") or (f"Unmatched · {d.get('phone')}" if d.get("phone") else "Unknown device"),
            "member_category": u.get("category"),
            "member_rank": u.get("rank"),
            "photo": u.get("photo_thumb") or u.get("photo"),
            "detail": f"New sign-in request · {d.get('device_name') or d.get('platform') or 'device'}",
            "status": d.get("status"),
        })

    events.sort(key=lambda e: e.get("at") or "", reverse=True)
    return {
        "date": today_local,
        "timezone": (office or {}).get("timezone") or DEFAULT_TZ,
        "events": events,
        "counts": {
            "check_in": sum(1 for e in events if e["type"] == "check_in"),
            "check_out": sum(1 for e in events if e["type"] == "check_out"),
            "temp_exit": sum(1 for e in events if e["type"] == "temp_exit"),
            "temp_return": sum(1 for e in events if e["type"] == "temp_return"),
            "applications": sum(1 for e in events if e["type"] == "application"),
            "access_requests": sum(1 for e in events if e["type"] == "access_request"),
            "total": len(events),
        },
    }




# ----------------------------------------------------------------------------
# Reports
# ----------------------------------------------------------------------------
async def compute_hours_report(start: str, end: str) -> List[dict]:
    """Aggregate hours and days present per member between dates inclusive."""
    users = await db.users.find(
        {}, {"_id": 0, "id": 1, "full_name": 1, "category": 1, "rank": 1, "weekly_off": 1}
    ).sort("full_name", 1).to_list(2000)
    sd = date.fromisoformat(start)
    ed = date.fromisoformat(end)
    span_days = max(1, (ed - sd).days + 1)

    # Batch: all attendance in range, grouped by user_id. Open sessions
    # (no check-out yet) are INCLUDED — a same-day check-in counts as a
    # "Present" day even if the member hasn't checked out yet. Hours are
    # only added when the session has actually closed (`hours` field set).
    atts = await db.attendance.find(
        {"date": {"$gte": start, "$lte": end}},
        {"_id": 0, "user_id": 1, "date": 1, "hours": 1, "late": 1, "excursions": 1,
         "overtime_total_min": 1, "overtime_status": 1, "check_out_at": 1},
    ).to_list(100000)
    by_user: dict = {}
    for a in atts:
        by_user.setdefault(a["user_id"], []).append(a)

    def _overstays(sessions: List[dict]) -> int:
        """Count excursions where the member returned later than the
        expected_return time (or hasn't returned at all yet but expected_return
        is past). Each such excursion counts as one overstay."""
        count = 0
        now = now_utc()
        for s in sessions:
            for e in (s.get("excursions") or []):
                er_raw = e.get("expected_return")
                if not er_raw:
                    continue
                try:
                    er = datetime.fromisoformat(er_raw)
                except Exception:
                    continue
                in_iso = e.get("in_at")
                ref = None
                if in_iso:
                    try:
                        ref = datetime.fromisoformat(in_iso)
                    except Exception:
                        ref = None
                else:
                    ref = now
                if ref and (ref - er).total_seconds() > 0:
                    count += 1
        return count

    # Approved leaves/tours that overlap the report window, grouped by user.
    leaves = await db.leaves.find(
        {
            "status": "approved",
            "start_date": {"$lte": end},
            "end_date": {"$gte": start},
        },
        {"_id": 0, "user_id": 1, "type": 1, "start_date": 1, "end_date": 1},
    ).to_list(10000)
    leaves_by_user_typed: dict = {}
    for leave in leaves:
        leaves_by_user_typed.setdefault(leave["user_id"], {}) \
            .setdefault(leave.get("type") or "leave", []).append(leave)

    # Breaks that overlap the report window — folded into the leave column
    # since on the Presence Board breaks already render as on_leave.
    breaks_window = await db.breaks.find(
        {"start_date": {"$lte": end}, "end_date": {"$gte": start}},
        {"_id": 0},
    ).to_list(500)

    def _days_overlap(ls_str: str, le_str: str) -> set:
        """Return the set of YYYY-MM-DD strings where [ls,le] overlaps the
        report window [sd,ed]."""
        try:
            ls = max(date.fromisoformat(ls_str), sd)
            le = min(date.fromisoformat(le_str), ed)
        except Exception:
            return set()
        days = set()
        cur = ls
        while cur <= le:
            days.add(cur.isoformat())
            cur += timedelta(days=1)
        return days

    def _count_days_of_type(user_id: str, ltype: str) -> int:
        days: set = set()
        for leave in leaves_by_user_typed.get(user_id, {}).get(ltype, []):
            days |= _days_overlap(leave["start_date"], leave["end_date"])
        return len(days)

    def _count_break_days(member: dict) -> int:
        days: set = set()
        for b in breaks_window:
            if not _breaks_module.break_applies_to(b, member):
                continue
            days |= _days_overlap(b["start_date"], b["end_date"])
        return len(days)

    WEEKDAY_NAME = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"]

    def _comp_off_earned(u: dict, sessions: List[dict]) -> int:
        wo = (u.get("weekly_off") or "monday").lower()
        unique_days = set()
        for s in sessions:
            try:
                d_ = date.fromisoformat(s["date"])
            except Exception:
                continue
            if WEEKDAY_NAME[d_.weekday()] == wo:
                unique_days.add(s["date"])
        return len(unique_days)

    rows = []
    for u in users:
        sessions = by_user.get(u["id"], [])
        total_hours = round(sum(s.get("hours") or 0 for s in sessions), 2)
        days_present = len({s["date"] for s in sessions})
        late_days = len({s["date"] for s in sessions if s.get("late")})
        days_leave = _count_days_of_type(u["id"], "leave")
        days_tour = _count_days_of_type(u["id"], "tour")
        days_break = _count_break_days(u)
        # Combined "time-off" column for backward-compat with older clients.
        days_on_leave = days_leave + days_tour + days_break
        overstays = _overstays(sessions)
        approved_ot_min = sum(int(s.get("overtime_total_min") or 0)
                              for s in sessions
                              if s.get("overtime_status") == "approved")
        pending_ot_min = sum(int(s.get("overtime_total_min") or 0)
                             for s in sessions
                             if s.get("overtime_status") == "pending")
        # Compensatory off bookkeeping (within this report's date range)
        co_earned = _comp_off_earned(u, sessions)
        co_used = _count_days_of_type(u["id"], "comp_off")
        co_pending = max(0, co_earned - co_used)
        # Days the member is "accounted for" — present, leave, tour, break,
        # or comp-off. Anything else in the span is absent.
        days_accounted = days_present + days_leave + days_tour + days_break + co_used
        days_absent = max(0, span_days - days_accounted)
        attendance_pct = round((days_present / span_days) * 100, 1)
        rows.append({
            "member_id": u["id"],
            "member_name": u["full_name"],
            "category": u["category"],
            "rank": u.get("rank"),
            "weekly_off": u.get("weekly_off") or "monday",
            "total_hours": total_hours,
            "days_present": days_present,
            "late_days": late_days,
            "days_leave": days_leave,
            "days_tour": days_tour,
            "days_break": days_break,
            "days_absent": days_absent,
            "days_accounted": days_accounted,
            "days_on_leave": days_on_leave,
            "overstays": overstays,
            "overtime_hours_approved": round(approved_ot_min / 60.0, 2),
            "overtime_hours_pending": round(pending_ot_min / 60.0, 2),
            "comp_off_earned": co_earned,
            "comp_off_used": co_used,
            "comp_off_pending": co_pending,
            "span_days": span_days,
            "attendance_pct": attendance_pct,
        })
    return rows


# ----------------------------------------------------------------------------
# Reports endpoints moved to routes/reports.py — see app.include_router call
# near the bottom of this file. `compute_hours_report` stays here and is
# passed into the factory.
# ----------------------------------------------------------------------------


# ----------------------------------------------------------------------------
app.include_router(api_router)

# Leave / Tour routes — split out 06/2026 during the server.py refactor.
from routes.leaves import make_router as _leaves_router  # noqa: E402
_leaves = _leaves_router(db, require_admin, get_current_user)
app.include_router(_leaves)
# Routes/reports needs enrich_leaves; the leaves router exposes it as an
# attribute for re-use without re-implementing.
enrich_leaves = _leaves.enrich_leaves  # type: ignore[attr-defined]

# Reports — heavy aggregation lives in `compute_hours_report` (still in
# server.py for now); the router file owns the HTTP shape + exports.
from routes.reports import make_router as _reports_router  # noqa: E402
app.include_router(_reports_router(
    db, require_admin, get_current_user, compute_hours_report, enrich_leaves,
))

# Daily bilingual content (motivational quote / English-Telugu word-of-the-day)
# generated once per day with Gemini and cached in MongoDB.
from daily_content import make_router as _daily_router  # noqa: E402
app.include_router(_daily_router(db))

# Guest check-in / check-out (coaches + admins).
from guests import make_router as _guests_router  # noqa: E402
app.include_router(_guests_router(db, require_coach_or_admin, local_date_str))

# Camps — scheduling overlay for institutional camps. Imported at the top of
# this file so the helpers can be reused by the late computation paths above.
app.include_router(_camps_module.make_router(db, require_admin))

# Regattas — national / international sailing events. Shown alongside camps on
# the unified Calendar view.
app.include_router(_regattas_module.make_router(db, require_admin))

# Breaks — holiday / rest-day overlay. While active, the covered members
# show up under Leave on the Presence Board (not Absent) and skip
# late-notification dispatches for the day.
app.include_router(_breaks_module.make_router(db, require_admin))


# Twilio SMS + Voice — parent notifications, per-institution sender numbers.
from sms import make_router as _sms_router  # noqa: E402
app.include_router(_sms_router(db, require_admin))


# Lightweight keep-alive endpoint — no auth, no DB hit. Plug an UptimeRobot
# (or similar) ping into https://i-showed-up.ychyderabad.com/api/health every
# 5-10 minutes to prevent any idle-container cold-starts during morning peak.
@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "i-showed-up"}

app.add_middleware(
    CORSMiddleware,
    allow_credentials=False,
    allow_origins=[
        o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",") if o.strip()
    ] or ["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
