from fastapi import FastAPI, APIRouter, HTTPException, Depends, status
from fastapi.responses import Response
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from fastapi.security import OAuth2PasswordBearer
import os
import io
import csv
import math
import uuid
import logging
import bcrypt
import jwt
from pathlib import Path
from pydantic import BaseModel, Field, EmailStr
from typing import List, Optional, Literal
from datetime import datetime, timezone, timedelta, date

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
# Security helpers
# ----------------------------------------------------------------------------
def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def create_token(user_id: str, role: str) -> str:
    payload = {
        "sub": user_id,
        "role": role,
        "exp": now_utc() + timedelta(minutes=JWT_EXPIRES_MINUTES),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


async def get_current_user(token: str = Depends(oauth2_scheme)) -> dict:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
        user_id = payload.get("sub")
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token has expired")
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Could not validate token")
    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


async def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin privileges required")
    return user


# ----------------------------------------------------------------------------
# Models
# ----------------------------------------------------------------------------
class LoginIn(BaseModel):
    email: EmailStr
    password: str


class UserPublic(BaseModel):
    id: str
    email: EmailStr
    full_name: str
    role: str
    category: str
    rank: Optional[str] = None
    photo: Optional[str] = None


class MemberCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=4)
    full_name: str
    category: Literal["sailor", "staff", "coach"] = "sailor"
    rank: Optional[str] = None
    role: Literal["admin", "member"] = "member"


class MemberUpdate(BaseModel):
    full_name: Optional[str] = None
    category: Optional[Literal["sailor", "staff", "coach"]] = None
    rank: Optional[str] = None
    photo: Optional[str] = None
    password: Optional[str] = None


class OfficeConfig(BaseModel):
    name: str = "Campus Office"
    latitude: float = 0.0
    longitude: float = 0.0
    radius_m: int = 100


class CheckInIn(BaseModel):
    qr_token: str
    latitude: float
    longitude: float
    photo: Optional[str] = None  # base64
    reason: Optional[str] = None  # required when outside geofence


class ScanCardIn(BaseModel):
    personal_qr: str
    latitude: float
    longitude: float
    photo: Optional[str] = None
    reason: Optional[str] = None


class LeaveCreate(BaseModel):
    type: Literal["leave", "tour"]
    start_date: str  # YYYY-MM-DD
    end_date: str
    reason: str
    location: Optional[str] = None  # for tour


class LeaveDecision(BaseModel):
    status: Literal["approved", "rejected"]


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


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()


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
        "photo": None,
        "personal_qr": "CARD-" + uuid.uuid4().hex[:12].upper(),
        "hashed_password": hash_password(body.password),
        "created_at": now_utc().isoformat(),
    }
    await db.users.insert_one(doc)
    return UserPublic(**{k: doc.get(k) for k in UserPublic.model_fields})


@api_router.get("/members", response_model=List[UserPublic])
async def list_members(user: dict = Depends(get_current_user)):
    users = await db.users.find({}, {"_id": 0}).sort("full_name", 1).to_list(2000)
    return [UserPublic(**{k: u.get(k) for k in UserPublic.model_fields}) for u in users]


@api_router.patch("/members/{member_id}", response_model=UserPublic)
async def update_member(member_id: str, body: MemberUpdate, admin: dict = Depends(require_admin)):
    update = {k: v for k, v in body.model_dump().items() if v is not None and k != "password"}
    if body.password:
        update["hashed_password"] = hash_password(body.password)
    if update:
        await db.users.update_one({"id": member_id}, {"$set": update})
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


@api_router.post("/members/me/photo", response_model=UserPublic)
async def set_my_photo(body: dict, user: dict = Depends(get_current_user)):
    photo = body.get("photo")
    await db.users.update_one({"id": user["id"]}, {"$set": {"photo": photo}})
    u = await db.users.find_one({"id": user["id"]}, {"_id": 0})
    return UserPublic(**{k: u.get(k) for k in UserPublic.model_fields})


# ----------------------------------------------------------------------------
# Attendance: check-in / check-out
# ----------------------------------------------------------------------------
async def open_session_for(user_id: str) -> Optional[dict]:
    return await db.attendance.find_one({"user_id": user_id, "check_out_at": None}, {"_id": 0})


