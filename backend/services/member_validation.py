"""Member data-entry guardrails (Oct 2026).

Pure validation shared by member create + update so the same rules that the
Data Quality sweep flags after the fact are now enforced at the point of
entry. Returns (errors, warnings):
  • errors   → hard-block the save (clearly-wrong data)
  • warnings → soft-confirm; the caller re-submits with force=true to proceed
"""
from __future__ import annotations

import re
from datetime import date


def _digits(s: str | None) -> str:
    return re.sub(r"[^0-9]", "", s or "")


_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def valid_mobile(s: str | None) -> bool:
    """A clean mobile number: 10 local digits, optionally with a country code
    (so +91-9991110001 / 919991110001 both pass on their last 10 digits)."""
    d = _digits(s)
    return 10 <= len(d) <= 13 and len(d[-10:]) == 10


def _hm_to_min(s: str | None):
    """"HH:MM" → minutes since midnight, or None if unparseable."""
    s = (s or "").strip()
    if not s:
        return None
    try:
        h, m = s.split(":")[:2]
        h, m = int(h), int(m)
        if 0 <= h <= 23 and 0 <= m <= 59:
            return h * 60 + m
    except (ValueError, TypeError):
        pass
    return None


def validate_member(fields: dict, is_athlete: bool) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []

    for label, key in (
        ("Mobile", "mobile"),
        ("Father's mobile", "father_mobile"),
        ("Mother's mobile", "mother_mobile"),
        ("Guardian's mobile", "guardian_mobile"),
    ):
        v = (fields.get(key) or "").strip()
        if v and not valid_mobile(v):
            errors.append(f"{label} '{v}' isn't a valid number — enter 10 digits")

    email = (fields.get("email") or "").strip()
    if email and not _EMAIL_RE.match(email):
        errors.append(f"Email '{email}' isn't valid — use name@example.com")

    dob = (fields.get("date_of_birth") or "").strip()
    if dob:
        try:
            d = date.fromisoformat(dob[:10])
            if d > date.today():
                errors.append("Date of birth can't be in the future")
            elif d.year < 1900:
                errors.append("Date of birth looks too old — check the year")
        except ValueError:
            errors.append(f"Date of birth '{dob}' isn't a valid date (use YYYY-MM-DD)")

    # Joining must not come after leaving.
    jd = (fields.get("joining_date") or "").strip()
    ld = (fields.get("leaving_date") or "").strip()
    try:
        if jd and ld and date.fromisoformat(jd[:10]) > date.fromisoformat(ld[:10]):
            errors.append("Joining date can't be after the leaving date")
    except ValueError:
        pass

    # Work shift: end must be after start; a shift over 12h is suspicious.
    ws, we = _hm_to_min(fields.get("work_start")), _hm_to_min(fields.get("work_end"))
    if ws is not None and we is not None:
        if we <= ws:
            errors.append("Work end time must be after the work start time")
        elif (we - ws) > 12 * 60:
            warnings.append(f"Shift is {round((we - ws) / 60, 1)}h long (over 12h) — double-check the work times")

    opening = fields.get("leave_balance_opening")
    if opening is not None:
        try:
            o = float(opening)
            if o < 0:
                errors.append("Opening leave balance can't be negative")
            elif o > 30:
                warnings.append(f"Opening leave balance of {opening} is unusually high (over 30 days) — double-check it")
        except (TypeError, ValueError):
            pass

    if is_athlete:
        has_parent = any(
            valid_mobile(fields.get(k))
            for k in ("father_mobile", "mother_mobile", "guardian_mobile")
        )
        if not has_parent:
            warnings.append("No valid parent/guardian mobile — absence & late alerts can't reach anyone")

    return errors, warnings
