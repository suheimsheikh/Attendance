"""
Reports endpoints — split out of `server.py`. Hours report, payroll report,
daily leave/tour report, and the CSV/PDF exports for each.

Heavy lifting (the `compute_hours_report` SQL-shaped aggregation) still lives
in `server.py` and is passed in via the factory. Same for `enrich_leaves`,
which is sourced from `routes.leaves` after that router is mounted.
"""
from __future__ import annotations

from routes.reports.common import (
    date,
    timedelta,
    Optional,
    APIRouter,
    HTTPException,
    _classify_timeline_day,
)
from routes.reports.hours import register as _reg_hours
from services.scope import athlete_like_keys
from routes.reports.timeline import register as _reg_timeline
from routes.reports.grid import register as _reg_grid
from routes.reports.grid_api import register as _reg_grid_api
from routes.reports.ledgers import register as _reg_ledgers


def make_router(db, require_admin, get_current_user, compute_hours_report, enrich_leaves) -> APIRouter:
    router = APIRouter(prefix="/api")

    def _ledger_window(year: Optional[int], month: Optional[str]) -> tuple[str, str, str]:
        """Resolve the (start_iso, end_iso, label) window for a ledger
        endpoint. `month` (YYYY-MM) wins over `year` — added 15 Feb 2026
        so all ledger drill-downs restrict to the current month by
        default (user request: "All ledgers should be restricted to the
        current month"). Older callers still pass `year` for
        year-wide PDF exports.
        """
        if month:
            try:
                y, m = (int(x) for x in month.split("-"))
                start_d = date(y, m, 1)
                end_d = (date(y + 1, 1, 1) if m == 12 else date(y, m + 1, 1)) - timedelta(days=1)
                return start_d.isoformat(), end_d.isoformat(), month
            except (ValueError, AttributeError):
                raise HTTPException(status_code=400, detail="month must be YYYY-MM")
        if year is not None:
            return f"{year}-01-01", f"{year}-12-31", str(year)
        raise HTTPException(status_code=400, detail="Either `month` (YYYY-MM) or `year` must be provided")

    async def _athlete_like_keys(db_) -> set:
        """Category keys flagged `is_athlete_like=True` (via the shared
        scope helper). Falls back to the seeded pair if the categories
        master isn't populated yet (fresh install / test)."""
        return set(await athlete_like_keys(db_))

    _ns = _reg_hours(router, _athlete_like_keys=_athlete_like_keys, compute_hours_report=compute_hours_report, db=db, enrich_leaves=enrich_leaves, get_current_user=get_current_user, require_admin=require_admin)

    _ns = _reg_timeline(router, db=db, require_admin=require_admin)

    _ns = _reg_grid(router, _athlete_like_keys=_athlete_like_keys, db=db, require_admin=require_admin)
    _grid_impl = _ns["_grid_impl"]

    _ns = _reg_grid_api(router, _grid_impl=_grid_impl, _ledger_window=_ledger_window, db=db, enrich_leaves=enrich_leaves, require_admin=require_admin)


    _ns = _reg_ledgers(router, _ledger_window=_ledger_window, db=db, require_admin=require_admin)

    # Expose the month-grid engine so server-to-server endpoints (e.g. the
    # PayCraft /leave-balances feed) can read the SAME per-member month
    # totals the grid shows — no reimplementation, no drift.
    router.grid_impl = _grid_impl
    return router