@api_router.get("/attendance/status")
async def my_attendance_status(user: dict = Depends(get_current_user)):
    sess = await open_session_for(user["id"])
    return {"checked_in": sess is not None, "session": sess}


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
    if sess:
        cin = datetime.fromisoformat(sess["check_in_at"])
        hours = round((ts - cin).total_seconds() / 3600.0, 2)
        await db.attendance.update_one({"id": sess["id"]}, {"$set": {
            "check_out_at": ts.isoformat(),
            "check_out_photo": photo,
            "hours": hours,
            "exit_latitude": lat,
            "exit_longitude": lng,
            "exit_distance_m": dist,
            "exit_out_of_geofence": out,
            "exit_reason": (reason or None),
            "checked_out_by": scanned_by,
        }})
        return {"ok": True, "action": "checkout", "member": target["full_name"],
                "hours": hours, "out_of_geofence": out}
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": target["id"],
        "date": ts.date().isoformat(),
        "check_in_at": ts.isoformat(),
        "check_out_at": None,
        "check_in_photo": photo,
        "check_out_photo": None,
        "hours": None,
        "latitude": lat,
        "longitude": lng,
        "distance_m": dist,
        "out_of_geofence": out,
        "geo_reason": (reason or None),
        "method": method,
        "checked_in_by": scanned_by,
    }
    await db.attendance.insert_one(doc)
    return {"ok": True, "action": "checkin", "member": target["full_name"], "out_of_geofence": out}


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


@api_router.post("/attendance/scan-card")
async def scan_card(body: ScanCardIn, user: dict = Depends(get_current_user)):
    """Proxy check-in/out for a person without a phone, via their personal QR card.
    Scanned by anyone with the app. Auto-toggles the carded member's session."""
    office = await db.config.find_one({"id": "office"})
    if not office:
        raise HTTPException(status_code=500, detail="Office not configured")
    target = await db.users.find_one({"personal_qr": body.personal_qr}, {"_id": 0})
    if not target:
        raise HTTPException(status_code=404, detail="Card not recognised — unknown member")
    res = await perform_toggle(target, office, body.latitude, body.longitude,
                               body.photo, body.reason, "card", user["id"])
    res["proxy"] = True
    return res


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
    today = now_utc().date().isoformat()
    users = await db.users.find({}, {"_id": 0}).sort("full_name", 1).to_list(2000)
    result = []
    for u in users:
        sess = await open_session_for(u["id"])
        leave = await active_leave_for(u["id"], today)
        if leave and leave["type"] == "tour":
            status_v = "on_tour"
            detail = leave.get("location") or "On tour"
            since = leave["start_date"]
            photo = u.get("photo")
        elif leave and leave["type"] == "leave":
            status_v = "on_leave"
            detail = f"Till {leave['end_date']}"
            since = leave["start_date"]
            photo = u.get("photo")
        elif sess:
            status_v = "on_campus"
            detail = "Since " + datetime.fromisoformat(sess["check_in_at"]).strftime("%H:%M")
            since = sess["check_in_at"]
            photo = sess.get("check_in_photo") or u.get("photo")
        else:
            last = await db.attendance.find_one(
                {"user_id": u["id"], "check_out_at": {"$ne": None}},
                {"_id": 0}, sort=[("check_out_at", -1)],
            )
            status_v = "exited"
            if last:
                detail = "Left " + datetime.fromisoformat(last["check_out_at"]).strftime("%H:%M")
                since = last["check_out_at"]
                photo = last.get("check_out_photo") or u.get("photo")
            else:
                detail = "Not on campus"
                since = None
                photo = u.get("photo")
        result.append({
            "id": u["id"],
            "full_name": u["full_name"],
            "role": u["role"],
            "category": u["category"],
            "rank": u.get("rank"),
            "status": status_v,
            "detail": detail,
            "since": since,
            "photo": photo,
            "flagged": bool(sess and sess.get("out_of_geofence") and status_v == "on_campus"),
        })
    order = {"on_campus": 0, "on_tour": 1, "on_leave": 2, "exited": 3}
    result.sort(key=lambda r: (order.get(r["status"], 9), r["full_name"]))
    counts = {"on_campus": 0, "exited": 0, "on_tour": 0, "on_leave": 0, "total": len(result)}
    for r in result:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    return {"members": result, "counts": counts, "date": today}


