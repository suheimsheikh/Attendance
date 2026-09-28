"""Feature Usage & Ageing — track which sidebar pages/modules are
actually used and when they were last touched, so admins can spot
dormant screens worth retiring.

Two data sources feed the report:
  1. Live pings — the frontend fires a lightweight POST on every route
     change (throttled client-side). Stored in `feature_usage`.
  2. Audit backfill — `audit_log` already records mutating actions
     (purchases, issues, stock-take, member edits, ...). We map those
     action prefixes onto features so the dashboard isn't blank on day
     one, even for pages that shipped before usage-tracking existed.

Super-admin only for the report; any signed-in user may ping.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from services.permissions import is_super_admin


# Canonical feature registry — mirrors the sidebar nav in Layout.jsx.
# `key` is the route path the frontend pings (window.location.pathname).
FEATURE_REGISTRY = [
    # Member
    {"key": "/", "label": "My Check In/Out", "group": "Member"},
    {"key": "/my-leaves", "label": "Leave/Tour/Late", "group": "Member"},
    {"key": "/my-corrections", "label": "My Corrections", "group": "Member"},
    {"key": "/tasks", "label": "Task Manager", "group": "Member"},
    {"key": "/escort-checkin", "label": "Escorts Check in/Out", "group": "Member"},
    {"key": "/rules", "label": "Attendance Rules", "group": "Member"},
    {"key": "/suggestions", "label": "Suggestions", "group": "Member"},
    {"key": "/profile", "label": "My Profile", "group": "Member"},
    # Attendance
    {"key": "/muster", "label": "Muster Roll", "group": "Attendance"},
    {"key": "/presence", "label": "Presence", "group": "Attendance"},
    {"key": "/parent-notifications", "label": "Parent Notifications", "group": "Attendance"},
    {"key": "/admin/calendar", "label": "Calendar", "group": "Attendance"},
    {"key": "/admin/dashboard", "label": "Dashboard", "group": "Attendance"},
    {"key": "/admin/approvals", "label": "Approvals", "group": "Attendance"},
    {"key": "/admin/reports", "label": "The Grid", "group": "Attendance"},
    {"key": "/admin/dar", "label": "DAR Reports", "group": "Attendance"},
    {"key": "/admin/leave-balances", "label": "Leave Balances", "group": "Attendance"},
    {"key": "/admin/masters", "label": "Masters", "group": "Attendance"},
    {"key": "/admin/data-quality", "label": "Rectify Data", "group": "Attendance"},
    # Kitchen
    {"key": "/meals", "label": "Meals Muster", "group": "Kitchen"},
    {"key": "/admin/meals-calendar", "label": "Consumption", "group": "Kitchen"},
    {"key": "/admin/meals-report", "label": "Purchases & Issues", "group": "Kitchen"},
    {"key": "/admin/recipes", "label": "Recipes", "group": "Kitchen"},
    {"key": "/admin/chefs-view", "label": "Chef's View", "group": "Kitchen"},
    {"key": "/admin/kitchen-audit", "label": "Kitchen Audit Log", "group": "Kitchen"},
    {"key": "/admin/kitchen-health", "label": "Data Health", "group": "Kitchen"},
    # System
    {"key": "/admin/office", "label": "Office Settings", "group": "System"},
    {"key": "/admin/category-health", "label": "Category Health", "group": "System"},
    {"key": "/admin/sms-log", "label": "SMS Log", "group": "System"},
    {"key": "/admin/notify-log", "label": "Parent Notify Log", "group": "System"},
    {"key": "/admin/escort-photos", "label": "Escort Photo Cleanup", "group": "System"},
    {"key": "/admin/audit-log", "label": "Audit Log", "group": "System"},
    {"key": "/admin/feature-usage", "label": "Feature Usage", "group": "System"},
    {"key": "/admin/backup", "label": "Backup & Restore", "group": "System"},
    {"key": "/whats-new", "label": "What's New", "group": "System"},
]

_VALID_KEYS = {f["key"] for f in FEATURE_REGISTRY}

# audit_log action-prefix → feature key. Longest prefixes first so
# "meals.item" wins over a hypothetical "meals" and "leave_balance"
# wins over "leave".
_AUDIT_MAP = sorted(
    [
        ("meals.issue", "/admin/meals-report"),
        ("meals.purchase", "/admin/meals-report"),
        ("meals.wastage", "/admin/meals-report"),
        ("meals.stocktake", "/admin/meals-report"),
        ("meals.item", "/admin/meals-report"),
        ("recipe", "/admin/recipes"),
        ("member", "/admin/masters"),
        ("category", "/admin/masters"),
        ("role", "/admin/masters"),
        ("institution", "/admin/masters"),
        ("fleet", "/admin/masters"),
        ("leave_balance", "/admin/leave-balances"),
        ("office", "/admin/office"),
        ("task", "/tasks"),
        ("rule", "/rules"),
        ("suggestion", "/suggestions"),
        ("dar", "/admin/dar"),
        ("checkin_approval", "/admin/approvals"),
        ("correction", "/admin/approvals"),
        ("overtime", "/admin/approvals"),
        ("leave", "/admin/approvals"),
        ("parent_notify", "/admin/notify-log"),
        ("notify", "/admin/notify-log"),
        ("attendance", "/admin/reports"),
    ],
    key=lambda t: -len(t[0]),
)


def _resolve_feature(path: str) -> Optional[str]:
    """Map a pinged pathname to a registry key. Exact match first, then
    longest-prefix (so `/admin/members` folds into `/admin/masters`-style
    parents if ever added). Root `/` only matches exactly."""
    if not path:
        return None
    p = path.split("?")[0].rstrip("/") or "/"
    if p in _VALID_KEYS:
        return p
    best = None
    for k in _VALID_KEYS:
        if k == "/":
            continue
        if p.startswith(k + "/") and (best is None or len(k) > len(best)):
            best = k
    return best


def _map_action(action: str) -> Optional[str]:
    if not action:
        return None
    for prefix, key in _AUDIT_MAP:
        if action.startswith(prefix):
            return key
    return None


def _bucket(last_iso: Optional[str], now: datetime):
    """Return (bucket, days_since). Buckets: active/stale/dormant/never."""
    if not last_iso:
        return "never", None
    try:
        dt = datetime.fromisoformat(last_iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return "never", None
    days = max(0, (now - dt).days)
    if days < 30:
        return "active", days
    if days < 90:
        return "stale", days
    return "dormant", days


class PingIn(BaseModel):
    path: str


def make_router(db, get_current_user, require_admin) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.post("/usage/ping")
    async def ping(body: PingIn, user: dict = Depends(get_current_user)):
        """Record a page visit. Fire-and-forget; unknown paths ignored."""
        key = _resolve_feature(body.path)
        if not key:
            return {"ok": False}
        now = datetime.now(timezone.utc).isoformat()
        try:
            await db.feature_usage.update_one(
                {"feature_key": key},
                {
                    "$inc": {"count": 1},
                    "$set": {
                        "last_used_at": now,
                        "last_used_by": user.get("id"),
                        "last_used_by_name": user.get("full_name") or user.get("email"),
                        "last_used_by_role": user.get("role"),
                    },
                    "$setOnInsert": {"feature_key": key, "first_used_at": now},
                },
                upsert=True,
            )
        except Exception:
            return {"ok": False}
        return {"ok": True, "feature_key": key}

    @router.get("/usage/report")
    async def usage_report(admin: dict = Depends(require_admin)):
        """Super-admin: every sidebar feature with live-ping counts,
        last-used date (max of live + audit backfill), and an ageing
        bucket."""
        if not is_super_admin(admin):
            raise HTTPException(status_code=403, detail="Super Admin only")

        usage = {}
        async for u in db.feature_usage.find({}, {"_id": 0}):
            usage[u.get("feature_key")] = u

        # Backfill last-used from the audit log (one grouped aggregation).
        backfill: dict[str, dict] = {}
        try:
            agg = await db.audit_log.aggregate([
                {"$group": {"_id": "$action",
                            "last": {"$max": "$at"},
                            "count": {"$sum": 1}}},
            ]).to_list(2000)
        except Exception:
            agg = []
        for r in agg:
            fk = _map_action(r.get("_id") or "")
            if not fk:
                continue
            cur = backfill.setdefault(fk, {"last": "", "count": 0})
            last = r.get("last") or ""
            if last > cur["last"]:
                cur["last"] = last
            cur["count"] += int(r.get("count") or 0)

        now = datetime.now(timezone.utc)
        rows = []
        summary = {"active": 0, "stale": 0, "dormant": 0, "never": 0}
        for f in FEATURE_REGISTRY:
            u = usage.get(f["key"]) or {}
            bf = backfill.get(f["key"]) or {}
            live_last = u.get("last_used_at") or ""
            audit_last = bf.get("last") or ""
            last = max(live_last, audit_last) or None
            bucket, days = _bucket(last, now)
            summary[bucket] = summary.get(bucket, 0) + 1
            rows.append({
                "key": f["key"],
                "label": f["label"],
                "group": f["group"],
                "last_used_at": last,
                "last_used_by_name": u.get("last_used_by_name"),
                "views": int(u.get("count") or 0),
                "audit_events": int(bf.get("count") or 0),
                "days_since": days,
                "bucket": bucket,
                "source": ("live" if live_last and live_last >= audit_last
                           else ("audit" if audit_last else None)),
            })
        return {"rows": rows, "summary": summary,
                "total": len(rows), "generated_at": now.isoformat()}

    return router
