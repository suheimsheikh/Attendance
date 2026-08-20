"""
Lightweight in-app presence + row-focus signals (Feb 2026).

**Presence** — chef/admin sessions POST a heartbeat every ~20 s; a
GET returns everyone whose last heartbeat is within a 90 s window.
Consumed by the Muster & Pantry pages to show "who's here right now".

**Row-focus** — piggybacks on the existing meals SSE channel. When a
chef focuses an editable cell on Daily Entry the client POSTs the
cell key; the server stashes it in an in-memory dict with a 15 s TTL
and bumps the meals SSE signal so peer tabs can query for the fresh
focus map. On blur the client DELETEs the key.

Both signals are ephemeral (no persistence beyond the current
process). If the backend restarts, everyone re-heartbeats within 30 s
and everything self-heals.
"""
import time
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

# In-memory presence store — user_id → {"id","name","role","last_seen"}.
# Single-process app so a dict is enough; add Redis if we horizontally
# scale later.
_presence: dict[str, dict] = {}
# Row-focus store — (scope, date, item_id) → {"user_id","name","expires_at"}
_row_focus: dict[tuple, dict] = {}

PRESENCE_TTL = 90.0   # s — heartbeats every ~20-30s from clients
FOCUS_TTL    = 15.0   # s — refreshed on every keystroke via the same POST


class HeartbeatIn(BaseModel):
    # Where in the app the user currently is; used to show context in
    # the presence chip (e.g. "on Muster", "on Daily Entry").
    where: Optional[str] = None


class RowFocusIn(BaseModel):
    scope: str          # "purchase" | "issue" | "wastage"
    date: str           # yyyy-mm-dd
    item_id: str
    action: str         # "focus" | "blur"


def _prune():
    """Drop expired entries from both stores. Called on every request."""
    now = time.time()
    for uid, rec in list(_presence.items()):
        if rec.get("last_seen", 0) + PRESENCE_TTL < now:
            _presence.pop(uid, None)
    for key, rec in list(_row_focus.items()):
        if rec.get("expires_at", 0) < now:
            _row_focus.pop(key, None)


def make_router(require_chef_or_admin, signal_meals):
    """Build the presence router.

    `signal_meals` is the same coroutine used by /meals endpoints to
    bump the SSE channel — we call it with scope='focus' whenever a
    row-focus change happens so peer clients refresh their focus map.
    """
    router = APIRouter(prefix="/api", tags=["presence"])

    @router.post("/presence/ping")
    async def ping(body: HeartbeatIn, user: dict = Depends(require_chef_or_admin)):
        """Heartbeat — keeps the user in the "online now" list for the
        next 90 s. Should be called every 20-30 s by chef+admin clients."""
        _prune()
        uid = user.get("id")
        if not uid:
            raise HTTPException(status_code=400, detail="No user id on session")
        _presence[uid] = {
            "id": uid,
            "name": user.get("full_name") or user.get("email") or "—",
            "role": user.get("role"),
            "photo": user.get("photo") or None,
            "where": (body.where or "")[:60],
            "last_seen": time.time(),
        }
        return {"ok": True, "online_count": len(_presence)}

    @router.get("/presence/online")
    async def online(user: dict = Depends(require_chef_or_admin)):
        """Return the currently-online chef+admin roster sorted by name."""
        _prune()
        rows = sorted(_presence.values(), key=lambda r: (r.get("name") or "").lower())
        return {"users": rows}

    @router.get("/presence/public")
    async def presence_public():
        """Public, unauthenticated "who's on shift" widget for the login
        page (Feb 2026 request — "show 'Priya just came online' so chefs
        know they've got backup arriving").

        Returns only first-name + role + how long ago they pinged, and
        only for users seen in the last 15 minutes. No IDs, no photos,
        no phone numbers — safe to render before the visitor authenticates.
        """
        _prune()
        now = time.time()
        rows = []
        for rec in _presence.values():
            last = rec.get("last_seen") or 0
            age = int(now - last)
            if age > 15 * 60:   # stale — window is intentionally short
                continue
            name = (rec.get("name") or "").split(" ")[0] or "Someone"
            rows.append({
                "first_name": name,
                "role": rec.get("role"),
                "age_seconds": age,
                "since_seconds": max(age, 0),
            })
        # Freshest first so the login page can highlight the newest.
        rows.sort(key=lambda r: r["age_seconds"])
        return {"count": len(rows), "users": rows[:20]}

    @router.post("/meals/focus")
    async def set_focus(body: RowFocusIn, user: dict = Depends(require_chef_or_admin)):
        """Mark (or clear) the row this user is currently editing on
        Daily Entry. Broadcast to peers via the meals SSE channel so
        they can show a soft "🟠 Priya is editing this row" chip."""
        _prune()
        key = (body.scope, body.date, body.item_id)
        if body.action == "focus":
            _row_focus[key] = {
                "user_id": user.get("id"),
                "name": user.get("full_name") or user.get("email") or "—",
                "expires_at": time.time() + FOCUS_TTL,
            }
        elif body.action == "blur":
            # Only clear if THIS user held the lock (peer's focus is
            # more recent — don't stomp it).
            cur = _row_focus.get(key)
            if cur and cur.get("user_id") == user.get("id"):
                _row_focus.pop(key, None)
        else:
            raise HTTPException(status_code=400, detail="action must be focus|blur")
        # Bump the meals SSE signal so peers know to refresh their map.
        try: await signal_meals("focus", body.date)
        except Exception: pass
        return {"ok": True}

    @router.get("/meals/focus")
    async def get_focus(date: str, user: dict = Depends(require_chef_or_admin)):
        """Fresh snapshot of who's editing what on the given day.
        Peer clients query this whenever an SSE 'focus' scope arrives."""
        _prune()
        rows = []
        for (scope, d, item_id), rec in _row_focus.items():
            if d != date: continue
            # Skip our own focus — the client already knows about it.
            if rec.get("user_id") == user.get("id"): continue
            rows.append({
                "scope": scope, "item_id": item_id,
                "user_id": rec["user_id"], "name": rec["name"],
            })
        return {"focus": rows}

    return router
