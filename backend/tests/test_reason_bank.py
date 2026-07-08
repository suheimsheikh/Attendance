"""Personal reason bank — per-user list of reasons that grows as the
member types them into overtime prompts and comp-off applications.

Feature added 7 Jul 2026 (user request: "As users mention reasons
they should attach to their own individual reason base and show up in
their droplist"). Reasons live on `users[uid].reasons: [str]`.
"""
from __future__ import annotations

import pytest


def _cleanup(admin_client, base_url):
    """Best-effort — clear whatever the tests seeded so they can be
    re-run against the same DB."""
    admin_client.get(f"{base_url}/api/me/reasons", timeout=15).json()
    for r in ("Picking up Rainbow Kids", "Agape Camp", "Came to arrange breakfast"):
        admin_client.delete(f"{base_url}/api/me/reasons",
                            params={"reason": r}, timeout=15)


def test_reason_bank_crud(admin_client, base_url):
    _cleanup(admin_client, base_url)

    # Empty on first read.
    r = admin_client.get(f"{base_url}/api/me/reasons", timeout=15).json()
    assert r == {"reasons": []}, r

    # Add three reasons — each response returns the running list, MRU-first.
    for name in ("Picking up Rainbow Kids", "Agape Camp", "Came to arrange breakfast"):
        body = admin_client.post(f"{base_url}/api/me/reasons",
                                 json={"reason": name}, timeout=15).json()
        assert name in body["reasons"], (name, body)
        assert body["reasons"][0] == name, "MRU should be at head"

    # Re-adding an existing reason bumps it to the front without duplication.
    body = admin_client.post(f"{base_url}/api/me/reasons",
                             json={"reason": "picking up RAINBOW kids"}, timeout=15).json()
    lowers = [x.lower() for x in body["reasons"]]
    assert lowers.count("picking up rainbow kids") == 1, body
    assert body["reasons"][0].lower() == "picking up rainbow kids", body

    # Whitespace + empty are silently ignored (no exception, no side-effect).
    before = body["reasons"]
    r = admin_client.post(f"{base_url}/api/me/reasons",
                          json={"reason": "   "}, timeout=15).json()
    assert r["reasons"] == before

    # Delete one — response returns updated list.
    body = admin_client.delete(f"{base_url}/api/me/reasons",
                               params={"reason": "Agape Camp"}, timeout=15).json()
    assert "Agape Camp" not in body["reasons"], body

    _cleanup(admin_client, base_url)


def test_reason_bank_empty_delete_400(admin_client, base_url):
    """Delete without a reason arg is a 400 — surfaces caller bug fast
    instead of silently wiping nothing."""
    r = admin_client.delete(f"{base_url}/api/me/reasons",
                            params={"reason": ""}, timeout=15)
    assert r.status_code == 400, r.text


@pytest.mark.slow
def test_reason_bank_cap_at_50(admin_client, base_url):
    """Chatty members shouldn't be able to grow their doc unbounded."""
    _cleanup(admin_client, base_url)
    for i in range(55):
        admin_client.post(f"{base_url}/api/me/reasons",
                          json={"reason": f"cap-test-reason-{i:03d}"}, timeout=15)
    body = admin_client.get(f"{base_url}/api/me/reasons", timeout=15).json()
    assert len(body["reasons"]) == 50, len(body["reasons"])
    # MRU-first: the newest (054) sits at the head, oldest (005) at the tail
    # — the first 5 (000-004) get evicted.
    assert body["reasons"][0] == "cap-test-reason-054"
    assert body["reasons"][-1] == "cap-test-reason-005"
    # Clean up
    for r in body["reasons"]:
        admin_client.delete(f"{base_url}/api/me/reasons",
                            params={"reason": r}, timeout=15)
