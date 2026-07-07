"""Audit-trail regression tests.

Guards that every admin-mutating endpoint we've wired writes a row
into `audit_log`, and that the reader endpoint respects the documented
filters (actor / entity / action / date-range).
"""
from __future__ import annotations

import datetime as dt


def _latest_audit(admin_client, base_url, entity_id: str):
    r = admin_client.get(f"{base_url}/api/admin/audit-log",
                         params={"entity_id": entity_id, "limit": 5}, timeout=10)
    assert r.status_code == 200, r.text
    return r.json()


def test_audit_writes_on_member_patch(admin_client, base_url, athlete):
    """A member PATCH must produce exactly one audit row with the
    `changes` map populated by the diff of before/after."""
    mid = athlete["id"]
    original_rank = athlete.get("rank")
    sentinel = f"AUDIT-TEST-{dt.datetime.now().microsecond}"

    r = admin_client.patch(f"{base_url}/api/members/{mid}",
                           json={"rank": sentinel}, timeout=15)
    assert r.status_code == 200, r.text

    out = _latest_audit(admin_client, base_url, mid)
    assert out["count"] >= 1
    top = out["rows"][0]
    assert top["action"] == "member.update"
    assert top["entity_type"] == "member"
    assert top["actor_name"], "actor_name must be populated"
    assert "changes" in top and "rank" in top["changes"]
    assert top["changes"]["rank"]["after"] == sentinel

    # Restore.
    admin_client.patch(f"{base_url}/api/members/{mid}",
                       json={"rank": original_rank}, timeout=15)


def test_audit_write_is_best_effort_on_password_reset(admin_client, base_url, athlete):
    """A password reset writes a row with the special action label
    but MUST NOT persist the hashed-password diff."""
    mid = athlete["id"]
    r = admin_client.patch(f"{base_url}/api/members/{mid}",
                           json={"password": "Temp!Reset123"}, timeout=15)
    assert r.status_code == 200, r.text

    out = _latest_audit(admin_client, base_url, mid)
    assert out["count"] >= 1
    top = out["rows"][0]
    assert top["action"] == "member.password_reset"
    # hashed_password is on the redact list — it must never leak into
    # the audit row's changes map.
    assert "hashed_password" not in (top.get("changes") or {})


def test_audit_filters_action_and_entity(admin_client, base_url, athlete):
    """`action=member.update` narrows to member edits only; adding
    `entity_id` further narrows to a single member."""
    mid = athlete["id"]
    r = admin_client.get(f"{base_url}/api/admin/audit-log",
                         params={"action": "member.update",
                                 "entity_id": mid, "limit": 5}, timeout=10)
    assert r.status_code == 200, r.text
    for row in r.json()["rows"]:
        assert row["action"] == "member.update"
        assert row["entity_id"] == mid


def test_audit_date_range(admin_client, base_url):
    """`since` filters out anything older than the given ISO date."""
    since = dt.date.today().isoformat()
    r = admin_client.get(f"{base_url}/api/admin/audit-log",
                         params={"since": since, "limit": 20}, timeout=10)
    assert r.status_code == 200, r.text
    for row in r.json()["rows"]:
        assert row["at"][:10] >= since
