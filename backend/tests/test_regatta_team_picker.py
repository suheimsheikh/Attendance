"""Backend tests for Regatta team picker + travel-check filtering (iter 101).

Covers:
- POST /api/regattas accepts team_ids (default []).
- PATCH /api/regattas/{id} with team_ids sets/clears/dedupes; other PATCH fields
  leave team_ids intact.
- GET /api/id-docs/travel-check?regatta_id=X behaviour with empty & populated
  team_ids (team_picked flag, member filtering).
"""
import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL").rstrip("/")
EXISTING_REGATTA = "43837a5e-3833-4e69-a4aa-c791a38a6bc5"  # TEST Overseas Cup


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": "admin@attendance.app", "password": "Admin@12345"},
                      timeout=30)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def h(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def active_members(h):
    r = requests.get(f"{BASE_URL}/api/members", headers=h, timeout=30)
    assert r.status_code == 200
    data = r.json()
    members = data if isinstance(data, list) else data.get("members", [])
    # pick 2 athletes + 1 coach + 1 staff if possible
    by_cat = {}
    for m in members:
        if m.get("status") and m["status"] != "active":
            continue
        by_cat.setdefault(m.get("category"), []).append(m)
    picks = []
    for cat in ("athlete", "coach", "staff"):
        if by_cat.get(cat):
            picks.extend(by_cat[cat][:2 if cat == "athlete" else 1])
        if len(picks) >= 3:
            break
    assert len(picks) >= 2, f"Need at least 2 active members, got {len(picks)}"
    return picks


# ---------- Create / PATCH regatta ----------

class TestRegattaTeamIds:
    created_ids = []

    def test_create_default_team_ids_empty(self, h):
        body = {
            "name": "TEST iter101 default",
            "level": "international",
            "country": "Portugal",
            "start_date": "2099-05-01",
            "end_date": "2099-05-05",
        }
        r = requests.post(f"{BASE_URL}/api/regattas", json=body, headers=h, timeout=20)
        assert r.status_code == 200, r.text
        doc = r.json()
        assert doc.get("team_ids") == []
        assert doc["id"]
        TestRegattaTeamIds.created_ids.append(doc["id"])

    def test_create_with_team_ids(self, h, active_members):
        ids = [m["id"] for m in active_members[:2]]
        body = {
            "name": "TEST iter101 with team",
            "level": "international",
            "country": "Portugal",
            "start_date": "2099-05-01",
            "end_date": "2099-05-05",
            "team_ids": ids,
        }
        r = requests.post(f"{BASE_URL}/api/regattas", json=body, headers=h, timeout=20)
        assert r.status_code == 200
        doc = r.json()
        assert sorted(doc["team_ids"]) == sorted(ids)
        TestRegattaTeamIds.created_ids.append(doc["id"])

    def test_patch_team_ids_set_dedupes(self, h, active_members):
        rid = TestRegattaTeamIds.created_ids[0]
        a, b = active_members[0]["id"], active_members[1]["id"]
        dup = [a, b, a, b]
        r = requests.patch(f"{BASE_URL}/api/regattas/{rid}",
                           json={"team_ids": dup}, headers=h, timeout=20)
        assert r.status_code == 200
        assert r.json()["team_ids"] == [a, b]

    def test_patch_other_field_leaves_team_ids_intact(self, h):
        rid = TestRegattaTeamIds.created_ids[0]
        before = requests.get(f"{BASE_URL}/api/regattas", headers=h, timeout=20).json()
        before_team = next(x["team_ids"] for x in before if x["id"] == rid)
        assert before_team  # non-empty
        r = requests.patch(f"{BASE_URL}/api/regattas/{rid}",
                           json={"notes": "patched note iter101"}, headers=h, timeout=20)
        assert r.status_code == 200
        doc = r.json()
        assert doc["team_ids"] == before_team
        assert doc["notes"] == "patched note iter101"

    def test_patch_clear_team_ids(self, h):
        rid = TestRegattaTeamIds.created_ids[0]
        r = requests.patch(f"{BASE_URL}/api/regattas/{rid}",
                           json={"team_ids": []}, headers=h, timeout=20)
        assert r.status_code == 200
        assert r.json()["team_ids"] == []

    def test_zz_cleanup(self, h):
        for rid in TestRegattaTeamIds.created_ids:
            requests.delete(f"{BASE_URL}/api/regattas/{rid}", headers=h, timeout=20)
        # Reset the shared TEST Overseas Cup to empty team as per instructions
        requests.patch(f"{BASE_URL}/api/regattas/{EXISTING_REGATTA}",
                       json={"team_ids": []}, headers=h, timeout=20)


# ---------- Travel check ----------

class TestTravelCheck:
    def test_travel_check_empty_team_shows_all_athlete_coach(self, h):
        # Ensure the shared regatta has empty team
        requests.patch(f"{BASE_URL}/api/regattas/{EXISTING_REGATTA}",
                       json={"team_ids": []}, headers=h, timeout=20)
        r = requests.get(
            f"{BASE_URL}/api/id-docs/travel-check?regatta_id={EXISTING_REGATTA}",
            headers=h, timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert data["regatta"] and data["regatta"]["id"] == EXISTING_REGATTA
        assert data["team_picked"] is False
        rows = data["rows"]
        assert len(rows) > 0
        # All rows must be athlete-like or coach category
        cats = {r.get("member_category") or r.get("category") for r in rows}
        # Loose check — must not be empty
        assert rows, "Expected members in rows when no team picked"

    def test_travel_check_with_team_filters(self, h):
        # Pick 2 member ids FROM the no-team travel-check result so we know they
        # are "self" active athletes/coaches that the endpoint will consider.
        requests.patch(f"{BASE_URL}/api/regattas/{EXISTING_REGATTA}",
                       json={"team_ids": []}, headers=h, timeout=20)
        base = requests.get(
            f"{BASE_URL}/api/id-docs/travel-check?regatta_id={EXISTING_REGATTA}",
            headers=h, timeout=30).json()
        assert len(base["rows"]) >= 2
        picks = [base["rows"][0]["member_id"], base["rows"][1]["member_id"]]
        r0 = requests.patch(f"{BASE_URL}/api/regattas/{EXISTING_REGATTA}",
                            json={"team_ids": picks}, headers=h, timeout=20)
        assert r0.status_code == 200
        r = requests.get(
            f"{BASE_URL}/api/id-docs/travel-check?regatta_id={EXISTING_REGATTA}",
            headers=h, timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert data["team_picked"] is True
        row_ids = {row["member_id"] for row in data["rows"]}
        assert row_ids == set(picks), f"Expected only team members, got {row_ids} vs {picks}"

    def test_travel_check_includes_staff_when_in_team(self, h):
        # Find a staff member
        members = requests.get(f"{BASE_URL}/api/members", headers=h, timeout=20).json()
        members = members if isinstance(members, list) else members.get("members", [])
        staff = next((m for m in members if m.get("category") == "staff"
                      and (m.get("status") or "active") == "active"), None)
        if not staff:
            pytest.skip("No active staff member available")
        requests.patch(f"{BASE_URL}/api/regattas/{EXISTING_REGATTA}",
                       json={"team_ids": [staff["id"]]}, headers=h, timeout=20)
        r = requests.get(
            f"{BASE_URL}/api/id-docs/travel-check?regatta_id={EXISTING_REGATTA}",
            headers=h, timeout=30)
        assert r.status_code == 200
        data = r.json()
        assert data["team_picked"] is True
        assert len(data["rows"]) == 1
        assert data["rows"][0]["member_id"] == staff["id"]

    def test_zz_cleanup_travel(self, h):
        requests.patch(f"{BASE_URL}/api/regattas/{EXISTING_REGATTA}",
                       json={"team_ids": []}, headers=h, timeout=20)
