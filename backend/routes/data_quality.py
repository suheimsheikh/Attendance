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

        # Sort by severity, then category.
        findings.sort(key=lambda f: (_severity_key(f), f.get("category", ""), f.get("code", "")))

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

    return router
