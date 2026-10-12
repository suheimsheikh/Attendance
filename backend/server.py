from fastapi import FastAPI, APIRouter, HTTPException, Depends
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pymongo.errors import DuplicateKeyError
from fastapi.security import OAuth2PasswordBearer
import os
import asyncio
import uuid
import logging
import jwt
from pathlib import Path
from pydantic import BaseModel, Field, field_validator
from typing import List, Optional, Literal, Dict
from datetime import datetime, timezone, timedelta, date
from contextlib import asynccontextmanager

# Local modules — imported up-top so `_active_camp_for` (used during request
# handling for check-in late computation) can reference them.
import camps as _camps_module
import regattas as _regattas_module
import breaks as _breaks_module
# Re-export shared SMS template constants from the SMS module so any legacy
# `from server import DEFAULT_PARENT_TEMPLATES` callers keep working.
from sms import DEFAULT_PARENT_TEMPLATES

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
# file all use one of these limits. See backend/config.py for the source of
# truth; re-exported here so existing `from server import MAX_USERS` callers
# continue to work.
# ----------------------------------------------------------------------------
from config import (
    MAX_USERS, MAX_SESSIONS, MAX_LEAVES, MAX_DEVICES, MAX_LOG_ROWS,
)


# ----------------------------------------------------------------------------
# Pure helpers (time, geo, photo, phone, auth, attendance math) live in
# `services/`. Re-exported from `server.py` so existing handlers continue to
# work unchanged, and so external imports (`from server import compute_late`)
# remain valid until callers are migrated to the new locations.
# ----------------------------------------------------------------------------
from services.time_utils import (
    DEFAULT_TZ, now_utc, iso, office_tz, local_now, local_date_str, local_hm,
)
from services.phone import phone_key
from services.photo import (
    MAX_PHOTO_BYTES, THUMB_MAX_PX, THUMB_QUALITY,
    check_photo_size as _check_photo_size,
    make_thumbnail as _make_thumbnail,
)
from services.auth_utils import (
    hash_password, verify_password, create_token,
)
from services.service_tokens import (
    is_service_token as _svc_is_service_token,
    authenticate_service_token as _svc_authenticate,
    create_or_replace_service_token as _svc_create,
    revoke_service_tokens as _svc_revoke,
    active_token_status as _svc_status,
)
from services.attendance_calc import (
    OVERTIME_THRESHOLD_MIN, OVERTIME_CATEGORIES, ATHLETE_CATEGORIES,
    compute_late,
    hm_to_minutes as _hm_to_minutes,
    compute_overtime_in, compute_overtime_out,
    session_ot_minutes as _session_ot_minutes,
    excursion_seconds as _excursion_seconds,
    open_excursion as _open_excursion,
    parse_expected_return as _parse_expected_return,
    effective_hours as _effective_hours,
)
from services.scope import athlete_like_keys as _athlete_like_keys


async def _active_camp_for(target: dict, ts: datetime, office: dict) -> Optional[dict]:
    """Look up the camp that applies to `target` at timestamp `ts` (used at
    check-in time so the stored late/late_minutes reflect the camp overlay)."""
    today_str = local_date_str(office, ts)
    weekday = _camps_module.weekday_key(ts.astimezone(office_tz(office)))
    camps_today = await _camps_module.fetch_camps_active_on(db, today_str)
    return _camps_module.resolve_member_camp(target, camps_today, weekday, today_str)


# Long-lived tokens for approved devices (passwordless phone login).
# Source of truth in backend/config.py; re-exported so existing callers work.
from config import DEVICE_TOKEN_MINUTES


async def get_current_user(token: str = Depends(oauth2_scheme)) -> dict:
    # Service tokens (svc_…) — additive, read-only PATs for background API
    # access. A normal JWT never starts with "svc_" so existing logins are
    # untouched. Read-only is enforced by the write-guard middleware below.
    if _svc_is_service_token(token):
        identity = await _svc_authenticate(db, token, JWT_SECRET)
        if identity:
            return identity
        raise HTTPException(status_code=401, detail="Invalid authentication token")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
        user_id = payload.get("sub")
        device_id = payload.get("device_id")
        is_escort = bool(payload.get("is_escort"))
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token has expired")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Could not validate token")
    # Escort-bound tokens resolve to the `escorts` collection. We adapt
    # the document to look user-shaped so the downstream code (and the
    # admin/coach gates) treat them as an authenticated identity without
    # accidental escalation. `is_escort=True` tells the escort endpoints
    # to use the session escort directly (no proxy required).
    if is_escort:
        esc = await db.escorts.find_one({"id": user_id}, {"_id": 0})
        if not esc:
            raise HTTPException(status_code=401, detail="Escort no longer registered")
        if esc.get("status") != "active":
            raise HTTPException(status_code=401, detail=f"Escort status: {esc.get('status')}")
        # Synthesise a minimal user-like dict. Role/category fields are
        # intentionally None so require_admin / require_coach_or_admin
        # reject escort tokens.
        return {
            "id": esc["id"],
            "full_name": esc["name"],
            "phone": esc.get("phone"),
            "institution": esc.get("institution"),
            "role": None,
            "category": None,
            "is_escort": True,
            "escort_id": esc["id"],
        }
    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    # Device-bound tokens (passwordless phone login) must reference an approved device.
    if device_id:
        device = await db.devices.find_one({"device_id": device_id, "user_id": user_id}, {"_id": 0})
        if not device or device.get("status") != "approved":
            # Self-heal for the "backup restore wiped my device row" case.
            # We already trust the JWT (signed by us, not expired) and the
            # user_id inside it maps to an active user record — so a MISSING
            # device row (or one whose user_id was rewritten by a foreign
            # backup) is an operational artifact, not a security event.
            # Look up the device_id alone; if it's outright missing OR
            # currently owned by a different user AND that other user
            # doesn't exist any more (ghost pointer post-restore), we
            # rebind to the JWT holder and mark approved. Explicitly
            # revoked/rejected rows still block — admins must re-approve
            # those the deliberate way.
            other = await db.devices.find_one({"device_id": device_id}, {"_id": 0})
            can_heal = False
            if other is None:
                can_heal = True   # row was wiped
            elif other.get("status") in ("approved", "pending"):
                other_user = None
                if other.get("user_id"):
                    other_user = await db.users.find_one(
                        {"id": other["user_id"]}, {"_id": 0, "id": 1})
                # Ghost pointer (device row references a user that no longer
                # exists) or explicit user rebind to a fresh, active user.
                if not other_user and user.get("active") is not False:
                    can_heal = True
            if can_heal and user.get("active") is not False:
                await db.devices.update_one(
                    {"device_id": device_id},
                    {"$set": {
                        "device_id": device_id,
                        "user_id": user_id,
                        "status": "approved",
                        "healed_at": now_utc().isoformat(),
                    },
                     "$setOnInsert": {"id": str(uuid.uuid4()),
                                      "created_at": now_utc().isoformat()}},
                    upsert=True,
                )
                device = await db.devices.find_one(
                    {"device_id": device_id, "user_id": user_id}, {"_id": 0})
            if not device or device.get("status") != "approved":
                raise HTTPException(status_code=401, detail="This device is no longer authorised")
    return user


async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin privileges required")
    return user


# ── Dual-mode auth for endpoints shared between the app (user JWT) and
# the PayCraft server-to-server integration (shared-secret ?key=). The
# optional scheme never auto-401s, so an endpoint can fall through to a
# GRID_API_KEY check when no bearer token is present.
oauth2_optional = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)


async def optional_user(token: Optional[str] = Depends(oauth2_optional)) -> Optional[dict]:
    if not token:
        return None
    try:
        return await get_current_user(token)
    except HTTPException:
        return None


def valid_grid_key(key: str) -> bool:
    """True when `key` matches GRID_API_KEY (constant-time). Same gate as
    GET /api/grid — used by the PayCraft server-to-server endpoints."""
    import hmac
    import os
    expected = os.environ.get("GRID_API_KEY", "").strip()
    return bool(expected) and bool(key) and hmac.compare_digest((key or "").strip(), expected)


def valid_members_api_token(token: str) -> bool:
    """True when `token` matches MEMBERS_API_TOKEN (constant-time). Gates the
    read-only roster-with-contacts feed consumed by the external Athlete
    Health Dashboard via `Authorization: Bearer <token>`."""
    import hmac
    import os
    expected = os.environ.get("MEMBERS_API_TOKEN", "").strip()
    return bool(expected) and bool(token) and hmac.compare_digest((token or "").strip(), expected)


