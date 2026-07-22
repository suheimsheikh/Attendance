"""Role/permission helpers shared across route modules.

Kept in a dedicated module so both `server.py` and `routes/*` can import
it without the classic ``from server import ...`` circular import that
occurs whenever a router needs a helper defined in server.py.
"""
from __future__ import annotations

import os

# Super-admin gating (04 Feb 2026). Env var ``SUPER_ADMIN_PHONES`` is a
# comma-separated whitelist of phone numbers whose owners see the
# ``Total Hours`` and ``Average Hours per Day`` columns on Reports. Kept
# out of the database so ops can seed it via .env — the DB user
# document still just carries ``role="admin"``.
_SUPER_ADMIN_PHONES = frozenset(
    p.strip() for p in (os.environ.get("SUPER_ADMIN_PHONES") or "9849002111").split(",")
    if p.strip()
)


def is_super_admin(user: dict) -> bool:
    """True when the user is an admin AND their mobile matches the env
    whitelist. Guards a small set of privacy-sensitive columns (hours
    worked) that only the top-of-org account should see. The field is
    stored as ``mobile`` on the user document (legacy naming); we also
    check ``phone`` for enriched dicts coming from client-side.
    """
    if not user or user.get("role") != "admin":
        return False
    mob = str(user.get("mobile") or user.get("phone") or "").strip()
    return bool(mob) and mob in _SUPER_ADMIN_PHONES



def is_ex_member(user: dict, today_iso: str | None = None) -> bool:
    """True when the user has been off-boarded (`leaving_date` set and
    already in the past). Used as a hard cutoff on check-in / muster /
    scan-card endpoints so ex-members can't accidentally clock in after
    their exit — the record still exists (to preserve history and leave
    balances) but new attendance is blocked.

    24 Feb 2026 — user request: "How do I exit a person who has
    resigned without disturbing attendance and balance leaves." The
    intent is display + write-guard: history stays, future check-ins
    stop.
    """
    from datetime import date as _date
    if not user:
        return False
    lv = (user.get("leaving_date") or "").strip()
    if not lv:
        return False
    today = today_iso or _date.today().isoformat()
    return lv < today
