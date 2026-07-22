"""Data Quality dashboard endpoint.

Scans the whole database for common data-hygiene issues an admin
should know about but might not otherwise notice:

  • Duplicates: emails, mobiles, full-names (case-insensitive).
  • Missing critical fields on athletes (institution, fleet, parent
    contacts) and staff (mobile).
  • Structural / temporal inconsistencies (leaves where end < start,
    sessions with check-out before check-in, sessions still open >36h).
  • Suspicious values: unphonelike mobiles, negative leave balances,
    check-ins with zero coordinates, DOB in the future.

Every finding carries a severity, a machine-readable code, a
description, and the offending entity id(s). The frontend renders
them grouped by category, sorted by severity.

Zero mutations — pure read-only diagnostic tool.
"""
from __future__ import annotations

import re
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends


SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2, "info": 3}


def _fix_for(code: str, entity_ids: list) -> Optional[dict]:
    """Map a finding code to a "Fix" call-to-action the frontend can
    turn into a button. Returns None when there's no automated jump
    target (e.g. review-only findings on duplicates).

    Each fix returns:
        { label, to, params }
    where `to` is a react-router path and `params` is a dict of URL
    search-params to append. The frontend links the button directly.
    """
    if not entity_ids:
        return None
    first = entity_ids[0]

    # Member-scoped: jump to Manage Members with `?edit=<id>` so the
    # edit modal opens directly on the right row.
    MEMBER_EDIT = {
        "member.missing_fields":       ("Fix missing fields", "/admin/members"),
        "athlete.no_parent_mobile":    ("Add parent contact", "/admin/members"),
        "member.bad_mobile":           ("Fix mobile",        "/admin/members"),
        "member.no_photo":             ("Add photo",         "/admin/members"),
        "member.photo_stale":          ("Refresh photo",     "/admin/members"),
        "member.dob_in_future":        ("Fix DOB",           "/admin/members"),
        "member.dob_ancient":          ("Fix DOB",           "/admin/members"),
        "member.dob_bad_format":       ("Fix DOB",           "/admin/members"),
    }
    if code in MEMBER_EDIT:
        label, to = MEMBER_EDIT[code]
        return {"label": label, "to": to,
                "params": {"edit": first, "highlight": first}}

    # Leave-balance findings live on the Leave Balances page.
    if code in ("member.negative_leave", "member.high_leave_opening"):
        return {"label": "Adjust balance", "to": "/admin/leave-balances",
                "params": {"highlight": first}}

    # Duplicate members: highlight the FIRST offender and let the admin
    # walk the list from there (up to 5 shown as chips in the row).
    if code in ("member.duplicate_email", "member.duplicate_mobile",
                "member.duplicate_name"):
        return {"label": "Review dupes", "to": "/admin/members",
                "params": {"highlight": first, "edit": first}}

    # Leave-record corruption → Approvals page.
    if code in ("leave.end_before_start", "leave.late_coming_multiday",
                "leave.half_day_wrong_type"):
        return {"label": "Review leave", "to": "/admin/approvals",
                "params": {"highlight": first}}

    # Attendance session corruption → open the member for retroactive fix.
    if code in ("session.checkout_before_checkin", "session.open_over_36h"):
        return {"label": "Open member", "to": "/admin/members",
                "params": {"highlight": first, "edit": first}}

    # New individual-field checks (26 Feb 2026) — jump into MemberForm.
    if code in ("member.missing_joining_date", "member.missing_category",
                "member.missing_rank", "member.missing_weekly_off",
                "member.missing_institution", "member.missing_fleet"):
        return {"label": "Fix on member", "to": "/admin/members",
                "params": {"edit": first, "highlight": first}}

    # Leave-record findings that need human judgement.
    if code == "leave.missing_reason":
        return {"label": "Add reason", "to": "/admin/approvals",
                "params": {"highlight": first}}
    if code == "leave.overlapping":
        return {"label": "Review leaves", "to": "/admin/approvals",
                "params": {"highlight": first}}

    # Device findings that need human judgement.
    if code in ("device.too_many_active", "device.stale_pending"):
        return {"label": "Review devices", "to": "/admin/devices",
                "params": {"highlight": first}}

    # Escort findings — jump into the Escorts admin page.
    if code in ("escort.no_institution", "escort.duplicate_phone",
                "escort.malformed_phone"):
        return {"label": "Edit escort", "to": "/admin/escorts",
                "params": {"highlight": first}}

    # Config findings — jump to the appropriate settings page.
    if code == "config.no_office_geofence":
        return {"label": "Set geofence", "to": "/admin/office", "params": {}}
    if code == "config.empty_categories":
        return {"label": "Set categories", "to": "/admin/masters", "params": {}}
    if code == "config.stale_holidays":
        return {"label": "Add holidays", "to": "/admin/holidays", "params": {}}

    return None


