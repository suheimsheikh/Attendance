"""Late-arrival, overtime, and excursion calculations.

These are pure functions — no DB calls. They consume already-loaded `office`,
`target` (the member doc), and timestamps, then return computed values.
Used by the attendance routes and the Presence Board endpoint.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Tuple

from .time_utils import office_tz

# OT policy: ONLY staff accrue overtime. Athletes, coaches and executives
# never accumulate OT minutes regardless of their check-in time.
OVERTIME_THRESHOLD_MIN = 30
OVERTIME_CATEGORIES = {"staff"}

# Athlete-like categories share the same rules across the app: no OT
# accrual (already handled by OVERTIME_CATEGORIES above), Breaks workflow
# instead of leaves, no leave-balance opening, and no comp-off accrual.
# "elite" was added when the Chef's View shipped so the kitchen can plan
# menus by fleet tier — elite kids are still athletes for every other
# system rule.
ATHLETE_CATEGORIES = {"athlete", "elite"}


def compute_late(office: dict, target: dict, ts: datetime, camp: Optional[dict] = None) -> Tuple[bool, int]:
    """Returns (is_late, minutes_late) comparing the check-in local time
    against the effective work_start + grace. If `camp` is provided, its
    `start_time` and (optional) `late_grace_minutes` override the member's
    defaults — this is how institutional camps replace a member's normal
    schedule. Hourly wagers have no set timings, so they're never late."""
    if is_hourly_wager(target):
        return False, 0
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
    # Whole seconds: 09:30:00 is on time, 09:30:01 is late (user rule, Oct 2026).
    local = ts.astimezone(office_tz(office)).replace(microsecond=0)
    threshold = local.replace(hour=h, minute=m, second=0) + timedelta(minutes=grace)
    if local > threshold:
        return True, -(-int((local - threshold).total_seconds()) // 60)
    return False, 0


def hm_to_minutes(hm: Optional[str]) -> Optional[int]:
    if not hm or not re.match(r"^\d{1,2}:\d{2}$", hm):
        return None
    h, m = (int(x) for x in hm.split(":"))
    return h * 60 + m


def round_half_hour_minutes(minutes: float) -> int:
    """Round a minute count to the nearest 30 minutes (a half hour), with
    the half-way point rounding UP. 0/negative → 0.

    Examples (user-confirmed rule): 5h44m (344) → 330 (5.5h);
    5h45m (345) → 360 (6.0h); 5h50m (350) → 360 (6.0h)."""
    if not minutes or minutes <= 0:
        return 0
    return int((minutes + 15) // 30) * 30


# Hourly wagers are paid for at most 8 hours a day (user rule, Oct 2026).
HOURLY_DAILY_CAP_MIN = 8 * 60


def is_hourly_wager(member: Optional[dict]) -> bool:
    """True when a member is paid purely for hours actually worked
    (per-member "Hourly wager" toggle). Such members get no leave /
    weekly-off pay; their pay is driven entirely by daily hours, fed to
    payroll through the OT channel."""
    return bool((member or {}).get("hourly_wager"))


def session_ot_minutes(member: Optional[dict], session: Optional[dict]) -> int:
    """OT minutes credited to payroll for ONE attendance session.

    Hourly-wager members are paid for the hours they were actually present
    (check-in → check-out, i.e. the stored `hours` field), expressed as
    overtime rounded to the nearest half hour and capped at 8 h a day
    (one session per day), and never accrue the
    standard early-in/late-out OT. Everyone else keeps their stamped
    `overtime_total_min`.

    This is the single source of truth for "OT passed to payroll" — every
    payroll-facing consumer (Grid totals, Attendance report, OT ledger,
    dashboard) routes through it so hourly-wager pay stays consistent."""
    session = session or {}
    if is_hourly_wager(member):
        hrs = session.get("hours")
        try:
            worked_min = float(hrs) * 60.0 if hrs else 0.0
        except (TypeError, ValueError):
            worked_min = 0.0
        return min(round_half_hour_minutes(worked_min), HOURLY_DAILY_CAP_MIN)
    return int(session.get("overtime_total_min") or 0)


def compute_overtime_in(office: Optional[dict], member: dict, ts: datetime) -> Tuple[int, str]:
    """Returns (early_minutes, work_start_hm). 0 if not applicable.

    Gated by two flags:
      • Member's `category` must be in OVERTIME_CATEGORIES (staff / coach /
        executive — athletes never accrue OT).
      • Member's `ot_eligible` must not be explicitly False. The flag is
        opt-out (added 7 Jul 2026): missing/None/True → compute as before;
        False → skip. Lets admins exclude specific staff members (e.g.
        salaried supervisors) from OT accrual without changing category.
    """
    if member.get("category") not in OVERTIME_CATEGORIES:
        return 0, ""
    if member.get("ot_eligible") is False:
        return 0, ""
    if member.get("hourly_wager"):
        # Hourly wagers are paid for actual hours worked, not early-in OT.
        return 0, ""
    work_start = member.get("work_start")
    ws_min = hm_to_minutes(work_start)
    if ws_min is None:
        return 0, ""
    local = ts.astimezone(office_tz(office))
    ts_min = local.hour * 60 + local.minute
    diff = ws_min - ts_min
    return (diff if diff >= OVERTIME_THRESHOLD_MIN else 0), work_start


def compute_overtime_out(office: Optional[dict], member: dict, ts: datetime) -> Tuple[int, str]:
    """Returns (late_minutes, work_end_hm). 0 if not applicable.

    Same eligibility rules as `compute_overtime_in` — see that docstring.
    """
    if member.get("category") not in OVERTIME_CATEGORIES:
        return 0, ""
    if member.get("ot_eligible") is False:
        return 0, ""
    if member.get("hourly_wager"):
        # Hourly wagers are paid for actual hours worked, not late-out OT.
        return 0, ""
    work_end = member.get("work_end")
    we_min = hm_to_minutes(work_end)
    if we_min is None:
        return 0, ""
    local = ts.astimezone(office_tz(office))
    ts_min = local.hour * 60 + local.minute
    diff = ts_min - we_min
    return (diff if diff >= OVERTIME_THRESHOLD_MIN else 0), work_end


def excursion_seconds(excursions: List[dict], up_to: Optional[datetime] = None) -> float:
    """Total away-seconds across closed excursions. If `up_to` is given,
    any still-open excursion is treated as closing at that moment (used at
    final check-out)."""
    total = 0.0
    for e in (excursions or []):
        if not e.get("out_at"):
            continue
        try:
            o = datetime.fromisoformat(e["out_at"])
            if o.tzinfo is None:
                o = o.replace(tzinfo=timezone.utc)
        except Exception:
            continue
        end = None
        if e.get("in_at"):
            try:
                end = datetime.fromisoformat(e["in_at"])
                if end.tzinfo is None:
                    end = end.replace(tzinfo=timezone.utc)
            except Exception:
                end = None
        elif up_to is not None:
            end = up_to
        if end:
            total += max(0.0, (end - o).total_seconds())
    return total


def open_excursion(sess: dict) -> Optional[dict]:
    for e in reversed(sess.get("excursions") or []):
        if e.get("out_at") and not e.get("in_at"):
            return e
    return None


def parse_expected_return(raw: Optional[str], office: Optional[dict], now: datetime) -> Optional[str]:
    """Accept either an HH:MM (today, office-local) or a full ISO datetime.
    Returns an ISO/UTC string suitable for storage in MongoDB."""
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
            # Naive datetimes are interpreted as office-local time (matches
            # how admins type "2026-07-01 18:00" into the UI without TZ info).
            dt = dt.replace(tzinfo=office_tz(office))
        return dt.astimezone(timezone.utc).isoformat()
    except Exception:
        return None
