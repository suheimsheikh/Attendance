from fastapi import FastAPI, APIRouter, HTTPException, Depends, status, UploadFile, File
from fastapi.responses import Response
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import DuplicateKeyError
from fastapi.security import OAuth2PasswordBearer
import os
import io
import csv
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
from typing import List, Optional, Literal, Tuple
from datetime import datetime, timezone, timedelta, date
from zoneinfo import ZoneInfo

# Local modules — imported up-top so `_active_camp_for` (used during request
# handling for check-in late computation) can reference them.
import camps as _camps_module
import regattas as _regattas_module

from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet

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

app = FastAPI()
api_router = APIRouter(prefix="/api")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


# ----------------------------------------------------------------------------
# Office timezone + late-arrival helpers
# ----------------------------------------------------------------------------
DEFAULT_TZ = "Asia/Kolkata"


def office_tz(office: Optional[dict]) -> ZoneInfo:
    name = (office or {}).get("timezone") or DEFAULT_TZ
    try:
        return ZoneInfo(name)
    except Exception:
        return ZoneInfo(DEFAULT_TZ)


def local_now(office: Optional[dict]) -> datetime:
    """Current time in the office's local timezone."""
    return now_utc().astimezone(office_tz(office))


def local_date_str(office: Optional[dict], dt: Optional[datetime] = None) -> str:
    """The calendar date (YYYY-MM-DD) in the office timezone for the given instant."""
    dt = dt or now_utc()
    return dt.astimezone(office_tz(office)).date().isoformat()


def local_hm(office: Optional[dict], iso_str: Optional[str]) -> str:
    """Format a stored UTC ISO timestamp as HH:MM in office local time."""
    if not iso_str:
        return ""
    return datetime.fromisoformat(iso_str).astimezone(office_tz(office)).strftime("%H:%M")


def compute_late(office: dict, target: dict, ts: datetime, camp: Optional[dict] = None) -> tuple[bool, int]:
    """Returns (is_late, minutes_late) comparing the check-in local time against
    the effective work_start + grace. If `camp` is provided, its `start_time`
    and (optional) `late_grace_minutes` override the member's defaults — this
    is how institutional camps replace a member's normal schedule."""
    if camp:
        ws = camp.get("start_time") or "09:00"
        cg = camp.get("late_grace_minutes")
        grace = int(cg if cg is not None else (office.get("late_grace_minutes") or 0))
    else:
        ws = (target.get("work_start") or office.get("default_work_start") or "09:00")
        grace = int(office.get("late_grace_minutes") or 0)
    try:
        h, m = (int(x) for x in ws.split(":")[:2])
    except Exception:
        return False, 0
    local = ts.astimezone(office_tz(office))
    threshold = local.replace(hour=h, minute=m, second=0, microsecond=0) + timedelta(minutes=grace)
    if local > threshold:
        return True, int((local - threshold).total_seconds() // 60)
    return False, 0


async def _active_camp_for(target: dict, ts: datetime, office: dict) -> Optional[dict]:
    """Look up the camp that applies to `target` at timestamp `ts` (used at
    check-in time so the stored late/late_minutes reflect the camp overlay)."""
    today_str = local_date_str(office, ts)
    weekday = _camps_module.weekday_key(ts.astimezone(office_tz(office)))
    camps_today = await _camps_module.fetch_camps_active_on(db, today_str)
    return _camps_module.resolve_member_camp(target, camps_today, weekday, today_str)



# ----------------------------------------------------------------------------
# Security helpers
# ----------------------------------------------------------------------------
def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def create_token(user_id: str, role: str, device_id: Optional[str] = None,
                 expires_minutes: Optional[int] = None) -> str:
    exp_minutes = expires_minutes if expires_minutes is not None else JWT_EXPIRES_MINUTES
    payload = {
        "sub": user_id,
        "role": role,
        "exp": now_utc() + timedelta(minutes=exp_minutes),
    }
    if device_id:
        payload["device_id"] = device_id
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


# Cap any photo POSTed to the API. Frontend resizes to 320 px (~30 KB), so
# 250 KB is generous and still rejects obvious abuse / accidental uploads.
MAX_PHOTO_BYTES = 250_000

def _check_photo_size(photo: Optional[str]):
    if photo and len(photo) > MAX_PHOTO_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Photo too large ({len(photo)} bytes; max {MAX_PHOTO_BYTES})",
        )


# Thumbnail size for list views (presence board, muster, sessions, timeline).
# 96 px keeps avatars crisp on retina while landing ~2-4 KB per photo —
# bringing /api/presence from ~3 MB to <200 KB for a 60-member academy.
THUMB_MAX_PX = 96
THUMB_QUALITY = 70

def _make_thumbnail(photo: Optional[str]) -> Optional[str]:
    """Take a `data:image/...;base64,...` string and return a tiny JPEG data URL.
    Returns None if `photo` is falsy or cannot be decoded — the caller should
    keep the original photo as the only source in that case."""
    if not photo or not isinstance(photo, str):
        return None
    try:
        # Strip the data-URL prefix if present
        b64 = photo.split(",", 1)[1] if photo.startswith("data:") else photo
        raw = base64.b64decode(b64)
        with Image.open(io.BytesIO(raw)) as im:
            im = im.convert("RGB")
            im.thumbnail((THUMB_MAX_PX, THUMB_MAX_PX))
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=THUMB_QUALITY, optimize=True)
            enc = base64.b64encode(buf.getvalue()).decode("ascii")
            return f"data:image/jpeg;base64,{enc}"
    except Exception as e:
        logger.warning("Failed to build thumbnail: %s", e)
        return None


