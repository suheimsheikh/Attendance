"""App-wide HTTP middleware as one pure-ASGI layer (Oct 2026 refactor).

Replaces five `BaseHTTPMiddleware` wrappers (request-id/access log, read-only
service tokens, client-id capture, stable cache headers, embed frame headers)
whose `call_next` raised "RuntimeError: No response returned." whenever a
client disconnected mid-request. Behaviour per request is unchanged:

  • X-Request-ID: accepted from the client (sanitised, ≤64 chars) or minted;
    echoed on the response, set on `request.state.request_id`, logged with
    status + duration (health pings skipped).
  • `svc_` bearer tokens are read-only → 403 on state-changing methods.
  • X-Client-Id stored in a contextvar for live-update echo suppression.
  • GET 200 on reference-data prefixes gets `Cache-Control: private, no-cache`
    unless the route set its own policy.
  • CSP `frame-ancestors` allow-list on every response; X-Frame-Options removed.
"""
from __future__ import annotations

import logging
import re
import time
import uuid

from starlette.datastructures import Headers, MutableHeaders
from starlette.responses import JSONResponse

from services.client_ctx import current_client_id

_req_logger = logging.getLogger("ishowedup.access")
_RID_STRIP = re.compile(r"[^A-Za-z0-9_-]")
_WRITE_EXEMPT = ("GET", "HEAD", "OPTIONS")

CACHEABLE_GET_PREFIXES = (
    "/api/office",
    "/api/institutions",
    "/api/fleets",
    "/api/masters/categories",
    "/api/roles",
    "/api/holidays",
    "/api/changelog",
    "/api/version",
)


def _is_cacheable(path: str) -> bool:
    return any(path == p or path.startswith(p + "/") for p in CACHEABLE_GET_PREFIXES)


class AppHttpMiddleware:
    def __init__(self, app, frame_ancestors: str):
        self.app = app
        self.frame_ancestors = frame_ancestors

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        method, path = scope["method"], scope["path"]
        rid = _RID_STRIP.sub("", headers.get("x-request-id", ""))[:64] or uuid.uuid4().hex[:12]
        scope.setdefault("state", {})["request_id"] = rid
        current_client_id.set(headers.get("x-client-id", ""))
        status = {"code": 0}

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                status["code"] = message["status"]
                h = MutableHeaders(scope=message)
                h["X-Request-ID"] = rid
                if method == "GET" and message["status"] == 200 and _is_cacheable(path) \
                        and "cache-control" not in h:
                    h["Cache-Control"] = "private, no-cache"
                h["Content-Security-Policy"] = self.frame_ancestors
                if "x-frame-options" in h:
                    del h["x-frame-options"]
            await send(message)

        scheme, _, cred = headers.get("authorization", "").partition(" ")
        read_only_block = scheme.lower() == "bearer" and cred.startswith("svc_") and method not in _WRITE_EXEMPT
        app = JSONResponse(status_code=403, content={"detail": "This API token is read-only"}) \
            if read_only_block else self.app

        started = time.perf_counter()
        try:
            await app(scope, receive, send_wrapper)
        except Exception:
            _req_logger.exception("rid=%s %s %s -> EXC %dms", rid, method, path,
                                  int((time.perf_counter() - started) * 1000))
            raise
        if path != "/api/health":
            _req_logger.info("rid=%s %s %s -> %d %dms", rid, method, path, status["code"],
                             int((time.perf_counter() - started) * 1000))
