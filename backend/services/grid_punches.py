"""Punch-only metadata for the integration Grid; no payroll recalculation."""
from datetime import datetime

from grid_models import GridPunchCell
from services.time_utils import office_tz


def _punch_hm(value: str | None, office: dict | None) -> str | None:
    if not value:
        return None
    try:
        stamp = datetime.fromisoformat(value)
        tz = office_tz(office)
        # Time-adjust corrections store naive office-local timestamps.
        # Live punches are offset-aware UTC. Treating naive as UTC would
        # silently add 5h30 to corrected punches in the payroll feed.
        if stamp.tzinfo is None:
            stamp = stamp.replace(tzinfo=tz)
        return stamp.astimezone(tz).strftime("%H:%M")
    except (ValueError, TypeError, OverflowError):
        return None


def grid_punch_meta(days: list[str], cells: list[str], attendance: dict,
                    office: dict | None) -> dict[str, dict]:
    result = {}
    for iso, code in zip(days, cells):
        session = attendance.get(iso) or {}
        # Legacy auto-closures may predate the missing_checkout flag.
        # An explicit False means an admin subsequently corrected the punch.
        missing_out = session.get("missing_checkout", session.get("auto_checkout", False))
        check_in = session.get("check_in_at")
        check_out = None if missing_out else session.get("check_out_at")
        values = {"code": code}
        # Only Grid-classified worked days expose punches. Stale records on
        # NJ/LF dates or manual leave/off overrides must remain code-only,
        # otherwise consumers could accidentally pay excluded days.
        # A worked-day override without a record has two explicit nulls.
        if code in {"P", "LT", "HD"}:
            values.update({"in": _punch_hm(check_in, office),
                           "out": _punch_hm(check_out, office)})
        result[iso] = GridPunchCell(**values).model_dump(by_alias=True, exclude_unset=True)
    return result