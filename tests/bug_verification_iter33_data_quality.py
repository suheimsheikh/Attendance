#!/usr/bin/env python3
"""Iteration 33 focused backend retest for Data Quality fixes.

Scope from review request:
1) config.empty_categories must read db.categories, not categories_master.
2) session.too_long_16h report/fix must handle mixed naive/tz-aware ISO strings.
3) Selected auto-fix endpoints must be idempotent on a second POST.

The script seeds only synthetic dq33_* rows and snapshots any pre-existing rows
that a bulk auto-fix could touch, then restores them before exit.
"""
from __future__ import annotations

import json
import os
import sys
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests
from pymongo import MongoClient


ROOT = Path("/app")
BACKEND_ENV = ROOT / "backend" / ".env"
OUT = ROOT / "test_reports" / "data_quality_iter33_backend_result.json"
API = os.environ.get("TEST_API_BASE", "http://localhost:8001/api")
MARKER = "dq33_"


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
        if dt.tzinfo is not None:
            dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
        return dt
    except Exception:
        return None


def hours(doc: dict[str, Any]) -> float | None:
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


def json_safe(x: Any) -> Any:
    if isinstance(x, list):
        return [json_safe(i) for i in x]
    if isinstance(x, dict):
        return {k: json_safe(v) for k, v in x.items() if k != "_id"}
    return x


def replace_doc(col, doc: dict[str, Any]) -> None:
    if "_id" in doc:
        col.replace_one({"_id": doc["_id"]}, doc, upsert=True)
    elif doc.get("id"):
        col.replace_one({"id": doc["id"]}, doc, upsert=True)
    else:
        col.insert_one(doc)


def restore_docs(col, docs: list[dict[str, Any]]) -> None:
    for d in docs:
        replace_doc(col, d)


def cleanup_marker_rows() -> None:
    for col in (db.attendance, db.leaves, db.devices, db.users, db.categories):
        col.delete_many({"id": {"$regex": f"^{MARKER}"}})


