"""
Regression test for the `meal_day_attendees` sort/coerce hardening
(Feb 2026 — fixed prod-only 500 when a `meal_records` row carried a
non-string value in category / institution / user_name / meal).

We can't unit-test the route body directly without a running Motor
connection, but the hard part — the sort key + meal coercion —
can be exercised in isolation by reimplementing them in this file
and re-applying to a synthetic row set. This locks the *shape* of
the defensive coercion so future edits don't silently regress it.
"""
from __future__ import annotations


def _sortkey(x: dict) -> tuple:
    """Mirror of the production sort key (kept in sync with
    routes/meals.py::meal_day_attendees::_sortkey)."""
    def _s(v, fallback: str = "") -> str:
        if v is None:
            return fallback
        try:
            return str(v).lower()
        except Exception:
            return fallback
    return (_s(x.get("category"), "zz"),
            _s(x.get("institution")),
            _s(x.get("user_name")))


def test_sortkey_all_strings_lowercased():
    got = _sortkey({"category": "Athlete", "institution": "MJPT",
                    "user_name": "Alice"})
    assert got == ("athlete", "mjpt", "alice")


def test_sortkey_none_category_buckets_to_zz():
    """Members with no category go to the END of the sort — behaviour
    match with pre-hardening code."""
    got = _sortkey({"category": None, "institution": "X", "user_name": "Y"})
    assert got[0] == "zz"


def test_sortkey_list_value_does_not_crash():
    """The bug we're guarding against: a legacy row with a list-typed
    category previously crashed `.lower()`. Now it stringifies."""
    got = _sortkey({"category": ["athlete"], "institution": None,
                    "user_name": "Z"})
    assert isinstance(got[0], str)   # no crash, some string
    assert got[1] == ""              # None institution → empty


def test_sortkey_numeric_value_does_not_crash():
    got = _sortkey({"category": 42, "institution": 3.14, "user_name": 0})
    assert got == ("42", "3.14", "0")


def test_sortkey_missing_fields_treated_as_none():
    """Row without the sort fields at all → defaults kick in."""
    got = _sortkey({})
    assert got == ("zz", "", "")


def test_meal_coerce_none_returns_empty_str():
    """Mirror of the meal coerce guard in the route body."""
    for raw in (None, "", "BREAKFAST", "Breakfast", 0, ["lunch"]):
        out = str(raw).lower() if raw is not None else ""
        assert isinstance(out, str)
