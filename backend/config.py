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
AUTO_APPROVAL_OVERTIME: bool = True


# ---------------------------------------------------------------------------
# Soft pagination caps — every `motor.to_list(N)` call across the codebase
# uses one of these. Centralising makes the implicit truncation limit
# obvious at a glance and easy to scale up when the academy grows past
# these numbers. Bumping any of them here is enough — no other code needs
# to know these values.
# ---------------------------------------------------------------------------
MAX_USERS: int = 5000          # roster + dropdowns. Academy is <500 today.
MAX_SESSIONS: int = 100000     # attendance rows in a single report window.
MAX_LEAVES: int = 20000
MAX_DEVICES: int = 2000
MAX_LOG_ROWS: int = 200


# ---------------------------------------------------------------------------
# Time-based tuning knobs. Adjusting any of these changes user-facing
# behaviour immediately on next restart; no data migration needed.
# ---------------------------------------------------------------------------
# Long-lived tokens for approved devices (passwordless phone login).
DEVICE_TOKEN_MINUTES: int = 60 * 24 * 365 * 2  # ~2 years

# How many days between forced profile-photo refreshes. Members
# re-capture once a year so coaches always see a current likeness on
# muster + the presence board.
PHOTO_REFRESH_DAYS: int = 365
