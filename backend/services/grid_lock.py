"""Month-lock guard shared by PayCraft API and portal-native write paths.

A month locked via POST /api/grid/lock is frozen for payroll: any write
that would change attendance / leave for a date in that month must 409.
"""
from fastapi import HTTPException


async def get_month_lock(db, month: str) -> dict:
    return await db.grid_locks.find_one({"month": month}, {"_id": 0}) or {}


async def assert_month_unlocked(db, month: str) -> None:
    lk = await get_month_lock(db, month)
    if lk.get("locked"):
        who = lk.get("locked_by_name") or lk.get("locked_by") or "an admin"
        raise HTTPException(
            status_code=409,
            detail=f"Month {month} is locked for payroll (by {who}). Unlock it first.",
        )


def _months_between(start_iso: str, end_iso: str) -> list:
    y, m = int(start_iso[:4]), int(start_iso[5:7])
    ey, em = int(end_iso[:4]), int(end_iso[5:7])
    out = []
    while (y, m) <= (ey, em):
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m > 12:
            y, m = y + 1, 1
    return out


async def assert_dates_unlocked(db, start_iso: str, end_iso: str | None = None) -> None:
    if not start_iso:
        return
    for month in _months_between(start_iso, end_iso or start_iso):
        await assert_month_unlocked(db, month)