def _severity_key(f: dict) -> int:
    return SEVERITY_ORDER.get(f.get("severity", "low"), 99)


def _norm_mobile(s: Optional[str]) -> str:
    """Last 10 digits — matches the app's `phone_key` convention."""
    if not s:
        return ""
    digits = re.sub(r"\D", "", s)
    return digits[-10:] if len(digits) >= 10 else digits


def _looks_like_mobile(s: Optional[str]) -> bool:
    return len(_norm_mobile(s)) == 10


def make_router(db, require_admin) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/admin/data-quality")
    async def data_quality(admin: dict = Depends(require_admin)):
        """Full DB sweep. Returns findings grouped by category with
        entity refs so the admin can jump straight into the offending
        member/leave/session record."""
        findings: list[dict] = []
        now = datetime.now(timezone.utc)

        # ── Members ───────────────────────────────────────────────
        users = await db.users.find({}, {"_id": 0}).to_list(5000)

        # 1. Duplicate emails (case-insensitive)
        by_email: dict[str, list[dict]] = defaultdict(list)
        for u in users:
            e = (u.get("email") or "").strip().lower()
            if e:
                by_email[e].append(u)
        for e, group in by_email.items():
            if len(group) > 1:
                findings.append({
                    "category": "Duplicates",
                    "code": "member.duplicate_email",
                    "severity": "high",
                    "message": f"Email '{e}' used by {len(group)} members",
                    "entity_type": "member",
                    "entity_ids": [u["id"] for u in group],
                    "entity_names": [u.get("full_name") for u in group],
                })

        # 2. Duplicate mobiles (last 10 digits)
        by_mobile: dict[str, list[dict]] = defaultdict(list)
        for u in users:
            k = _norm_mobile(u.get("mobile"))
            if k:
                by_mobile[k].append(u)
        for k, group in by_mobile.items():
            if len(group) > 1:
                findings.append({
                    "category": "Duplicates",
                    "code": "member.duplicate_mobile",
                    "severity": "high",
                    "message": f"Mobile ending {k[-4:]} used by {len(group)} members",
                    "entity_type": "member",
                    "entity_ids": [u["id"] for u in group],
                    "entity_names": [u.get("full_name") for u in group],
                })

        # 3. Duplicate full names (weaker signal → medium severity)
        by_name: dict[str, list[dict]] = defaultdict(list)
        for u in users:
            n = (u.get("full_name") or "").strip().upper()
            if n:
                by_name[n].append(u)
        for n, group in by_name.items():
            if len(group) > 1:
                findings.append({
                    "category": "Duplicates",
                    "code": "member.duplicate_name",
                    "severity": "medium",
                    "message": f"Full name '{n}' used by {len(group)} members — possible dupes",
                    "entity_type": "member",
                    "entity_ids": [u["id"] for u in group],
                    "entity_names": [u.get("full_name") for u in group],
                })

        # 4. Missing critical fields
        for u in users:
            cat = u.get("category")
            missing = []
            if not u.get("full_name"):
                missing.append("full_name")
            if not u.get("mobile") and cat != "athlete":
                # Athletes may only have parent mobiles — checked below.
                missing.append("mobile")
            if u.get("mobile") and not _looks_like_mobile(u.get("mobile")):
                findings.append({
                    "category": "Suspicious values",
                    "code": "member.bad_mobile",
                    "severity": "medium",
                    "message": f"Mobile '{u.get('mobile')}' isn't 10 digits",
                    "entity_type": "member",
                    "entity_ids": [u["id"]],
                    "entity_names": [u.get("full_name")],
                })
            if cat == "athlete":
                if not u.get("institution"):
                    missing.append("institution")
                if not u.get("fleet"):
                    missing.append("fleet")
                parent_mobiles = [u.get("father_mobile"), u.get("mother_mobile"),
                                  u.get("guardian_mobile")]
                if not any(_looks_like_mobile(p) for p in parent_mobiles):
                    findings.append({
                        "category": "Missing data",
                        "code": "athlete.no_parent_mobile",
                        "severity": "high",
                        "message": "Athlete has no valid parent/guardian mobile — SMS/WhatsApp alerts won't reach anyone",
                        "entity_type": "member",
                        "entity_ids": [u["id"]],
                        "entity_names": [u.get("full_name")],
                    })
            if missing:
                findings.append({
                    "category": "Missing data",
                    "code": "member.missing_fields",
                    "severity": "medium",
                    "message": f"Missing: {', '.join(missing)}",
                    "entity_type": "member",
                    "entity_ids": [u["id"]],
                    "entity_names": [u.get("full_name")],
                })
            # Negative or huge leave balance
            bal = u.get("leave_balance_opening")
            if isinstance(bal, (int, float)):
                if bal < 0:
                    findings.append({
                        "category": "Suspicious values",
                        "code": "member.negative_leave",
                        "severity": "high",
                        "message": f"Opening leave balance = {bal} (negative)",
                        "entity_type": "member",
                        "entity_ids": [u["id"]],
                        "entity_names": [u.get("full_name")],
                    })
                elif bal > 60:
                    findings.append({
                        "category": "Suspicious values",
                        "code": "member.high_leave_opening",
                        "severity": "low",
                        "message": f"Opening leave balance = {bal} (higher than typical annual quota)",
                        "entity_type": "member",
                        "entity_ids": [u["id"]],
                        "entity_names": [u.get("full_name")],
                    })
            # DOB sanity
            dob = u.get("date_of_birth")
            if dob:
                if not re.match(r"^\d{4}-\d{2}-\d{2}$", dob):
                    findings.append({
                        "category": "Suspicious values",
                        "code": "member.dob_bad_format",
                        "severity": "medium",
                        "message": f"Date of birth '{dob}' isn't in ISO YYYY-MM-DD",
                        "entity_type": "member",
                        "entity_ids": [u["id"]],
                        "entity_names": [u.get("full_name")],
                    })
                else:
                    try:
                        d_ = date.fromisoformat(dob)
                        if d_ > date.today():
                            findings.append({
                                "category": "Suspicious values",
                                "code": "member.dob_in_future",
                                "severity": "medium",
                                "message": f"Date of birth {dob} is in the future",
                                "entity_type": "member",
                                "entity_ids": [u["id"]],
                                "entity_names": [u.get("full_name")],
                            })
                        elif d_ < date(1900, 1, 1):
                            findings.append({
                                "category": "Suspicious values",
                                "code": "member.dob_ancient",
                                "severity": "low",
                                "message": f"Date of birth {dob} is implausibly old",
                                "entity_type": "member",
                                "entity_ids": [u["id"]],
                                "entity_names": [u.get("full_name")],
                            })
                    except ValueError:
                        findings.append({
                            "category": "Suspicious values",
                            "code": "member.dob_bad_format",
                            "severity": "medium",
                            "message": f"Date of birth '{dob}' isn't a valid ISO date",
                            "entity_type": "member",
                            "entity_ids": [u["id"]],
                            "entity_names": [u.get("full_name")],
                        })
            # Missing photo
            if not u.get("photo"):
                findings.append({
                    "category": "Missing data",
                    "code": "member.no_photo",
                    "severity": "low",
                    "message": "No profile photo on file",
                    "entity_type": "member",
                    "entity_ids": [u["id"]],
                    "entity_names": [u.get("full_name")],
                })
            else:
                # Stale photo — anything older than 12 months. Only
                # applies to athletes (competitive kids grow fast;
                # staff/coach faces are stable enough that a stale
                # photo isn't a coaching-recognition problem).
                captured = u.get("photo_captured_at")
                if u.get("category") == "athlete" and captured:
                    try:
                        capt_dt = datetime.fromisoformat(captured.replace("Z", "+00:00"))
                        age_days = (now - capt_dt).days
                        if age_days > 365:
                            findings.append({
                                "category": "Stale data",
                                "code": "member.photo_stale",
                                "severity": "low",
                                "message": f"Photo captured {age_days} days ago — kids' faces change fast, worth a refresh",
                                "entity_type": "member",
                                "entity_ids": [u["id"]],
                                "entity_names": [u.get("full_name")],
                            })
                    except (ValueError, TypeError):
                        pass

        # ── Leaves ────────────────────────────────────────────────
        leaves = await db.leaves.find({}, {"_id": 0}).to_list(20000)
        for lv in leaves:
            s, e = lv.get("start_date"), lv.get("end_date")
            if s and e and e < s:
                findings.append({
                    "category": "Corrupt records",
                    "code": "leave.end_before_start",
                    "severity": "high",
                    "message": f"Leave {lv.get('type')} {s} → {e}: end before start",
                    "entity_type": "leave",
                    "entity_ids": [lv["id"]],
                    "entity_names": [lv.get("reason") or "(no reason)"],
                })
            if lv.get("type") == "late_coming" and s != e:
                findings.append({
                    "category": "Corrupt records",
                    "code": "leave.late_coming_multiday",
                    "severity": "medium",
                    "message": f"Late-coming spans multiple days ({s} → {e}) — should be single-day",
                    "entity_type": "leave",
                    "entity_ids": [lv["id"]],
                    "entity_names": [lv.get("reason") or "(no reason)"],
                })
            if lv.get("half_day") and lv.get("type") != "leave":
                findings.append({
                    "category": "Corrupt records",
                    "code": "leave.half_day_wrong_type",
                    "severity": "medium",
                    "message": f"Half-day flag set on type={lv.get('type')} (only Leave supports half-day)",
                    "entity_type": "leave",
                    "entity_ids": [lv["id"]],
                    "entity_names": [lv.get("reason") or "(no reason)"],
                })

        # ── Attendance sessions ──────────────────────────────────
        sessions = await db.attendance.find({}, {"_id": 0}).to_list(20000)
        stale_cutoff = now - timedelta(hours=36)
        for s in sessions:
            ci = s.get("check_in_at")
            co = s.get("check_out_at")
            if ci and co and co < ci:
                findings.append({
                    "category": "Corrupt records",
                    "code": "session.checkout_before_checkin",
                    "severity": "high",
                    "message": f"Session {s.get('date')}: check-out before check-in",
                    "entity_type": "attendance",
                    "entity_ids": [s.get("id") or s.get("session_id") or "?"],
                    "entity_names": [s.get("member_name") or s.get("user_id")],
                })
            if ci and not co:
                try:
                    ci_dt = datetime.fromisoformat(ci)
                    if ci_dt < stale_cutoff:
                        findings.append({
                            "category": "Stale data",
                            "code": "session.open_over_36h",
                            "severity": "medium",
                            "message": f"Session open since {s.get('date')} — no check-out for 36h+",
                            "entity_type": "attendance",
                            "entity_ids": [s.get("id") or s.get("session_id") or "?"],
                            "entity_names": [s.get("member_name") or s.get("user_id")],
                        })
                except ValueError:
                    pass

        # ── New checks (26 Feb 2026 user request) ─────────────────
        # Adds 15 detectors and 6 one-click safe auto-fixes on top of
        # the original suite. Each finding may carry `auto_fix: true`
        # so the frontend renders a Fix-Now button (POST) instead of
        # the default navigate-to-edit link.
        today_iso = date.today().isoformat()

        # --- Members: missing individual fields (surfaced separately
        #     from the `member.missing_fields` roll-up so filters can
        #     target one at a time). ---
        for field, code, sev, msg in [
            ("joining_date", "member.missing_joining_date", "low",
             "no joining date on record"),
            ("category", "member.missing_category", "low",
             "no category set"),
            ("rank", "member.missing_rank", "info",
             "no rank / role title"),
            ("weekly_off", "member.missing_weekly_off", "low",
             "no weekly-off set (defaults to Monday)"),
            ("institution", "member.missing_institution", "low",
             "no institution set"),
            ("fleet", "member.missing_fleet", "info",
             "no fleet assigned"),
        ]:
            missing = [u for u in users if u.get("role") != "admin"
                       and not (u.get(field) or "").strip()]
            for u in missing[:50]:
                findings.append({
                    "category": "Missing fields",
                    "code": code, "severity": sev,
                    "message": f"{u.get('full_name')} — {msg}",
                    "entity_type": "member",
                    "entity_ids": [u["id"]],
                    "entity_names": [u.get("full_name")],
                })

        # --- Approved leaves without a reason ---
        approved_leaves = await db.leaves.find(
            {"status": "approved", "$or": [{"reason": None}, {"reason": ""}]},
            {"_id": 0, "id": 1, "user_name": 1, "start_date": 1, "end_date": 1}
        ).limit(200).to_list(200)
        for L in approved_leaves:
            findings.append({
                "category": "Leaves",
                "code": "leave.missing_reason", "severity": "info",
                "message": f"Approved leave {L.get('start_date')}→{L.get('end_date')} has no reason",
                "entity_type": "leave",
                "entity_ids": [L["id"]],
                "entity_names": [L.get("user_name") or "(unknown)"],
            })

        # --- Overlapping approved leaves for the same member ---
        overlap_leaves = await db.leaves.find(
            {"status": "approved"},
            {"_id": 0, "id": 1, "user_id": 1, "user_name": 1, "start_date": 1, "end_date": 1}
        ).sort([("user_id", 1), ("start_date", 1)]).to_list(20000)
        by_user_lv: dict[str, list[dict]] = defaultdict(list)
        for L in overlap_leaves:
            by_user_lv[L.get("user_id") or ""].append(L)
        for uid, arr in by_user_lv.items():
            arr.sort(key=lambda x: x.get("start_date") or "")
            for i in range(len(arr) - 1):
                a, b = arr[i], arr[i + 1]
                if (a.get("end_date") or "") >= (b.get("start_date") or ""):
                    findings.append({
                        "category": "Leaves",
                        "code": "leave.overlapping", "severity": "high",
                        "message": (f"Overlap: {a['start_date']}→{a['end_date']} "
                                    f"clashes with {b['start_date']}→{b['end_date']}"),
                        "entity_type": "leave",
                        "entity_ids": [b["id"], a["id"]],
                        "entity_names": [b.get("user_name") or "(unknown)"],
                    })

        # --- LOP days > actual leave span (arithmetic corruption) ---
        lop_leaves = await db.leaves.find(
            {"lop_days": {"$gt": 0}},
            {"_id": 0, "id": 1, "user_name": 1, "start_date": 1, "end_date": 1, "lop_days": 1}
        ).to_list(20000)
        for L in lop_leaves:
            try:
                sd = date.fromisoformat(L["start_date"])
                ed = date.fromisoformat(L["end_date"])
                span = (ed - sd).days + 1
                if (L.get("lop_days") or 0) > span:
                    findings.append({
                        "category": "Leaves",
                        "code": "leave.lop_exceeds_span", "severity": "high",
                        "message": (f"lop_days={L['lop_days']} > span={span} "
                                    f"({L['start_date']}→{L['end_date']})"),
                        "entity_type": "leave",
                        "entity_ids": [L["id"]],
                        "entity_names": [L.get("user_name") or "(unknown)"],
                        "auto_fix": True,
                    })
            except Exception:
                continue

        # --- Attendance: zero-duration sessions ---
        zero_dur = await db.attendance.find(
            {"$expr": {"$eq": ["$check_in_at", "$check_out_at"]},
             "check_out_at": {"$ne": None}},
            {"_id": 0, "id": 1, "user_name": 1, "check_in_at": 1}
        ).limit(200).to_list(200)
        for r in zero_dur:
            findings.append({
                "category": "Attendance",
                "code": "session.zero_duration", "severity": "medium",
                "message": f"Zero-duration session at {r['check_in_at'][:16].replace('T', ' ')}",
                "entity_type": "attendance",
                "entity_ids": [r["id"]],
                "entity_names": [r.get("user_name") or "(unknown)"],
                "auto_fix": True,
            })

        # --- Attendance: sessions longer than 16 hours ---
        long_cursor = db.attendance.find(
            {"check_out_at": {"$ne": None}},
            {"_id": 0, "id": 1, "user_name": 1, "check_in_at": 1, "check_out_at": 1}
        )
        long_added = 0
        async for r in long_cursor:
            if long_added >= 200:
                break
            try:
                dt_in = datetime.fromisoformat(r["check_in_at"])
                dt_out = datetime.fromisoformat(r["check_out_at"])
                if (dt_out - dt_in).total_seconds() > 16 * 3600:
                    hours = round((dt_out - dt_in).total_seconds() / 3600, 1)
                    findings.append({
                        "category": "Attendance",
                        "code": "session.too_long_16h", "severity": "medium",
                        "message": f"Session lasted {hours}h ({r['check_in_at'][:10]}) — likely missed checkout",
                        "entity_type": "attendance",
                        "entity_ids": [r["id"]],
                        "entity_names": [r.get("user_name") or "(unknown)"],
                        "auto_fix": True,
                    })
                    long_added += 1
            except Exception:
                continue

        # --- Attendance: duplicate open sessions (same member, two+ opens) ---
        dupe_open = await db.attendance.aggregate([
            {"$match": {"check_out_at": None}},
            {"$group": {"_id": "$user_id",
                        "sessions": {"$push": {"id": "$id",
                                               "check_in_at": "$check_in_at",
                                               "user_name": "$user_name"}},
                        "n": {"$sum": 1}}},
            {"$match": {"n": {"$gt": 1}}},
        ]).to_list(1000)
        for g in dupe_open:
            sessions = sorted(g["sessions"], key=lambda s: s.get("check_in_at") or "")
            for s in sessions[1:]:
                findings.append({
                    "category": "Attendance",
                    "code": "session.duplicate_open", "severity": "high",
                    "message": f"Duplicate open session at {s['check_in_at'][:16].replace('T', ' ')}",
                    "entity_type": "attendance",
                    "entity_ids": [s["id"]],
                    "entity_names": [s.get("user_name") or "(unknown)"],
                    "auto_fix": True,
                })

        # --- Devices: approved for ex-members ---
        ex_users = [u for u in users
                    if (u.get("leaving_date") or "").strip() and (u.get("leaving_date") or "").strip() < today_iso]
        ex_ids = [u["id"] for u in ex_users]
        if ex_ids:
            ex_devs = await db.devices.find(
                {"user_id": {"$in": ex_ids}, "status": "approved"},
                {"_id": 0, "id": 1, "user_id": 1, "device_id": 1}
            ).limit(200).to_list(200)
            ex_map = {u["id"]: u for u in ex_users}
            for d in ex_devs:
                u = ex_map.get(d["user_id"], {})
                findings.append({
                    "category": "Devices",
                    "code": "device.approved_for_ex_member", "severity": "medium",
                    "message": f"Approved device for {u.get('full_name')} (exited {u.get('leaving_date')})",
                    "entity_type": "device",
                    "entity_ids": [d["id"]],
                    "entity_names": [u.get("full_name") or "(unknown)"],
                    "auto_fix": True,
                })

        # --- Devices: users with more than 3 approved devices ---
        heavy = await db.devices.aggregate([
            {"$match": {"status": "approved", "user_id": {"$ne": None}}},
            {"$group": {"_id": "$user_id", "n": {"$sum": 1}}},
            {"$match": {"n": {"$gt": 3}}},
        ]).to_list(1000)
        heavy_ids = [h["_id"] for h in heavy]
        heavy_users = await db.users.find({"id": {"$in": heavy_ids}}, {"_id": 0, "id": 1, "full_name": 1}).to_list(1000) if heavy_ids else []
        by_id_h = {u["id"]: u["full_name"] for u in heavy_users}
        for h in heavy:
            findings.append({
                "category": "Devices",
                "code": "device.too_many_active", "severity": "info",
                "message": f"{by_id_h.get(h['_id']) or 'Member'} has {h['n']} approved devices — probably leftover browsers",
                "entity_type": "member",
                "entity_ids": [h["_id"]],
                "entity_names": [by_id_h.get(h["_id"]) or "(unknown)"],
            })

        # --- Devices: pending requests > 7 days old ---
        stale_cut = (now - timedelta(days=7)).isoformat()
        stale_devs = await db.devices.find(
            {"status": "pending", "requested_at": {"$lt": stale_cut}},
            {"_id": 0, "id": 1, "device_id": 1, "requested_at": 1}
        ).limit(200).to_list(200)
        for d in stale_devs:
            findings.append({
                "category": "Devices",
                "code": "device.stale_pending", "severity": "medium",
                "message": f"Pending request from {d['requested_at'][:10]} — over 7 days old",
                "entity_type": "device",
                "entity_ids": [d["id"]],
                "entity_names": [f"device {d.get('device_id', '')[:8]}"],
            })

        # --- Escorts: without institution ---
        escorts = await db.escorts.find({}, {"_id": 0, "id": 1, "name": 1, "mobile": 1,
                                              "institution": 1, "mobile_last10": 1}).to_list(5000)
        for e in escorts:
            if not (e.get("institution") or "").strip():
                findings.append({
                    "category": "Escorts",
                    "code": "escort.no_institution", "severity": "info",
                    "message": f"{e.get('name') or 'Escort'} has no institution set",
                    "entity_type": "escort",
                    "entity_ids": [e["id"]],
                    "entity_names": [e.get("name") or "(unnamed)"],
                })

        # --- Escorts: duplicate phone numbers ---
        esc_by_phone: dict[str, list[dict]] = defaultdict(list)
        for e in escorts:
            k = (e.get("mobile_last10") or "").strip()
            if k:
                esc_by_phone[k].append(e)
        for k, group in esc_by_phone.items():
            if len(group) > 1:
                findings.append({
                    "category": "Escorts",
                    "code": "escort.duplicate_phone", "severity": "medium",
                    "message": f"Phone {k} shared by {len(group)} escort rows",
                    "entity_type": "escort",
                    "entity_ids": [e["id"] for e in group],
                    "entity_names": [e.get("name") or "(unnamed)" for e in group],
                })

        # --- Escorts: malformed phone (not clean 10 digits) ---
        for e in escorts:
            m10 = (e.get("mobile_last10") or "").strip()
            if not re.fullmatch(r"\d{10}", m10):
                findings.append({
                    "category": "Escorts",
                    "code": "escort.malformed_phone", "severity": "medium",
                    "message": f"{e.get('name') or 'Escort'} phone '{e.get('mobile') or ''}' is not 10 digits",
                    "entity_type": "escort",
                    "entity_ids": [e["id"]],
                    "entity_names": [e.get("name") or "(unnamed)"],
                })

        # --- Config: office geofence not set ---
        office = await db.config.find_one({"id": "office"})
        if not (office and office.get("lat") and office.get("lng")):
            findings.append({
                "category": "Configuration",
                "code": "config.no_office_geofence", "severity": "medium",
                "message": "Office geofence lat/lng not set — GPS distance can't be computed",
                "entity_type": "config",
                "entity_ids": ["office"],
                "entity_names": ["Office geofence"],
            })

        # --- Config: categories master empty ---
        cat_n = await db.categories_master.count_documents({})
        if cat_n == 0:
            findings.append({
                "category": "Configuration",
                "code": "config.empty_categories", "severity": "high",
                "message": "Categories master empty — dropdowns will crash",
                "entity_type": "config",
                "entity_ids": ["categories"],
                "entity_names": ["Categories master"],
            })

        # --- Config: no upcoming holidays in next 6 months ---
        horizon = (date.today() + timedelta(days=180)).isoformat()
        upcoming_hols = await db.holidays.count_documents({"date": {"$gte": today_iso, "$lte": horizon}})
        if upcoming_hols == 0:
            findings.append({
                "category": "Configuration",
                "code": "config.stale_holidays", "severity": "medium",
                "message": "No holidays scheduled in the next 6 months — payroll math will treat all as working days",
                "entity_type": "config",
                "entity_ids": ["holidays"],
                "entity_names": ["Holiday calendar"],
            })

        # Sort by severity, then category.
        findings.sort(key=lambda f: (_severity_key(f), f.get("category", ""), f.get("code", "")))

        # Attach a "Fix" call-to-action to every finding that has an
        # automated jump target. Done after sorting so the mapping is
        # a pure post-processing step (easy to audit / disable).
        for f in findings:
            f["fix"] = _fix_for(f.get("code", ""), f.get("entity_ids") or [])

        # Roll-up counts for the summary card.
        summary = defaultdict(int)
        for f in findings:
            summary[f["severity"]] += 1

        return {
            "generated_at": now.isoformat(),
            "total_findings": len(findings),
            "by_severity": dict(summary),
            "findings": findings,
        }

    # ── Auto-fix endpoints (26 Feb 2026) ──────────────────────────
    # Each POST performs ONE safe bulk mutation and returns the count
    # of rows fixed. Admin-guarded, no additional confirmations — the
    # frontend already prompts before calling.

    @router.post("/admin/data-quality/fix/session.zero_duration")
    async def fix_zero(admin: dict = Depends(require_admin)):
        r = await db.attendance.delete_many(
            {"$expr": {"$eq": ["$check_in_at", "$check_out_at"]},
             "check_out_at": {"$ne": None}}
        )
        return {"fixed": r.deleted_count}

    @router.post("/admin/data-quality/fix/session.too_long_16h")
    async def fix_long(admin: dict = Depends(require_admin)):
        fixed = 0
        cursor = db.attendance.find({"check_out_at": {"$ne": None}})
        async for r in cursor:
            try:
                dt_in = datetime.fromisoformat(r["check_in_at"])
                dt_out = datetime.fromisoformat(r["check_out_at"])
                if (dt_out - dt_in).total_seconds() > 16 * 3600:
                    capped = (dt_in + timedelta(hours=16)).isoformat()
                    await db.attendance.update_one(
                        {"id": r["id"]},
                        {"$set": {"check_out_at": capped, "auto_capped": True,
                                  "auto_capped_by": "data_quality",
                                  "auto_capped_at": datetime.now(timezone.utc).isoformat()}},
                    )
                    fixed += 1
            except Exception:
                continue
        return {"fixed": fixed}

    @router.post("/admin/data-quality/fix/session.duplicate_open")
    async def fix_dupe_open(admin: dict = Depends(require_admin)):
        groups = await db.attendance.aggregate([
            {"$match": {"check_out_at": None}},
            {"$group": {"_id": "$user_id",
                        "sessions": {"$push": {"id": "$id",
                                               "check_in_at": "$check_in_at"}},
                        "n": {"$sum": 1}}},
            {"$match": {"n": {"$gt": 1}}},
        ]).to_list(2000)
        fixed = 0
        for g in groups:
            sessions = sorted(g["sessions"], key=lambda s: s.get("check_in_at") or "")
            for s in sessions[1:]:
                r = await db.attendance.delete_one({"id": s["id"]})
                fixed += r.deleted_count
        return {"fixed": fixed}

    @router.post("/admin/data-quality/fix/session.open_over_36h")
    async def fix_dangling(admin: dict = Depends(require_admin)):
        """Close sessions that have been open > 36h at check-in + 8h."""
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=36)).isoformat()
        fixed = 0
        cursor = db.attendance.find({"check_out_at": None,
                                     "check_in_at": {"$lt": cutoff}})
        async for r in cursor:
            try:
                dt_in = datetime.fromisoformat(r["check_in_at"])
                close_at = (dt_in + timedelta(hours=8)).isoformat()
                await db.attendance.update_one(
                    {"id": r["id"]},
                    {"$set": {"check_out_at": close_at, "auto_closed": True,
                              "auto_closed_by": "data_quality",
                              "auto_closed_at": datetime.now(timezone.utc).isoformat()}},
                )
                fixed += 1
            except Exception:
                continue
        return {"fixed": fixed}

    @router.post("/admin/data-quality/fix/leave.lop_exceeds_span")
    async def fix_lop_cap(admin: dict = Depends(require_admin)):
        leaves = await db.leaves.find(
            {"lop_days": {"$gt": 0}},
            {"_id": 0, "id": 1, "start_date": 1, "end_date": 1, "lop_days": 1}
        ).to_list(20000)
        fixed = 0
        for L in leaves:
            try:
                sd = date.fromisoformat(L["start_date"])
                ed = date.fromisoformat(L["end_date"])
                span = (ed - sd).days + 1
                if (L.get("lop_days") or 0) > span:
                    await db.leaves.update_one(
                        {"id": L["id"]}, {"$set": {"lop_days": float(span)}})
                    fixed += 1
            except Exception:
                continue
        return {"fixed": fixed}

    @router.post("/admin/data-quality/fix/device.approved_for_ex_member")
    async def fix_ex_devices(admin: dict = Depends(require_admin)):
        today_iso = date.today().isoformat()
        ex_users = await db.users.find(
            {"leaving_date": {"$nin": [None, ""], "$lt": today_iso}},
            {"_id": 0, "id": 1}
        ).to_list(2000)
        uids = [u["id"] for u in ex_users]
        if not uids:
            return {"fixed": 0}
        r = await db.devices.update_many(
            {"user_id": {"$in": uids}, "status": "approved"},
            {"$set": {"status": "revoked",
                      "revoked_reason": "Ex-member cleanup via Data Quality",
                      "revoked_at": datetime.now(timezone.utc).isoformat(),
                      "revoked_by": admin.get("id")}},
        )
        return {"fixed": r.modified_count}

    return router
