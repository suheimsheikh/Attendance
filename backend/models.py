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
    # OT eligibility (7 Jul 2026). Explicit False disables OT accrual;
    # None/True → category-based defaults apply.
    ot_eligible: Optional[bool] = None
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
