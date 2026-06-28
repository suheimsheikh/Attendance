"""Iter4 — Unified Leave System (comp-off + paid-leave waterfall).

Validates:
- /api/me/leave-summary shape
- /api/members/{id}/leave-summary admin endpoint shape
- POST /api/leaves with type=leave stamps comp_off_used/paid_leave_used/lop_days
- Zero-balance leave => lop_days == requested
- Legacy /api/me/comp-off-balance & /api/members/{id}/comp-off-balance still work
- /api/auth/me regression — enriched leave_balance_opening/remaining
- /api/leaves admin listing enriched with member_name/member_category
- /api/leaves/group still creates one row per picked member
"""
import os
import uuid
import requests
import pytest

# Read REACT_APP_BACKEND_URL from frontend/.env (test runners don't inherit it)
def _load_base_url():
    v = os.environ.get("REACT_APP_BACKEND_URL")
    if v:
        return v.rstrip("/")
    try:
        with open("/app/frontend/.env") as fh:
            for line in fh:
                if line.startswith("REACT_APP_BACKEND_URL="):
                    return line.split("=", 1)[1].strip().rstrip("/")
    except Exception:
        pass
    raise RuntimeError("REACT_APP_BACKEND_URL not configured")

BASE_URL = _load_base_url()


@pytest.fixture(scope="module")
def admin_token():
    r = requests.post(f"{BASE_URL}/api/auth/login",
                      json={"email": "admin@attendance.app", "password": "Admin@12345"},
                      timeout=20)
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.fixture(scope="module")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def admin_me(admin_headers):
    r = requests.get(f"{BASE_URL}/api/auth/me", headers=admin_headers, timeout=15)
    assert r.status_code == 200
    return r.json()