# ----------------------------------------------------------------------------
# Leave / Tour
# ----------------------------------------------------------------------------
@api_router.post("/leaves")
async def create_leave(body: LeaveCreate, user: dict = Depends(get_current_user)):
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user["id"],
        "type": body.type,
        "start_date": body.start_date,
        "end_date": body.end_date,
        "reason": body.reason,
        "location": body.location,
        "status": "pending",
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
    if status_filter:
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
    today = now_utc().date()
    week_start = (today - timedelta(days=today.weekday())).isoformat()
    month_start = today.replace(day=1).isoformat()
    sessions = await db.attendance.find(
        {"user_id": user["id"], "hours": {"$ne": None}}, {"_id": 0}
    ).sort("check_in_at", -1).to_list(500)
    week_hours = round(sum((s["hours"] or 0) for s in sessions if s["date"] >= week_start), 2)
    month_hours = round(sum((s["hours"] or 0) for s in sessions if s["date"] >= month_start), 2)
    days_this_week = len({s["date"] for s in sessions if s["date"] >= week_start})
    open_sess = await open_session_for(user["id"])
    pending_leaves = await db.leaves.count_documents({"user_id": user["id"], "status": "pending"})
    recent = sessions[:10]
    return {
        "week_hours": week_hours,
        "month_hours": month_hours,
        "days_this_week": days_this_week,
        "checked_in": open_sess is not None,
        "open_session": open_sess,
        "pending_leaves": pending_leaves,
        "recent": recent,
    }


# ----------------------------------------------------------------------------
# Admin dashboard summary
# ----------------------------------------------------------------------------
@api_router.get("/admin/summary")
async def admin_summary(admin: dict = Depends(require_admin)):
    today = now_utc().date().isoformat()
    total_members = await db.users.count_documents({})
    on_campus = await db.attendance.count_documents({"check_out_at": None})
    pending_leaves = await db.leaves.count_documents({"status": "pending"})
    on_leave_tour = await db.leaves.count_documents({
        "status": "approved",
        "start_date": {"$lte": today},
        "end_date": {"$gte": today},
    })
    return {
        "total_members": total_members,
        "on_campus": on_campus,
        "pending_leaves": pending_leaves,
        "on_leave_tour": on_leave_tour,
    }


# ----------------------------------------------------------------------------
# Reports
# ----------------------------------------------------------------------------
async def compute_hours_report(start: str, end: str) -> List[dict]:
    """Aggregate hours and days present per member between dates inclusive."""
    users = await db.users.find({}, {"_id": 0}).sort("full_name", 1).to_list(2000)
    rows = []
    # number of days in range
    sd = date.fromisoformat(start)
    ed = date.fromisoformat(end)
    span_days = max(1, (ed - sd).days + 1)
    for u in users:
        sessions = await db.attendance.find({
            "user_id": u["id"],
            "date": {"$gte": start, "$lte": end},
            "hours": {"$ne": None},
        }, {"_id": 0}).to_list(2000)
        total_hours = round(sum(s.get("hours") or 0 for s in sessions), 2)
        days_present = len({s["date"] for s in sessions})
        attendance_pct = round((days_present / span_days) * 100, 1)
        rows.append({
            "member_id": u["id"],
            "member_name": u["full_name"],
            "category": u["category"],
            "rank": u.get("rank"),
            "total_hours": total_hours,
            "days_present": days_present,
            "span_days": span_days,
            "attendance_pct": attendance_pct,
        })
    return rows


@api_router.get("/reports/hours")
async def hours_report(start: str, end: str, admin: dict = Depends(require_admin)):
    rows = await compute_hours_report(start, end)
    return {"start": start, "end": end, "rows": rows}


@api_router.get("/reports/daily")
async def daily_report(on: Optional[str] = None, user: dict = Depends(get_current_user)):
    """Daily leave & tour report for a given date (default today)."""
    on = on or now_utc().date().isoformat()
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
    headers = ["Name", "Category", "Rank", "Hours", "Days Present", "Attendance %"]
    table = [[r["member_name"], r["category"], r.get("rank") or "-", r["total_hours"],
              r["days_present"], f"{r['attendance_pct']}%"] for r in rows]
    if fmt == "pdf":
        pdf = _pdf_from_table("Attendance & Hours Report", headers, table, f"{start} to {end}")
        return Response(content=pdf, media_type="application/pdf",
                        headers={"Content-Disposition": f"attachment; filename=hours_{start}_{end}.pdf"})
    return _csv_response(headers, table, f"hours_{start}_{end}.csv")


@api_router.get("/reports/daily/export")
async def export_daily(on: Optional[str] = None, fmt: str = "csv", user: dict = Depends(get_current_user)):
    on = on or now_utc().date().isoformat()
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

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
