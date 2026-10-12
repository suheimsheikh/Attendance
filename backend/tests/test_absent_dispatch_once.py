"""Absentee WhatsApp prompt — two independent daily dispatches:

  • kind=staff  — non-athlete (staff/coach) absentees, ADMINS ONLY, due 10:00,
    every day regardless of camps. Deterministic, so it anchors the
    "first sender wins for everyone that day" behaviour here.
  • kind=camp   — camp participants, admins + present coaches, camp days only.
    Coaches are allowed (not 403); POST needs an active camp.

First admin/eligible user to POST marks the day sent for everyone; later
users see who sent it.
"""
from __future__ import annotations

import pytest


@pytest.fixture
def clean_staff_today(admin_client, base_url, mongo_db):
    if mongo_db is None:
        pytest.skip("mongo_db fixture unavailable")
    url = f"{base_url}/api/muster/absent-dispatch?kind=staff"
    today = admin_client.get(url, timeout=30).json()["date"]
    key = {"date": today, "kind": "staff"}
    prior = mongo_db.absent_dispatch_log.find_one(key)
    mongo_db.absent_dispatch_log.delete_one(key)
    yield today
    mongo_db.absent_dispatch_log.delete_one(key)
    if prior:
        prior.pop("_id", None)
        mongo_db.absent_dispatch_log.insert_one(prior)


def test_staff_first_admin_wins(admin_client, second_admin_client, base_url, clean_staff_today):
    url = f"{base_url}/api/muster/absent-dispatch?kind=staff"
    status = admin_client.get(url, timeout=30).json()
    assert status["sent"] is False
    assert status["eligible"] is True
    assert status["dispatch_after_hm"] == "10:00"
    first = admin_client.post(url, timeout=30).json()
    assert first["first"] is True and first["sent"] is True and first["sent_at"]
    assert first["kind"] == "staff"
    second = second_admin_client.post(url, timeout=30).json()
    assert second["first"] is False
    assert second["sent_by_id"] == first["sent_by_id"]
    status = second_admin_client.get(url, timeout=30).json()
    assert status["sent"] is True and status["sent_by_name"] == first["sent_by_name"]


def test_staff_admin_only(make_member, base_url):
    """Coaches are not eligible for the staff dispatch and cannot send it."""
    m = make_member("coach", login=True)
    url = f"{base_url}/api/muster/absent-dispatch?kind=staff"
    got = m["client"].get(url, timeout=30)
    assert got.status_code == 200 and got.json()["eligible"] is False
    assert m["client"].post(url, timeout=30).status_code == 403


def test_camp_requires_active_camp(admin_client, base_url, mongo_db):
    """With no camp active today, the camp dispatch is not a camp day and
    POST is rejected (nothing to send to the parents group)."""
    if mongo_db is None:
        pytest.skip("mongo_db fixture unavailable")
    url = f"{base_url}/api/muster/absent-dispatch?kind=camp"
    status = admin_client.get(url, timeout=30).json()
    assert status["kind"] == "camp"
    if status["is_camp_day"]:
        pytest.skip("a camp is active today in this environment")
    assert status["dispatch_after_hm"] is None
    assert admin_client.post(url, timeout=30).status_code == 400


def test_camp_coach_allowed(make_member, base_url):
    """Coaches may read the camp dispatch status (not 403, unlike staff)."""
    m = make_member("coach", login=True)
    url = f"{base_url}/api/muster/absent-dispatch?kind=camp"
    got = m["client"].get(url, timeout=30)
    assert got.status_code == 200
    assert "is_camp_day" in got.json()