# ------------------------- /api/me/leave-summary -------------------------
class TestLeaveSummary:
    def test_me_leave_summary_shape(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/me/leave-summary", headers=admin_headers, timeout=15)
        assert r.status_code == 200, r.text
        d = r.json()
        assert "comp_off" in d and "paid_leave" in d
        assert set(["accrued", "used", "available"]).issubset(d["comp_off"].keys())
        assert set(["opening", "used", "available", "tracked"]).issubset(d["paid_leave"].keys())
        assert "total_available" in d
        assert "weekly_off" in d
        assert "weekly_off_source" in d

    def test_member_leave_summary_admin(self, admin_headers, admin_me):
        # Admin viewing their own member record via the admin route.
        r = requests.get(f"{BASE_URL}/api/members/{admin_me['id']}/leave-summary",
                         headers=admin_headers, timeout=15)
        assert r.status_code == 200, r.text
        d = r.json()
        assert "comp_off" in d and "paid_leave" in d and "total_available" in d

    def test_member_leave_summary_404(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/members/nonexistent-id-xyz/leave-summary",
                         headers=admin_headers, timeout=15)
        assert r.status_code == 404


# ------------------------- Legacy endpoints --------------------------------
class TestLegacyCompOff:
    def test_me_comp_off_balance(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/me/comp-off-balance", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        d = r.json()
        for k in ("accrued", "used", "available", "weekly_off"):
            assert k in d

    def test_member_comp_off_balance(self, admin_headers, admin_me):
        r = requests.get(f"{BASE_URL}/api/members/{admin_me['id']}/comp-off-balance",
                         headers=admin_headers, timeout=15)
        assert r.status_code == 200


# ------------------------- /api/auth/me regression ------------------------
class TestAuthMeRegression:
    def test_auth_me_enriched(self, admin_me):
        # Non-athlete users should expose leave_balance_opening/remaining
        # (admin is non-athlete by definition)
        assert "leave_balance_opening" in admin_me
        assert "leave_balance_remaining" in admin_me


# ------------------------- POST /api/leaves waterfall ---------------------
class TestLeaveCreateWaterfall:
    """Create leaves on a brand-new test member with 0 paid-leave balance."""

    @pytest.fixture(scope="class")
    def test_member(self, admin_headers):
        # Create a fresh non-athlete user with opening=0 → all leaves should be LOP
        payload = {
            "full_name": f"TEST Waterfall {uuid.uuid4().hex[:6]}",
            "email": f"test_waterfall_{uuid.uuid4().hex[:6]}@example.com",
            "category": "coach",
            "rank": "Coach",
            "leave_balance_opening": 0,
            "password": "TestPass@123",
        }
        r = requests.post(f"{BASE_URL}/api/members", headers=admin_headers, json=payload, timeout=20)
        if r.status_code not in (200, 201):
            pytest.skip(f"Cannot create test member: {r.status_code} {r.text}")
        u = r.json()
        yield u
        # cleanup
        try:
            requests.delete(f"{BASE_URL}/api/members/{u['id']}", headers=admin_headers, timeout=10)
        except Exception:
            pass

    def test_zero_balance_leave_all_lop(self, admin_headers, test_member):
        # 3-day leave with 0 comp-off + 0 paid → entirely LOP
        body = {
            "type": "leave",
            "start_date": "2026-02-02",
            "end_date": "2026-02-04",
            "reason": "TEST waterfall zero-balance",
        }
        r = requests.post(
            f"{BASE_URL}/api/leaves?target_user_id={test_member['id']}",
            headers=admin_headers, json=body, timeout=20,
        )
        assert r.status_code == 200, r.text
        leave = r.json()
        assert leave["type"] == "leave"
        assert leave.get("comp_off_used") == 0
        # paid_leave_used may be int 0 or float 0.0
        assert (leave.get("paid_leave_used") or 0) == 0
        assert leave.get("lop_days") == 3
        leave_id = leave["id"]
        # verify persistence via GET /leaves (admin all)
        listing = requests.get(f"{BASE_URL}/api/leaves", headers=admin_headers, timeout=15).json()
        match = [item for item in listing if item["id"] == leave_id]
        assert match, "Newly created leave missing from admin listing"
        found = match[0]
        assert found.get("lop_days") == 3
        assert "member_name" in found and "member_category" in found
        # cleanup
        requests.patch(f"{BASE_URL}/api/leaves/{leave['id']}",
                       headers=admin_headers,
                       json={"status": "rejected"}, timeout=10)

    def test_tour_does_not_stamp_ladder(self, admin_headers, test_member):
        body = {
            "type": "tour",
            "start_date": "2026-02-10",
            "end_date": "2026-02-10",
            "reason": "TEST tour",
            "location": "Test Base",
        }
        r = requests.post(
            f"{BASE_URL}/api/leaves?target_user_id={test_member['id']}",
            headers=admin_headers, json=body, timeout=20,
        )
        assert r.status_code == 200, r.text
        d = r.json()
        # Tour rows should NOT carry the ladder stamps
        assert "lop_days" not in d or d.get("lop_days") in (None, 0)
        # cleanup
        requests.patch(f"{BASE_URL}/api/leaves/{d['id']}",
                       headers=admin_headers, json={"status": "rejected"}, timeout=10)


# ------------------------- Group leave -----------------------------------
class TestGroupLeave:
    def test_group_leave_creates_rows(self, admin_headers, admin_me):
        body = {
            "type": "leave",
            "user_ids": [admin_me["id"]],
            "start_date": "2026-03-15",
            "end_date": "2026-03-15",
            "reason": "TEST group leave",
            "auto_approve": True,
        }
        r = requests.post(f"{BASE_URL}/api/leaves/group", headers=admin_headers, json=body, timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["created"] == 1
        assert d["status"] == "approved"

        # Cleanup: find the leave and delete via reject
        listing = requests.get(f"{BASE_URL}/api/leaves?status_filter=approved",
                               headers=admin_headers, timeout=15).json()
        match = [item for item in listing if item.get("reason") == "TEST group leave" and item["user_id"] == admin_me["id"]]
        for item in match:
            requests.patch(f"{BASE_URL}/api/leaves/{item['id']}",
                           headers=admin_headers, json={"status": "rejected"}, timeout=10)


# ------------------------- /api/leaves listing regression ----------------
class TestLeavesListing:
    def test_admin_list_enriched(self, admin_headers):
        r = requests.get(f"{BASE_URL}/api/leaves", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        rows = r.json()
        assert isinstance(rows, list)
        if rows:
            assert "member_name" in rows[0]
