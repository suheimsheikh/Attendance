#!/usr/bin/env python3
"""Focused verification for Data Quality checks + safe auto-fix endpoints.

This is a test artifact only. It seeds synthetic dq_test_* rows, snapshots any
pre-existing rows that bulk auto-fix endpoints may touch, restores them after
each assertion, and writes a concise JSON result file.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone, date
from pathlib import Path
from typing import Any

import jwt
import requests
from pymongo import MongoClient


ROOT = Path("/app")
BACKEND_ENV = ROOT / "backend" / ".env"
OUT = ROOT / "test_reports" / "data_quality_backend_result.json"
API = os.environ.get("TEST_API_BASE", "http://localhost:8001/api")
MARKER_PREFIX = "dq_test_"


def load_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k] = v.strip().strip('"').strip("'")
    return env


ENV = load_env(BACKEND_ENV)
client = MongoClient(ENV["MONGO_URL"])
db = client[ENV["DB_NAME"]]


def iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat()


def parse_dt(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        # The legacy DB mixes naive ISO strings and timezone-aware strings.
        # Normalize to naive UTC so test comparisons don't fail on type mixing.
        if dt.tzinfo is not None:
            dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
        return dt
    except Exception:
        return None


def duration_hours(doc: dict[str, Any]) -> float | None:
    ci = parse_dt(doc.get("check_in_at"))
    co = parse_dt(doc.get("check_out_at"))
    if not ci or not co:
        return None
    return (co - ci).total_seconds() / 3600


def lop_span(doc: dict[str, Any]) -> int | None:
    try:
        return (date.fromisoformat(doc["end_date"]) - date.fromisoformat(doc["start_date"])).days + 1
    except Exception:
        return None


def clean_old_marker_rows() -> None:
    for col in (db.attendance, db.leaves, db.devices, db.escorts):
        col.delete_many({"id": {"$regex": f"^{MARKER_PREFIX}"}})
    db.users.delete_many({"id": {"$regex": f"^{MARKER_PREFIX}"}})


def replace_or_insert(col, doc: dict[str, Any]) -> None:
    if "_id" in doc:
        col.replace_one({"_id": doc["_id"]}, doc, upsert=True)
    elif doc.get("id"):
        col.replace_one({"id": doc["id"]}, doc, upsert=True)
    else:
        col.insert_one(doc)


def restore_docs(col, docs: list[dict[str, Any]]) -> None:
    for doc in docs:
        replace_or_insert(col, doc)


def login_admin() -> tuple[str, dict[str, Any]]:
    r = requests.post(
        f"{API}/auth/login",
        json={"email": ENV["ADMIN_SEED_EMAIL"], "password": ENV["ADMIN_SEED_PASSWORD"]},
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()
    return data["access_token"], data["user"]


def post_fix(code: str, token: str | None = None) -> requests.Response:
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    return requests.post(f"{API}/admin/data-quality/fix/{code}", headers=headers, timeout=60)


def get_report(token: str) -> dict[str, Any]:
    r = requests.get(f"{API}/admin/data-quality", headers={"Authorization": f"Bearer {token}"}, timeout=60)
    r.raise_for_status()
    return r.json()


def create_member_token(user_id: str, role: str = "member") -> str:
    payload = {
        "sub": user_id,
        "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(hours=2),
    }
    return jwt.encode(payload, ENV["JWT_SECRET_KEY"], algorithm=ENV["JWT_ALGORITHM"])


class Tester:
    def __init__(self) -> None:
        self.run_id = uuid.uuid4().hex[:10]
        self.user_id = f"{MARKER_PREFIX}user_{self.run_id}"
        self.issues: list[str] = []
        self.evidence: dict[str, Any] = {}
        self.admin_token = ""
        self.member_token = ""

    def assert_true(self, cond: bool, msg: str) -> None:
        if not cond:
            self.issues.append(msg)

    def seed_base_data(self) -> None:
        now = datetime.now(timezone.utc)
        db.users.insert_one({
            "id": self.user_id,
            "email": f"{self.user_id}@example.test",
            "full_name": f"DQ Test Member {self.run_id}",
            "role": "member",
            "category": "staff",
            "rank": "QA",
            "mobile": f"900{self.run_id[:7]}",
            "joining_date": "2026-01-01",
            "weekly_off": "sunday",
            "institution": "QA Institute",
            "fleet": "QA Fleet",
            "created_at": iso(now),
        })
        self.member_token = create_member_token(self.user_id)

        # Missing-field detector member.
        db.users.insert_one({
            "id": f"{MARKER_PREFIX}missing_member_{self.run_id}",
            "email": f"missing_{self.run_id}@example.test",
            "full_name": f"DQ Missing Fields {self.run_id}",
            "role": "member",
            "category": "staff",
            "mobile": f"901{self.run_id[:7]}",
            "rank": "",
            "joining_date": "",
            "weekly_off": "",
            "institution": "",
            "fleet": "",
            "created_at": iso(now),
        })
        # Overlapping leaves.
        db.leaves.insert_many([
            {"id": f"{MARKER_PREFIX}overlap_a_{self.run_id}", "user_id": self.user_id, "user_name": "DQ Test Member", "type": "leave", "status": "approved", "start_date": "2026-02-01", "end_date": "2026-02-05", "reason": "dq overlap a"},
            {"id": f"{MARKER_PREFIX}overlap_b_{self.run_id}", "user_id": self.user_id, "user_name": "DQ Test Member", "type": "leave", "status": "approved", "start_date": "2026-02-04", "end_date": "2026-02-06", "reason": "dq overlap b"},
        ])
        # Too many approved devices.
        db.devices.insert_many([
            {"id": f"{MARKER_PREFIX}device_many_{i}_{self.run_id}", "user_id": self.user_id, "device_id": f"dq-many-{i}-{self.run_id}", "status": "approved", "requested_at": iso(now)}
            for i in range(4)
        ])
        # Duplicate escorts.
        phone_key = f"78{self.run_id[:8]}"[:10]
        db.escorts.insert_many([
            {"id": f"{MARKER_PREFIX}escort_a_{self.run_id}", "name": f"DQ Escort A {self.run_id}", "mobile": phone_key, "mobile_last10": phone_key, "institution": "QA", "status": "active"},
            {"id": f"{MARKER_PREFIX}escort_b_{self.run_id}", "name": f"DQ Escort B {self.run_id}", "mobile": phone_key, "mobile_last10": phone_key, "institution": "QA", "status": "active"},
        ])

    def auth_guard_tests(self) -> None:
        codes = [
            "session.zero_duration", "session.too_long_16h", "session.duplicate_open",
            "session.open_over_36h", "leave.lop_exceeds_span", "device.approved_for_ex_member",
        ]
        no_auth = {}
        member_auth = {}
        for code in codes:
            r1 = post_fix(code, None)
            r2 = post_fix(code, self.member_token)
            no_auth[code] = r1.status_code
            member_auth[code] = r2.status_code
            self.assert_true(r1.status_code == 401, f"{code}: no-auth returned {r1.status_code}, expected 401")
            self.assert_true(r2.status_code == 403, f"{code}: member token returned {r2.status_code}, expected 403")
        self.evidence["auth_guard"] = {"no_auth": no_auth, "member_auth": member_auth}

    def findings_shape_and_codes(self) -> None:
        report = get_report(self.admin_token)
        findings = report.get("findings", [])
        required_fields = {"code", "severity", "message", "entity_type", "entity_ids", "entity_names"}
        malformed = [f.get("code", "<missing-code>") for f in findings if not required_fields.issubset(f.keys())]
        self.assert_true(not malformed, f"Findings missing required fields: {malformed[:10]}")
        codes = {f.get("code") for f in findings}
        expected_present = {
            "member.missing_joining_date", "member.missing_weekly_off", "member.missing_institution",
            "leave.overlapping", "device.too_many_active", "escort.duplicate_phone",
            "config.no_office_geofence", "config.empty_categories", "config.stale_holidays",
        }
        # session.too_long_16h is verified with a dedicated seed in its fix test.
        missing_codes = sorted(c for c in expected_present if c not in codes)
        self.assert_true(not missing_codes, f"Expected seeded/global new codes missing from GET report: {missing_codes}")

        auto_codes = {
            "session.zero_duration", "session.too_long_16h", "session.duplicate_open",
            "session.open_over_36h", "leave.lop_exceeds_span", "device.approved_for_ex_member",
        }
        bad_auto = [f.get("code") for f in findings if f.get("code") in auto_codes and f.get("auto_fix") is not True]
        self.assert_true(not bad_auto, f"Auto-fix findings missing auto_fix:true: {bad_auto[:10]}")

        office = db.config.find_one({"id": "office"}, {"_id": 0}) or {}
        cats_count = db.categories.count_documents({})
        cats_master_count = db.categories_master.count_documents({})
        self.evidence["get_report"] = {
            "total_findings": report.get("total_findings"),
            "seeded_codes_present": sorted(expected_present - set(missing_codes)),
            "config_codes_present": sorted(c for c in codes if str(c).startswith("config.")),
            "office_has_latitude_longitude_radius": bool(office.get("latitude") and office.get("longitude") and (office.get("radius_m") or 0) > 0),
            "office_has_lat_lng": bool(office.get("lat") and office.get("lng")),
            "categories_count": cats_count,
            "categories_master_count": cats_master_count,
        }
        # Detect false-positive global config checks caused by wrong collection/field names.
        if "config.no_office_geofence" in codes and self.evidence["get_report"]["office_has_latitude_longitude_radius"]:
            self.issues.append("config.no_office_geofence fires even though office config has latitude/longitude/radius_m set")
        if "config.empty_categories" in codes and cats_count > 0:
            self.issues.append("config.empty_categories fires even though db.categories has seeded category rows; detector reads db.categories_master")

    def test_fix_too_long(self) -> None:
        test_id = f"{MARKER_PREFIX}long_{self.run_id}"
        before = [d for d in db.attendance.find({"check_out_at": {"$ne": None}}) if (duration_hours(d) or 0) > 16]
        ci = datetime.now(timezone.utc) - timedelta(days=1)
        db.attendance.insert_one({"id": test_id, "user_id": self.user_id, "user_name": "DQ Test Member", "date": date.today().isoformat(), "check_in_at": iso(ci), "check_out_at": iso(ci + timedelta(hours=19)), "source": "dq_test"})
        r = post_fix("session.too_long_16h", self.admin_token)
        self.assert_true(r.status_code == 200, f"too_long fix returned HTTP {r.status_code}: {r.text[:200]}")
        data = r.json() if r.ok else {}
        self.assert_true(set(data.keys()) == {"fixed"} and isinstance(data.get("fixed"), int), f"too_long response not {{fixed:int}}: {data}")
        doc = db.attendance.find_one({"id": test_id})
        self.assert_true(doc and duration_hours(doc) == 16, f"too_long test row not capped to exactly 16h: {doc}")
        self.assert_true(bool(doc and doc.get("auto_capped") is True and doc.get("auto_capped_by") == "data_quality"), "too_long did not set auto_capped flags")
        remaining = [d.get("id") for d in db.attendance.find({"check_out_at": {"$ne": None}}) if (duration_hours(d) or 0) > 16]
        self.assert_true(not remaining, f"too_long left >16h sessions after fix: {remaining[:5]}")
        r2 = post_fix("session.too_long_16h", self.admin_token)
        self.assert_true(r2.ok and r2.json().get("fixed") == 0, f"too_long not idempotent: {r2.status_code} {r2.text}")
        db.attendance.delete_one({"id": test_id})
        restore_docs(db.attendance, before)
        self.evidence["fix_session.too_long_16h"] = {"initial_existing": len(before), "first_fixed": data.get("fixed"), "second_fixed": r2.json().get("fixed") if r2.ok else None}

    def test_fix_zero_duration(self) -> None:
        test_id = f"{MARKER_PREFIX}zero_{self.run_id}"
        before = list(db.attendance.find({"$expr": {"$eq": ["$check_in_at", "$check_out_at"]}, "check_out_at": {"$ne": None}}))
        t = iso(datetime.now(timezone.utc) - timedelta(hours=2))
        db.attendance.insert_one({"id": test_id, "user_id": self.user_id, "user_name": "DQ Test Member", "date": date.today().isoformat(), "check_in_at": t, "check_out_at": t, "source": "dq_test"})
        r = post_fix("session.zero_duration", self.admin_token)
        data = r.json() if r.ok else {}
        self.assert_true(r.ok and set(data.keys()) == {"fixed"} and isinstance(data.get("fixed"), int), f"zero_duration bad response: {r.status_code} {r.text}")
        rem = db.attendance.count_documents({"$expr": {"$eq": ["$check_in_at", "$check_out_at"]}, "check_out_at": {"$ne": None}})
        self.assert_true(rem == 0, f"zero_duration left {rem} zero-duration rows")
        self.assert_true(db.attendance.count_documents({"id": test_id}) == 0, "zero_duration did not delete synthetic row")
        r2 = post_fix("session.zero_duration", self.admin_token)
        self.assert_true(r2.ok and r2.json().get("fixed") == 0, f"zero_duration not idempotent: {r2.status_code} {r2.text}")
        restore_docs(db.attendance, before)
        self.evidence["fix_session.zero_duration"] = {"initial_existing": len(before), "first_fixed": data.get("fixed"), "second_fixed": r2.json().get("fixed") if r2.ok else None}

    def test_fix_duplicate_open(self) -> None:
        ids = [f"{MARKER_PREFIX}dup_open_early_{self.run_id}", f"{MARKER_PREFIX}dup_open_late_{self.run_id}"]
        groups = list(db.attendance.aggregate([
            {"$match": {"check_out_at": None}}, {"$group": {"_id": "$user_id", "n": {"$sum": 1}}}, {"$match": {"n": {"$gt": 1}}}
        ]))
        affected_uids = [g["_id"] for g in groups]
        before = list(db.attendance.find({"check_out_at": None, "user_id": {"$in": affected_uids}})) if affected_uids else []
        now = datetime.now(timezone.utc)
        db.attendance.insert_many([
            {"id": ids[0], "user_id": self.user_id, "user_name": "DQ Test Member", "date": date.today().isoformat(), "check_in_at": iso(now - timedelta(hours=4)), "check_out_at": None, "source": "dq_test"},
            {"id": ids[1], "user_id": self.user_id, "user_name": "DQ Test Member", "date": date.today().isoformat(), "check_in_at": iso(now - timedelta(hours=1)), "check_out_at": None, "source": "dq_test"},
        ])
        r = post_fix("session.duplicate_open", self.admin_token)
        data = r.json() if r.ok else {}
        self.assert_true(r.ok and set(data.keys()) == {"fixed"}, f"duplicate_open bad response: {r.status_code} {r.text}")
        remaining = list(db.attendance.find({"user_id": self.user_id, "check_out_at": None, "id": {"$in": ids}}))
        self.assert_true(len(remaining) == 1 and remaining[0]["id"] == ids[0], f"duplicate_open did not keep only earliest synthetic open row: {remaining}")
        remaining_groups = list(db.attendance.aggregate([
            {"$match": {"check_out_at": None}}, {"$group": {"_id": "$user_id", "n": {"$sum": 1}}}, {"$match": {"n": {"$gt": 1}}}
        ]))
        self.assert_true(not remaining_groups, f"duplicate_open left duplicate groups: {remaining_groups[:5]}")
        r2 = post_fix("session.duplicate_open", self.admin_token)
        self.assert_true(r2.ok and r2.json().get("fixed") == 0, f"duplicate_open not idempotent: {r2.status_code} {r2.text}")
        db.attendance.delete_many({"id": {"$in": ids}})
        restore_docs(db.attendance, before)
        self.evidence["fix_session.duplicate_open"] = {"initial_existing_groups": len(groups), "first_fixed": data.get("fixed"), "second_fixed": r2.json().get("fixed") if r2.ok else None}

    def test_fix_open_over_36h(self) -> None:
        test_id = f"{MARKER_PREFIX}open36_{self.run_id}"
        cutoff = datetime.now(timezone.utc) - timedelta(hours=36)
        before = [d for d in db.attendance.find({"check_out_at": None}) if (parse_dt(d.get("check_in_at")) or datetime.now(timezone.utc)) < cutoff]
        ci = datetime.now(timezone.utc) - timedelta(hours=48)
        db.attendance.insert_one({"id": test_id, "user_id": self.user_id, "user_name": "DQ Test Member", "date": date.today().isoformat(), "check_in_at": iso(ci), "check_out_at": None, "source": "dq_test"})
        r = post_fix("session.open_over_36h", self.admin_token)
        data = r.json() if r.ok else {}
        self.assert_true(r.ok and set(data.keys()) == {"fixed"}, f"open_over_36h bad response: {r.status_code} {r.text}")
        doc = db.attendance.find_one({"id": test_id})
        self.assert_true(doc and duration_hours(doc) == 8, f"open_over_36h did not close synthetic row at +8h: {doc}")
        self.assert_true(bool(doc and doc.get("auto_closed") is True), "open_over_36h did not set auto_closed true")
        rem = [d.get("id") for d in db.attendance.find({"check_out_at": None}) if (parse_dt(d.get("check_in_at")) or datetime.now(timezone.utc)) < cutoff]
        self.assert_true(not rem, f"open_over_36h left stale open sessions: {rem[:5]}")
        r2 = post_fix("session.open_over_36h", self.admin_token)
        self.assert_true(r2.ok and r2.json().get("fixed") == 0, f"open_over_36h not idempotent: {r2.status_code} {r2.text}")
        db.attendance.delete_one({"id": test_id})
        restore_docs(db.attendance, before)
        self.evidence["fix_session.open_over_36h"] = {"initial_existing": len(before), "first_fixed": data.get("fixed"), "second_fixed": r2.json().get("fixed") if r2.ok else None}

    def test_fix_lop_exceeds_span(self) -> None:
        test_id = f"{MARKER_PREFIX}lop_{self.run_id}"
        before = [d for d in db.leaves.find({"lop_days": {"$gt": 0}}) if lop_span(d) is not None and (d.get("lop_days") or 0) > lop_span(d)]
        db.leaves.insert_one({"id": test_id, "user_id": self.user_id, "user_name": "DQ Test Member", "type": "leave", "status": "approved", "start_date": "2026-01-01", "end_date": "2026-01-03", "lop_days": 999, "reason": "dq lop test"})
        r = post_fix("leave.lop_exceeds_span", self.admin_token)
        data = r.json() if r.ok else {}
        self.assert_true(r.ok and set(data.keys()) == {"fixed"}, f"lop_exceeds_span bad response: {r.status_code} {r.text}")
        doc = db.leaves.find_one({"id": test_id})
        self.assert_true(doc and float(doc.get("lop_days")) == 3.0, f"lop_exceeds_span did not cap to 3: {doc}")
        rem = [d.get("id") for d in db.leaves.find({"lop_days": {"$gt": 0}}) if lop_span(d) is not None and (d.get("lop_days") or 0) > lop_span(d)]
        self.assert_true(not rem, f"lop_exceeds_span left leaves with lop_days > span: {rem[:5]}")
        r2 = post_fix("leave.lop_exceeds_span", self.admin_token)
        self.assert_true(r2.ok and r2.json().get("fixed") == 0, f"lop_exceeds_span not idempotent: {r2.status_code} {r2.text}")
        db.leaves.delete_one({"id": test_id})
        restore_docs(db.leaves, before)
        self.evidence["fix_leave.lop_exceeds_span"] = {"initial_existing": len(before), "first_fixed": data.get("fixed"), "second_fixed": r2.json().get("fixed") if r2.ok else None}

    def test_fix_device_approved_for_ex_member(self) -> None:
        today = date.today().isoformat()
        ex_user_id = f"{MARKER_PREFIX}ex_user_{self.run_id}"
        db.users.insert_one({
            "id": ex_user_id, "email": f"ex_{self.run_id}@example.test", "full_name": f"DQ Ex Member {self.run_id}",
            "role": "member", "category": "staff", "rank": "QA", "joining_date": "2026-01-01", "weekly_off": "sunday", "institution": "QA", "fleet": "QA",
        })
        # Exercise the public admin PATCH path for setting leaving_date, then insert an approved device afterwards.
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        patch = requests.patch(f"{API}/members/{ex_user_id}", json={"leaving_date": yesterday}, headers={"Authorization": f"Bearer {self.admin_token}"}, timeout=30)
        self.assert_true(patch.ok, f"PATCH member leaving_date failed: {patch.status_code} {patch.text[:200]}")
        ex_ids_before = [u["id"] for u in db.users.find({"leaving_date": {"$nin": [None, ""], "$lt": today}}, {"id": 1})]
        before = list(db.devices.find({"user_id": {"$in": ex_ids_before}, "status": "approved"}))
        test_dev = f"{MARKER_PREFIX}ex_dev_{self.run_id}"
        db.devices.insert_one({"id": test_dev, "user_id": ex_user_id, "device_id": f"dq-ex-{self.run_id}", "status": "approved", "requested_at": iso(datetime.now(timezone.utc))})
        r = post_fix("device.approved_for_ex_member", self.admin_token)
        data = r.json() if r.ok else {}
        self.assert_true(r.ok and set(data.keys()) == {"fixed"}, f"approved_for_ex_member bad response: {r.status_code} {r.text}")
        doc = db.devices.find_one({"id": test_dev})
        self.assert_true(doc and doc.get("status") == "revoked", f"approved_for_ex_member did not revoke synthetic device: {doc}")
        self.assert_true(doc and doc.get("revoked_reason") == "Ex-member cleanup via Data Quality", f"approved_for_ex_member wrong revoked_reason: {doc}")
        rem = db.devices.count_documents({"user_id": {"$in": ex_ids_before + [ex_user_id]}, "status": "approved"})
        self.assert_true(rem == 0, f"approved_for_ex_member left {rem} approved devices for ex-members")
        r2 = post_fix("device.approved_for_ex_member", self.admin_token)
        self.assert_true(r2.ok and r2.json().get("fixed") == 0, f"approved_for_ex_member not idempotent: {r2.status_code} {r2.text}")
        db.devices.delete_one({"id": test_dev})
        restore_docs(db.devices, before)
        db.users.delete_one({"id": ex_user_id})
        self.evidence["fix_device.approved_for_ex_member"] = {"initial_existing": len(before), "first_fixed": data.get("fixed"), "second_fixed": r2.json().get("fixed") if r2.ok else None}

    def run(self) -> dict[str, Any]:
        clean_old_marker_rows()
        try:
            self.admin_token, admin_user = login_admin()
            self.evidence["admin_login"] = {"ok": True, "user": admin_user.get("email") or admin_user.get("full_name")}
            self.seed_base_data()
            self.auth_guard_tests()
            self.findings_shape_and_codes()
            self.test_fix_too_long()
            self.test_fix_zero_duration()
            self.test_fix_duplicate_open()
            self.test_fix_open_over_36h()
            self.test_fix_lop_exceeds_span()
            self.test_fix_device_approved_for_ex_member()
        except Exception as e:  # capture unexpected infrastructure/test failures
            self.issues.append(f"Unexpected test exception: {type(e).__name__}: {e}")
        finally:
            clean_old_marker_rows()
        result = {
            "ok": not self.issues,
            "issues": self.issues,
            "evidence": self.evidence,
            "api_base": API,
        }
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(result, default=str, indent=2))
        return result


if __name__ == "__main__":
    result = Tester().run()
    print(json.dumps(result, default=str, indent=2))
    sys.exit(0 if result["ok"] else 1)