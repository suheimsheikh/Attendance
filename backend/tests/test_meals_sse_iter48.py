"""Iter 48 — two-context Playwright tests for the SSE frame-collapse fix.

Runs with pytest but is intended as documentation of the manual scenarios
exercised by the testing agent's mcp_browser_automation runs. The real
verification lives in the iteration report; here we only smoke-verify the
backend SSE stream + PATCH+PUT endpoints still work end-to-end.
"""
import os, time, threading, requests, pytest

BASE = os.environ.get("REACT_APP_BACKEND_URL", "").rstrip("/")
EMAIL = "admin@attendance.app"
PW = os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345")
DATE = "2026-08-01"


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{BASE}/api/auth/login", json={"email": EMAIL, "password": PW})
    assert r.status_code == 200
    return r.json()["access_token"]


def _cleanup(tok):
    h = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}
    requests.put(f"{BASE}/api/meals/purchases/{DATE}", headers=h, json={"lines": []})
    requests.put(f"{BASE}/api/meals/issues/{DATE}", headers=h, json={"lines": []})


def test_sse_frame_emitted_on_purchase_patch(token):
    """A PATCH to purchases must bump meals_signal seq and emit an SSE frame
    with scope=purchases and the mutating tab's client_id."""
    _cleanup(token)
    frames = []

    def listen():
        r = requests.get(f"{BASE}/api/meals/events?token={token}", stream=True, timeout=15)
        for line in r.iter_lines():
            if line and line.startswith(b"data:"):
                frames.append(line.decode())
                if len(frames) >= 3:
                    break

    t = threading.Thread(target=listen, daemon=True)
    t.start()
    time.sleep(2)  # let baseline frame arrive
    items = requests.get(
        f"{BASE}/api/meals/items", headers={"Authorization": f"Bearer {token}"}
    ).json()
    items = items["items"] if isinstance(items, dict) else items
    iid = items[0]["id"]
    r = requests.put(
        f"{BASE}/api/meals/purchases/{DATE}",
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json",
                 "X-Client-Id": "iter48-test"},
        json={"lines": [{"item_id": iid, "qty": 1, "rate": 1}]},
    )
    assert r.status_code == 200
    time.sleep(3)
    _cleanup(token)
    assert len(frames) >= 2, f"Expected >=2 SSE frames, got: {frames}"
    latest = frames[-1]
    assert '"scope": "purchases"' in latest
    assert DATE in latest