# Long-lived tokens for approved devices (passwordless phone login)
DEVICE_TOKEN_MINUTES = 60 * 24 * 365 * 2  # ~2 years


def normalize_phone(raw: str) -> str:
    """Keep digits only; drop a leading country code's plus. Used to match mobile numbers."""
    return re.sub(r"[^0-9]", "", raw or "")


def phone_key(raw: str) -> str:
    """Comparable key: last 10 digits, so +91-99911 10001 == 9991110001."""
    d = normalize_phone(raw)
    return d[-10:] if len(d) >= 10 else d


OVERTIME_THRESHOLD_MIN = 30  # only flag OT when delta >= this many minutes
OVERTIME_CATEGORIES = {"staff"}  # OT policy: ONLY staff accrue OT. Athletes,
                                 # coaches and executives never accumulate OT
                                 # minutes regardless of their check-in time.


def _hm_to_minutes(hm: Optional[str]) -> Optional[int]:
    if not hm or not re.match(r"^\d{1,2}:\d{2}$", hm):
        return None
    h, m = (int(x) for x in hm.split(":"))
    return h * 60 + m


def compute_overtime_in(office: Optional[dict], member: dict, ts: datetime) -> Tuple[int, str]:
    """Returns (early_minutes, work_start_hm). 0 if not applicable."""
    if member.get("category") not in OVERTIME_CATEGORIES:
        return 0, ""
    work_start = member.get("work_start")
    ws_min = _hm_to_minutes(work_start)
    if ws_min is None:
        return 0, ""
    local = ts.astimezone(office_tz(office))
    ts_min = local.hour * 60 + local.minute
    diff = ws_min - ts_min
    return (diff if diff >= OVERTIME_THRESHOLD_MIN else 0), work_start


def compute_overtime_out(office: Optional[dict], member: dict, ts: datetime) -> Tuple[int, str]:
    """Returns (late_minutes, work_end_hm). 0 if not applicable."""
    if member.get("category") not in OVERTIME_CATEGORIES:
        return 0, ""
    work_end = member.get("work_end")
    we_min = _hm_to_minutes(work_end)
    if we_min is None:
        return 0, ""
    local = ts.astimezone(office_tz(office))
    ts_min = local.hour * 60 + local.minute
    diff = ts_min - we_min
    return (diff if diff >= OVERTIME_THRESHOLD_MIN else 0), work_end


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
    father_mobile: Optional[str] = None
    mother_mobile: Optional[str] = None
    guardian_mobile: Optional[str] = None


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
    weekly_off: Literal["monday","tuesday","wednesday","thursday","friday","saturday","sunday"] = "monday"
    father_mobile: Optional[str] = None
    mother_mobile: Optional[str] = None
    guardian_mobile: Optional[str] = None


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
    weekly_off: Optional[Literal["monday","tuesday","wednesday","thursday","friday","saturday","sunday"]] = None
    leave_balance_opening: Optional[float] = None
    father_mobile: Optional[str] = None
    mother_mobile: Optional[str] = None
    guardian_mobile: Optional[str] = None


class LeaveBalanceBulkRow(BaseModel):
    member_id: str
    opening: float


class LeaveBalanceBulkIn(BaseModel):
    rows: List[LeaveBalanceBulkRow]


class InstitutionIn(BaseModel):
    name: str
    short_name: Optional[str] = None
    active: bool = True


class GroupLeaveIn(BaseModel):
    user_ids: List[str]
    type: Literal["leave", "tour", "comp_off", "late_coming"]
    start_date: str
    end_date: str
    reason: str
    location: Optional[str] = None
    auto_approve: bool = True


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


class CheckInIn(BaseModel):
    qr_token: str
    latitude: float
    longitude: float
    photo: Optional[str] = None  # base64
    reason: Optional[str] = None  # required when outside geofence


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


class LeaveCreate(BaseModel):
    type: Literal["leave", "tour", "comp_off", "late_coming"]
    start_date: str  # YYYY-MM-DD
    end_date: str
    reason: str
    location: Optional[str] = None  # for tour
    expected_arrival: Optional[str] = None  # HH:MM for late_coming


class LeaveDecision(BaseModel):
    status: Literal["approved", "rejected"]


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



# ----------------------------------------------------------------------------
# Geo helpers
# ----------------------------------------------------------------------------
def haversine_m(lat1, lon1, lat2, lon2) -> float:
    R = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * R * math.asin(min(1.0, math.sqrt(a)))


# ----------------------------------------------------------------------------
# Startup: seed admin + office config
# ----------------------------------------------------------------------------
@app.on_event("startup")
async def seed():
    await db.users.create_index("email", unique=True)
    await db.users.create_index("id", unique=True)
    await db.devices.create_index("device_id", unique=True)
    # Prevent duplicate parent-notification dispatches per (user, day, type)
    # if two coaches tap "Notify parents" simultaneously.
    await db.parent_notifications.create_index(
        [("user_id", 1), ("date", 1), ("type", 1)], unique=True
    )
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
            "qr_token": "OFFICE-" + uuid.uuid4().hex[:12].upper(),
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
            except Exception:
                pass
        logger.info(f"Seeded institutions master from existing users")


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()


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


