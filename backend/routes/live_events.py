"""GET /api/events — SSE stream of app-wide change signals (approvals / corrections).
EventSource can't send headers, so the JWT comes as ?token=. Emits the current seq on
connect, a frame whenever it moves, and a keepalive ping every ~20 s."""
import asyncio
import json

import jwt
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse


def make_router(db, jwt_secret: str, jwt_algo: str) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/events")
    async def app_events(token: str):
        try:
            payload = jwt.decode(token, jwt_secret, algorithms=[jwt_algo])
        except Exception:
            raise HTTPException(status_code=401, detail="Invalid or expired token")
        u = await db.users.find_one({"id": payload.get("sub")}, {"_id": 0, "id": 1, "active": 1})
        if not u or u.get("active") is False:
            raise HTTPException(status_code=403, detail="Not allowed")

        async def stream():
            yield ":" + (" " * 2048) + "\n\n"
            last, beat = None, 0
            while True:
                doc = await db.config.find_one({"id": "app_signal"}, {"_id": 0, "seq": 1, "scope": 1, "client": 1})
                seq = int((doc or {}).get("seq") or 0)
                if seq != last:
                    last = seq
                    yield "data: " + json.dumps({"seq": seq, "scope": (doc or {}).get("scope"),
                                                 "client": (doc or {}).get("client") or ""}) + "\n\n"
                beat += 1
                if beat % 20 == 0:
                    yield ": ping\n\n"
                await asyncio.sleep(1)

        return StreamingResponse(stream(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache, no-transform",
                                          "X-Accel-Buffering": "no", "Content-Encoding": "identity"})

    return router
