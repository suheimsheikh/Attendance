"""Pure-ASGI AppHttpMiddleware (Oct 2026): request-id echo, svc_ read-only
guard, CSP frame-ancestors, no X-Frame-Options, reference-data no-cache."""
from __future__ import annotations

import asyncio

from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from services.http_middleware import AppHttpMiddleware


async def _ok(request):
    return JSONResponse({"rid": request.state.request_id}, headers={"X-Frame-Options": "DENY"})


async def _slow(request):
    await asyncio.sleep(0.05)
    return JSONResponse({"ok": True})


def _client():
    app = Starlette(routes=[Route("/api/masters/categories", _ok), Route("/api/thing", _ok, methods=["GET", "POST"]),
                            Route("/api/slow", _slow)])
    app.add_middleware(AppHttpMiddleware, frame_ancestors="frame-ancestors 'self' https://x.example")
    return TestClient(app)


def test_request_id_echo_and_sanitised():
    r = _client().get("/api/thing", headers={"X-Request-ID": "ab c\n<d>"})
    assert r.headers["x-request-id"] == "abcd" == r.json()["rid"]
    assert len(_client().get("/api/thing").headers["x-request-id"]) == 12


def test_security_and_cache_headers():
    r = _client().get("/api/masters/categories")
    assert r.headers["content-security-policy"] == "frame-ancestors 'self' https://x.example"
    assert "x-frame-options" not in r.headers
    assert r.headers["cache-control"] == "private, no-cache"
    assert "cache-control" not in _client().get("/api/thing").headers


def test_svc_token_is_read_only():
    c = _client()
    assert c.get("/api/thing", headers={"Authorization": "Bearer svc_abc"}).status_code == 200
    r = c.post("/api/thing", headers={"Authorization": "Bearer svc_abc"})
    assert r.status_code == 403 and r.json()["detail"] == "This API token is read-only"
    assert r.headers["x-request-id"]
    assert c.post("/api/thing", headers={"Authorization": "Bearer user_jwt"}).status_code == 200