class DQRetest:
    def __init__(self) -> None:
        self.run_id = uuid.uuid4().hex[:10]
        self.issues: list[dict[str, Any]] = []
        self.evidence: dict[str, Any] = {}
        self.token = ""
        self.user_id = f"{MARKER}user_{self.run_id}"

    def fail(self, check: str, detail: str, **extra: Any) -> None:
        self.issues.append({"check": check, "detail": detail, **extra})

    def expect(self, cond: bool, check: str, detail: str, **extra: Any) -> None:
        if not cond:
            self.fail(check, detail, **extra)

    def login(self) -> None:
        r = requests.post(
            f"{API}/auth/login",
            json={"email": ENV["ADMIN_SEED_EMAIL"], "password": ENV["ADMIN_SEED_PASSWORD"]},
            timeout=30,
        )
        self.expect(r.status_code == 200, "admin_login", f"HTTP {r.status_code}: {r.text[:200]}")
        if r.ok:
            data = r.json()
            self.token = data["access_token"]
            self.evidence["admin_login"] = {"ok": True, "user": data.get("user", {}).get("email")}

    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}

    def report(self) -> dict[str, Any]:
        r = requests.get(f"{API}/admin/data-quality", headers=self.headers(), timeout=90)
        self.expect(r.status_code == 200, "get_data_quality", f"HTTP {r.status_code}: {r.text[:300]}")
        return r.json() if r.ok else {"findings": []}

    def post_fix(self, code: str) -> requests.Response:
        return requests.post(f"{API}/admin/data-quality/fix/{code}", headers=self.headers(), timeout=90)

    def seed_user(self) -> None:
        db.users.insert_one({
            "id": self.user_id,
            "email": f"{self.user_id}@example.test",
            "full_name": f"DQ33 Test User {self.run_id}",
            "role": "member",
            "category": "staff",
            "rank": "QA",
            "mobile": f"98{self.run_id[:8]}",
            "joining_date": "2026-01-01",
            "weekly_off": "sunday",
            "institution": "QA",
            "fleet": "QA",
        })

    def test_categories_detector_both_branches(self) -> None:
        original = list(db.categories.find({}))
        synthetic_id = f"{MARKER}cat_{self.run_id}"
        try:
            if db.categories.count_documents({}) == 0:
                db.categories.insert_one({"id": synthetic_id, "name": "DQ33 Synthetic Category", "value": "dq33"})

            count_with_rows = db.categories.count_documents({})
            rep_with_rows = self.report()
            codes_with_rows = [f.get("code") for f in rep_with_rows.get("findings", [])]
            self.expect(
                count_with_rows >= 1 and "config.empty_categories" not in codes_with_rows,
                "config.empty_categories_non_empty_branch",
                "config.empty_categories fired even though db.categories has >=1 row",
                categories_count=count_with_rows,
                has_code="config.empty_categories" in codes_with_rows,
            )

            db.categories.delete_many({})
            count_empty = db.categories.count_documents({})
            rep_empty = self.report()
            codes_empty = [f.get("code") for f in rep_empty.get("findings", [])]
            self.expect(
                count_empty == 0 and "config.empty_categories" in codes_empty,
                "config.empty_categories_empty_branch",
                "config.empty_categories did not fire when db.categories was empty",
                categories_count=count_empty,
                has_code="config.empty_categories" in codes_empty,
            )
            self.evidence["categories_detector"] = {
                "original_count": len(original),
                "non_empty_count": count_with_rows,
                "non_empty_has_config_empty_categories": "config.empty_categories" in codes_with_rows,
                "empty_count": count_empty,
                "empty_has_config_empty_categories": "config.empty_categories" in codes_empty,
            }
        finally:
            db.categories.delete_many({})
            restore_docs(db.categories, original)

    def test_too_long_mixed_datetime_shapes(self) -> None:
        test_ids = [f"{MARKER}long_{i}_{self.run_id}" for i in range(6)]
        now_date = date.today().isoformat()
        rows = [
            # naive -> naive
            {"id": test_ids[0], "check_in_at": "2026-07-01T00:00:00", "check_out_at": "2026-07-01T18:30:00"},
            # Z -> Z
            {"id": test_ids[1], "check_in_at": "2026-07-02T00:00:00Z", "check_out_at": "2026-07-02T18:00:00Z"},
            # +00:00 -> +00:00
            {"id": test_ids[2], "check_in_at": "2026-07-03T00:00:00+00:00", "check_out_at": "2026-07-03T20:00:00+00:00"},
            # Z -> naive: this used to raise aware/naive TypeError without normalization.
            {"id": test_ids[3], "check_in_at": "2026-07-04T00:00:00Z", "check_out_at": "2026-07-04T18:45:00"},
            # naive -> +00:00: inverse mixed shape.
            {"id": test_ids[4], "check_in_at": "2026-07-05T00:00:00", "check_out_at": "2026-07-05T17:30:00+00:00"},
            # Non-UTC offset -> same non-UTC offset.
            {"id": test_ids[5], "check_in_at": "2026-07-06T06:00:00+05:30", "check_out_at": "2026-07-07T01:00:00+05:30"},
        ]
        before_gt16_docs = [d for d in db.attendance.find({"check_out_at": {"$ne": None}}) if (hours(d) or 0) > 16]
        try:
            for r in rows:
                db.attendance.insert_one({
                    **r,
                    "user_id": self.user_id,
                    "user_name": "DQ33 Test User",
                    "date": now_date,
                    "source": "dq33_test",
                })

            seeded_gt16_before = [d.get("id") for d in db.attendance.find({"id": {"$in": test_ids}}) if (hours(d) or 0) > 16]
            all_gt16_before = [d.get("id") for d in db.attendance.find({"check_out_at": {"$ne": None}}) if (hours(d) or 0) > 16]
            rep_before = self.report()
            long_findings_before = [f for f in rep_before.get("findings", []) if f.get("code") == "session.too_long_16h"]
            reported_ids = {eid for f in long_findings_before for eid in f.get("entity_ids", [])}

            r1 = self.post_fix("session.too_long_16h")
            data1 = r1.json() if r1.ok else {}
            all_gt16_after = [d.get("id") for d in db.attendance.find({"check_out_at": {"$ne": None}}) if (hours(d) or 0) > 16]
            seeded_after_docs = list(db.attendance.find({"id": {"$in": test_ids}}, {"_id": 0}))
            seeded_hours_after = {d["id"]: hours(d) for d in seeded_after_docs}

            r2 = self.post_fix("session.too_long_16h")
            data2 = r2.json() if r2.ok else {}

            self.expect(len(seeded_gt16_before) == len(test_ids), "too_long_seed_setup", "Not all mixed-shape seed rows measured >16h before fix", seeded_gt16_before=seeded_gt16_before)
            self.expect(bool(long_findings_before), "too_long_report_detector", "GET /admin/data-quality did not include session.too_long_16h before fix")
            self.expect(any(tid in reported_ids for tid in test_ids), "too_long_report_mixed_ids", "Report did not include any synthetic mixed-shape too-long attendance id", reported_synthetic=sorted(reported_ids.intersection(test_ids)))
            self.expect(r1.status_code == 200 and isinstance(data1.get("fixed"), int), "too_long_first_post_response", f"Bad first POST response: HTTP {r1.status_code} {r1.text[:300]}")
            self.expect(data1.get("fixed", 0) >= len(test_ids), "too_long_first_post_count", "First POST fixed fewer rows than seeded >16h rows", first_fixed=data1.get("fixed"), seeded=len(test_ids))
            self.expect(not all_gt16_after, "too_long_after_count", "Rows with real span >16h remained after fix", remaining_gt16_ids=all_gt16_after[:20])
            bad_seeded_caps = {k: v for k, v in seeded_hours_after.items() if v is None or v > 16.0001}
            self.expect(not bad_seeded_caps, "too_long_seeded_capped", "Seeded mixed-shape rows were not capped to <=16h", seeded_hours_after=seeded_hours_after)
            self.expect(r2.status_code == 200 and data2.get("fixed") == 0, "too_long_second_post_idempotency", f"Second POST not idempotent: HTTP {r2.status_code} {r2.text[:300]}")
            self.evidence["session.too_long_16h"] = {
                "existing_gt16_before": len(before_gt16_docs),
                "seeded_gt16_before": len(seeded_gt16_before),
                "all_gt16_before": len(all_gt16_before),
                "report_findings_before": len(long_findings_before),
                "reported_synthetic_ids": sorted(reported_ids.intersection(test_ids)),
                "first_fixed": data1.get("fixed"),
                "all_gt16_after": len(all_gt16_after),
                "seeded_hours_after": seeded_hours_after,
                "second_fixed": data2.get("fixed"),
            }
        finally:
            db.attendance.delete_many({"id": {"$in": test_ids}})
            restore_docs(db.attendance, before_gt16_docs)

    def test_other_fix_idempotency(self) -> None:
        summary: dict[str, Any] = {}
        # session.zero_duration
        zero_id = f"{MARKER}zero_{self.run_id}"
        zero_before = list(db.attendance.find({"$expr": {"$eq": ["$check_in_at", "$check_out_at"]}, "check_out_at": {"$ne": None}}))
        try:
            t = iso(datetime.now(timezone.utc) - timedelta(hours=2))
            db.attendance.insert_one({"id": zero_id, "user_id": self.user_id, "user_name": "DQ33 Test User", "date": date.today().isoformat(), "check_in_at": t, "check_out_at": t, "source": "dq33_test"})
            r1, r2 = self.post_fix("session.zero_duration"), None
            d1 = r1.json() if r1.ok else {}
            r2 = self.post_fix("session.zero_duration")
            d2 = r2.json() if r2.ok else {}
            self.expect(r1.ok and d1.get("fixed", 0) >= 1, "zero_duration_first_fix", f"First zero_duration fix failed: HTTP {r1.status_code} {r1.text[:200]}")
            self.expect(r2.ok and d2.get("fixed") == 0, "zero_duration_second_idempotency", f"Second zero_duration fix not idempotent: HTTP {r2.status_code} {r2.text[:200]}")
            summary["session.zero_duration"] = {"first_fixed": d1.get("fixed"), "second_fixed": d2.get("fixed")}
        finally:
            db.attendance.delete_one({"id": zero_id})
            restore_docs(db.attendance, zero_before)

        # session.open_over_36h
        open_id = f"{MARKER}open36_{self.run_id}"
        cutoff = datetime.now(timezone.utc) - timedelta(hours=36)
        open_before = [d for d in db.attendance.find({"check_out_at": None}) if (parse_dt(d.get("check_in_at")) or datetime.now(timezone.utc)) < cutoff]
        try:
            ci = datetime.now(timezone.utc) - timedelta(hours=48)
            db.attendance.insert_one({"id": open_id, "user_id": self.user_id, "user_name": "DQ33 Test User", "date": date.today().isoformat(), "check_in_at": iso(ci), "check_out_at": None, "source": "dq33_test"})
            r1 = self.post_fix("session.open_over_36h")
            d1 = r1.json() if r1.ok else {}
            r2 = self.post_fix("session.open_over_36h")
            d2 = r2.json() if r2.ok else {}
            self.expect(r1.ok and d1.get("fixed", 0) >= 1, "open_over_36h_first_fix", f"First open_over_36h fix failed: HTTP {r1.status_code} {r1.text[:200]}")
            self.expect(r2.ok and d2.get("fixed") == 0, "open_over_36h_second_idempotency", f"Second open_over_36h fix not idempotent: HTTP {r2.status_code} {r2.text[:200]}")
            summary["session.open_over_36h"] = {"first_fixed": d1.get("fixed"), "second_fixed": d2.get("fixed")}
        finally:
            db.attendance.delete_one({"id": open_id})
            restore_docs(db.attendance, open_before)

        # leave.lop_exceeds_span
        leave_id = f"{MARKER}lop_{self.run_id}"
        lop_before = [d for d in db.leaves.find({"lop_days": {"$gt": 0}}) if lop_span(d) is not None and (d.get("lop_days") or 0) > lop_span(d)]
        try:
            db.leaves.insert_one({"id": leave_id, "user_id": self.user_id, "user_name": "DQ33 Test User", "type": "leave", "status": "approved", "start_date": "2026-07-01", "end_date": "2026-07-03", "lop_days": 99, "reason": "dq33 lop"})
            r1 = self.post_fix("leave.lop_exceeds_span")
            d1 = r1.json() if r1.ok else {}
            r2 = self.post_fix("leave.lop_exceeds_span")
            d2 = r2.json() if r2.ok else {}
            self.expect(r1.ok and d1.get("fixed", 0) >= 1, "lop_exceeds_span_first_fix", f"First lop fix failed: HTTP {r1.status_code} {r1.text[:200]}")
            self.expect(r2.ok and d2.get("fixed") == 0, "lop_exceeds_span_second_idempotency", f"Second lop fix not idempotent: HTTP {r2.status_code} {r2.text[:200]}")
            summary["leave.lop_exceeds_span"] = {"first_fixed": d1.get("fixed"), "second_fixed": d2.get("fixed")}
        finally:
            db.leaves.delete_one({"id": leave_id})
            restore_docs(db.leaves, lop_before)

        # device.approved_for_ex_member
        ex_user = f"{MARKER}ex_{self.run_id}"
        dev_id = f"{MARKER}dev_{self.run_id}"
        today = date.today().isoformat()
        yesterday = (date.today() - timedelta(days=1)).isoformat()
        ex_user_ids_before = [u["id"] for u in db.users.find({"leaving_date": {"$nin": [None, ""], "$lt": today}}, {"id": 1})]
        device_before = list(db.devices.find({"user_id": {"$in": ex_user_ids_before}, "status": "approved"}))
        try:
            db.users.insert_one({"id": ex_user, "email": f"{ex_user}@example.test", "full_name": "DQ33 Ex User", "role": "member", "category": "staff", "leaving_date": yesterday})
            db.devices.insert_one({"id": dev_id, "user_id": ex_user, "device_id": f"dq33-{self.run_id}", "status": "approved", "requested_at": iso(datetime.now(timezone.utc))})
            r1 = self.post_fix("device.approved_for_ex_member")
            d1 = r1.json() if r1.ok else {}
            r2 = self.post_fix("device.approved_for_ex_member")
            d2 = r2.json() if r2.ok else {}
            self.expect(r1.ok and d1.get("fixed", 0) >= 1, "approved_for_ex_member_first_fix", f"First device fix failed: HTTP {r1.status_code} {r1.text[:200]}")
            self.expect(r2.ok and d2.get("fixed") == 0, "approved_for_ex_member_second_idempotency", f"Second device fix not idempotent: HTTP {r2.status_code} {r2.text[:200]}")
            summary["device.approved_for_ex_member"] = {"first_fixed": d1.get("fixed"), "second_fixed": d2.get("fixed")}
        finally:
            db.devices.delete_one({"id": dev_id})
            db.users.delete_one({"id": ex_user})
            restore_docs(db.devices, device_before)

        self.evidence["other_fix_idempotency"] = summary

    def run(self) -> dict[str, Any]:
        cleanup_marker_rows()
        try:
            self.login()
            if self.token:
                self.seed_user()
                self.test_categories_detector_both_branches()
                self.test_too_long_mixed_datetime_shapes()
                self.test_other_fix_idempotency()
        except Exception as exc:
            self.fail("unexpected_exception", f"{type(exc).__name__}: {exc}")
        finally:
            cleanup_marker_rows()
        result = {
            "ok": not self.issues,
            "issues": json_safe(self.issues),
            "evidence": json_safe(self.evidence),
            "api_base": API,
            "db_name": ENV.get("DB_NAME"),
        }
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(result, indent=2, default=str))
        return result


if __name__ == "__main__":
    res = DQRetest().run()
    print(json.dumps(res, indent=2, default=str))
    sys.exit(0 if res["ok"] else 1)