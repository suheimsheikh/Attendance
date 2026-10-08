"""Absentee WhatsApp prompt: first admin to send marks the day as sent for
every admin; later admins see who sent it. Non-admins are blocked."""
from __future__ import annotations

import pytest


@pytest.fixture
def clean_today(admin_client, base_url, mongo_db):
    if mongo_db is None:
        pytest.skip("mongo_db fixture unavailable")
    today = admin_client.get(f"{base_url}/api/muster/absent-dispatch", timeout=30).json()["date"]
    prior = mongo_db.absent_dispatch_log.find_one({"date": today})
    mongo_db.absent_dispatch_log.delete_one({"date": today})
    yield today
    mongo_db.absent_dispatch_log.delete_one({"date": today})
    if prior:
        mongo_db.absent_dispatch_log.insert_one(prior)


def test_first_admin_wins(admin_client, second_admin_client, base_url, clean_today):
    url = f"{base_url}/api/muster/absent-dispatch"
    assert admin_client.get(url, timeout=30).json()["sent"] is False
    first = admin_client.post(url, timeout=30).json()
    assert first["first"] is True and first["sent"] is True and first["sent_at"]
    second = second_admin_client.post(url, timeout=30).json()
    assert second["first"] is False
    assert second["sent_by_id"] == first["sent_by_id"]
    status = second_admin_client.get(url, timeout=30).json()
    assert status["sent"] is True and status["sent_by_name"] == first["sent_by_name"]


def test_non_admin_forbidden(make_member, base_url):
    m = make_member("coach", login=True)
    assert m["client"].get(f"{base_url}/api/muster/absent-dispatch", timeout=30).status_code == 403
    assert m["client"].post(f"{base_url}/api/muster/absent-dispatch", timeout=30).status_code == 403
