"""Regression guard (9 Jul 2026): a scope=all break must NOT wipe the
On Campus column on the Presence Board. Physical check-ins always
override a scheduled break — the coach needs to see who actually
showed up, even on a rest day, with the break context preserved as
a detail tag.

User report: "I entered a break in preview and the presence on campus
data has disappeared."

Root cause: `elif brk:` was earlier in the presence-resolution chain
than `elif sess:`. A scope=all break forced every member into
`on_leave`, hiding physical check-ins. Fix reorders the branches so
`sess` wins; brk still populates the detail string with an "on break"
overlay so the anomaly stays visible.
"""
from __future__ import annotations

import datetime
import os
import uuid

import pytest
import requests


def _login(base_url) -> str:
    r = requests.post(
        f"{base_url}/api/auth/login",
        json={"email": os.environ.get("TEST_ADMIN_EMAIL", "admin@attendance.app"),
              "password": os.environ.get("TEST_ADMIN_PASSWORD", "Admin@12345")},
        timeout=30,
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


def test_scope_all_break_does_not_wipe_on_campus(base_url):
    token = _login(base_url)
    hdr = {"Authorization": f"Bearer {token}"}

    # Snapshot the current on_campus roster — if it's empty, we can't
    # assert the invariant meaningfully; skip rather than pretend to
    # pass.
    pres_before = requests.get(f"{base_url}/api/presence", headers=hdr, timeout=30).json()
    on_campus_before = [
        m for m in pres_before.get("members", [])
        if m.get("status") == "on_campus"
    ]
    if not on_campus_before:
        pytest.skip("no on_campus members in preview — nothing to assert against.")

    # Create a temporary scope=all break covering today, verify the
    # on_campus roster survives, then clean up.
    today = datetime.date.today().isoformat()
    tomorrow = (datetime.date.today() + datetime.timedelta(days=1)).isoformat()
    name = f"pytest-break-{uuid.uuid4().hex[:6]}"
    create = requests.post(
        f"{base_url}/api/breaks", headers=hdr,
        json={"name": name, "scope": "all",
              "start_date": today, "end_date": tomorrow},
        timeout=30,
    )
    assert create.status_code in (200, 201), create.text
    brk_id = create.json()["id"]

    try:
        pres_after = requests.get(f"{base_url}/api/presence", headers=hdr, timeout=30).json()
        on_campus_after = [
            m for m in pres_after.get("members", [])
            if m.get("status") == "on_campus"
        ]
        # The break must not erase check-ins — every previously-on-campus
        # member must still show as on_campus.
        before_ids = {m["id"] for m in on_campus_before}
        after_ids = {m["id"] for m in on_campus_after}
        missing = before_ids - after_ids
        assert not missing, (
            "scope=all break wiped on-campus members: "
            + ", ".join(sorted(missing))[:200]
        )

        # And the detail must carry the "on break" overlay so coaches
        # still notice the anomaly.
        sample = next(iter(on_campus_after), {})
        assert "on break" in (sample.get("detail") or "").lower(), (
            f"expected 'on break' hint in detail for on_campus rows during a "
            f"scope=all break, got {sample.get('detail')!r}"
        )
    finally:
        requests.delete(f"{base_url}/api/breaks/{brk_id}", headers=hdr, timeout=30)
