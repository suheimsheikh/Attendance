"""Data-quality endpoint smoke + regression tests.

The scan is intentionally comprehensive so on a real DB with active
attendance/leave data, some findings are always expected. These tests
therefore assert the SHAPE of the response, spot-check the invariants
of the classifier, and verify severity ordering.
"""
from __future__ import annotations

import pytest


def test_data_quality_shape(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/admin/data-quality", timeout=30)
    assert r.status_code == 200, r.text
    body = r.json()
    for k in ("generated_at", "total_findings", "by_severity", "findings"):
        assert k in body
    assert isinstance(body["findings"], list)
    assert body["total_findings"] == len(body["findings"])


def test_findings_have_required_fields(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/admin/data-quality", timeout=30)
    for f in r.json()["findings"]:
        for k in ("category", "code", "severity", "message",
                  "entity_type", "entity_ids"):
            assert k in f, f"finding missing {k}: {f}"
        assert f["severity"] in ("high", "medium", "low", "info")
        assert isinstance(f["entity_ids"], list)


def test_findings_sorted_by_severity(admin_client, base_url):
    r = admin_client.get(f"{base_url}/api/admin/data-quality", timeout=30)
    order = {"high": 0, "medium": 1, "low": 2, "info": 3}
    prev = -1
    for f in r.json()["findings"]:
        cur = order[f["severity"]]
        assert cur >= prev, "findings must be severity-ascending"
        prev = cur


def test_synthetic_bad_dob_surfaces(admin_client, base_url, athlete):
    """Set an athlete's DOB to a bad-format string → next scan lists
    `member.dob_bad_format` as a finding on that member."""
    mid = athlete["id"]
    original = athlete.get("date_of_birth")
    try:
        r = admin_client.patch(f"{base_url}/api/members/{mid}",
                               json={"date_of_birth": "01/04/2000"}, timeout=15)
        assert r.status_code == 200
        sc = admin_client.get(f"{base_url}/api/admin/data-quality", timeout=30)
        codes = {(f["code"], tuple(f["entity_ids"])) for f in sc.json()["findings"]}
        assert any(c[0] == "member.dob_bad_format" and mid in c[1] for c in codes), \
            "bad-format DOB was not flagged"
    finally:
        admin_client.patch(f"{base_url}/api/members/{mid}",
                           json={"date_of_birth": original}, timeout=15)


def test_synthetic_negative_leave_surfaces(admin_client, base_url, athlete):
    """A negative opening leave balance must be caught."""
    mid = athlete["id"]
    original = athlete.get("leave_balance_opening")
    try:
        r = admin_client.patch(f"{base_url}/api/members/{mid}",
                               json={"leave_balance_opening": -5}, timeout=15)
        assert r.status_code == 200
        sc = admin_client.get(f"{base_url}/api/admin/data-quality", timeout=30)
        assert any(f["code"] == "member.negative_leave" and mid in f["entity_ids"]
                   for f in sc.json()["findings"]), "negative leave not flagged"
    finally:
        admin_client.patch(f"{base_url}/api/members/{mid}",
                           json={"leave_balance_opening": original}, timeout=15)
