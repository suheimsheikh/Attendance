"""Unit tests for `services/auth_utils.py` — hash + token."""
import os
from datetime import datetime, timezone, timedelta

import jwt
import pytest

from services.auth_utils import (
    JWT_SECRET, JWT_ALGO, JWT_EXPIRES_MINUTES,
    hash_password, verify_password, create_token,
)


def test_hash_password_returns_bcrypt_string():
    h = hash_password("Admin@12345")
    assert h.startswith("$2b$") or h.startswith("$2a$") or h.startswith("$2y$")
    # New salt each time
    assert h != hash_password("Admin@12345")


def test_verify_password_accepts_correct_password():
    h = hash_password("S3cret!")
    assert verify_password("S3cret!", h) is True


def test_verify_password_rejects_wrong_password():
    h = hash_password("S3cret!")
    assert verify_password("s3cret!", h) is False  # case-sensitive
    assert verify_password("", h) is False


def test_verify_password_returns_false_on_malformed_hash():
    # Should not raise — corrupted DB value, treat as wrong password.
    assert verify_password("anything", "not-a-bcrypt-hash") is False


def test_create_token_encodes_user_id_and_role():
    tok = create_token("user-abc", "admin")
    payload = jwt.decode(tok, JWT_SECRET, algorithms=[JWT_ALGO])
    assert payload["sub"] == "user-abc"
    assert payload["role"] == "admin"
    assert "device_id" not in payload  # only included when provided
    # exp is in the future and roughly matches JWT_EXPIRES_MINUTES
    exp = datetime.fromtimestamp(payload["exp"], tz=timezone.utc)
    expected = datetime.now(timezone.utc) + timedelta(minutes=JWT_EXPIRES_MINUTES)
    assert abs((exp - expected).total_seconds()) < 60


def test_create_token_includes_device_id_when_passed():
    tok = create_token("u1", "member", device_id="dev-xyz")
    payload = jwt.decode(tok, JWT_SECRET, algorithms=[JWT_ALGO])
    assert payload["device_id"] == "dev-xyz"


def test_create_token_honours_explicit_expiry():
    tok = create_token("u1", "member", expires_minutes=1)
    payload = jwt.decode(tok, JWT_SECRET, algorithms=[JWT_ALGO])
    exp = datetime.fromtimestamp(payload["exp"], tz=timezone.utc)
    delta = (exp - datetime.now(timezone.utc)).total_seconds()
    assert 0 < delta < 120


def test_create_token_signature_validates():
    tok = create_token("u1", "member")
    # Tampered token must fail
    bad = tok[:-2] + ("AA" if tok[-2:] != "AA" else "BB")
    with pytest.raises(jwt.InvalidTokenError):
        jwt.decode(bad, JWT_SECRET, algorithms=[JWT_ALGO])
