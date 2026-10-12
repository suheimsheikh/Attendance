"""Find (and, with --apply, remove) duplicate attendance rows so the unique
(user_id, date) index can be built.

The app's invariant is ONE attendance row per member per day. Legacy data or
old check-in races can leave duplicates, which block the `uniq_user_date`
index from building. This script reports those duplicates and, only when run
with --apply, keeps the single best row per (user_id, date) and deletes the
rest.

"Best" row = the richest/most-complete one:
  1. prefer a row that has a check_out_at (a completed session)
  2. then the one with the earliest check_in_at (the real arrival)
  3. then the one with the most non-null fields

SAFE BY DEFAULT: dry-run. It prints what it WOULD delete and changes nothing.
Pass --apply to actually delete. READ the dry-run output first.

Usage (from /app/backend):
    python scripts/dedupe_attendance.py            # dry-run, report only
    python scripts/dedupe_attendance.py --apply     # actually delete losers
"""
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from pymongo import MongoClient

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


def _score(doc: dict) -> tuple:
    has_checkout = 1 if doc.get("check_out_at") else 0
    # Earliest check_in sorts first → negate by using the raw ISO string
    # (ascending). We want to KEEP earliest, so rank it higher.
    ci = doc.get("check_in_at") or "9999"
    filled = sum(1 for v in doc.values() if v not in (None, "", [], {}))
    # Higher is better: completed session, then (earliest check-in via
    # reversed string compare handled by the caller), then most fields.
    return (has_checkout, filled, ci)


def main() -> int:
    apply = "--apply" in sys.argv
    url, name = os.environ.get("MONGO_URL"), os.environ.get("DB_NAME")
    if not (url and name):
        print("MONGO_URL / DB_NAME not set"); return 2
    db = MongoClient(url)[name]
    groups = list(db.attendance.aggregate([
        {"$group": {"_id": {"u": "$user_id", "d": "$date"},
                    "ids": {"$push": "$_id"}, "n": {"$sum": 1}}},
        {"$match": {"n": {"$gt": 1}}},
    ]))
    if not groups:
        print("No duplicate (user_id, date) rows. The unique index can build.")
        return 0
    total_delete = 0
    for g in groups:
        docs = list(db.attendance.find({"_id": {"$in": g["ids"]}}))
        # Keep: completed session wins, then most fields, then earliest check-in.
        docs.sort(key=lambda d: (
            1 if d.get("check_out_at") else 0,
            sum(1 for v in d.values() if v not in (None, "", [], {})),
            # earliest check_in is better → invert by comparing later
        ), reverse=True)
        # Among equal top candidates prefer the earliest check-in.
        keep = min(docs, key=lambda d: (
            0 if d.get("check_out_at") else 1,     # completed first
            d.get("check_in_at") or "9999",         # earliest arrival
        ))
        losers = [d for d in docs if d["_id"] != keep["_id"]]
        total_delete += len(losers)
        print(f"user={g['_id']['u']} date={g['_id']['d']}: "
              f"keep id={keep.get('id')} (checkout={bool(keep.get('check_out_at'))}), "
              f"delete {len(losers)}")
        if apply:
            db.attendance.delete_many({"_id": {"$in": [d["_id"] for d in losers]}})
    print(f"\n{'DELETED' if apply else 'WOULD DELETE'} {total_delete} row(s) "
          f"across {len(groups)} duplicate group(s).")
    if not apply:
        print("Dry-run only — re-run with --apply to delete. Then redeploy so "
              "the uniq_user_date index builds on startup.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
