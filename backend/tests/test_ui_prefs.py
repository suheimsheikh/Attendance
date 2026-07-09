"""Per-user UI preferences endpoint (4 Feb 2026).

Covers:
  • empty GET returns {}
  • PATCH persists and round-trips
  • PATCH merges (doesn't clobber prior keys)
  • null value un-sets a pref
  • payload larger than the 4 KB cap → 413
  • unauthenticated request → 401
"""
from __future__ import annotations

import uuid

import requests


def _fresh_user(admin_client, base_url):
    """Spin a short-lived user so tests don't pollute the admin's own
    prefs blob. Returns (id, token, requests.Session)."""
    email = f"prefs-{uuid.uuid4().hex[:6]}@yachtclub.in"
    r = admin_client.post(f"{base_url}/api/members", json={
        "email": email, "password": "Prefs@1234",
        "full_name": "Prefs Regression", "role": "member",
        "category": "staff",
    }, timeout=30)
    assert r.status_code == 200, r.text
    uid = r.json()["id"]
    tok = requests.post(f"{base_url}/api/auth/login",
                        json={"email": email, "password": "Prefs@1234"},
                        timeout=15).json()["access_token"]
    s = requests.Session()
    s.headers.update({"Authorization": f"Bearer {tok}",
                      "Content-Type": "application/json"})
    return uid, tok, s


def test_ui_prefs_get_empty(admin_client, base_url):
    uid, _t, sess = _fresh_user(admin_client, base_url)
    try:
        r = sess.get(f"{base_url}/api/me/ui-prefs", timeout=15)
        assert r.status_code == 200
        assert r.json() == {}
    finally:
        admin_client.delete(f"{base_url}/api/members/{uid}", timeout=15)


def test_ui_prefs_patch_persists(admin_client, base_url):
    uid, _t, sess = _fresh_user(admin_client, base_url)
    try:
        r = sess.patch(f"{base_url}/api/me/ui-prefs", json={
            "sidebar_collapsed": ["masters", "system"],
        }, timeout=15)
        assert r.status_code == 200
        assert r.json()["sidebar_collapsed"] == ["masters", "system"]

        # Round-trip via GET
        r2 = sess.get(f"{base_url}/api/me/ui-prefs", timeout=15)
        assert r2.status_code == 200
        assert r2.json()["sidebar_collapsed"] == ["masters", "system"]
    finally:
        admin_client.delete(f"{base_url}/api/members/{uid}", timeout=15)


def test_ui_prefs_patch_merges(admin_client, base_url):
    uid, _t, sess = _fresh_user(admin_client, base_url)
    try:
        sess.patch(f"{base_url}/api/me/ui-prefs", json={"foo": "bar"}, timeout=15)
        r = sess.patch(f"{base_url}/api/me/ui-prefs", json={"baz": 42}, timeout=15)
        assert r.status_code == 200
        # Both keys survive.
        body = r.json()
        assert body["foo"] == "bar"
        assert body["baz"] == 42
    finally:
        admin_client.delete(f"{base_url}/api/members/{uid}", timeout=15)


def test_ui_prefs_null_unsets_key(admin_client, base_url):
    uid, _t, sess = _fresh_user(admin_client, base_url)
    try:
        sess.patch(f"{base_url}/api/me/ui-prefs", json={"foo": "bar"}, timeout=15)
        r = sess.patch(f"{base_url}/api/me/ui-prefs", json={"foo": None}, timeout=15)
        assert r.status_code == 200
        assert "foo" not in r.json()
    finally:
        admin_client.delete(f"{base_url}/api/members/{uid}", timeout=15)


def test_ui_prefs_size_cap_returns_413(admin_client, base_url):
    uid, _t, sess = _fresh_user(admin_client, base_url)
    try:
        big = "x" * 5000  # 5 KB > 4 KB cap
        r = sess.patch(f"{base_url}/api/me/ui-prefs", json={"blob": big},
                       timeout=15)
        assert r.status_code == 413
    finally:
        admin_client.delete(f"{base_url}/api/members/{uid}", timeout=15)


def test_ui_prefs_unauth_gets_401(base_url):
    r = requests.get(f"{base_url}/api/me/ui-prefs", timeout=15)
    assert r.status_code in (401, 403)
