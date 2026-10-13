"""Member management routes (admin CRUD, archive/delete, import, cards, photos).
Moved out of server.py (Oct 2026) — paths and behaviour unchanged."""
from __future__ import annotations

import io
import re
import uuid
from datetime import date
from typing import Any, Dict, List, Literal, Optional

import openpyxl
from fastapi import APIRouter, Depends, File, Header, HTTPException, UploadFile
from fastapi.responses import Response
from openpyxl.utils import get_column_letter
from pydantic import BaseModel, EmailStr, Field

from models import UserPublic
from parents_import_utils import (
    norm_name as _norm_name,
    fuzzy_score as _fuzzy_score,
    norm_mobile as _norm_mobile,
    clean_name as _clean_name,
)
from routes.admin_audit import write_audit
from services.auth_utils import hash_password
from services.permissions import is_super_admin
from services.phone import phone_key
from services.member_validation import validate_member
from services.photo import check_photo_size as _check_photo_size, make_thumbnail as _make_thumbnail, member_photo_url
from services.time_utils import local_date_str, local_now, now_utc

import logging

logger = logging.getLogger("server")

SEEDED_CATEGORIES = {"athlete", "elite", "staff", "coach", "executive"}

class MemberCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=4)
    full_name: str
    given_name: Optional[str] = None
    surname: Optional[str] = None
    category: str = "athlete"
    rank: Optional[str] = None
    mobile: Optional[str] = None
    work_start: Optional[str] = None
    work_end: Optional[str] = None
    # Per-day-of-week timing override for THIS member (employees only).
    # Shape { "sat": {"start":"08:00","end":"12:00"}, ... } keyed mon..sun;
    # a blank/missing day inherits. Overrides the office-level dow_hours.
    dow_hours: Optional[Dict[str, Dict[str, Any]]] = None
    role: Literal["admin", "member", "chef"] = "member"
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
    blood_group: Optional[str] = None
    address: Optional[str] = None
    emergency_contact_name: Optional[str] = None
    emergency_contact_phone: Optional[str] = None
    school_class: Optional[str] = None
    medical_notes: Optional[str] = None
    # ISO YYYY-MM-DD. Optional — powers the "Happy birthday" flourish
    # on the Check-In greeting (added 7 Jul 2026).
    date_of_birth: Optional[str] = None
    # ISO YYYY-MM-DD of the day the member joined the academy /
    # started their contract. Grid renders pre-joining days as "NJ"
    # (Not Joined) so they don't count as absent. Optional — legacy
    # rows without a joining_date behave as before (no NJ cells).
    # Added 14 Feb 2026 (user request).
    joining_date: Optional[str] = None
    # ISO YYYY-MM-DD of the day the member exited the academy. Grid
    # renders post-leaving days as "LF" (Left) so they don't count as
    # absent for a member who has moved on. Optional. Added 14 Feb 2026.
    leaving_date: Optional[str] = None
    # OT-eligible flag (7 Jul 2026). Explicit `False` disables OT
    # accrual for this member regardless of category. `None` / `True`
    # → the pre-existing category-based rule applies (staff/coach/
    # executive accrue, athletes never do).
    ot_eligible: Optional[bool] = None
    dar_exempt: Optional[bool] = None
    dar_required: Optional[bool] = None
    # Hourly-wager flag (Jun 2026). When True, the member is paid purely
    # for hours actually worked (check-in → check-out), fed to payroll via
    # the OT channel rounded to the nearest half hour. They accrue no
    # standard early-in/late-out OT and get no leave / weekly-off pay.
    hourly_wager: Optional[bool] = None
    # 20 Feb 2026 chef request: allow per-member override of the
    # category-level `meal_eligible` flag so edge cases (e.g. a driver
    # who never eats mess) don't require creating a whole new category.
    # `None` (default) means "inherit from category"; explicit `True`
    # or `False` overrides. Roster and mark-bulk both consult this
    # field before falling back to the category master.
    meal_eligible: Optional[bool] = None


