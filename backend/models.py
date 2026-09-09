"""
Shared Pydantic models used across server.py and the split-out route modules.

Extracted from the monolith server.py during the 06/2026 modularisation
pass. Anything imported by more than one router belongs here so we don't
recreate import cycles when more route files are carved out of server.py.
"""
from __future__ import annotations

from typing import Optional
from pydantic import BaseModel


class UserPublic(BaseModel):
    """Public-facing user shape — what /auth/me, /members, etc. return.

    `email` / `role` / `category` are required for member-style users but
    null for escorts — keep the schema permissive so /auth/me can return
    both shapes through a single response_model.
    """
    id: str
    email: Optional[str] = None
    full_name: str
    role: Optional[str] = None
    category: Optional[str] = None
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
    # ISO YYYY-MM-DD. Optional — drives the "Happy birthday" flourish
    # on the Check-In greeting (added 7 Jul 2026).
    date_of_birth: Optional[str] = None
    # ISO YYYY-MM-DD of the day the member joined the academy. Drives
    # the Grid "NJ" (Not Joined) cell — days before this date render
    # as an em-dash on grey stripe instead of counting as absent
    # (added 14 Feb 2026, user request).
    joining_date: Optional[str] = None
    # ISO YYYY-MM-DD of the day the member exited the academy. Drives
    # the Grid "LF" (Left) cell — days after this date don't count
    # as absent. Optional.
    leaving_date: Optional[str] = None
    # OT eligibility (7 Jul 2026). Explicit False disables OT accrual;
    # None/True → category-based defaults apply.
    ot_eligible: Optional[bool] = None
    # DAR exemption (Sep 2026). Staff/coach/executive must file a Daily
    # Activity Report at check-out unless this is True.
    dar_exempt: Optional[bool] = None
    dar_required: Optional[bool] = None
    # Weekly off (day of week, lowercase e.g. "monday"). Drives comp-off
    # accrual and the "day off" bucket in Reports. Was silently stripped
    # from /members responses until 04 Feb 2026 because it wasn't
    # declared on UserPublic — the DB always had it.
    weekly_off: Optional[str] = None
    # Opening comp-off balance for the year (added at year-rollover so
    # unused comp-off carries forward). Same silent-strip fix as
    # weekly_off above.
    comp_off_opening: Optional[float] = None
    # Superuser flag (04 Feb 2026). True when the user's phone number
    # matches a comma-separated env whitelist (`SUPER_ADMIN_PHONES`).
    # Powers the "Hours" columns gating in Reports — only super admins
    # see Total Hours / Avg Hours. Nullable so non-enriched serialised
    # snapshots (e.g. from admin CSV import) don't break the model.
    is_super_admin: Optional[bool] = None
    # Optional decorated fields — populated by GET /members for the admin
    # Members page (Fleet / Last seen / Leave balance columns). Other
    # endpoints that return UserPublic just leave these as None.
    last_seen_date: Optional[str] = None
    leave_balance_opening: Optional[float] = None
    leave_balance_remaining: Optional[float] = None
    # Escort-token flag — when True the frontend routes the session to
    # /escort-checkin instead of the member self-check-in page.
    is_escort: Optional[bool] = None
    escort_id: Optional[str] = None
    phone: Optional[str] = None