def _bearer_from_header(authorization: Optional[str]) -> Optional[str]:
    """Extract the raw token from an `Authorization: Bearer <token>` header."""
    if not authorization:
        return None
    parts = authorization.split(None, 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return None


def _last10_digits(v: Optional[str]) -> Optional[str]:
    """Normalise a phone to a 10-digit Indian mobile (strip spaces / +91 /
    punctuation, keep the last 10 digits). None when there aren't 10 digits."""
    if not v:
        return None
    digits = "".join(ch for ch in str(v) if ch.isdigit())
    return digits[-10:] if len(digits) >= 10 else (digits or None)


def _payroll_bucket(rows: list, category: Optional[str]) -> list:
    """Category filter matching /reports/payroll: athlete / rest / payroll."""
    al = set(ATHLETE_CATEGORIES)
    if category == "athlete":
        return [r for r in rows if r.get("category") in al]
    if category == "rest":
        return [r for r in rows if r.get("category") not in al]
    if category == "payroll":
        return [r for r in rows if r.get("category") in {"staff", "coach"}]
    return rows


# Super-admin gating (04 Feb 2026). Moved to services/permissions.py so
# routes/*.py can import it directly without a `from server import ...`
# circular import. Re-exported here for backwards-compatibility with any
# tests that reach for `server.is_super_admin` / `server._SUPER_ADMIN_PHONES`.
from services.permissions import is_super_admin, _SUPER_ADMIN_PHONES, is_ex_member


async def require_coach_or_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") == "admin":
        return user
    # Chef role — added 4 Feb 2026 with the Roles master. Chefs get the
    # same read-only Muster / Presence access as coaches so they can
    # plan meal counts at the check-in window.
    if user.get("role") == "chef":
        return user
    if user.get("category") == "coach":
        return user
    raise HTTPException(status_code=403, detail="Coach, chef, or admin privileges required")


async def require_chef_or_admin(user: dict = Depends(get_current_user)) -> dict:
    """Chef's View gating (4 Feb 2026). Chef's View was admin-only when
    it shipped in Jul 2026; opening it to the dedicated `chef` role
    lets kitchen staff plan meals without giving them admin rights.
    Coaches also included (updated 4 Feb 2026) so on-the-ground staff
    can see meal counts alongside Muster / Presence."""
    if user.get("role") in ("admin", "chef"):
        return user
    if user.get("category") == "coach":
        return user
    raise HTTPException(status_code=403, detail="Chef, coach, or admin privileges required")


# ----------------------------------------------------------------------------
# Models
# ----------------------------------------------------------------------------


class LeaveBalanceBulkRow(BaseModel):
    member_id: str
    # Either or both may be sent — only the supplied fields are written so
    # editing one column doesn't clobber the other.
    opening: Optional[float] = None
    comp_off_opening: Optional[int] = None


class LeaveBalanceBulkIn(BaseModel):
    rows: List[LeaveBalanceBulkRow]


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
    # Org-wide default weekly off. Used by comp-off accrual when a member's
    # own `weekly_off` field is blank — saves the admin from having to fill
    # in the same Sunday/Monday choice on every single member profile.
    # Member-level `weekly_off` (if set) always overrides this fallback.
    default_weekly_off: Literal["monday","tuesday","wednesday","thursday","friday","saturday","sunday"] = "sunday"
    # Per-day-of-week work-timing overrides, standardised across ALL employees
    # (staff / coach / executive — never athletes, who are camp-driven). Shape:
    #   { "sat": {"start": "08:00", "end": "12:00"}, "sun": {...}, ... }
    # keyed mon..sun. A blank/missing day inherits the normal schedule. A
    # member's own `dow_hours` overrides this office-level default per day.
    # Added Jun 2026 (user request — coaches need special Sat/Sun timings).
    dow_hours: Dict[str, Dict[str, str]] = Field(default_factory=dict)
    # R3 (30 Jun 2026): Per-category minimum calendar-day notice before a
    # member may self-apply for a `leave` (NOT tour/posting/late-coming,
    # which are all naturally last-minute). Each category falls back to 3
    # when missing. Anything less and the user-side Apply button is
    # blocked with a tooltip telling them to ask the admin to file on
    # their behalf. Set a category to 0 to disable the gate for that
    # category. Legacy int values (from before the per-category split,
    # 30 Jun 2026 morning) are coerced to a uniform-per-category dict by
    # the validator below.
    leave_notice_days: Dict[str, int] = Field(default_factory=lambda: {
        "athlete": 3, "staff": 3, "coach": 3, "executive": 3,
    })
    # Half-day leave windows (30 Jun 2026). FN = forenoon, PN = postnoon.
    # These are informational — they drive UI copy and Presence-board
    # cutover timing; the balance ladder just deducts 0.5. Stored as
    # HH:MM strings so admins can tune them without a code push.
    half_day_fn_start: str = "09:30"
    half_day_fn_end: str = "13:30"
    half_day_pn_start: str = "13:30"
    half_day_pn_end: str = "18:00"
    # Chef's View — members must be checked in on or before this
    # office-local HH:MM to count as eligible for breakfast. Admins can
    # tune it on the Office Settings page (e.g. tighten to 06:45 on
    # regatta days). Empty/missing falls back to 07:00 in the endpoint.
    meal_breakfast_cutoff: str = "07:00"

    @field_validator("leave_notice_days", mode="before")
    @classmethod
    def _coerce_leave_notice_days(cls, v):
        """Migrate legacy `leave_notice_days: <int>` payloads (from the
        single-value version, ~30 Jun 2026 morning) into the per-category
        dict shape. Also seed any missing category with the default of 3
        so the admin form never starts with blank cells."""
        cats = ("athlete", "staff", "coach", "executive")
        if v is None:
            return {c: 3 for c in cats}
        if isinstance(v, (int, float)):
            n = max(0, int(v))
            return {c: n for c in cats}
        if isinstance(v, dict):
            out: dict = {}
            for c in cats:
                try:
                    out[c] = max(0, int(v.get(c, 3)))
                except (TypeError, ValueError):
                    out[c] = 3
            return out
        return {c: 3 for c in cats}
    # Daily reminder SMS to anyone still checked-in. The cron fires at
    # `checkout_reminder_time` (office-local HH:MM) and sends one SMS per
    # member who has an open session for today AND hasn't already been
    # reminded (idempotent via reminder_sent_at on the attendance doc).
    checkout_reminder_enabled: bool = True
    checkout_reminder_time: str = "20:00"
    checkout_reminder_template: str = "Hi {name}, looks like you're still checked in at {academy}. Please check out via the app when you leave."
    twilio: TwilioConfig = Field(default_factory=TwilioConfig)


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
    # Aggregation hot-paths (added 07/2026 after a payload perf audit —
    # approvals-summary + presence + dashboard were doing full-collection
    # scans on these status fields). Sparse where the field is optional so
    # the index stays small even as attendance grows to tens of thousands.
    await db.attendance.create_index("date")
    await db.attendance.create_index("status")
    await db.attendance.create_index("approval_status", sparse=True)
    await db.attendance.create_index("overtime_status", sparse=True)
    await db.dars.create_index([("user_id", 1), ("date", 1)], unique=True)
    await db.dars.create_index([("date", -1)])
    await db.todos.create_index([("owner_id", 1), ("status", 1), ("due_date", 1)])
    await db.checklists.create_index("owner_id")
    await db.checklist_ticks.create_index([("checklist_id", 1), ("date", 1)], unique=True)
    await db.leaves.create_index([("status", 1), ("start_date", 1), ("end_date", 1)])
    await db.leaves.create_index([("user_id", 1), ("status", 1)])
    await db.leaves.create_index("status")
    # Feb 2026 · Slice 1 — the Decision-history table in Approvals
    # sorts decided leaves by `decided_at DESC`. Without an index Mongo
    # falls back to an in-memory sort that scales linearly with the
    # collection; this covers the pattern with an O(log n) walk.
    await db.leaves.create_index([("decided_at", -1)], sparse=True)
    # Slice 2 — the applicant-side login banner does
    # find({user_id, status in [approved,rejected], decision_ack_at:null})
    # on every page mount. Compound index covers all three predicates
    # and reduces the scan to only the small unacked set.
    await db.leaves.create_index([("user_id", 1), ("decision_ack_at", 1)], sparse=True)
    await db.devices.create_index("status", sparse=True)
    # Escort module hot-paths (added 06/2026 alongside the Escorts launch):
    # `escorts.id` is used by every escort-token request via get_current_user,
    # `mobile_last10` by phone_login, and `status` + `institution` by the
    # kiosk active list + the escort-scoped muster filter. The compound
    # (escort_id, date) index makes the escort_attendance idempotency check
    # (find one row for today) O(1) instead of a scan.
    await db.escorts.create_index("id", unique=True)
    await db.escorts.create_index("mobile_last10")
    await db.escorts.create_index([("status", 1), ("institution", 1)])
    await db.escort_attendance.create_index([("escort_id", 1), ("date", -1)])
    await db.escort_attendance.create_index("date")
    # Perf pass 20 Feb 2026 — the calendar-grid + approvals + reports
    # endpoints were doing full-collection scans on these. All ~O(1)
    # writes so keeping them indexed is a no-brainer.
    await db.corrections.create_index([("status", 1), ("created_at", -1)])
    await db.corrections.create_index("requester_id")
    # Feb 2026 · Slice 3 — decision-history section on Approvals queries
    # corrections by (status in [approved,rejected]) then sorts by
    # `decided_at DESC`. Sparse because only decided rows populate the
    # field.
    await db.corrections.create_index([("decided_at", -1)], sparse=True)
    await db.breaks.create_index([("start_date", 1), ("end_date", 1)])
    await db.holidays.create_index("date")
    # Covering-compound so /reports/calendar-grid + /reports/attendance can
    # answer from the index without fetching docs. Added 20 Feb 2026 perf
    # pass 2. Motor's `create_index` is idempotent so this is safe to
    # deploy on top of the existing (user_id, date) index — Mongo just
    # picks the more specific one for range queries.
    await db.attendance.create_index([
        ("user_id", 1), ("date", -1),
        ("check_in_at", 1), ("is_late", 1),
    ])
    # Perf pass 24 Feb 2026 — audit_log + sms_log had NO indexes; every
    # admin view/filter was doing a full-collection scan (~700 rows and
    # growing). Sort key is `at` DESC (most-recent-first paging), and
    # the filter fields are actor_id / entity_id / entity_type / action.
    await db.audit_log.create_index([("at", -1)])
    await db.audit_log.create_index("actor_id", sparse=True)
    await db.audit_log.create_index("entity_id", sparse=True)
    await db.audit_log.create_index([("entity_type", 1), ("at", -1)])
    await db.feature_usage.create_index("feature_key", unique=True)
    await db.daily_leave_report_log.create_index("date", unique=True)
    for coll, key in (("absent_dispatch_log", "date"), ("member_id_docs", "user_id"), ("passport_reminder_log", "week")):
        try:
            await db[coll].create_index(key, unique=True)
        except Exception:
            logger.exception("unique index %s.%s not created (duplicates?)", coll, key)
    await db.cron_runs.create_index([("job", 1), ("run_id", 1)], unique=True)
    await db.sms_log.create_index([("at", -1)])
    await db.sms_log.create_index("to", sparse=True)
    # Meal muster index — added here in addition to the runtime
    # _ensure_meal_index() call so a fresh install has the guarantee
    # from boot without waiting for the first /meals/roster hit.
    await db.meal_records.create_index(
        [("user_id", 1), ("date", 1), ("meal", 1)],
        unique=True, name="uniq_user_date_meal",
    )
    await db.meal_records.create_index([("date", 1), ("meal", 1)])
    # Pantry-stock collections grow one doc per day forever — every stock /
    # expense / drill-down read filters by date (or lines.*), so index them
    # before the scans get slow (code review, Jun 2026).
    # One doc per date for these collections — `date` is UNIQUE so concurrent
    # first-writes of a fresh day can't create duplicate docs. _ensure_unique
    # upgrades a legacy non-unique index idempotently on boot.
    async def _ensure_unique_date(coll):
        try:
            await coll.create_index("date", unique=True)
        except Exception:
            try:
                await coll.drop_index("date_1")
            except Exception:
                pass
            await coll.create_index("date", unique=True)

    await _ensure_unique_date(db.meal_purchases)
    await db.meal_purchases.create_index("lines.item_id")
    await db.meal_purchases.create_index("lines.vendor_id")
    await _ensure_unique_date(db.meal_issues)
    await db.meal_issues.create_index("lines.item_id")
    await _ensure_unique_date(db.meal_wastage)
    await _ensure_unique_date(db.meal_adjustments)
    await db.meal_adjustments.create_index("lines.item_id")
    await db.meal_items.create_index([("category_key", 1), ("sort_order", 1)])
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

    # Super-admin phone backfill (24 Feb 2026): if the seeded admin has no
    # `mobile` set, stamp the first phone from SUPER_ADMIN_PHONES on it so
    # the passwordless phone-login path works out of the box on any fresh
    # deployment. Without this, a production DB that was seeded before the
    # phone-login feature existed leaves the admin unreachable via phone —
    # they can still log in with email + password, but that's admin-only
    # and clumsy for the "just tap Continue" experience.
    from services.permissions import _SUPER_ADMIN_PHONES as _SEED_SUPER_PHONES
    if _SEED_SUPER_PHONES:
        primary_super = next(iter(_SEED_SUPER_PHONES))
        # Only patch the primary admin — deliberately narrow so we don't
        # accidentally overwrite anybody else's mobile.
        admin_row = await db.users.find_one({"email": ADMIN_EMAIL}, {"_id": 0, "id": 1, "mobile": 1})
        if admin_row and not (admin_row.get("mobile") or "").strip():
            key = phone_key(primary_super)
            await db.users.update_one(
                {"id": admin_row["id"]},
                {"$set": {"mobile": primary_super, "mobile_last10": key}},
            )
            logger.info("Backfilled super-admin phone %s onto %s", primary_super, ADMIN_EMAIL)
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
    # Backfill `id` on legacy sms_log rows so merge-mode restore can dedupe them.
    sms_ids = 0
    async for row in db.sms_log.find({"id": {"$exists": False}}, {"_id": 1}):
        await db.sms_log.update_one({"_id": row["_id"]}, {"$set": {"id": str(uuid.uuid4())}})
        sms_ids += 1
    if sms_ids:
        logger.info("Backfilled id on %d sms_log row(s)", sms_ids)
    await db.login_attempts.create_index("identifier")
    # One-time security backfill: auto-created phone-login users used to get
    # their phone number as the email/password credential. Randomize those
    # hashes so the email login path can't be used as a backdoor. Guarded by
    # a config marker — bcrypt checks are slow, run once.
    if not await db.config.find_one({"id": "sec_backfill_phone_pwd"}):
        randomized = 0
        async for u in db.users.find(
            {"email": {"$regex": r"^\d+(-[0-9a-f]{4})?@attendance\.app$"}},
            {"_id": 0, "id": 1, "email": 1, "mobile": 1, "hashed_password": 1},
        ):
            digits = (u.get("mobile") or u["email"].split("@")[0].split("-")[0]) or ""
            if digits and verify_password(digits, u.get("hashed_password") or ""):
                await db.users.update_one(
                    {"id": u["id"]},
                    {"$set": {"hashed_password": hash_password(uuid.uuid4().hex)}},
                )
                randomized += 1
        await db.config.insert_one({"id": "sec_backfill_phone_pwd",
                                    "at": now_utc().isoformat(), "randomized": randomized})
        if randomized:
            logger.info("Randomized weak phone-number passwords on %d user(s)", randomized)
    # Backfill escort validity-from for legacy escort rows that pre-date
    # the 28 Jun 2026 validity-window feature. Sets `valid_from` to the
    # escort's recorded `start_date` (or `created_at` if missing) and
    # leaves `valid_until` as null — admins must set it the next time
    # they edit the escort. This keeps existing escorts able to log in
    # while nudging admins to fill in the missing end date.
    esc_filled = 0
    async for e in db.escorts.find(
        {"valid_from": {"$exists": False}},
        {"_id": 0, "id": 1, "start_date": 1, "created_at": 1},
    ):
        seed_from = e.get("start_date") or (e.get("created_at") or "")[:10]
        if not seed_from:
            continue
        await db.escorts.update_one(
            {"id": e["id"]},
            {"$set": {"valid_from": seed_from, "valid_until": None}},
        )
        esc_filled += 1
    if esc_filled:
        logger.info("Backfilled valid_from on %d escort(s); valid_until left null", esc_filled)
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

    # Seed categories master with the 5 canonical categories. `elite` was
    # added on 7 Jul 2026 alongside the Chef's View so kitchens can plan
    # menus by fleet tier. Elite kids still behave as athletes for every
    # other rule (Breaks workflow, no OT accrual, expected-daily filter).
    await db.categories.create_index("key", unique=True)
    if await db.categories.count_documents({}) == 0:
        _CATEGORY_SEED = [
            {"key": "athlete",   "label": "Athletes",   "sort_order": 10,
             "color": "sky",      "is_athlete_like": True,  "meal_eligible": True},
            {"key": "elite",     "label": "Elite",      "sort_order": 20,
             "color": "rose",     "is_athlete_like": True,  "meal_eligible": True},
            {"key": "coach",     "label": "Coaches",    "sort_order": 30,
             "color": "emerald",  "is_athlete_like": False, "meal_eligible": True},
            {"key": "staff",     "label": "Staff",      "sort_order": 40,
             "color": "amber",    "is_athlete_like": False, "meal_eligible": True},
            {"key": "executive", "label": "Executives", "sort_order": 50,
             "color": "violet",   "is_athlete_like": False, "meal_eligible": True},
        ]
        now_iso = now_utc().isoformat()
        for row in _CATEGORY_SEED:
            try:
                await db.categories.insert_one({
                    "id": str(uuid.uuid4()),
                    **row,
                    "active": True,
                    "created_at": now_iso,
                })
            except Exception as e:
                logger.debug("category seed skipped %r: %s", row["key"], e)
        logger.info("Seeded categories master (athlete, elite, coach, staff, executive)")

    # ------------------------------------------------------------------
    # Roles master (4 Feb 2026) — seeded system roles: admin, member,
    # chef. `is_system=True` prevents rename/delete. Chef is the new
    # role that grants read-access to Muster/Presence/Chef's View.
    # ------------------------------------------------------------------
    from routes.roles import seed_default_roles
    try:
        await seed_default_roles(db)
        logger.info("Seeded roles master (admin, chef, member)")
    except Exception as e:
        logger.debug("role seed skipped: %s", e)


# Background daily jobs live in services/scheduler.py.
from services.scheduler import (
    close_stale_open_sessions as _close_stale_impl,
    send_checkout_reminders as _send_reminders_impl,
    midnight_auto_checkout_loop, checkout_reminder_loop,
)


async def _close_stale_open_sessions(reason: str) -> int:
    return await _close_stale_impl(db, reason)


async def _send_checkout_reminders() -> int:
    return await _send_reminders_impl(db)


@asynccontextmanager
async def _lifespan(_app):
    """Startup: seed + catch-up + spawn background loops.
    Shutdown: cancel loops + close Mongo client."""
    import asyncio
    await _seed_database()
    from services.dar import refresh_tuition_keys
    await refresh_tuition_keys(db)
    try:
        from services.attendance_helpers import clear_hourly_timing_marks
        n = await clear_hourly_timing_marks(db, await db.config.find_one({"id": "office"}))
        if n:
            logger.info("hourly wagers: cleared late/early-out marks on %d row(s)", n)
    except Exception:
        logger.exception("hourly timing-mark cleanup failed")
    try:
        n = await _close_stale_open_sessions("startup_catchup")
        if n:
            logger.info("startup catch-up auto-checkout: closed %d stale session(s)", n)
    except Exception:
        logger.exception("startup catch-up auto-checkout failed")
    tasks = [
        asyncio.create_task(midnight_auto_checkout_loop(db)),
        asyncio.create_task(checkout_reminder_loop(db)),
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
# Auth + device-approval routes moved to routes/auth.py — see app.include_router
# call near the bottom of this file. Helpers (create_token, hash_password,
# verify_password) come from services/auth_utils and are passed into the
# factory.
# ----------------------------------------------------------------------------


# ----------------------------------------------------------------------------
# ----------------------------------------------------------------------------
# Office config + changelog routes moved to routes/office.py — see
# app.include_router call near the bottom of this file.
# ----------------------------------------------------------------------------


def member_photo_url(u: dict) -> Optional[str]:
    """Compat shim — the canonical implementation lives in
    services.photo.member_photo_url. Kept here so existing server.py
    call sites don't need touching."""
    from services.photo import member_photo_url as _mpu
    return _mpu(u)


@api_router.get("/leave-balances")
async def list_leave_balances(key: str = "", category: Optional[str] = None,
                              month: Optional[str] = None,
                              user: Optional[dict] = Depends(optional_user)):
    """Return every NON-ATHLETE member with their opening leave balance and
    current usage, used by the spreadsheet-style admin editor.

    Leave-balance tracking applies to coaches / staff / executives but NOT
    athletes — athletes don't accrue or consume a numeric leave quota
    (their breaks are tracked via the Breaks workflow, fleet-wide), so
    they're excluded from the listing.

    The row shape carries three pools so admins can audit Paid Leave AND
    Comp-Off side-by-side without opening individual member pages, plus
    a Tour-days counter for the year (tours are independent of any pool
    — they don't consume balance — but admins still want visibility).
    """
    # PayCraft server-to-server mode: ?key=GRID_API_KEY → simple
    # {rows:[{member_id,member_name,category,balances:{leave,comp_off}}]}.
    if key:
        if not valid_grid_key(key):
            raise HTTPException(status_code=401, detail="Invalid key")
        from holidays import compute_pay_balances
        office = await db.config.find_one({"id": "office"})
        yr = local_date_str(office)[:4]
        # Month Loss-of-Pay per member — the EXACT same figure the admin
        # grid shows for that month (reuses the grid engine, no drift).
        # Caller may pass ?month=YYYY-MM; defaults to the current month.
        lop_month = (month or local_date_str(office)[:7])
        import re as _re
        if not _re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", lop_month):
            raise HTTPException(status_code=400, detail="month must be in YYYY-MM format (e.g. 2026-09)")
        import calendar as _cal
        month_label = f"{_cal.month_name[int(lop_month[5:7])]} {lop_month[:4]}"
        roster = await db.users.find({"archived": {"$ne": True}}, {"_id": 0}).to_list(5000)
        roster = _payroll_bucket(roster, category or "rest")
        # Compute the month grid (for LOP) and every member's balances
        # CONCURRENTLY. The per-member balance summaries are independent,
        # so bound them with a semaphore and gather instead of awaiting in
        # series (was ~5 round-trips × N members done sequentially — the
        # dominant cost of the PayCraft feed). Numbers are byte-identical.
        _sem = asyncio.Semaphore(16)
        async def _member_row(u):
            async with _sem:
                b = await compute_pay_balances(db, u, year=yr)
            return {
                "member_id": u.get("id"),
                "member_name": u.get("full_name"),
                "category": u.get("category"),
                # Hourly-wager members are paid purely for hours worked (fed
                # via the Grid OT channel) and get no leave / weekly-off pay.
                # Surfaced here so the payroll consumer can skip leave/LOP
                # logic for them. Balances are still reported as-is (additive,
                # no number changes) — the consumer decides based on pay_basis.
                "hourly_wager": bool(u.get("hourly_wager")),
                "pay_basis": "hourly" if u.get("hourly_wager") else "salaried",
                # Hourly wagers: hours only — leave / comp-off sent as 0.
                "balances": {
                    "leave": 0 if u.get("hourly_wager") else b["paid_available"],
                    "comp_off": 0 if u.get("hourly_wager") else b["comp_available"],
                },
                # Per-row month stamp so each LOP value is self-describing
                # even after PayCraft flattens rows into a payroll sheet.
                "lop_month": lop_month,
            }
        grid, bal_rows = await asyncio.gather(
            _GRID_IMPL(lop_month, None, None, None, with_meta=False),
            asyncio.gather(*[_member_row(u) for u in roster]),
        )
        lop_map = {r["member_id"]: r["totals"].get("lop", 0) for r in grid.get("rows", [])}
        for r in bal_rows:
            r["lop_month_days"] = lop_map.get(r["member_id"], 0)
        out_rows = sorted(bal_rows, key=lambda r: (r["member_name"] or "").lower())
        return {"month": lop_month, "month_label": month_label, "rows": out_rows}
    if not user or user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin privileges required")
    users = await db.users.find(
        {"category": {"$nin": list(ATHLETE_CATEGORIES)}, "archived": {"$ne": True}},
        {"_id": 0, "id": 1, "full_name": 1, "category": 1,
         "rank": 1, "institution": 1,
         "leave_balance_opening": 1, "comp_off_opening": 1, "weekly_off": 1},
    ).sort("full_name", 1).to_list(2000)
    office = await db.config.find_one({"id": "office"})
    today = local_date_str(office)
    year = today[:4]
    yr_start, yr_end = f"{year}-01-01", f"{year}-12-31"
    # Pull every approved leave/tour/posting row for the year ONCE and bucket by
    # user_id+type → avoids N queries per member.
    approved = await db.leaves.find({
        "status": "approved",
        "start_date": {"$lte": yr_end},
        "end_date":   {"$gte": yr_start},
        "type": {"$in": ["leave", "tour", "comp_off", "posting"]},
    }, {"_id": 0, "user_id": 1, "type": 1, "start_date": 1, "end_date": 1,
        "comp_off_used": 1, "paid_leave_used": 1, "lop_days": 1}).to_list(20000)
    paid_used: dict = {}
    comp_used: dict = {}
    tour_days: dict = {}
    # Per-user list of (start, end) approved tour ranges. Used downstream
    # to compute the "tour days that landed on the user's weekly_off"
    # slice of their comp-off accrual (added 28 Jun 2026; mirrors
    # holidays.compute_comp_off_balance so the admin Leave Balances page
    # matches /api/me/comp-off-balance).
    tour_ranges_by_user: dict = {}
    # R2 (30 Jun 2026): expanded posting date-set per user. Used to
    # suppress weekly-off comp-off accrual that would otherwise fire
    # while a member is on Posting deputation.
    posting_dates_by_user: dict = {}
    for L in approved:
        uid = L["user_id"]
        n = _days_inclusive_safe(L["start_date"], L["end_date"])
        if L["type"] == "leave":
            # Prefer the explicit stamps; fall back to the whole window as
            # paid days for legacy pre-Jun-2026 rows that don't have them.
            if L.get("paid_leave_used") is not None:
                paid_used[uid] = paid_used.get(uid, 0.0) + float(L["paid_leave_used"])
            else:
                paid_used[uid] = paid_used.get(uid, 0.0) + n
            if L.get("comp_off_used") is not None:
                comp_used[uid] = comp_used.get(uid, 0) + int(L["comp_off_used"])
        elif L["type"] == "comp_off":
            # Legacy direct comp-off application — whole window counts.
            comp_used[uid] = comp_used.get(uid, 0) + n
        elif L["type"] == "tour":
            tour_days[uid] = tour_days.get(uid, 0) + n
            tour_ranges_by_user.setdefault(uid, []).append(
                (L["start_date"], L["end_date"])
            )
        elif L["type"] == "posting":
            # Expand into a date-set used to gate comp-off accrual below.
            try:
                s = max(date.fromisoformat(L["start_date"]), date.fromisoformat(yr_start))
                e = min(date.fromisoformat(L["end_date"]), date.fromisoformat(yr_end))
            except Exception:
                continue
            pset = posting_dates_by_user.setdefault(uid, set())
            cur = s
            while cur <= e:
                pset.add(cur.isoformat())
                cur = date.fromordinal(cur.toordinal() + 1)
    # Comp-off accrual is per-member and depends on attendance ∩ weekly-off.
    # Cache the office default to avoid hitting db.config inside the loop.
    default_weekly_off = (office or {}).get("default_weekly_off") or "sunday"
    # Pull this year's attendance dates once, group by user — cheaper than
    # one query per user for academies with ~100 staff.
    atts = await db.attendance.find(
        {"date": {"$gte": yr_start, "$lte": yr_end}},
        {"_id": 0, "user_id": 1, "date": 1},
    ).to_list(50000)
    att_dates: dict = {}
    for a in atts:
        att_dates.setdefault(a["user_id"], set()).add(a["date"])

    from holidays import WEEKDAY_KEY  # local import — keeps top-of-file clean
    today_iso = today  # ISO date in office-local tz; reuse for tour-past gate
    out = []
    for u in users:
        uid = u["id"]
        opening = float(u.get("leave_balance_opening") or 0)
        taken = float(paid_used.get(uid, 0))
        # Comp-off accrual = days the user attended that fell on their
        # effective weekly off … MINUS any such date that lands inside an
        # approved posting window (R2, 30 Jun 2026).
        wo = (u.get("weekly_off") or default_weekly_off).lower()
        accrued_from_attendance = 0
        att_seen = att_dates.get(uid, set())
        posting_set = posting_dates_by_user.get(uid, set())
        for ds in att_seen:
            try:
                if WEEKDAY_KEY[date.fromisoformat(ds).weekday()] == wo and ds not in posting_set:
                    accrued_from_attendance += 1
            except Exception:
                continue
        # … PLUS approved tour days that landed on the weekly_off AND are
        # past-or-today (28 Jun 2026 evening update — future tour Sundays
        # no longer pre-accrue). Mirrors holidays.compute_comp_off_balance.
        # Athletes are excluded (Breaks workflow). Tour dates that also
        # have attendance are NOT double-counted.
        accrued_from_tours = 0
        if (u.get("category") or "").lower() not in ATHLETE_CATEGORIES:
            seen_tour_dates: set = set()
            for s_iso, e_iso in tour_ranges_by_user.get(uid, ()):
                try:
                    s = max(date.fromisoformat(s_iso), date.fromisoformat(yr_start))
                    e = min(date.fromisoformat(e_iso), date.fromisoformat(yr_end))
                except Exception:
                    continue
                cur = s
                while cur <= e:
                    ds = cur.isoformat()
                    if (ds not in seen_tour_dates
                            and ds not in att_seen
                            and ds <= today_iso
                            and WEEKDAY_KEY[cur.weekday()] == wo):
                        accrued_from_tours += 1
                        seen_tour_dates.add(ds)
                    cur = date.fromordinal(cur.toordinal() + 1)
        # … PLUS any admin-seeded opening balance carried forward
        # (e.g. last-year's unused credits at fresh-deployment time).
        # Stored on the user doc as `comp_off_opening` (default 0).
        accrued_from_opening = int(u.get("comp_off_opening") or 0)
        accrued = accrued_from_attendance + accrued_from_tours + accrued_from_opening
        co_used = int(comp_used.get(uid, 0))
        co_avail = max(0, accrued - co_used)
        out.append({
            "id": uid,
            "full_name": u["full_name"],
            "category": u.get("category"),
            "rank": u.get("rank"),
            "institution": u.get("institution"),
            "opening": opening,
            "taken_this_year": taken,
            "balance": round(opening - taken, 1),
            # Comp-off pool (year-to-date)
            "comp_off_accrued": accrued,
            "comp_off_opening": accrued_from_opening,
            # Split for the admin Leave Balances UI sub-line ("Accrued X · Y
            # from tours · Z opening"). Sum of these three equals
            # comp_off_accrued.
            "comp_off_accrued_from_attendance": accrued_from_attendance,
            "comp_off_accrued_from_tours": accrued_from_tours,
            "comp_off_accrued_from_opening": accrued_from_opening,
            "comp_off_used": co_used,
            "comp_off_available": co_avail,
            # Tour days (year-to-date; informational only)
            "tour_days": int(tour_days.get(uid, 0)),
        })
    return {"year": int(year), "rows": out}


def _days_inclusive_safe(start_iso: str, end_iso: str) -> int:
    try:
        return (date.fromisoformat(end_iso) - date.fromisoformat(start_iso)).days + 1
    except Exception:
        return 1


@api_router.post("/leave-balances/bulk")
async def bulk_set_leave_balances(body: LeaveBalanceBulkIn, admin: dict = Depends(require_admin)):
    """Persist Paid-Leave opening and/or Comp-Off opening per member. Only the
    fields supplied on each row are written — sending just `opening` leaves
    `comp_off_opening` untouched and vice-versa, so the admin Leave Balances
    page can save the two columns independently."""
    updated = 0
    for row in body.rows:
        patch = {}
        if row.opening is not None:
            patch["leave_balance_opening"] = float(row.opening)
        if row.comp_off_opening is not None:
            # Clamp negatives to 0 — a negative opening would silently
            # debit the live accrual which is almost never what an admin
            # intends and is trivially recoverable by re-saving.
            patch["comp_off_opening"] = max(0, int(row.comp_off_opening))
        if not patch:
            continue
        before = await db.users.find_one({"id": row.member_id},
                                         {"_id": 0, "id": 1, "full_name": 1,
                                          "leave_balance_opening": 1,
                                          "comp_off_opening": 1})
        r = await db.users.update_one({"id": row.member_id}, {"$set": patch})
        if r.modified_count or r.matched_count:
            updated += 1
            # Audit each row that actually took a write — one row per
            # member so the log is granular enough to answer "who bumped
            # ARUNA's paid-leave opening from 12 → 24?".
            after = {**(before or {}), **patch}
            await write_audit(
                db, actor=admin, action="leave_balance.set",
                entity_type="member", entity_id=row.member_id,
                entity_name=(before or {}).get("full_name"),
                before=before, after=after,
            )
    return {"ok": True, "updated": updated}


# ----------------------------------------------------------------------------
# Institutions master
# ----------------------------------------------------------------------------
# ----------------------------------------------------------------------------
# Institutions + Fleets master CRUD moved to routes/masters.py — see
# app.include_router call near the bottom of this file.
# ----------------------------------------------------------------------------


# ----------------------------------------------------------------------------
# Group leave — file the same leave for many members in one shot
# ----------------------------------------------------------------------------
# coaches always see a current likeness on the muster.
# Source of truth in backend/config.py.
from config import PHOTO_REFRESH_DAYS

# Weekly photo-refresh (Jun 2026, user request): once a week, on a RANDOM
# working day, the self check-in prompts for a fresh selfie that replaces
# the stored photo. No fixed pattern, never on the member's weekly-off,
# and unsynchronised across members. This replaces the old yearly refresh.
_WEEKDAY_NAMES = ["monday", "tuesday", "wednesday", "thursday",
                  "friday", "saturday", "sunday"]


def _iso_week_key(d) -> str:
    """`YYYY-Www` ISO-week key for a date — the unit a weekly refresh is
    scoped to (Mon–Sun)."""
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def _weekly_photo_due(user: dict, office: Optional[dict], local_date) -> bool:
    """True when this member is due their weekly random photo refresh AND
    today is on/after their randomly-assigned working day for the week.

    Random day is a deterministic hash of (member_id, iso-week), so it's
    stable within the week, differs per member (no sync) and per week (no
    pattern). The assigned day is drawn only from the member's WORKING days
    (weekly-off excluded), and we fire on the first check-in whose weekday
    is on/after it — so the member's LAST working day always qualifies,
    guaranteeing the refresh happens once that week as long as they check
    in. Already-refreshed weeks (photo_refresh_week == this week) are skipped.
    """
    week_key = _iso_week_key(local_date)
    if user.get("photo_refresh_week") == week_key:
        return False
    weekly_off = (user.get("weekly_off")
                  or (office or {}).get("default_weekly_off")
                  or "sunday").strip().lower()
    working_indices = [i for i in range(7) if _WEEKDAY_NAMES[i] != weekly_off]
    if not working_indices:
        return False
    today_weekday = local_date.weekday()  # Mon=0 … Sun=6
    if today_weekday not in working_indices:
        return False  # member's weekly-off — real check-ins won't land here
    import hashlib
    seed = int(hashlib.sha256(f"{user['id']}:{week_key}".encode()).hexdigest(), 16)
    target_pos = seed % len(working_indices)
    today_pos = working_indices.index(today_weekday)
    return today_pos >= target_pos


@api_router.get("/me/photo-status")
async def my_photo_status(user: dict = Depends(get_current_user)):
    """Tells the SelfCheckIn page whether the member needs to (re)capture a
    selfie before checking in. A photo is "needed" if it's MISSING, or when
    the member is due their weekly random refresh (see `_weekly_photo_due`)."""
    photo = user.get("photo")
    office = await db.config.find_one({"id": "office"}, {"_id": 0})
    local_date = local_now(office).date()
    week_key = _iso_week_key(local_date)

    needs = not photo  # no photo at all → always need one
    reason = "missing" if not photo else "ok"
    if photo and _weekly_photo_due(user, office, local_date):
        needs = True
        reason = "weekly_refresh"
    return {
        "has_photo": bool(photo),
        "captured_at": user.get("photo_captured_at"),
        "week_key": week_key,
        "needs_photo": needs,
        "reason": reason,
    }


# ── Personal Reason Bank ─────────────────────────────────────────────
# Each member accumulates their own list of reasons — anything they
# type into an OT check-in/check-out prompt or a comp-off application
# is added (case-insensitively deduped) so it re-appears as a
# suggestion next time. Kept private per-user; admins do not curate.
# Introduced 7 Jul 2026 for the user-driven "personal reason base"
# feature; storage is `users[uid].reasons: [str]` sorted MRU-first.
async def _ensure_reason_in_bank(user_id: str, reason: Optional[str]) -> None:
    """Append `reason` to the user's personal bank if it's not already
    present (case-insensitive). Silent no-op for empty / whitespace
    input. Sort order: most-recently-used first — repeat use bumps a
    reason to the top."""
    if not reason or not reason.strip():
        return
    r = reason.strip()
    # Use explicit `is None` — an existing user without a `reasons`
    # field yields `{}` from find_one, which is falsy but valid.
    u = await db.users.find_one({"id": user_id}, {"_id": 0, "reasons": 1})
    if u is None:
        return
    current = list(u.get("reasons") or [])
    # Case-insensitive dedup — treat "Rainbow Kids" and "rainbow kids"
    # as the same entry (keep the newer capitalisation).
    lowered = r.lower()
    kept = [x for x in current if x.lower() != lowered]
    new_list = [r] + kept  # MRU at head
    # Hard cap so a chatty member doesn't grow the doc unbounded.
    new_list = new_list[:50]
    if new_list != current:
        await db.users.update_one({"id": user_id}, {"$set": {"reasons": new_list}})


@api_router.get("/me/reasons")
async def list_my_reasons(user: dict = Depends(get_current_user)):
    """Return the caller's personal reason bank (MRU-first)."""
    u = await db.users.find_one({"id": user["id"]}, {"_id": 0, "reasons": 1})
    return {"reasons": list((u or {}).get("reasons") or [])}


class ReasonIn(BaseModel):
    reason: str


@api_router.post("/me/reasons")
async def add_my_reason(body: ReasonIn, user: dict = Depends(get_current_user)):
    """Manually add a reason (also happens automatically on OT/comp-off
    submit). Idempotent — repeated adds bump the reason to the top."""
    await _ensure_reason_in_bank(user["id"], body.reason)
    u = await db.users.find_one({"id": user["id"]}, {"_id": 0, "reasons": 1})
    return {"reasons": list((u or {}).get("reasons") or [])}


@api_router.delete("/me/reasons")
async def delete_my_reason(reason: str, user: dict = Depends(get_current_user)):
    """Prune a stale reason from the caller's bank. Match is
    case-insensitive. Reason passed as `?reason=...` query so we don't
    need to escape it for a URL path."""
    if not reason or not reason.strip():
        raise HTTPException(status_code=400, detail="Reason is required")
    target = reason.strip().lower()
    u = await db.users.find_one({"id": user["id"]}, {"_id": 0, "reasons": 1})
    current = list((u or {}).get("reasons") or [])
    kept = [x for x in current if x.lower() != target]
    if kept != current:
        await db.users.update_one({"id": user["id"]}, {"$set": {"reasons": kept}})
    return {"reasons": kept}


# ----------------------------------------------------------------------------
# Attendance: check-in / check-out
# ----------------------------------------------------------------------------
# Attendance helpers live in services/attendance_helpers.py (thin db-bound wrappers below).
import services.attendance_helpers as _att
from services.attendance_helpers import geo_check, _compute_early_out_at_checkout


async def open_session_for(user_id: str) -> Optional[dict]:
    return await _att.open_session_for(db, user_id)


async def _late_days_in_month(user_id: str, date_iso: str) -> int:
    return await _att.late_days_in_month(db, user_id, date_iso)


async def _resolve_site_for(office: dict, lat: float, lng: float):
    return await _att.resolve_site_for(db, office, lat, lng)


async def _cancel_stale_missed_checkin(user_id: str, date_iso: str) -> int:
    return await _att.cancel_stale_missed_checkin(db, user_id, date_iso)


async def _has_checkin_today(user_id: str, date_str: str) -> bool:
    return await _att.has_checkin_today(db, user_id, date_str)


# ----------------------------------------------------------------------------
# Presence Board (GET /api/presence) moved to routes/presence_board.py on
# 12 Oct 2026 (Refactor #5). Read-only roster aggregation; wired via
# app.include_router near the bottom of this file. The _WEEKDAY_KEY constant
# and _make_absence_streak_computer helper moved with it.
# ----------------------------------------------------------------------------


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
# Rich profile dashboard — /me/profile-details
# ----------------------------------------------------------------------------
@api_router.get("/me/profile-details")
async def my_profile_details(user: dict = Depends(get_current_user)):
    """One-shot "everything you need to know about yourself" payload for
    the member's Profile page. Bundles balance summary, YTD/MTD stats,
    late-arrival and early-out lists, OT accrual, and recent activity.

    Kept as a single roundtrip so the profile renders in one paint —
    the individual sources (`/me/stats`, `/me/leave-summary`,
    `/me/comp-off-balance`) are still available for callers that only
    want a slice. All numeric fields are safe for direct display; the
    lists are pre-sorted (latest first).
    """
    return await _profile_details_for(user)


async def _profile_details_for(user: dict) -> dict:
    """Compute the full profile-details payload for `user`. Shared by
    `/me/profile-details` (self-view) and
    `/admin/members/{id}/profile-details` (admin search-and-view). See
    the endpoint docstring above for the payload shape.
    """
    from holidays import compute_balance_summary, compute_comp_off_balance

    office = await db.config.find_one({"id": "office"})
    today = local_now(office).date()
    today_iso = today.isoformat()
    month_start = today.replace(day=1).isoformat()
    week_start = (today - timedelta(days=today.weekday())).isoformat()
    year_start = f"{today.year}-01-01"

    # Fire independent fetches concurrently — big wall-clock win.
    balance_task = compute_balance_summary(db, user)
    comp_off_task = compute_comp_off_balance(db, user)
    sessions_task = db.attendance.find(
        {"user_id": user["id"], "date": {"$gte": year_start, "$lte": today_iso}},
        {"_id": 0, "id": 1, "date": 1, "check_in_at": 1, "check_out_at": 1,
         "hours": 1, "late": 1, "late_minutes": 1,
         "overtime_total_min": 1, "ot_early": 1,
         "work_start_at_session": 1, "work_end_at_session": 1},
    ).sort("date", -1).to_list(500)
    open_task = open_session_for(user["id"])
    pending_leaves_task = db.leaves.count_documents(
        {"user_id": user["id"], "status": "pending"},
    )
    balance, comp_off, sessions, open_sess, pending_leaves = await asyncio.gather(
        balance_task, comp_off_task, sessions_task, open_task, pending_leaves_task,
    )

    # Attendance aggregates.
    week_sessions = [s for s in sessions if s["date"] >= week_start]
    month_sessions = [s for s in sessions if s["date"] >= month_start]

    late_this_month = [s for s in month_sessions if s.get("late")]
    late_ytd_count = sum(1 for s in sessions if s.get("late"))

    # Early-out detection — checked out significantly (>15m) before
    # work_end_at_session. Session must have a check_out_at recorded.
    def _hhmm_to_min(hhmm: str):
        if not hhmm or ":" not in hhmm:
            return None
        try:
            h, m = hhmm.split(":")[:2]
            return int(h) * 60 + int(m)
        except (ValueError, TypeError):
            return None

    def _timestamp_local_min(ts):
        # `ts` is a datetime string in UTC ISO. Convert to office-local
        # minute-of-day so it can be compared to the HH:MM `work_end`.
        if not ts:
            return None
        try:
            from services.time_utils import office_tz
            dt = datetime.fromisoformat(ts).astimezone(office_tz(office))
            return dt.hour * 60 + dt.minute
        except (ValueError, TypeError, AttributeError):
            return None

    early_outs_month = []
    for s in month_sessions:
        if not s.get("check_out_at"):
            continue
        work_end = s.get("work_end_at_session")
        end_min = _hhmm_to_min(work_end) if work_end else None
        out_min = _timestamp_local_min(s.get("check_out_at"))
        if end_min is None or out_min is None:
            continue
        early_by = end_min - out_min
        if early_by >= 15:  # 15-min grace
            early_outs_month.append({
                "id": s.get("id"), "date": s["date"],
                "check_out_at": s.get("check_out_at"),
                "expected_end": work_end,
                "early_by_minutes": early_by,
                "hours": s.get("hours"),
                # Reason captured at checkout time (13 Feb 2026). May be
                # blank for historical rows that predate the feature —
                # the Profile card falls back to an em-dash in that case.
                "reason": s.get("early_out_reason"),
            })

    ot_minutes_month = sum(_session_ot_minutes(user, s) for s in month_sessions)
    ot_minutes_ytd = sum(_session_ot_minutes(user, s) for s in sessions)

    week_hours = round(sum((s.get("hours") or 0) for s in week_sessions), 2)
    month_hours = round(sum((s.get("hours") or 0) for s in month_sessions), 2)
    ytd_hours = round(sum((s.get("hours") or 0) for s in sessions), 2)

    days_this_week = len({s["date"] for s in week_sessions})
    days_this_month = len({s["date"] for s in month_sessions})
    days_ytd = len({s["date"] for s in sessions})

    # Slim the payload — cap the recent + late + early lists.
    recent = sessions[:15]
    late_this_month_list = [{
        "id": s.get("id"), "date": s["date"],
        "check_in_at": s.get("check_in_at"),
        "late_minutes": int(s.get("late_minutes") or 0),
        "hours": s.get("hours"),
    } for s in late_this_month[:30]]

    return {
        # Section 1 — headline stats
        "today": today_iso,
        "checked_in": open_sess is not None,
        "open_session": open_sess,
        # Section 2 — attendance aggregates
        "attendance": {
            "week_hours": week_hours,
            "month_hours": month_hours,
            "ytd_hours": ytd_hours,
            "days_this_week": days_this_week,
            "days_this_month": days_this_month,
            "days_ytd": days_ytd,
            "late_days_this_week": len({s["date"] for s in week_sessions if s.get("late")}),
            "late_days_this_month": len(late_this_month),
            "late_days_ytd": late_ytd_count,
            "early_outs_this_month": len(early_outs_month),
        },
        # Section 3 — OT (minutes; convert to h/m client-side)
        "overtime": {
            "month_minutes": int(ot_minutes_month),
            "ytd_minutes": int(ot_minutes_ytd),
        },
        # Section 4 — leave & comp-off balances (from holidays.py)
        "balance": balance,
        "comp_off": comp_off,
        # Section 5 — pending items
        "pending": {
            "leaves": pending_leaves,
        },
        # Section 6 — drill-down lists (already trimmed)
        "recent_attendance": recent,
        "late_this_month": late_this_month_list,
        "early_outs_this_month": early_outs_month[:30],
    }


# Admin search-and-view — same rich profile payload for any target member.
# 18 Feb 2026 user request "admins should be able to see any members
# profile with a search". Front-end wires this on the Profile page via
# ?member=<uuid>.
@api_router.get("/admin/members/{member_id}/profile-details")
async def admin_member_profile_details(
    member_id: str,
    admin: dict = Depends(require_admin),
):
    target = await db.users.find_one({"id": member_id}, {"_id": 0, "password_hash": 0})
    if not target:
        raise HTTPException(404, "Member not found")
    payload = await _profile_details_for(target)
    # Return the target's basic profile so the Hero card renders
    # correctly without the client needing a second roundtrip. Only the
    # display-safe fields are surfaced — password hashes / tokens are
    # already stripped by the projection above.
    payload["user"] = {
        "id": target.get("id"),
        "full_name": target.get("full_name"),
        "role": target.get("role"),
        "category": target.get("category"),
        "mobile": target.get("mobile"),
        "email": target.get("email"),
        "photo_url": target.get("photo_url"),
        "photo": member_photo_url(target),
        "rank": target.get("rank"),
        "institution": target.get("institution"),
        "fleet": target.get("fleet"),
        "joining_date": target.get("joining_date"),
        "leaving_date": target.get("leaving_date"),
    }
    return payload


# ----------------------------------------------------------------------------


# ----------------------------------------------------------------------------
# Muster roll endpoints moved to routes/muster.py — see app.include_router
# call near the bottom of this file. The `_active_camp_for` helper is
# passed into the factory so the muster check-in path still applies camp
# overlays to the stored late_minutes.
# ----------------------------------------------------------------------------


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
        missing = bool(s.get("missing_checkout"))
        hours = 0.0 if missing else round(max(0.0, (end_ref - cin).total_seconds()) / 3600.0, 2)

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
            "missing_checkout": missing,
            "needs_correction": bool(s.get("needs_correction")),
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
# Admin tooling endpoints (wipe / backup / restore / preflight / summary /
# activity) moved to routes/admin_tools.py — see app.include_router call
# near the bottom of this file.
# ----------------------------------------------------------------------------


# ----------------------------------------------------------------------------
# Reports
# ----------------------------------------------------------------------------
async def compute_hours_report(start: str, end: str) -> List[dict]:
    """Aggregate hours and days present per member between dates inclusive."""
    users = await db.users.find(
        {"archived": {"$ne": True}}, {"_id": 0, "id": 1, "full_name": 1, "category": 1, "rank": 1, "weekly_off": 1, "fleet": 1, "leaving_date": 1, "joining_date": 1, "hourly_wager": 1}
    ).sort("full_name", 1).to_list(2000)
    sd = date.fromisoformat(start)
    ed = date.fromisoformat(end)
    span_days = max(1, (ed - sd).days + 1)

    # Absent-calc corrections (7 Jul 2026): a member's weekly-off day
    # in the window is legitimately "off", not "absent". Same for the
    # current in-progress day when the window's `end` is today (mid-day
    # runs used to show today as absent until the member checked in).
    office = await db.config.find_one({"id": "office"})
    today_iso = local_date_str(office)
    end_is_today = (end == today_iso)

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

    # PENDING comp-off applications (used by the Comp-Off "Applied" column
    # in the Attendance report). Kept separate from `leaves_by_user_typed`
    # so the approved-only aggregation above stays untouched.
    pending_comp_off = await db.leaves.find(
        {
            "status": "pending",
            "type": "comp_off",
            "start_date": {"$lte": end},
            "end_date": {"$gte": start},
        },
        {"_id": 0, "user_id": 1, "start_date": 1, "end_date": 1},
    ).to_list(10000)
    pending_comp_off_by_user: dict = {}
    for lv in pending_comp_off:
        pending_comp_off_by_user.setdefault(lv["user_id"], []).append(lv)

    # Half-day leaves (FN/PN, 0.5-day deduction) in the window — surfaced
    # as its own column so admins can spot partial absences at a glance
    # (7 Jul 2026 user-requested addition).
    half_day_leaves = await db.leaves.find(
        {
            "status": "approved",
            "type": "leave",
            "half_day": {"$in": ["FN", "PN"]},
            "start_date": {"$lte": end},
            "end_date": {"$gte": start},
        },
        {"_id": 0, "user_id": 1, "start_date": 1, "end_date": 1},
    ).to_list(10000)
    half_days_by_user: dict = {}
    half_day_dates_by_user: dict = {}
    for lv in half_day_leaves:
        # Half-days are single-day by construction — start==end.
        try:
            d_ = date.fromisoformat(lv["start_date"])
            if sd <= d_ <= ed:
                half_days_by_user[lv["user_id"]] = half_days_by_user.get(lv["user_id"], 0) + 1
                half_day_dates_by_user.setdefault(lv["user_id"], set()).add(d_.isoformat())
        except Exception:
            pass

    # Escort-duty days per member (7 Jul 2026 user-requested): distinct
    # dates in `escort_attendance` where the member was one of the
    # athletes checked in with an escort. Useful for coaches / athletes
    # who accompany parent-escorts around the campus.
    escort_rows = await db.escort_attendance.find(
        {"date": {"$gte": start, "$lte": end}},
        {"_id": 0, "date": 1, "check_in_athlete_ids": 1},
    ).to_list(10000)
    escort_days_by_user: dict = {}
    for er in escort_rows:
        for aid in (er.get("check_in_athlete_ids") or []):
            escort_days_by_user.setdefault(aid, set()).add(er["date"])

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

    def _days_of_type(user_id: str, ltype: str) -> set:
        """Set of ISO date strings the member is on `ltype` (leave / tour /
        comp_off / posting / late_coming), clipped to the report window."""
        days: set = set()
        for leave in leaves_by_user_typed.get(user_id, {}).get(ltype, []):
            days |= _days_overlap(leave["start_date"], leave["end_date"])
        return days

    def _count_days_of_type(user_id: str, ltype: str) -> int:
        return len(_days_of_type(user_id, ltype))

    def _break_days(member: dict) -> set:
        days: set = set()
        for b in breaks_window:
            if not _breaks_module.break_applies_to(b, member):
                continue
            days |= _days_overlap(b["start_date"], b["end_date"])
        return days

    def _count_break_days(member: dict) -> int:
        return len(_break_days(member))

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
        present_dates = {s["date"] for s in sessions}
        total_hours = round(sum(s.get("hours") or 0 for s in sessions), 2)
        days_present = len(present_dates)
        # Late-count parity with the Grid (Jun 2026 fix): the Grid renders
        # pre-joining days as NJ and post-leaving days as LF and excludes
        # them from every total. Payroll must do the same, else a stray
        # late punch dated before a member's joining_date (or after their
        # leaving_date) made payroll's late_days read one higher than the
        # Grid. Filter those out so both views agree.
        _jd = u.get("joining_date")
        _ld = u.get("leaving_date")
        late_dates = {s["date"] for s in sessions if s.get("late")
                      and not (_jd and s["date"] < _jd)
                      and not (_ld and s["date"] > _ld)}
        late_days = len(late_dates)
        leave_dates = _days_of_type(u["id"], "leave")
        tour_dates = _days_of_type(u["id"], "tour")
        break_dates = _break_days(u)
        comp_off_used_dates = _days_of_type(u["id"], "comp_off")
        days_leave = len(leave_dates)
        days_tour = len(tour_dates)
        days_break = len(break_dates)
        # Combined "time-off" column for backward-compat with older clients.
        days_on_leave = days_leave + days_tour + days_break
        overstays = _overstays(sessions)
        # As of 15 Feb 2026 OT has no approval workflow — every minute
        # recorded on the row is counted as "served" (both approved and
        # pending buckets are collapsed into the same value). Keys kept
        # for backward-compat with older frontend clients that still
        # read `overtime_hours_approved` / `overtime_hours_pending`.
        total_ot_min = sum(_session_ot_minutes(u, s) for s in sessions)
        approved_ot_min = total_ot_min
        pending_ot_min = 0
        # Compensatory off bookkeeping (within this report's date range)
        co_earned = _comp_off_earned(u, sessions)
        co_used = len(comp_off_used_dates)
        co_pending = max(0, co_earned - co_used)
        # Days the member is "accounted for" — present, leave, tour,
        # posting (admin off-base assignment), late-coming (approved
        # delayed arrival), break, or comp-off. Anything else in the
        # span is *provisionally* absent — but weekly-off days they
        # didn't work AND the in-progress day (today, if the window
        # ends today) are legitimately-off, not absent. See the block
        # near the top of this function.
        #
        # Build the *set* of accounted calendar days first so overlaps
        # between categories (e.g. half-day check-in + half-day leave on
        # the same date, or a leave that spans across a Sunday the
        # member also checked in on) don't double-count.
        accounted_dates: set = set(present_dates)
        # All leave-like types that mean "not absent" on that date. Note
        # `late_coming` is a same-day one-day record acknowledging the
        # member will arrive late — an approved one is admin-sanctioned
        # presence for the day, even if attendance never got captured
        # (7 Jul 2026 fix: ARUNA was showing absent for a Jul 2 with
        # approved late-coming and no attendance row).
        for ltype in ("leave", "tour", "posting", "comp_off", "late_coming"):
            for leave in leaves_by_user_typed.get(u["id"], {}).get(ltype, []):
                accounted_dates |= _days_overlap(leave["start_date"], leave["end_date"])
        for b in breaks_window:
            if _breaks_module.break_applies_to(b, u):
                accounted_dates |= _days_overlap(b["start_date"], b["end_date"])
        # Clamp the span to the member's employment window (28 Sep 2026
        # payroll fix): days before joining_date / after leaving_date are
        # neither worked nor weekly-off, so counting them as Absent — and
        # in the attendance-% denominator — inflated absences for mid-month
        # joiners/leavers and disagreed with the Grid's NJ/LF cells (which
        # already exclude them). `_jd`/`_ld` are set above for the late
        # filter; reuse them here.
        m_sd, m_ed = sd, ed
        if _jd:
            try:
                _jdd = date.fromisoformat(_jd)
                if _jdd > m_sd:
                    m_sd = _jdd
            except ValueError:
                pass
        if _ld:
            try:
                _ldd = date.fromisoformat(_ld)
                if _ldd < m_ed:
                    m_ed = _ldd
            except ValueError:
                pass
        m_sd_iso, m_ed_iso = m_sd.isoformat(), m_ed.isoformat()
        span_days_m = ((m_ed - m_sd).days + 1) if m_sd <= m_ed else 0
        # Unworked weekly-off days WITHIN the employment window (worked
        # ones are already in `days_present` and earn comp-off via
        # `_comp_off_earned`). Skip days already covered by leave/tour/
        # break/comp-off so we don't double-count them into `days_off`.
        # Default to Monday when no weekly_off is stamped.
        wo_name = (u.get("weekly_off") or "monday").lower()
        unworked_weekly_offs = 0
        weekly_off_dates: set = set()
        if wo_name in WEEKDAY_NAME and span_days_m > 0:
            wo_idx = WEEKDAY_NAME.index(wo_name)
            cur = m_sd
            while cur <= m_ed:
                if cur.weekday() == wo_idx and cur.isoformat() not in accounted_dates:
                    unworked_weekly_offs += 1
                    weekly_off_dates.add(cur.isoformat())
                cur += timedelta(days=1)
        # In-progress current day — exclude from absent count until the
        # day has ended (avoids "everyone is absent" first-thing-in-the-
        # morning noise). Only when the window ends today AND today falls
        # inside the member's employment window AND isn't already accounted.
        in_progress_today = 1 if (
            end_is_today and span_days_m > 0
            and m_sd_iso <= today_iso <= m_ed_iso
            and today_iso not in accounted_dates
        ) else 0
        off_dates = set(weekly_off_dates)
        if in_progress_today:
            off_dates.add(today_iso)
        # len(set) — today can be BOTH the in-progress day and an unworked
        # weekly off (e.g. running the report on a Monday); the set dedupes
        # so days_off always equals len(dates_off).
        days_off = len(off_dates)
        # Accounted days that actually fall inside the employment window,
        # so a leave that spills past leaving_date can't drive absent < 0
        # or shrink the workable span incorrectly.
        accounted_in_window = {d for d in accounted_dates if m_sd_iso <= d <= m_ed_iso}
        days_absent = max(0, span_days_m - len(accounted_in_window) - days_off)
        # Absent-date set: enumerate the EMPLOYMENT window and exclude
        # accounted + off. Feeds the drill-down tooltip.
        absent_dates: set = set()
        if span_days_m > 0:
            cur = m_sd
            while cur <= m_ed:
                iso_ = cur.isoformat()
                if iso_ not in accounted_dates and iso_ not in off_dates:
                    absent_dates.add(iso_)
                cur += timedelta(days=1)
        # Cap at days_absent — invariant guard should keep them equal
        # but a defensive slice makes UI display predictable.
        absent_dates_list = sorted(absent_dates)[:days_absent]
        # Attendance-% uses the workable span within employment (excludes
        # weekly-off days + the in-progress day). 0% when the member wasn't
        # employed at all during the window.
        workable_span = span_days_m - days_off
        attendance_pct = round((days_present / workable_span) * 100, 1) if workable_span > 0 else 0.0
        rows.append({
            "member_id": u["id"],
            "member_name": u["full_name"],
            "category": u["category"],
            "hourly_wager": bool(u.get("hourly_wager")),
            "rank": u.get("rank"),
            "weekly_off": u.get("weekly_off") or "monday",
            "fleet": u.get("fleet"),
            "leaving_date": u.get("leaving_date"),
            "total_hours": total_hours,
            "days_present": days_present,
            "late_days": late_days,
            "days_leave": days_leave,
            "days_tour": days_tour,
            "days_break": days_break,
            "days_absent": days_absent,
            "days_accounted": len(accounted_in_window),
            "days_not_employed": max(0, span_days - span_days_m),
            "days_on_leave": days_on_leave,
            "days_off": days_off,
            "overstays": overstays,
            "overtime_hours_approved": round(approved_ot_min / 60.0, 2),
            "overtime_hours_pending": round(pending_ot_min / 60.0, 2),
            # Overtime "Served" = sum of all OT minutes recorded on any
            # attendance row within the window, regardless of status
            # (7 Jul 2026 — drives the Attendance table's Overtime · Served
            # column). Rejected OT is still time-served, so it's included.
            "overtime_hours_served": round(
                sum(_session_ot_minutes(u, s) for s in sessions) / 60.0, 2
            ),
            "comp_off_earned": co_earned,
            "comp_off_used": co_used,
            "comp_off_pending": co_pending,
            # Comp-Off "Applied" = distinct calendar days across pending
            # comp-off leaves overlapping the window (7 Jul 2026 — drives
            # the Comp-Off · Applied column).
            "comp_off_applied": len({
                d for lv in pending_comp_off_by_user.get(u["id"], [])
                for d in _days_overlap(lv["start_date"], lv["end_date"])
            }),
            # 7 Jul 2026 user-requested extras — surface data that
            # already existed on the row but wasn't rendered.
            "half_days": half_days_by_user.get(u["id"], 0),
            "avg_hours_per_day": round(total_hours / max(1, days_present), 2) if days_present else 0,
            "escort_days": len(escort_days_by_user.get(u["id"], set())),
            # Date arrays for the drill-down tooltip (7 Jul 2026 —
            # user-requested "click a number to see why"). Sent inline
            # on the row since they're small (0-31 items each). The
            # frontend renders them as native `title` tooltips on the
            # relevant cells.
            "dates_present": sorted(present_dates),
            "dates_off": sorted(off_dates),
            "dates_absent": absent_dates_list,
            "dates_late": sorted(late_dates),
            "dates_leave": sorted(leave_dates),
            "dates_tour": sorted(tour_dates),
            "dates_break": sorted(break_dates),
            "dates_half_day": sorted(half_day_dates_by_user.get(u["id"], set())),
            "dates_comp_off_used": sorted(comp_off_used_dates),
            "dates_comp_off_applied": sorted({
                d for lv in pending_comp_off_by_user.get(u["id"], [])
                for d in _days_overlap(lv["start_date"], lv["end_date"])
            }),
            "dates_escort": sorted(escort_days_by_user.get(u["id"], set())),
            "dates_overtime_served": sorted({
                s["date"] for s in sessions
                if _session_ot_minutes(u, s) > 0
            }),
            # 15 Feb 2026: OT no longer has an approval workflow, so
            # applied/approved buckets are now aliases of served. Kept
            # as keys for frontend backward-compat.
            "dates_overtime_applied": [],
            "dates_overtime_approved": sorted({
                s["date"] for s in sessions
                if _session_ot_minutes(u, s) > 0
            }),
            "dates_comp_off_earned": sorted({
                s["date"] for s in sessions
                if wo_name in WEEKDAY_NAME
                and date.fromisoformat(s["date"]).weekday() == WEEKDAY_NAME.index(wo_name)
            }),
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
# API service tokens (read-only PATs) — admin-issued, non-expiring, for
# background/programmatic GET access. Secret shown once; only a hash stored.
# ----------------------------------------------------------------------------
@api_router.post("/auth/service-token")
async def create_service_token(admin: dict = Depends(require_admin)):
    raw = await _svc_create(db, admin["id"], JWT_SECRET)
    return {
        "token": raw,
        "warning": "Copy this now — it is shown only once and cannot be retrieved again.",
    }


@api_router.get("/auth/service-token")
async def get_service_token_status(admin: dict = Depends(require_admin)):
    doc = await _svc_status(db)
    if not doc:
        return {"exists": False}
    return {
        "exists": True,
        "last4": doc.get("last4"),
        "prefix": doc.get("prefix"),
        "created_at": doc.get("created_at"),
        "last_used_at": doc.get("last_used_at"),
    }


@api_router.delete("/auth/service-token")
async def delete_service_token(admin: dict = Depends(require_admin)):
    n = await _svc_revoke(db)
    return {"revoked": n > 0}


# ----------------------------------------------------------------------------
app.include_router(api_router)

# Member management routes — included right after api_router to keep route priority unchanged.
from routes.members import make_router as _members_router
app.include_router(_members_router(
    db, get_current_user, require_admin, optional_user, valid_grid_key,
    valid_members_api_token, _bearer_from_header, _last10_digits,
    _payroll_bucket, _iso_week_key,
))

# Attendance read-only routes (phase 1 of the attendance split).
from routes.attendance import make_router as _attendance_router
app.include_router(_attendance_router(db, get_current_user, require_admin))
from routes.live_events import make_router as _live_events_router
app.include_router(_live_events_router(db, JWT_SECRET, JWT_ALGO))
from routes.attendance_actions import make_router as _attendance_actions_router
app.include_router(_attendance_actions_router(
    db, get_current_user, require_admin, open_session_for, _late_days_in_month,
    _resolve_site_for, _cancel_stale_missed_checkin, _has_checkin_today,
    _active_camp_for, _ensure_reason_in_bank,
))

# Auth + device-approval — split out 06/2026 during the server.py refactor.
from routes.auth import make_router as _auth_router
app.include_router(_auth_router(
    db, require_admin, get_current_user,
    verify_password, hash_password, create_token,
    JWT_SECRET, JWT_ALGO, DEVICE_TOKEN_MINUTES,
))

# Office config + changelog — split out 06/2026.
from routes.office import make_router as _office_router
app.include_router(_office_router(
    db, require_admin, get_current_user, _send_checkout_reminders, OfficeConfig,
))

# Institutions + Fleets master CRUD — split out 06/2026.
from routes.masters import make_router as _masters_router
app.include_router(_masters_router(db, require_admin, get_current_user))

# Satellite-site geofences (e.g. Rowing Academy) — added 28 Jun 2026.
from routes.sites import make_router as _sites_router
app.include_router(_sites_router(db, require_admin, get_current_user))

# Muster — bulk check-in/out for coaches, admins, and active escorts.
from routes.muster import make_router as _muster_router
app.include_router(_muster_router(db, get_current_user, _active_camp_for, _resolve_site_for))

from routes.notify import make_router as _notify_router
app.include_router(_notify_router(db, get_current_user, require_admin))

# Admin tooling (wipe / backup / restore / preflight / summary / activity).
from routes.admin_tools import make_router as _admin_tools_router
app.include_router(_admin_tools_router(db, require_admin))

# Platform-cron endpoints (daily auto-backup). Secured by WEBHOOK_CRON_SECRET.
from routes.cron import make_router as _cron_router
app.include_router(_cron_router(db))# Admin audit log — one row per admin-mutating action (member edits,
# leave-balance changes, retroactive attendance overrides, etc.).
# Read endpoint: GET /api/admin/audit-log.
from routes.admin_audit import make_router as _audit_router, write_audit
app.include_router(_audit_router(db, require_admin))

# Check-in approvals queue + unified approvals summary (8 Jul 2026).
from routes.checkin_approvals import make_router as _checkin_approvals_router
app.include_router(_checkin_approvals_router(db, require_admin, write_audit))

from routes.id_docs import make_router as _id_docs_router
app.include_router(_id_docs_router(db, require_admin))
from routes.education import make_router as _education_router
app.include_router(_education_router(db, require_admin))
from routes.dar import make_router as _dar_router
app.include_router(_dar_router(db, get_current_user, require_admin, valid_grid_key, write_audit))

from routes.tasks import make_router as _tasks_router
app.include_router(_tasks_router(db, get_current_user, require_admin, write_audit))

from routes.rules import make_router as _rules_router
app.include_router(_rules_router(db, get_current_user, require_admin, write_audit))
from routes.suggestions import make_router as _suggestions_router
app.include_router(_suggestions_router(db, get_current_user, require_admin, write_audit))

# Data-quality dashboard — read-only DB sweep for dupes, missing
# fields, and structural inconsistencies.
from routes.data_quality import make_router as _data_quality_router
app.include_router(_data_quality_router(db, require_admin))

# Feature usage & ageing (Jun 2026) — tracks which sidebar pages are
# used and when, so admins can retire dormant screens. Any user pings;
# super-admin reads. See routes/usage.py.
from routes.usage import make_router as _usage_router
app.include_router(_usage_router(db, get_current_user, require_admin))

# Daily leave/tour WhatsApp report — once-a-day admin nudge + posted lock.
from routes.leave_report import make_router as _leave_report_router
app.include_router(_leave_report_router(db, require_admin))

# Attendance dedupe / repair tool (Jun 2026) — one-check-in-per-day cleanup.
from routes.attendance_repair import make_router as _attendance_repair_router
app.include_router(_attendance_repair_router(db, require_admin))

# Single-glance admin dashboard (GET /api/admin/dashboard) — aggregates
# Now / This week / This month / Attention widgets in one payload.
from routes.dashboard import make_router as _dashboard_router
app.include_router(_dashboard_router(db, require_admin))

# Chef's View (GET /api/admin/meals-today) + Categories master read.
from routes.meals import make_router as _meals_router
_meals = _meals_router(db, require_admin, get_current_user, require_chef_or_admin, write_audit)
app.include_router(_meals)

from routes.recipes import make_router as _recipes_router
app.include_router(_recipes_router(db, require_admin, get_current_user, require_chef_or_admin))

# Presence + row-focus (Feb 2026). Reuses the meals SSE channel so
# peer tabs learn about focus changes on the same channel they already
# subscribe to.
from routes.presence import make_router as _presence_router
_signal_meals_fn = getattr(_meals, "_signal_meals_ref", [None])[0] or (lambda *a, **k: None)
app.include_router(_presence_router(require_chef_or_admin, _signal_meals_fn))

# Presence Board (GET /api/presence) — the live/historical roster view
# (Refactor #5, 12 Oct 2026; read-only, split out of server.py).
from routes.presence_board import make_router as _presence_board_router
app.include_router(_presence_board_router(db, get_current_user))

from routes.roles import make_router as _roles_router
app.include_router(_roles_router(db, require_admin, get_current_user))

from routes.prefs import make_router as _prefs_router
app.include_router(_prefs_router(db, get_current_user))

# Help chat — Claude-powered assistant for the bottom-right widget.
# Injects the user's own attendance snapshot into every turn so
# questions like "how many late days do I have this year?" can be
# answered without tool-calling.
from routes.help_chat import make_router as _help_chat_router
app.include_router(_help_chat_router(db, get_current_user, _profile_details_for))

# Leave / Tour routes — split out 06/2026 during the server.py refactor.
from routes.leaves import make_router as _leaves_router
from holidays import (
    compute_comp_off_balance as _compute_comp_off_balance,
    compute_balance_summary as _compute_balance_summary,
    split_leave_days as _split_leave_days,
)
_leaves = _leaves_router(
    db, require_admin, get_current_user,
    _compute_comp_off_balance, _compute_balance_summary, _split_leave_days,
)
app.include_router(_leaves)
# Routes/reports needs enrich_leaves; the leaves router exposes it as an
# attribute for re-use without re-implementing.
enrich_leaves = _leaves.enrich_leaves  # type: ignore[attr-defined]

# Reports — heavy aggregation lives in `compute_hours_report` (still in
# server.py for now); the router file owns the HTTP shape + exports.
from routes.reports import make_router as _reports_router
_reports_router_instance = _reports_router(
    db, require_admin, get_current_user, compute_hours_report, enrich_leaves,
)
# Reach the month-grid engine from the PayCraft /leave-balances feed so its
# LOP figure is the exact same number the grid shows (see list_leave_balances).
_GRID_IMPL = _reports_router_instance.grid_impl
app.include_router(_reports_router_instance)

from routes.profile_attendance import make_router as _profile_attendance_router
app.include_router(_profile_attendance_router(db, get_current_user, require_admin, _GRID_IMPL))

# Corrections facility — member-raised after-the-fact fixes to attendance
# and leave rows, admin-approved. See routes/corrections.py for the full
# design and the applier dispatch table.
from routes.corrections import make_router as _corrections_router
app.include_router(_corrections_router(db, require_admin, get_current_user, write_audit))

# Escorts — separate entity (not employees) tracked under institutions.
# Owns CRUD, daily attendance, temp-exit, and 30-day photo retention.
from routes.escorts import make_router as _escorts_router
app.include_router(_escorts_router(
    db, require_admin, get_current_user, require_coach_or_admin,
))

# Daily bilingual content (motivational quote / English-Telugu word-of-the-day)
# generated once per day with Gemini and cached in MongoDB.
from daily_content import make_router as _daily_router
app.include_router(_daily_router(db))

# Guest check-in / check-out (coaches + admins).
from guests import make_router as _guests_router
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

# Holidays — public-holiday master list. Drives comp-off accrual: any
# attendance on a holiday OR the member's weekly_off accrues +1 comp-off
# credit. Holidays and Breaks are managed separately (no auto-create).
from holidays import make_router as _holidays_router
app.include_router(_holidays_router(db, require_admin, get_current_user))


# Twilio SMS + Voice — parent notifications, per-institution sender numbers.
from sms import make_router as _sms_router
app.include_router(_sms_router(db, require_admin))


# External (server-to-server) read-only API for the Inventory app.
# Guarded by X-API-Key header — see routes/external.py. Feb 2026.
from routes.external import make_router as _external_router
app.include_router(_external_router(db))


# Lightweight keep-alive endpoint — no auth, no DB hit. Plug an UptimeRobot
# (or similar) ping into https://i-showed-up.ychyderabad.com/api/health every
# 5-10 minutes to prevent any idle-container cold-starts during morning peak.
@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "i-showed-up"}


# Trusted embed origins (PayCraft now, ychyderabad domain later) — read
# from env so the SAME build works in preview and production. Used both
# for CORS (below) and the Content-Security-Policy frame-ancestors header.
_EMBED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_EMBED_ORIGINS", "").split(",") if o.strip()]
_FRAME_ANCESTORS = "frame-ancestors 'self'" + ("" if not _EMBED_ORIGINS else " " + " ".join(_EMBED_ORIGINS))

# Request-ID/access log, read-only svc_ tokens, client-id, cache + frame
# headers — one pure-ASGI layer (see services/http_middleware.py).
from services.http_middleware import AppHttpMiddleware
app.add_middleware(AppHttpMiddleware, frame_ancestors=_FRAME_ANCESTORS)

# GZip compression — cuts JSON payload sizes ~70% for typical text-heavy
# responses like /api/members and /api/presence (which include lots of
# repeated field names). `minimum_size=500` avoids compressing tiny
# heartbeat responses where the compression overhead would exceed the
# win. Browsers send `Accept-Encoding: gzip` automatically.
from fastapi.middleware.gzip import GZipMiddleware
app.add_middleware(GZipMiddleware, minimum_size=500)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=False,
    allow_origins=(
        ["*"] if "*" in [o.strip() for o in os.environ.get("CORS_ORIGINS", "*").split(",") if o.strip()]
        else (list(dict.fromkeys(
            [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()] + _EMBED_ORIGINS
        )) or ["*"])
    ),
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Request-ID"],
)