class MemberUpdate(BaseModel):
    full_name: Optional[str] = None
    given_name: Optional[str] = None
    surname: Optional[str] = None
    email: Optional[str] = None
    category: Optional[str] = None
    rank: Optional[str] = None
    mobile: Optional[str] = None
    work_start: Optional[str] = None
    work_end: Optional[str] = None
    dow_hours: Optional[Dict[str, Dict[str, Any]]] = None
    photo: Optional[str] = None
    password: Optional[str] = None
    role: Optional[Literal["admin", "member", "chef"]] = None
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
    blood_group: Optional[str] = None
    address: Optional[str] = None
    emergency_contact_name: Optional[str] = None
    emergency_contact_phone: Optional[str] = None
    school_class: Optional[str] = None
    medical_notes: Optional[str] = None
    date_of_birth: Optional[str] = None
    joining_date: Optional[str] = None
    leaving_date: Optional[str] = None
    ot_eligible: Optional[bool] = None
    dar_exempt: Optional[bool] = None
    dar_required: Optional[bool] = None
    # See the note on MemberCreate.hourly_wager.
    hourly_wager: Optional[bool] = None
    # Per-member override — see the note on MemberIn.meal_eligible.
    meal_eligible: Optional[bool] = None


# Bulk admin edit on the Members page: cohort-level fields applied to many
# members in one network round-trip. The allowlist is deliberately narrow —
# fields like `full_name`, `mobile`, `email`, `photo`, `password`, and
# `leave_balance_opening` are per-individual and never make sense in bulk.
BULK_MEMBER_ALLOWED_FIELDS = {"category", "role", "institution", "fleet", "weekly_off", "gender"}


class BulkMemberUpdateIn(BaseModel):
    member_ids: List[str]
    updates: MemberUpdate



