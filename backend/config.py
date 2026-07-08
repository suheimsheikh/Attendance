"""
Shared feature flags + config constants.

Kept in a dedicated module so both `server.py` and the route modules
under `routes/` can import from it without creating a cycle. Anything
that both sides need to read (e.g. approval-workflow toggles) lives
here.

Do NOT import from `server` or from any `routes/*` module here — this
module must sit at the bottom of the dependency graph.
"""
from __future__ import annotations


# ---------------------------------------------------------------------------
# Approval workflow flags (introduced 08 Jul 2026 at admin's request).
#
# When True, the system automatically routes anomalous check-ins and
# earned-overtime into the /admin/approvals queue. Admin wanted these
# OFF while cleaning up a large accumulated pre-launch backlog and
# handling these cases manually. Flip either back to True to restore
# the automatic queuing behavior — the underlying `late` /
# `out_of_geofence` / `overtime_total_min` fields are still calculated
# and stored so no historical data is lost by turning these off.
# ---------------------------------------------------------------------------
AUTO_APPROVAL_LATE_CHECKINS: bool = False
AUTO_APPROVAL_OVERTIME: bool = False
