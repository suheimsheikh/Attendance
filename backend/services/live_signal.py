"""App-wide live-update signal (Oct 2026). Mutations bump a Mongo-backed seq;
GET /api/events (SSE) pushes it so open tabs refresh just the affected data
inline instead of polling every minute. Same pattern as /api/meals/events."""
import logging

from services.client_ctx import current_client_id
from services.time_utils import now_utc


async def bump(db, scope: str) -> None:
    try:
        await db.config.update_one(
            {"id": "app_signal"},
            {"$inc": {"seq": 1},
             "$set": {"scope": scope, "client": current_client_id.get(), "at": now_utc().isoformat()}},
            upsert=True,
        )
    except Exception:
        logging.getLogger("server").warning("app signal bump failed", exc_info=True)