def make_router(db, get_current_user, require_admin, optional_user, valid_grid_key,
                valid_members_api_token, _bearer_from_header, _last10_digits,
                _payroll_bucket, _iso_week_key) -> APIRouter:
    router = APIRouter(prefix="/api")

    async def _resolve_category(key: str) -> dict:
        """Seeded keys map to themselves. A custom Masters category is kept in
        `custom_category` and the member follows staff rules (athlete rules if
        the category is athlete-like) — user rule, Oct 2026."""
        key = (key or "").strip().lower()
        if key in SEEDED_CATEGORIES:
            return {"category": key, "custom_category": None}
        cat = await db.categories.find_one({"key": key}, {"_id": 0, "is_athlete_like": 1})
        if not cat:
            raise HTTPException(status_code=400, detail=f"Unknown category '{key}' — add it in Masters → Categories first")
        return {"category": "athlete" if cat.get("is_athlete_like") else "staff", "custom_category": key}

    # ----------------------------------------------------------------------------
    # Member management (admin)
    # ----------------------------------------------------------------------------
    @router.post("/members", response_model=UserPublic)
    async def create_member(body: MemberCreate, force: bool = False, admin: dict = Depends(require_admin)):
        if await db.users.find_one({"email": body.email}):
            raise HTTPException(status_code=400, detail="Email already registered")
        # Data-entry guardrails (Oct 2026): catch bad mobiles / DOB / missing
        # parent contact at the source so they never reach the Data Quality sweep.
        is_ath = (body.category or "").lower() in ("athlete", "elite")
        errs, warns = validate_member(body.model_dump(), is_ath)
        if body.mobile and (body.mobile or "").strip():
            key = phone_key(body.mobile)
            if key and len(key) == 10 and await db.users.find_one(
                    {"mobile_last10": key, "archived": {"$ne": True}}, {"_id": 1}):
                errs.append("This mobile number is already used by another member")
        if (body.full_name or "").strip() and await db.users.find_one(
                {"full_name": body.full_name, "archived": {"$ne": True}}, {"_id": 1}):
            warns.append(f"Another member is already named '{body.full_name}'")
        if errs:
            raise HTTPException(status_code=400, detail=" • ".join(errs))
        if warns and not force:
            raise HTTPException(status_code=409, detail={"needs_confirm": True, "warnings": warns})
        doc = {
            "id": str(uuid.uuid4()),
            "email": body.email,
            "full_name": body.full_name,
            "given_name": body.given_name,
            "surname": body.surname,
            "role": body.role,
            "category": body.category,
            "rank": body.rank,
            "mobile": body.mobile,
            "mobile_last10": phone_key(body.mobile or "") or None,
            "work_start": body.work_start,
            "work_end": body.work_end,
            "dow_hours": body.dow_hours,
            "institution": body.institution,
            "gender": body.gender,
            "weekly_off": body.weekly_off,
            "father_mobile": body.father_mobile,
            "father_name": body.father_name,
            "mother_mobile": body.mother_mobile,
            "mother_name": body.mother_name,
            "guardian_mobile": body.guardian_mobile,
            "guardian_name": body.guardian_name,
            **{k: getattr(body, k) for k in ("blood_group", "address", "emergency_contact_name",
                                             "emergency_contact_phone", "school_class", "medical_notes")},
            "date_of_birth": body.date_of_birth,
            "joining_date": body.joining_date,
            "leaving_date": body.leaving_date,
            "ot_eligible": body.ot_eligible,
            "dar_exempt": body.dar_exempt,
            "dar_required": body.dar_required,
            "hourly_wager": body.hourly_wager,
            "photo": None,
            "personal_qr": "CARD-" + uuid.uuid4().hex[:12].upper(),
            "hashed_password": hash_password(body.password),
            "created_at": now_utc().isoformat(),
        }
        doc.update(await _resolve_category(body.category))
        await db.users.insert_one(doc)
        return UserPublic(**{k: doc.get(k) for k in UserPublic.model_fields})


    @router.get("/members")
    async def list_members(key: str = "", category: Optional[str] = None,
                           include_archived: bool = False,
                           authorization: Optional[str] = Header(default=None),
                           user: Optional[dict] = Depends(optional_user)):
        """List all members. For bandwidth reasons we emit a small photo URL
        (`/api/members/{id}/photo?v=X`) in place of the base64 payload — this
        keeps the JSON tiny (~30 KB vs ~450 KB), lets the browser cache the
        thumbnail independently, and only downloads photos that are actually
        scrolled into view. Callers needing the full original still fetch
        `/members/{id}` (admin) or `/members/{id}/card` (printable).

        Decorates each row with:
          - `last_seen_date`: ISO date of the member's most recent check-in
            (or None if they've never checked in).
          - `leave_balance_opening`: from the user doc, as-is.
          - `leave_balance_remaining`: opening − YTD-approved-leave-days.
        Two bulk aggregations keep this O(2) round trips regardless of roster size.
        """
        # PayCraft server-to-server mode: ?key=GRID_API_KEY → payroll-shaped
        # roster ({rows:[...]}), no user login required.
        if key:
            if not valid_grid_key(key):
                raise HTTPException(status_code=401, detail="Invalid key")
            office = await db.config.find_one(
                {"id": "office"}, {"_id": 0, "default_work_start": 1, "default_work_end": 1}) or {}
            roster = await db.users.find({"status": {"$ne": "left"}, "archived": {"$ne": True}}, {"_id": 0}).to_list(5000)
            roster = _payroll_bucket(roster, category)
            rows = [{
                "member_id": u.get("id"),
                "member_name": u.get("full_name"),
                "rank": u.get("rank"),
                "category": u.get("category"),
                "fleet": u.get("fleet"),
                "institution": u.get("institution"),
                "work_start": u.get("work_start") or office.get("default_work_start") or "09:00",
                "work_end": u.get("work_end") or office.get("default_work_end") or "17:00",
                "active": (u.get("leaving_date") is None) and (u.get("active", True) is not False),
            } for u in roster]
            rows.sort(key=lambda r: (r["member_name"] or "").lower())
            return {"rows": rows}
        # Athlete Health Dashboard server-to-server mode:
        # `Authorization: Bearer <MEMBERS_API_TOKEN>` → read-only roster with
        # parent/guardian contact numbers ONLY. Never exposes PIN, password,
        # or attendance data. Kept ABOVE the JWT check because the same
        # Authorization header would otherwise be parsed as a (failing) JWT.
        _svc_tok = _bearer_from_header(authorization)
        if _svc_tok and valid_members_api_token(_svc_tok):
            roster = await db.users.find(
                {"status": {"$ne": "left"}, "archived": {"$ne": True}},
                {"_id": 0, "id": 1, "full_name": 1, "category": 1, "mobile": 1,
                 "guardian_name": 1, "guardian_mobile": 1,
                 "mother_name": 1, "mother_mobile": 1,
                 "father_name": 1, "father_mobile": 1},
            ).sort("full_name", 1).to_list(5000)
            members = []
            for u in roster:
                g_ph = _last10_digits(u.get("guardian_mobile"))
                m_ph = _last10_digits(u.get("mother_mobile"))
                f_ph = _last10_digits(u.get("father_mobile"))
                self_ph = _last10_digits(u.get("mobile"))
                contacts = []
                if u.get("guardian_name") or g_ph:
                    contacts.append({"role": "guardian", "name": u.get("guardian_name"), "phone": g_ph})
                if u.get("mother_name") or m_ph:
                    contacts.append({"role": "mother", "name": u.get("mother_name"), "phone": m_ph})
                if u.get("father_name") or f_ph:
                    contacts.append({"role": "father", "name": u.get("father_name"), "phone": f_ph})
                members.append({
                    "id": u.get("id"),
                    "name": u.get("full_name"),
                    "role": u.get("category"),
                    "guardian_name": u.get("guardian_name"),
                    "guardian_phone": g_ph, "guardian_mobile": g_ph, "guardian_number": g_ph,
                    "mother_name": u.get("mother_name"),
                    "mother_phone": m_ph, "mother_mobile": m_ph,
                    "father_name": u.get("father_name"),
                    "father_phone": f_ph, "father_mobile": f_ph,
                    "contacts": contacts,
                    # Last-ditch single phone: guardian → mother → father → self.
                    "phone": g_ph or m_ph or f_ph or self_ph,
                })
            return {"members": members}
        if not user:
            raise HTTPException(status_code=401, detail="Not authenticated")
        users = await db.users.find(
            {} if include_archived else {"archived": {"$ne": True}},
            {"_id": 0, "hashed_password": 0}).sort("full_name", 1).to_list(2000)

        # Bulk: latest check-in date per user. $sort+$first rides the existing
        # {user_id:1, date:-1} index (DISTINCT_SCAN) — O(#users), not O(#rows).
        last_seen_rows = await db.attendance.aggregate([
            {"$sort": {"user_id": 1, "date": -1}},
            {"$group": {"_id": "$user_id", "last": {"$first": "$date"}}},
        ]).to_list(5000)
        last_seen_map = {r["_id"]: r["last"] for r in last_seen_rows if r.get("last")}

        # Bulk: approved leave days YTD per user.
        office = await db.config.find_one({"id": "office"})
        today = local_date_str(office)
        year = today[:4]
        # Mirrors /leave-balances: prefer the explicit paid_leave_used stamp
        # (covers half-days & comp-off-funded leaves); legacy rows fall back
        # to the whole inclusive window. Overlap query matches too.
        leaves_ytd = await db.leaves.find({
            "status": "approved", "type": "leave",
            "start_date": {"$lte": f"{year}-12-31"},
            "end_date": {"$gte": f"{year}-01-01"},
        }, {"_id": 0, "user_id": 1, "start_date": 1, "end_date": 1,
            "paid_leave_used": 1}).to_list(20000)
        ytd_map: dict = {}
        for leave in leaves_ytd:
            if leave.get("paid_leave_used") is not None:
                n = float(leave["paid_leave_used"])
            else:
                try:
                    n = (date.fromisoformat(leave["end_date"]) - date.fromisoformat(leave["start_date"])).days + 1
                except Exception:
                    n = 1
            ytd_map[leave["user_id"]] = ytd_map.get(leave["user_id"], 0.0) + n

        out: List[UserPublic] = []
        for u in users:
            last_seen_iso = last_seen_map.get(u["id"])
            opening = float(u.get("leave_balance_opening") or 0) if u.get("leave_balance_opening") is not None else None
            taken = float(ytd_map.get(u["id"], 0))
            remaining = None if opening is None else round(opening - taken, 1)
            # Emit a URL instead of the base64 blob so the browser caches thumbs
            # independently of the JSON response. See member_photo_url().
            u_swapped = {
                **u,
                "photo": member_photo_url(u),
                "last_seen_date": last_seen_iso[:10] if last_seen_iso else None,
                "leave_balance_opening": opening,
                "leave_balance_remaining": remaining,
            }
            out.append(UserPublic(**{k: u_swapped.get(k) for k in UserPublic.model_fields}))
        return out

    @router.get("/staff-roster/export")
    async def export_staff_roster(admin: dict = Depends(require_admin)):
        """Excel (.xlsx) roster of the non-athlete workforce — Staff,
        Executives and Coaches — for payroll seeding. One row per person
        with an empty 'Monthly Salary' column ready to be filled in and fed
        to the payroll workflow. Admin-only.
        """
        import io
        from openpyxl import Workbook
        from openpyxl.styles import Font, PatternFill, Alignment
        from openpyxl.utils import get_column_letter

        wanted = ["staff", "executive", "coach"]
        labels = {"staff": "Staff", "executive": "Executive", "coach": "Coach"}

        users = await db.users.find(
            {"category": {"$in": wanted}},
            {"_id": 0, "full_name": 1, "rank": 1, "category": 1, "mobile": 1, "email": 1},
        ).to_list(5000)
        order = {"staff": 0, "executive": 1, "coach": 2}
        users.sort(key=lambda u: (order.get(u.get("category"), 9), (u.get("full_name") or "").lower()))

        wb = Workbook()
        ws = wb.active
        ws.title = "Staff Roster"
        headers = ["S.No", "Name", "Designation", "Category", "Mobile", "Monthly Salary"]
        ws.append(headers)
        head_fill = PatternFill("solid", fgColor="1E293B")
        head_font = Font(bold=True, color="FFFFFF")
        for col, _ in enumerate(headers, start=1):
            cell = ws.cell(row=1, column=col)
            cell.fill = head_fill
            cell.font = head_font
            cell.alignment = Alignment(horizontal="center", vertical="center")

        for i, u in enumerate(users, start=1):
            ws.append([
                i,
                u.get("full_name") or "",
                u.get("rank") or "",
                labels.get(u.get("category"), u.get("category") or ""),
                u.get("mobile") or "",
                "",
            ])

        widths = [7, 32, 24, 14, 16, 16]
        for col, w in enumerate(widths, start=1):
            ws.column_dimensions[get_column_letter(col)].width = w
        ws.freeze_panes = "A2"

        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)
        from fastapi.responses import Response
        today = date.today().isoformat()
        return Response(
            content=buf.getvalue(),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": f'attachment; filename="staff_roster_{today}.xlsx"'},
        )





    @router.get("/members/{member_id}/photo")
    async def get_member_photo(member_id: str):
        """Return the raw thumbnail bytes for a member's profile photo.
        Split out from the members list so the list stays small (< 100 KB)
        and the browser caches each thumbnail independently. Cacheable for
        up to a year because the URL includes a hash of the photo bytes
        (?v=…) — uploading a new photo produces a new URL, so stale caches
        are naturally bypassed.

        Auth: intentionally UN-authenticated. `<img src=…>` requests from the
        browser can't carry the `Authorization: Bearer` header, and photos
        are already displayed throughout the logged-in app anyway. The URL
        itself carries a content-hash cache-buster which makes it very hard
        to guess a valid URL for a specific member.
        """
        u = await db.users.find_one({"id": member_id}, {"_id": 0, "photo": 1, "photo_thumb": 1})
        if not u:
            raise HTTPException(status_code=404, detail="Member not found")
        b64 = u.get("photo_thumb") or u.get("photo")
        if not b64:
            raise HTTPException(status_code=404, detail="No photo on file")
        import base64
        import re
        m = re.match(r"^data:(image/[a-zA-Z0-9.+-]+);base64,(.+)$", b64.strip())
        if not m:
            raise HTTPException(status_code=500, detail="Stored photo is not a valid data URI")
        content_type, payload = m.group(1), m.group(2)
        try:
            raw = base64.b64decode(payload)
        except Exception:
            raise HTTPException(status_code=500, detail="Stored photo could not be decoded")
        from fastapi.responses import Response
        return Response(
            content=raw,
            media_type=content_type,
            headers={
                # ?v=hash cache-buster in the URL means we can safely cache
                # for a very long time — a new upload produces a new URL.
                "Cache-Control": "public, max-age=31536000, immutable",
            },
        )


    @router.post("/members/bulk-update")
    async def bulk_update_members(body: BulkMemberUpdateIn, admin: dict = Depends(require_admin)):
        """Apply a small set of cohort-level fields to many members at once.

        Used by the Members admin table's bulk-edit toolbar so an admin can,
        e.g., reshuffle 30 athletes into a new fleet at season start with a
        single click. Per-individual fields (name, mobile, email, photo,
        password, opening leave balance) are intentionally NOT supported —
        they don't have a sensible "apply to all" value.
        """
        if not body.member_ids:
            raise HTTPException(status_code=400, detail="No members selected")
        submitted = body.updates.model_dump(exclude_unset=True)
        # Narrow allowlist — anything outside this set is rejected so a future
        # accidental UI bug can't blast e.g. everyone's password to the same
        # value via this endpoint.
        update = {k: v for k, v in submitted.items() if k in BULK_MEMBER_ALLOWED_FIELDS}
        if update.get("category"):
            update.update(await _resolve_category(update["category"]))
        if not update:
            raise HTTPException(status_code=400, detail="No valid fields to update — pick one of: " + ", ".join(sorted(BULK_MEMBER_ALLOWED_FIELDS)))
        # Self-protection: prevent the signed-in admin from accidentally
        # demoting themselves to "member" via a bulk role change.
        if update.get("role") == "member" and admin["id"] in body.member_ids:
            raise HTTPException(status_code=400, detail="You cannot remove your own admin access via a bulk update")
        res = await db.users.update_many({"id": {"$in": body.member_ids}}, {"$set": update})
        return {"updated": int(res.modified_count), "matched": int(res.matched_count), "fields": list(update.keys())}


    @router.patch("/members/{member_id}", response_model=UserPublic)
    async def update_member(member_id: str, body: MemberUpdate, force: bool = False, admin: dict = Depends(require_admin)):
        if body.role is not None and body.role == "member" and member_id == admin["id"]:
            raise HTTPException(status_code=400, detail="You cannot remove your own admin access")
        if body.photo is not None:
            # Guard: the members-list endpoint now emits photo URLs
            # (`/api/members/{id}/photo?v=…`) instead of base64 blobs, and the
            # MemberForm sends the initial member payload back verbatim on save.
            # If we don't intercept the URL-shaped photo here, it would be
            # written into the DB as a literal string, destroying the real
            # photo. Only accept photo values that look like a proper data URI —
            # anything else, treat as "photo field wasn't touched by the user".
            if not body.photo.startswith("data:"):
                body.photo = None
                # Also pop from the pydantic "explicitly-set" tracker so
                # model_dump(exclude_unset=True) skips it and we don't nuke
                # the DB row with `photo=None` on save.
                body.__pydantic_fields_set__.discard("photo")
            else:
                _check_photo_size(body.photo)
        # Snapshot BEFORE — feeds the audit diff.
        before_doc = await db.users.find_one({"id": member_id}, {"_id": 0})
        if not before_doc:
            raise HTTPException(status_code=404, detail="Member not found")
        # NOTE: `exclude_unset=True` distinguishes between "field omitted from
        # request" (leave unchanged) and "field explicitly set to null" (clear
        # it). Without this, inline-edit cells in the Members admin table can
        # SET values but never CLEAR them, because Pydantic defaults all
        # unspecified Optional fields to None and we used to filter all Nones.
        update = {k: v for k, v in body.model_dump(exclude_unset=True).items() if k != "password"}
        if "email" in update:
            email = (update["email"] or "").strip().lower()
            if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email):
                raise HTTPException(status_code=400, detail="Enter a valid email address")
            if await db.users.find_one({"email": email, "id": {"$ne": member_id}}, {"_id": 1}):
                raise HTTPException(status_code=409, detail="Another member already uses this email")
            update["email"] = email
        if "category" in update:
            if update["category"]:
                update.update(await _resolve_category(update["category"]))
            else:
                update.pop("category")
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
        # Data-entry guardrails (Oct 2026): validate the resulting member.
        merged = {**before_doc, **update}
        is_ath = (merged.get("category") or "").lower() in ("athlete", "elite")
        errs, warns = validate_member(merged, is_ath)
        if "mobile" in update and (update.get("mobile") or "").strip():
            key = phone_key(update["mobile"])
            if key and len(key) == 10 and await db.users.find_one(
                    {"mobile_last10": key, "id": {"$ne": member_id}, "archived": {"$ne": True}}, {"_id": 1}):
                errs.append("This mobile number is already used by another member")
        if "full_name" in update and (update.get("full_name") or "").strip() and await db.users.find_one(
                {"full_name": update["full_name"], "id": {"$ne": member_id}, "archived": {"$ne": True}}, {"_id": 1}):
            warns.append(f"Another member is already named '{update['full_name']}'")
        if errs:
            raise HTTPException(status_code=400, detail=" • ".join(errs))
        if warns and not force:
            raise HTTPException(status_code=409, detail={"needs_confirm": True, "warnings": warns})
        if update:
            await db.users.update_one({"id": member_id}, {"$set": update})
        u = await db.users.find_one({"id": member_id}, {"_id": 0})
        if not u:
            raise HTTPException(status_code=404, detail="Member not found")
        if body.hourly_wager:
            # Switched to hourly → no timings: clear Late / Early-out marks
            # from the current open month onward.
            from services.attendance_helpers import clear_hourly_timing_marks
            await clear_hourly_timing_marks(db, await db.config.find_one({"id": "office"}), [member_id])
        # Auto-revoke devices when leaving_date crosses into the past.
        # 24 Feb 2026 user request: an admin sets `leaving_date` to
        # off-board someone → their existing sessions on personal devices
        # should die immediately so they can no longer log in or check
        # themselves in. We only fire this when the leaving_date TRANSITION
        # actually moves into the past (not on every save, not on future
        # dates yet to arrive).
        if "leaving_date" in update:
            old_lv = (before_doc.get("leaving_date") or "").strip()
            new_lv = (u.get("leaving_date") or "").strip()
            today = local_date_str(await db.config.find_one({"id": "office"}))
            was_ex = bool(old_lv) and old_lv < today
            is_ex_now = bool(new_lv) and new_lv < today
            if is_ex_now and not was_ex:
                rev = await db.devices.update_many(
                    {"user_id": member_id, "status": {"$ne": "revoked"}},
                    {"$set": {"status": "revoked",
                              "revoked_reason": f"Member exited on {new_lv}",
                              "revoked_at": now_utc().isoformat(),
                              "revoked_by": admin.get("id")}},
                )
                logger.info("Auto-revoked %d device(s) for exited member %s",
                            rev.modified_count, u.get("full_name"))
        # Audit trail — one row per admin-driven member edit. Sensitive
        # fields (photo bytes, hashed password) are redacted from the
        # diff to keep the log lean and to avoid re-persisting secrets.
        audit_before = {k: v for k, v in before_doc.items()
                        if k not in ("photo", "photo_thumb", "hashed_password")}
        audit_after = {k: v for k, v in u.items()
                       if k not in ("photo", "photo_thumb", "hashed_password")}
        action = "member.password_reset" if body.password else "member.update"
        await write_audit(
            db, actor=admin, action=action,
            entity_type="member", entity_id=member_id,
            entity_name=u.get("full_name"),
            before=audit_before, after=audit_after,
        )
        return UserPublic(**{k: u.get(k) for k in UserPublic.model_fields})


    @router.get("/members/import-template")
    async def import_template(admin: dict = Depends(require_admin)):
        """Download a starter Excel template for /members/import.

        NOTE: This route MUST stay before `/members/{member_id}` in route
        registration order — FastAPI matches by registration order and a
        parametric route would otherwise capture "import-template" as a member id.
        """
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


    @router.get("/members/{member_id}", response_model=UserPublic)
    async def get_member(member_id: str, admin: dict = Depends(require_admin)):
        """Single-member fetch used by double-click edit on the Presence Board."""
        u = await db.users.find_one({"id": member_id}, {"_id": 0})
        if not u:
            raise HTTPException(status_code=404, detail="Member not found")
        return UserPublic(**{k: u.get(k) for k in UserPublic.model_fields})


    async def _queue_member_action(member_id: str, kind: str, admin: dict, reason: str) -> dict:
        """Queue a member delete/archive for Super-Admin approval (non-super
        admins). Inserts a pending correction row that shows up in the
        unified Approvals screen; a Super Admin applies it there."""
        target = await db.users.find_one({"id": member_id}, {"_id": 0, "id": 1, "full_name": 1})
        if not target:
            raise HTTPException(status_code=404, detail="Member not found")
        office = await db.config.find_one({"id": "office"})
        today = local_date_str(office)
        doc = {
            "id": str(uuid.uuid4()),
            "entity_type": "member",
            "kind": kind,
            "entity_id": member_id,
            "target_date": today,
            "payload": {"member_name": target.get("full_name")},
            "reason": (reason or "").strip() or f"Request to {'delete' if kind == 'member_delete' else 'archive'} {target.get('full_name')}",
            "status": "pending",
            "requester_id": member_id,
            "requester_name": target.get("full_name"),
            "requested_at": now_utc().isoformat(),
            "decided_by_id": None, "decided_by_name": None, "decided_at": None,
            "admin_note": None,
            "filed_by_admin_id": admin["id"],
            "filed_by_admin_name": admin["full_name"],
            "needs_super_admin": True,
        }
        await db.corrections.insert_one(doc)
        await write_audit(
            db, actor=admin, action="member_action_requested",
            entity_type="correction", entity_id=doc["id"],
            entity_name=f"member/{kind} · {target.get('full_name')}",
            before=None, after={"status": "pending", "needs_super_admin": True, "kind": kind},
            reason=doc["reason"],
        )
        return {"ok": True, "queued": True, "needs_super_admin": True, "id": doc["id"]}


    async def _do_delete_member(member_id: str) -> None:
        await db.users.delete_one({"id": member_id})
        await db.attendance.delete_many({"user_id": member_id})
        await db.leaves.delete_many({"user_id": member_id})


    @router.delete("/members/{member_id}")
    async def delete_member(member_id: str, reason: str = "", admin: dict = Depends(require_admin)):
        if member_id == admin["id"]:
            raise HTTPException(status_code=400, detail="Cannot delete yourself")
        # Super Admins delete directly; regular admins queue for Super-Admin
        # sign-off in the Approvals screen (Jun 2026, user request).
        if not is_super_admin(admin):
            return await _queue_member_action(member_id, "member_delete", admin, reason)
        await _do_delete_member(member_id)
        await write_audit(
            db, actor=admin, action="member_deleted", entity_type="member",
            entity_id=member_id, entity_name=member_id, before=None, after=None,
            reason=reason or "Deleted by Super Admin",
        )
        return {"ok": True, "deleted": True}


    @router.post("/members/{member_id}/archive")
    async def archive_member(member_id: str, reason: str = "", admin: dict = Depends(require_admin)):
        if member_id == admin["id"]:
            raise HTTPException(status_code=400, detail="Cannot archive yourself")
        target = await db.users.find_one({"id": member_id}, {"_id": 0, "id": 1})
        if not target:
            raise HTTPException(status_code=404, detail="Member not found")
        if not is_super_admin(admin):
            return await _queue_member_action(member_id, "member_archive", admin, reason)
        await db.users.update_one({"id": member_id}, {"$set": {
            "archived": True, "archived_at": now_utc().isoformat(), "archived_by": admin["full_name"],
        }})
        await write_audit(
            db, actor=admin, action="member_archived", entity_type="member",
            entity_id=member_id, entity_name=member_id, before={"archived": False},
            after={"archived": True}, reason=reason or "Archived by Super Admin",
        )
        return {"ok": True, "archived": True}


    @router.post("/members/{member_id}/unarchive")
    async def unarchive_member(member_id: str, admin: dict = Depends(require_admin)):
        res = await db.users.update_one({"id": member_id}, {"$set": {
            "archived": False, "archived_at": None, "archived_by": None,
        }})
        if res.matched_count == 0:
            raise HTTPException(status_code=404, detail="Member not found")
        await write_audit(
            db, actor=admin, action="member_unarchived", entity_type="member",
            entity_id=member_id, entity_name=member_id, before={"archived": True},
            after={"archived": False}, reason="Unarchived",
        )
        return {"ok": True, "archived": False}




    @router.get("/members/{member_id}/card")
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


    @router.get("/admin/cards")
    async def all_cards(admin: dict = Depends(require_admin)):
        """Every member's personal QR — for batch printing of member ID cards."""
        users = await db.users.find(
            {"archived": {"$ne": True}}, {"_id": 0, "id": 1, "full_name": 1, "rank": 1, "category": 1, "personal_qr": 1}
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


    @router.post("/members/import")
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




    @router.post("/members/import-parents")
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


    @router.post("/members/me/photo", response_model=UserPublic)
    async def set_my_photo(body: dict, user: dict = Depends(get_current_user)):
        photo = body.get("photo")
        _check_photo_size(photo)
        thumb = _make_thumbnail(photo) if photo else None
        office = await db.config.find_one({"id": "office"}, {"_id": 0, "timezone": 1})
        week_key = _iso_week_key(local_now(office).date())
        await db.users.update_one(
            {"id": user["id"]},
            {"$set": {"photo": photo, "photo_thumb": thumb,
                      "photo_captured_at": now_utc().isoformat(),
                      "photo_refresh_week": week_key}},
        )
        u = await db.users.find_one({"id": user["id"]}, {"_id": 0})
        return UserPublic(**{k: u.get(k) for k in UserPublic.model_fields})


    @router.post("/members/{member_id}/photo", response_model=UserPublic)
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
        office = await db.config.find_one({"id": "office"}, {"_id": 0, "timezone": 1})
        week_key = _iso_week_key(local_now(office).date())
        await db.users.update_one(
            {"id": member_id},
            {"$set": {"photo": photo, "photo_thumb": thumb,
                      "photo_captured_at": now_utc().isoformat(),
                      "photo_refresh_week": week_key}},
        )
        u = await db.users.find_one({"id": member_id}, {"_id": 0})
        return UserPublic(**{k: u.get(k) for k in UserPublic.model_fields})

    return router
