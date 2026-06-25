"""Unit tests for `services/phone.py`."""
from services.phone import normalize_phone, phone_key


def test_normalize_drops_non_digits():
    assert normalize_phone("+91 98765-43210") == "919876543210"


def test_normalize_handles_none_and_empty():
    assert normalize_phone(None) == ""
    assert normalize_phone("") == ""


def test_normalize_keeps_zero_padding():
    assert normalize_phone("0091 9876543210") == "00919876543210"


def test_phone_key_returns_last_10_digits():
    # Standard Indian numbers with country codes match the local-form
    assert phone_key("+91 98765 43210") == "9876543210"
    assert phone_key("00919876543210") == "9876543210"
    assert phone_key("9876543210") == "9876543210"


def test_phone_key_short_number_returned_as_is():
    # Anything < 10 digits returns whatever's there (no padding)
    assert phone_key("123") == "123"
    assert phone_key("") == ""


def test_phone_key_normalises_via_normalize():
    # Sanity: digits-only path
    assert phone_key("98 76 54-32 10") == "9876543210"
