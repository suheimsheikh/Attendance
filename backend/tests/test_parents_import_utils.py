"""Unit tests for `parents_import_utils.py`."""
from parents_import_utils import norm_name, fuzzy_score, norm_mobile, clean_name


# ---------- norm_name ----------
def test_norm_name_lowercases():
    assert norm_name("PREETHI KONGARA") == "preethi kongara"


def test_norm_name_collapses_whitespace():
    assert norm_name("  Preethi   Kongara  ") == "preethi kongara"


def test_norm_name_handles_empty():
    assert norm_name("") == ""
    assert norm_name(None) == ""


# ---------- fuzzy_score ----------
def test_fuzzy_score_identical_is_one():
    assert fuzzy_score("Preethi Kongara", "Preethi Kongara") == 1.0


def test_fuzzy_score_case_insensitive():
    # norm_name lowercases, so casing should not affect the score.
    assert fuzzy_score("PREETHI KONGARA", "preethi kongara") == 1.0


def test_fuzzy_score_close_match_is_high():
    score = fuzzy_score("Preethi Kongara", "Preethi Kongra")
    assert 0.85 < score < 1.0


def test_fuzzy_score_distant_match_is_low():
    score = fuzzy_score("Anil Sharma", "Vijay Kumar")
    assert score < 0.5


# ---------- norm_mobile ----------
def test_norm_mobile_int_value():
    assert norm_mobile(9876543210) == "9876543210"


def test_norm_mobile_float_value():
    # Excel often delivers as float
    assert norm_mobile(9876543210.0) == "9876543210"


def test_norm_mobile_string_strips_punctuation():
    assert norm_mobile("+91-9876-543210") == "919876543210"
    assert norm_mobile("(987) 654-3210") == "9876543210"


def test_norm_mobile_blank_returns_none():
    assert norm_mobile(None) is None
    assert norm_mobile("") is None
    assert norm_mobile("   ") is None


def test_norm_mobile_no_number_markers_returns_none():
    for marker in ("LATE", "N/A", "NA", "-", "--", "NIL", "NONE"):
        assert norm_mobile(marker) is None
        assert norm_mobile(marker.lower()) is None  # case-insensitive


def test_norm_mobile_negative_or_zero_int_returns_none():
    assert norm_mobile(0) is None
    assert norm_mobile(-1) is None


# ---------- clean_name ----------
def test_clean_name_strips_whitespace():
    assert clean_name("  Anil Sharma  ") == "Anil Sharma"


def test_clean_name_strips_late_prefix_for_deceased():
    # Used in the YCH parents sheet for deceased parents.
    assert clean_name("LATE Anil Sharma") == "Anil Sharma"
    assert clean_name("late mahesh kumar") == "mahesh kumar"


def test_clean_name_returns_none_for_markers():
    for marker in ("-", "--", "N/A", "NA", "NIL", "NONE", "LATE"):
        assert clean_name(marker) is None
        assert clean_name(marker.lower()) is None


def test_clean_name_returns_none_for_empty():
    assert clean_name(None) is None
    assert clean_name("") is None
    assert clean_name("   ") is None
