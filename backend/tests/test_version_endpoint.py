"""Smoke test for the /api/version endpoint (30 Jun 2026)."""
import os
import subprocess

import pytest
import requests


def test_version_endpoint_returns_string(base_url):
    r = requests.get(f"{base_url}/api/version", timeout=10)
    assert r.status_code == 200, r.text
    data = r.json()
    assert "version" in data
    assert isinstance(data["version"], str)
    assert data["version"], "version must not be empty"


def test_version_endpoint_public_no_auth(base_url):
    """The endpoint must not require an Authorization header — the
    frontend polls it even on the login screen so users see the
    'refresh' prompt even before signing in."""
    r = requests.get(f"{base_url}/api/version", timeout=10)
    assert r.status_code == 200
    # No 401/403 without auth.


def test_version_endpoint_stable_across_calls(base_url):
    """Two immediate calls must return the same value (endpoint is
    cached at import time so version-poller comparisons are stable)."""
    a = requests.get(f"{base_url}/api/version", timeout=10).json()["version"]
    b = requests.get(f"{base_url}/api/version", timeout=10).json()["version"]
    assert a == b


def test_version_env_override_wins():
    """Unit-level: when APP_VERSION is set, _cached_version returns it."""
    from routes.office import _cached_version
    _cached_version.cache_clear()
    os.environ["APP_VERSION"] = "test-sha-abc123"
    try:
        assert _cached_version() == "test-sha-abc123"
    finally:
        os.environ.pop("APP_VERSION", None)
        _cached_version.cache_clear()


def test_version_git_fallback_when_no_env():
    """Without APP_VERSION, we should fall back to git SHA (if the .git
    dir is present) or the boot-timestamp string."""
    from routes.office import _cached_version
    os.environ.pop("APP_VERSION", None)
    _cached_version.cache_clear()
    v = _cached_version()
    assert isinstance(v, str) and v
    # Either a 7-char (or so) hex git SHA or "boot-<epoch>".
    assert v.startswith("boot-") or all(c in "0123456789abcdef" for c in v.lower())
    _cached_version.cache_clear()
