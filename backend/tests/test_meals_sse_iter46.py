"""Iteration 46: SSE live pantry updates.

Tests:
  * GET /api/meals/events auth (401 no token / invalid token, 200 admin)
  * SSE emits baseline frame quickly then a new frame after a purchase
    PUT with a distinct X-Client-Id.
"""
import json
import os
import re
import threading
import time

import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
ADMIN_EMAIL = "admin@attendance.app"
ADMIN_PASSWORD = os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345")


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=15,
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def _pick_pantry_item(token):
    r = requests.get(
        f"{BASE_URL}/api/meals/items",
        headers={"Authorization": f"Bearer {token}"},
        timeout=15,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    items = data["items"] if isinstance(data, dict) else data
    # find an active/purchasable item
    for it in items:
        if it.get("id") and it.get("active", True):
            return it["id"]
    pytest.skip("no pantry items available")


_NO_KEEP = {"Connection": "close", "Accept-Encoding": "identity"}


def _fresh_get(url, **kw):
    """Use a brand-new session so we never reuse a pooled keep-alive
    connection from a previous test (the shared preview ingress
    sometimes stalls a reused connection for tiny error responses)."""
    s = requests.Session()
    try:
        return s.get(url, **kw)
    finally:
        s.close()


def test_events_401_without_token():
    r = _fresh_get(f"{BASE_URL}/api/meals/events", timeout=15, headers=_NO_KEEP)
    assert r.status_code in (401, 422), r.status_code


def test_events_401_invalid_token():
    r = _fresh_get(
        f"{BASE_URL}/api/meals/events?token=not-a-jwt",
        timeout=15, headers=_NO_KEEP,
    )
    assert r.status_code == 401, r.status_code


def _read_sse_frames(url, timeout, stop_after=None):
    """Yield parsed JSON data frames from an SSE stream until timeout
    (seconds) or `stop_after` frames received."""
    frames = []
    with requests.get(url, timeout=timeout, stream=True,
                      headers={"Accept-Encoding": "identity"}) as r:
        assert r.status_code == 200, r.text[:200]
        assert "text/event-stream" in r.headers.get("content-type", "")
        start = time.time()
        buf = b""
        for chunk in r.iter_content(chunk_size=1, decode_unicode=False):
            if chunk is None:
                continue
            buf += chunk
            while b"\n\n" in buf:
                event, buf = buf.split(b"\n\n", 1)
                for line in event.split(b"\n"):
                    if line.startswith(b"data: "):
                        try:
                            frames.append(json.loads(line[6:].decode("utf-8")))
                        except Exception:
                            pass
            if stop_after and len(frames) >= stop_after:
                break
            if time.time() - start > timeout:
                break
    return frames


def test_events_baseline_and_signal(admin_token):
    """Full flow: connect → baseline seq frame delivered quickly →
    PUT purchases with X-Client-Id=test-x → new frame with that client
    id and scope=purchases arrives within ~6s. Cleans up by zeroing."""
    item_id = _pick_pantry_item(admin_token)
    stream_url = f"{BASE_URL}/api/meals/events?token={admin_token}"

    results = {"frames": [], "err": None}

    def reader():
        try:
            results["frames"] = _read_sse_frames(stream_url, timeout=12, stop_after=2)
        except Exception as e:
            results["err"] = repr(e)

    t = threading.Thread(target=reader, daemon=True)
    t.start()
    # let baseline frame arrive
    time.sleep(3)

    put_r = requests.put(
        f"{BASE_URL}/api/meals/purchases/2026-08-02",
        headers={
            "Authorization": f"Bearer {admin_token}",
            "X-Client-Id": "test-x",
            "Content-Type": "application/json",
        },
        json={"lines": [{"item_id": item_id, "qty": 1, "rate": 1, "vendor_id": None}]},
        timeout=15,
    )
    assert put_r.status_code == 200, put_r.text

    t.join(timeout=10)

    # cleanup: zero the purchase
    requests.put(
        f"{BASE_URL}/api/meals/purchases/2026-08-02",
        headers={
            "Authorization": f"Bearer {admin_token}",
            "X-Client-Id": "test-x",
            "Content-Type": "application/json",
        },
        json={"lines": []},
        timeout=15,
    )

    assert results["err"] is None, results["err"]
    frames = results["frames"]
    assert len(frames) >= 2, f"expected >=2 frames, got {frames}"
    # baseline frame
    assert isinstance(frames[0].get("seq"), int)
    # second frame reflects our mutation
    later = [f for f in frames[1:] if f.get("seq", 0) > frames[0]["seq"]]
    assert later, f"no post-mutation frame: {frames}"
    latest = later[-1]
    assert latest.get("scope") == "purchases", latest
    assert latest.get("date") == "2026-08-02", latest
    assert latest.get("client") == "test-x", latest