async def _midnight_auto_checkout_loop():
    """Forever: sleep until the next office-local midnight (+10s safety buffer),
    then run the cleanup. Resilient — caught exceptions don't kill the loop."""
    import asyncio
    while True:
        try:
            office = await db.config.find_one({"id": "office"}, {"_id": 0})
            tz = office_tz(office)
            now_local = datetime.now(tz)
            next_run = (now_local + timedelta(days=1)).replace(hour=0, minute=0, second=10, microsecond=0)
            wait = max(60, (next_run - now_local).total_seconds())
            await asyncio.sleep(wait)
        except asyncio.CancelledError:
            return
        except Exception:
            logger.exception("midnight scheduler tick failed; retrying in 1h")
            await asyncio.sleep(3600)
            continue
        try:
            n = await _close_stale_open_sessions("midnight_cron")
            logger.info("midnight auto-checkout: closed %d stale session(s)", n)
        except Exception:
            logger.exception("midnight auto-checkout job failed")


@app.on_event("startup")
async def _start_midnight_scheduler():
    """Catch up at startup (in case the server was down across midnight), then
    spawn the recurring loop."""
    import asyncio
    try:
        n = await _close_stale_open_sessions("startup_catchup")
        if n:
            logger.info("startup catch-up auto-checkout: closed %d stale session(s)", n)
    except Exception:
        logger.exception("startup catch-up auto-checkout failed")
    asyncio.create_task(_midnight_auto_checkout_loop())


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
    matched_id = None
    async for u in db.users.find({"mobile": {"$ne": None}}, {"_id": 0, "id": 1, "mobile": 1}):
        if phone_key(u.get("mobile") or "") == key:
            matched_id = u["id"]
            break
    if not matched_id:
        return None
    return await db.users.find_one({"id": matched_id}, {"_id": 0, "hashed_password": 0})


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

    # Pre-designated admin -> instant approve + login (the "cinch")
    if matched and matched.get("role") == "admin":
        await db.devices.update_one({"device_id": body.device_id}, {"$set": {
            "status": "approved", "user_id": matched["id"],
            "approved_by": "auto-admin", "approved_at": now, "last_login_at": now,
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


async def _stamp_action(device_pk: str, status: str, admin_id: str, extra: Optional[dict] = None) -> int:
    """Update a device's status AND the audit trail in one shot. Returns
    matched_count so callers can 404 on missing devices."""
    payload = {
        "status": status,
        "last_action": status,
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
    return office


@api_router.put("/office")
async def update_office(body: OfficeConfig, admin: dict = Depends(require_admin)):
    await db.config.update_one({"id": "office"}, {"$set": body.model_dump()})
    return await db.config.find_one({"id": "office"}, {"_id": 0})


@api_router.post("/office/regenerate-qr")
async def regenerate_qr(admin: dict = Depends(require_admin)):
    new_token = "OFFICE-" + uuid.uuid4().hex[:12].upper()
    await db.config.update_one({"id": "office"}, {"$set": {"qr_token": new_token}})
    return {"qr_token": new_token}


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
        "work_start": body.work_start,
        "work_end": body.work_end,
        "institution": body.institution,
        "gender": body.gender,
        "weekly_off": body.weekly_off,
        "father_mobile": body.father_mobile,
        "mother_mobile": body.mother_mobile,
        "guardian_mobile": body.guardian_mobile,
        "photo": None,
        "personal_qr": "CARD-" + uuid.uuid4().hex[:12].upper(),
        "hashed_password": hash_password(body.password),
        "created_at": now_utc().isoformat(),
    }
    await db.users.insert_one(doc)
    return UserPublic(**{k: doc.get(k) for k in UserPublic.model_fields})


@api_router.get("/members", response_model=List[UserPublic])
async def list_members(user: dict = Depends(get_current_user)):
    users = await db.users.find({}, {"_id": 0, "hashed_password": 0}).sort("full_name", 1).to_list(2000)
    return [UserPublic(**{k: u.get(k) for k in UserPublic.model_fields}) for u in users]


@api_router.patch("/members/{member_id}", response_model=UserPublic)
async def update_member(member_id: str, body: MemberUpdate, admin: dict = Depends(require_admin)):
    if body.role == "member" and member_id == admin["id"]:
        raise HTTPException(status_code=400, detail="You cannot remove your own admin access")
    if body.photo is not None:
        _check_photo_size(body.photo)
    update = {k: v for k, v in body.model_dump().items() if v is not None and k != "password"}
    if body.password:
        update["hashed_password"] = hash_password(body.password)
    # Keep `photo_thumb` in sync whenever `photo` changes (including being cleared).
    if body.photo is not None:
        update["photo_thumb"] = _make_thumbnail(body.photo) if body.photo else None
        update["photo_captured_at"] = now_utc().isoformat()
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
    """Return every member with their opening leave balance and current usage,
    used by the spreadsheet-style admin editor."""
    users = await db.users.find({}, {"_id": 0, "id": 1, "full_name": 1, "category": 1,
                                      "rank": 1, "institution": 1,
                                      "leave_balance_opening": 1, "weekly_off": 1}
                                ).sort("full_name", 1).to_list(2000)
    office = await db.config.find_one({"id": "office"})
    today = local_date_str(office)
    year = today[:4]
    leaves = await db.leaves.find({
        "status": "approved", "type": "leave",
        "start_date": {"$gte": f"{year}-01-01", "$lte": f"{year}-12-31"},
    }, {"_id": 0, "user_id": 1, "start_date": 1, "end_date": 1}).to_list(20000)
    used: dict = {}
    for l in leaves:
        try:
            sd = date.fromisoformat(l["start_date"])
            ed = date.fromisoformat(l["end_date"])
            n = (ed - sd).days + 1
        except Exception:
            n = 1
        used[l["user_id"]] = used.get(l["user_id"], 0) + n
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


# ----------------------------------------------------------------------------
# Group leave — file the same leave for many members in one shot
# ----------------------------------------------------------------------------
@api_router.post("/leaves/group")
async def group_leave(body: GroupLeaveIn, admin: dict = Depends(require_admin)):
    if not body.user_ids:
        raise HTTPException(status_code=400, detail="Pick at least one member")
    office = await db.config.find_one({"id": "office"})
    today = local_date_str(office)
    late_application = bool(body.start_date and body.start_date < today)
    docs = []
    for uid in body.user_ids:
        d = {
            "id": str(uuid.uuid4()),
            "user_id": uid,
            "type": body.type,
            "start_date": body.start_date,
            "end_date": body.end_date,
            "reason": body.reason,
            "location": body.location,
            "status": "approved" if body.auto_approve else "pending",
            "late_application": late_application,
            "filed_by_admin": admin["id"],
            "filed_by_admin_name": admin["full_name"],
            "group_leave": True,
            "created_at": now_utc().isoformat(),
        }
        if body.auto_approve:
            d["decided_by"] = admin["full_name"]
            d["decided_at"] = now_utc().isoformat()
        docs.append(d)
    if docs:
        await db.leaves.insert_many(docs)
    return {"ok": True, "created": len(docs), "status": "approved" if body.auto_approve else "pending"}



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
    """Office master QR + every member's personal QR — for batch printing."""
    office = await db.config.find_one({"id": "office"}, {"_id": 0})
    users = await db.users.find(
        {}, {"_id": 0, "id": 1, "full_name": 1, "rank": 1, "category": 1, "personal_qr": 1}
    ).sort("full_name", 1).to_list(2000)
    return {
        "office_qr": office.get("qr_token") if office else None,
        "office_name": office.get("name") if office else None,
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
        if await db.users.find_one({"email": email}):
            errors.append({"row": n, "reason": f"Skipped — email already exists ({email})"})
            continue
        doc = {
            "id": str(uuid.uuid4()),
            "email": email,
            "full_name": name,
            "role": "member",
            "category": category,
            "rank": rank,
            "mobile": mobile,
            "work_start": ws_start,
            "work_end": ws_end,
            "institution": institution,
            "gender": gender,
            "photo": None,
            "personal_qr": "CARD-" + uuid.uuid4().hex[:12].upper(),
            "hashed_password": hash_password(password),
            "created_at": now_utc().isoformat(),
        }
        await db.users.insert_one(doc)
        created.append({"full_name": name, "email": email, "password": password})
    return {"created": created, "errors": errors, "created_count": len(created), "error_count": len(errors)}


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


def _excursion_seconds(excursions: List[dict], up_to: Optional[datetime] = None) -> float:
    """Total away-seconds across closed excursions. If `up_to` is given, any still-open
    excursion is treated as closing at that moment (used at final check-out)."""
    total = 0.0
    for e in (excursions or []):
        if not e.get("out_at"):
            continue
        try:
            o = datetime.fromisoformat(e["out_at"])
        except Exception:
            continue
        end = None
        if e.get("in_at"):
            try: end = datetime.fromisoformat(e["in_at"])
            except Exception: end = None
        elif up_to is not None:
            end = up_to
        if end:
            total += max(0.0, (end - o).total_seconds())
    return total


def _open_excursion(sess: dict) -> Optional[dict]:
    for e in reversed(sess.get("excursions") or []):
        if e.get("out_at") and not e.get("in_at"):
            return e
    return None



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


def _parse_expected_return(raw: Optional[str], office: Optional[dict], now: datetime) -> Optional[str]:
    """Accept either an HH:MM (today, office-local) or a full ISO datetime. Returns ISO/UTC."""
    if not raw:
        return None
    raw = raw.strip()
    # HH:MM short form -> today @ HH:MM in office tz
    if re.match(r"^\d{1,2}:\d{2}$", raw):
        try:
            h, m = (int(x) for x in raw.split(":"))
            local_now_v = now.astimezone(office_tz(office))
            cand = local_now_v.replace(hour=h, minute=m, second=0, microsecond=0)
            if cand <= local_now_v:
                cand = cand + timedelta(days=1)
            return cand.astimezone(timezone.utc).isoformat()
        except Exception:
            return None
    # Full ISO
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=office_tz(office))
        return dt.astimezone(timezone.utc).isoformat()
    except Exception:
        return None


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
        except Exception:
            pass
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


@api_router.post("/attendance/checkin")
async def check_in(body: CheckInIn, user: dict = Depends(get_current_user)):
    office = await db.config.find_one({"id": "office"})
    if not office:
        raise HTTPException(status_code=500, detail="Office not configured")
    if body.qr_token != office["qr_token"]:
        raise HTTPException(status_code=400, detail="Invalid Office QR code")
    if await open_session_for(user["id"]):
        raise HTTPException(status_code=400, detail="You are already checked in")
    return await perform_toggle(user, office, body.latitude, body.longitude,
                                body.photo, body.reason, "office_qr", None)


@api_router.post("/attendance/checkout")
async def check_out(body: CheckInIn, user: dict = Depends(get_current_user)):
    office = await db.config.find_one({"id": "office"})
    if not await open_session_for(user["id"]):
        raise HTTPException(status_code=400, detail="You are not checked in")
    if office and body.qr_token != office["qr_token"]:
        raise HTTPException(status_code=400, detail="Invalid Office QR code")
    return await perform_toggle(user, office, body.latitude, body.longitude,
                                body.photo, body.reason, "office_qr", None)


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
    status: Optional[str] = "pending",
    admin: dict = Depends(require_admin),
):
    office = await db.config.find_one({"id": "office"})
    if not date_from and not date_to:
        today = local_date_str(office)
        yesterday = (date.fromisoformat(today) - timedelta(days=1)).isoformat()
        date_from = date_to = yesterday
    q: dict = {"overtime_total_min": {"$gt": 0}}
    if status and status != "all":
        q["overtime_status"] = status
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
async def presence(user: dict = Depends(get_current_user)):
    office = await db.config.find_one({"id": "office"})
    today = local_date_str(office)
    users = await db.users.find(
        {}, {"_id": 0, "id": 1, "full_name": 1, "role": 1, "category": 1, "rank": 1,
             "photo_thumb": 1, "photo": 1, "work_start": 1, "work_end": 1, "institution": 1,
             "father_mobile": 1, "mother_mobile": 1, "guardian_mobile": 1}
    ).sort("full_name", 1).to_list(2000)

    # Batch: open sessions, active leaves for today, and last checkout per user
    sessions = await db.attendance.find({"check_out_at": None}, {"_id": 0}).to_list(5000)
    sess_map = {s["user_id"]: s for s in sessions}

    leaves = await db.leaves.find({
        "status": "approved", "start_date": {"$lte": today}, "end_date": {"$gte": today},
    }, {"_id": 0}).to_list(5000)
    leave_map = {l["user_id"]: l for l in leaves}

    last_outs = await db.attendance.aggregate([
        {"$match": {"check_out_at": {"$ne": None}}},
        {"$sort": {"check_out_at": -1}},
        {"$group": {"_id": "$user_id", "doc": {"$first": "$$ROOT"}}},
    ]).to_list(5000)
    last_map = {d["_id"]: d["doc"] for d in last_outs}

    # Today's parent-notification dispatches → keyed (user_id, type) for fast lookup.
    notified_today = await db.parent_notifications.find(
        {"date": today}, {"_id": 0, "user_id": 1, "type": 1}
    ).to_list(5000)
    notify_map: dict = {}
    for n in notified_today:
        notify_map.setdefault(n["user_id"], set()).add(n["type"])

    # Camps overlay — fetch all camps whose date range covers today in a single
    # query, then resolve per-member at the loop level. Cheaper than per-user.
    camps_today = await _camps_module.fetch_camps_active_on(db, today)
    today_weekday = _camps_module.weekday_key(now_utc().astimezone(office_tz(office)))
    def _camp_for(u: dict) -> Optional[dict]:
        return _camps_module.resolve_member_camp(u, camps_today, today_weekday, today)

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

    result = []
    for u in users:
        # Use a small thumbnail in list responses so the Presence Board payload
        # stays under a couple hundred KB regardless of head-count. Falls back to
        # the full photo for legacy members who haven't been backfilled yet.
        u_thumb = u.get("photo_thumb") or u.get("photo")
        sess = sess_map.get(u["id"])
        leave = leave_map.get(u["id"])
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
            # Has the member shown any session today? `last` could be from a
            # previous day. Decide between "exited" (closed session today),
            # "absent" (no session today, past work_start), or "not_due"
            # (no session today, not yet past work_start).
            today = local_date_str(office)
            last_today = last and (last.get("date") == today)
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
                    local_now = now_utc().astimezone(office_tz(office))
                    threshold = local_now.replace(hour=ws_h, minute=ws_m, second=0, microsecond=0) + timedelta(minutes=grace)
                    past_start = local_now > threshold
                except Exception:
                    past_start = True
                if past_start and is_expected_today:
                    # Approved late-coming notice covering today → softer treatment
                    late_today = await db.leaves.find_one({
                        "user_id": u["id"], "status": "approved", "type": "late_coming",
                        "start_date": {"$lte": today}, "end_date": {"$gte": today},
                    }, {"_id": 0, "expected_arrival": 1, "reason": 1})
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
        open_exc_v = _open_excursion(sess) if sess else None
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
        sent_types = notify_map.get(u["id"], set())
        notify_due_not_arrived = False
        notify_due_late = False
        if u.get("category") == "athlete":
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

        result.append({
            "id": u["id"],
            "full_name": u["full_name"],
            "role": u["role"],
            "category": u["category"],
            "rank": u.get("rank"),
            "institution": u.get("institution"),
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
        })
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
        "date": today,
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
# Leave / Tour
# ----------------------------------------------------------------------------
@api_router.post("/leaves")
async def create_leave(body: LeaveCreate, target_user_id: Optional[str] = None,
                      user: dict = Depends(get_current_user)):
    """Create a leave/tour/comp-off request. Admins may pass `target_user_id`
    to file on behalf of another member."""
    target_user = user
    if target_user_id and target_user_id != user["id"]:
        if user.get("role") != "admin":
            raise HTTPException(status_code=403, detail="Only admins may file on behalf of others")
        target_user = await db.users.find_one({"id": target_user_id}, {"_id": 0})
        if not target_user:
            raise HTTPException(status_code=404, detail="Target member not found")
    office = await db.config.find_one({"id": "office"})
    today = local_date_str(office)
    late_application = bool(body.start_date and body.start_date < today)
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": target_user["id"],
        "type": body.type,
        "start_date": body.start_date,
        "end_date": body.end_date,
        "reason": body.reason,
        "location": body.location,
        "expected_arrival": body.expected_arrival,
        "status": "pending",
        "late_application": late_application,
        "filed_by_admin": user["id"] if target_user["id"] != user["id"] else None,
        "filed_by_admin_name": user["full_name"] if target_user["id"] != user["id"] else None,
        "created_at": now_utc().isoformat(),
    }
    await db.leaves.insert_one(doc)
    doc.pop("_id", None)
    return doc


async def enrich_leaves(leaves: List[dict]) -> List[dict]:
    user_ids = list({l["user_id"] for l in leaves})
    users = await db.users.find({"id": {"$in": user_ids}}, {"_id": 0}).to_list(2000)
    umap = {u["id"]: u for u in users}
    for l in leaves:
        u = umap.get(l["user_id"], {})
        l["member_name"] = u.get("full_name", "Unknown")
        l["member_category"] = u.get("category")
        l["member_rank"] = u.get("rank")
    return leaves


@api_router.get("/leaves/mine")
async def my_leaves(user: dict = Depends(get_current_user)):
    leaves = await db.leaves.find({"user_id": user["id"]}, {"_id": 0}).sort("created_at", -1).to_list(500)
    return leaves


@api_router.get("/leaves")
async def all_leaves(status_filter: Optional[str] = None, admin: dict = Depends(require_admin)):
    q = {}
    if status_filter == "late":
        q["late_application"] = True
    elif status_filter:
        q["status"] = status_filter
    leaves = await db.leaves.find(q, {"_id": 0}).sort("created_at", -1).to_list(1000)
    return await enrich_leaves(leaves)


@api_router.patch("/leaves/{leave_id}")
async def decide_leave(leave_id: str, body: LeaveDecision, admin: dict = Depends(require_admin)):
    await db.leaves.update_one({"id": leave_id}, {"$set": {"status": body.status}})
    l = await db.leaves.find_one({"id": leave_id}, {"_id": 0})
    if not l:
        raise HTTPException(status_code=404, detail="Leave not found")
    return l


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
    on_leave_ids = {l["user_id"] for l in on_leave}

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
        late, late_min = compute_late(office, athlete, now)
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
                except Exception: pass
            overdue_min = None
            if e.get("expected_return"):
                try:
                    er = datetime.fromisoformat(e["expected_return"])
                    ref = datetime.fromisoformat(in_iso) if in_iso else now
                    diff = int((ref - er).total_seconds() // 60)
                    overdue_min = max(0, diff)
                except Exception: pass
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
        })

    rows.sort(key=lambda r: (not r["open"], r["check_in_at"]))
    counts = {
        "members": len(rows),
        "open": sum(1 for r in rows if r["open"]),
        "on_temp_exit": sum(1 for r in rows if r["on_temp_exit"]),
        "closed": sum(1 for r in rows if not r["open"]),
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
    """Download a master-data snapshot (users, institutions, office config)
    as a single tar.gz. Use this to bootstrap a fresh deployment on Day 1 of
    any new term — transactional data (attendance, leaves, notifications,
    devices) is intentionally NOT included so the new term starts clean."""
    import tarfile
    import io as _io
    import json as _json
    from datetime import datetime as _dt, timezone as _tz

    buf = _io.BytesIO()
    tf = tarfile.open(fileobj=buf, mode="w:gz")

    masters = ["users", "institutions", "config"]
    manifest = {
        "created_at": _dt.now(_tz.utc).isoformat(),
        "kind": "ych-master",
        "collections": {},
    }
    for name in masters:
        docs = await db[name].find({}).to_list(10000)
        for d in docs:
            d.pop("_id", None)
        payload = _json.dumps(docs, default=str, indent=2).encode("utf-8")
        info = tarfile.TarInfo(f"ych-master/{name}.json")
        info.size = len(payload)
        tf.addfile(info, _io.BytesIO(payload))
        manifest["collections"][name] = len(docs)

    mpayload = _json.dumps(manifest, indent=2).encode("utf-8")
    info = tarfile.TarInfo("ych-master/manifest.json")
    info.size = len(mpayload)
    tf.addfile(info, _io.BytesIO(mpayload))
    tf.close()

    fname = f"ych-master-{_dt.now().strftime('%Y%m%d-%H%M')}.tar.gz"
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
    """Restore master data from a backup tar.gz.
    mode='merge'   → insert only new docs (existing users/institutions/config
                     stay intact — safe default)
    mode='replace' → wipe the master collections first (DANGEROUS — clears
                     current admins/members)"""
    import tarfile
    import io as _io
    import json as _json

    raw = await file.read()
    try:
        tf = tarfile.open(fileobj=_io.BytesIO(raw), mode="r:gz")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not open archive: {e}")

    counts: dict = {}
    masters = ["users", "institutions", "config"]
    for tname in masters:
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
        for d in docs:
            d.pop("_id", None)
            doc_id = d.get("id")
            if mode == "merge" and doc_id:
                existing = await col.find_one({"id": doc_id}, {"_id": 1})
                if existing:
                    continue
            try:
                await col.insert_one(d)
                added += 1
            except DuplicateKeyError:
                pass  # already there
        counts[tname] = added
    return {"mode": mode, "inserted": counts}


@api_router.post("/admin/snapshot/import")
async def admin_snapshot_import(
    file: UploadFile = File(...),
    mode: str = "merge",
    admin: dict = Depends(require_admin),
):
    """One-time data migration helper. Accepts a tar.gz snapshot (a folder of
    `<collection>.json` files) and inserts the docs into the live DB.

    mode='merge'   → insert only if a doc with the same `id` doesn't exist
                     (existing admin accounts, devices, config stay intact).
    mode='replace' → wipe each target collection first, then load.
    """
    import tarfile
    import io as _io
    import json as _json
    raw = await file.read()
    try:
        tf = tarfile.open(fileobj=_io.BytesIO(raw), mode="r:gz")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not open archive: {e}")

    counts: dict = {}
    targets = ["users", "attendance", "leaves", "institutions", "config", "devices", "parent_notifications"]
    for tname in targets:
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
        for d in docs:
            d.pop("_id", None)
            doc_id = d.get("id")
            if mode == "merge" and doc_id:
                existing = await col.find_one({"id": doc_id}, {"_id": 1})
                if existing:
                    continue
            try:
                await col.insert_one(d)
                added += 1
            except DuplicateKeyError:
                pass  # already there (unique-indexed field collision)
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
        if a.get("user_id"): user_ids.add(a["user_id"])
    for l in leaves_today:
        if l.get("user_id"): user_ids.add(l["user_id"])
    for d in devices_today:
        if d.get("user_id"): user_ids.add(d["user_id"])
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

    for l in leaves_today:
        u = umap.get(l.get("user_id"), {})
        events.append({
            "id": f"leave-{l['id']}",
            "type": "application",
            "subtype": l.get("type"),  # leave | tour
            "at": l.get("created_at"),
            "member_id": l.get("user_id"),
            "member_name": u.get("full_name", "Unknown"),
            "member_category": u.get("category"),
            "member_rank": u.get("rank"),
            "photo": u.get("photo_thumb") or u.get("photo"),
            "detail": f"Applied for {l.get('type', 'leave')}"
                      + (f" · {l.get('start_date')} → {l.get('end_date')}" if l.get("start_date") else "")
                      + (f" · {l.get('location')}" if l.get("location") else ""),
            "status": l.get("status"),
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

    # Batch: all attendance in range with hours, grouped by user_id
    atts = await db.attendance.find(
        {"date": {"$gte": start, "$lte": end}, "hours": {"$ne": None}},
        {"_id": 0, "user_id": 1, "date": 1, "hours": 1, "late": 1, "excursions": 1,
         "overtime_total_min": 1, "overtime_status": 1},
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
        {"_id": 0, "user_id": 1, "start_date": 1, "end_date": 1},
    ).to_list(10000)
    leaves_by_user: dict = {}
    for l in leaves:
        leaves_by_user.setdefault(l["user_id"], []).append(l)

    def _count_leave_days(user_leaves: List[dict]) -> int:
        days = set()
        for l in user_leaves:
            ls = max(date.fromisoformat(l["start_date"]), sd)
            le = min(date.fromisoformat(l["end_date"]), ed)
            cur = ls
            while cur <= le:
                days.add(cur.isoformat())
                cur += timedelta(days=1)
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
        days_on_leave = _count_leave_days(leaves_by_user.get(u["id"], []))
        overstays = _overstays(sessions)
        approved_ot_min = sum(int(s.get("overtime_total_min") or 0)
                              for s in sessions
                              if s.get("overtime_status") == "approved")
        pending_ot_min = sum(int(s.get("overtime_total_min") or 0)
                             for s in sessions
                             if s.get("overtime_status") == "pending")
        # Compensatory off bookkeeping (within this report's date range)
        co_earned = _comp_off_earned(u, sessions)
        co_used = 0
        for l in (leaves_by_user.get(u["id"]) or []):
            if l.get("type") != "comp_off":
                continue
            ls = max(date.fromisoformat(l["start_date"]), sd)
            le = min(date.fromisoformat(l["end_date"]), ed)
            cur = ls
            while cur <= le:
                co_used += 1
                cur += timedelta(days=1)
        co_pending = max(0, co_earned - co_used)
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


@api_router.get("/reports/hours")
async def hours_report(start: str, end: str, admin: dict = Depends(require_admin)):
    rows = await compute_hours_report(start, end)
    return {"start": start, "end": end, "rows": rows}


@api_router.get("/reports/payroll")
async def payroll_report(month: Optional[str] = None, admin: dict = Depends(require_admin)):
    """Monthly payroll report. `month` = YYYY-MM (defaults to the previous
    calendar month so a 1st-of-month run pulls last month's numbers)."""
    office = await db.config.find_one({"id": "office"})
    today = date.fromisoformat(local_date_str(office))
    if not month:
        first_this = today.replace(day=1)
        last_prev = first_this - timedelta(days=1)
        month = f"{last_prev.year:04d}-{last_prev.month:02d}"
    y, m = (int(x) for x in month.split("-"))
    start_d = date(y, m, 1)
    if m == 12:
        end_d = date(y + 1, 1, 1) - timedelta(days=1)
    else:
        end_d = date(y, m + 1, 1) - timedelta(days=1)
    start_iso, end_iso = start_d.isoformat(), end_d.isoformat()
    rows = await compute_hours_report(start_iso, end_iso)
    # Attach leave balance (annual taken vs opening, computed from full year-to-date)
    users = await db.users.find({}, {"_id": 0, "id": 1, "leave_balance_opening": 1}).to_list(2000)
    opening_map = {u["id"]: float(u.get("leave_balance_opening") or 0) for u in users}
    leaves = await db.leaves.find({
        "status": "approved", "type": "leave",
        "start_date": {"$gte": f"{y}-01-01", "$lte": f"{y}-12-31"},
    }, {"_id": 0}).to_list(20000)
    ytd_taken: dict = {}
    for l in leaves:
        try:
            n = (date.fromisoformat(l["end_date"]) - date.fromisoformat(l["start_date"])).days + 1
        except Exception:
            n = 1
        ytd_taken[l["user_id"]] = ytd_taken.get(l["user_id"], 0) + n
    for r in rows:
        opening = opening_map.get(r["member_id"], 0.0)
        taken = float(ytd_taken.get(r["member_id"], 0))
        r["leave_balance_opening"] = opening
        r["leave_balance_taken_ytd"] = taken
        r["leave_balance_remaining"] = round(opening - taken, 1)
    return {"month": month, "start": start_iso, "end": end_iso, "rows": rows}


@api_router.get("/reports/daily")
async def daily_report(on: Optional[str] = None, user: dict = Depends(get_current_user)):
    """Daily leave & tour report for a given date (default today)."""
    if not on:
        office = await db.config.find_one({"id": "office"})
        on = local_date_str(office)
    leaves = await db.leaves.find({
        "status": "approved",
        "start_date": {"$lte": on},
        "end_date": {"$gte": on},
    }, {"_id": 0}).to_list(1000)
    leaves = await enrich_leaves(leaves)
    on_leave = [l for l in leaves if l["type"] == "leave"]
    on_tour = [l for l in leaves if l["type"] == "tour"]
    return {"date": on, "on_leave": on_leave, "on_tour": on_tour}


# ----------- Exports (CSV / PDF) -----------
def _pdf_from_table(title: str, headers: List[str], data: List[List[str]], subtitle: str = "") -> bytes:
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, topMargin=20 * mm, bottomMargin=15 * mm)
    styles = getSampleStyleSheet()
    elems = [Paragraph(title, styles["Title"])]
    if subtitle:
        elems.append(Paragraph(subtitle, styles["Normal"]))
    elems.append(Spacer(1, 8 * mm))
    table_data = [headers] + (data if data else [["No records"] + [""] * (len(headers) - 1)])
    t = Table(table_data, repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1F2937")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#D1D5DB")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F3F4F6")]),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    elems.append(t)
    doc.build(elems)
    return buf.getvalue()


def _csv_response(headers: List[str], rows: List[List], filename: str) -> Response:
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(headers)
    for r in rows:
        w.writerow(r)
    return Response(
        content=out.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@api_router.get("/reports/hours/export")
async def export_hours(start: str, end: str, fmt: str = "csv", admin: dict = Depends(require_admin)):
    rows = await compute_hours_report(start, end)
    headers = ["Attendance %", "Name", "Category", "Rank", "Weekly off", "Hours",
               "OT Hours (approved)", "OT Hours (pending)",
               "Days Present", "Late Days", "Leave Days", "Overstays",
               "Comp-Off Earned", "Comp-Off Used", "Comp-Off Pending"]
    table = [[f"{r['attendance_pct']}%", r["member_name"], r["category"], r.get("rank") or "-",
              (r.get("weekly_off") or "monday").title(),
              r["total_hours"], r.get("overtime_hours_approved", 0), r.get("overtime_hours_pending", 0),
              r["days_present"], r.get("late_days", 0), r.get("days_on_leave", 0),
              r.get("overstays", 0),
              r.get("comp_off_earned", 0), r.get("comp_off_used", 0), r.get("comp_off_pending", 0)] for r in rows]
    if fmt == "pdf":
        pdf = _pdf_from_table("Attendance & Hours Report", headers, table, f"{start} to {end}")
        return Response(content=pdf, media_type="application/pdf",
                        headers={"Content-Disposition": f"attachment; filename=hours_{start}_{end}.pdf"})
    return _csv_response(headers, table, f"hours_{start}_{end}.csv")


@api_router.get("/reports/daily/export")
async def export_daily(on: Optional[str] = None, fmt: str = "csv", user: dict = Depends(get_current_user)):
    if not on:
        office = await db.config.find_one({"id": "office"})
        on = local_date_str(office)
    leaves = await db.leaves.find({
        "status": "approved",
        "start_date": {"$lte": on},
        "end_date": {"$gte": on},
    }, {"_id": 0}).to_list(1000)
    leaves = await enrich_leaves(leaves)
    headers = ["Name", "Type", "Location", "From", "Till", "Reason"]
    table = [[l["member_name"], l["type"].title(), l.get("location") or "-",
              l["start_date"], l["end_date"], l.get("reason") or "-"] for l in leaves]
    if fmt == "pdf":
        pdf = _pdf_from_table("Daily Leave & Tour Report", headers, table, f"Date: {on}")
        return Response(content=pdf, media_type="application/pdf",
                        headers={"Content-Disposition": f"attachment; filename=daily_{on}.pdf"})
    return _csv_response(headers, table, f"daily_{on}.csv")


# ----------------------------------------------------------------------------
app.include_router(api_router)

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


# Lightweight keep-alive endpoint — no auth, no DB hit. Plug an UptimeRobot
# (or similar) ping into https://i-showed-up.ychyderabad.com/api/health every
# 5-10 minutes to prevent any idle-container cold-starts during morning peak.
@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "i-showed-up"}

app.add_middleware(
    CORSMiddleware,
    allow_credentials=False,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
