"""
Admin tooling endpoints — pre-flight checks, dashboard counters, live
activity feed, full backup / restore, and the danger-zone wipe.

Split out of `server.py` during the 06/2026 modularisation pass.

Covers:
  • POST /api/admin/attendance/wipe   — delete every attendance row.
  • GET  /api/admin/backup            — tar.gz snapshot of all collections.
  • POST /api/admin/restore           — merge / replace from a backup tar.gz.
  • GET  /api/admin/preflight         — green / amber / red launch checklist.
  • GET  /api/admin/summary           — dashboard counter card.
  • GET  /api/admin/activity          — today's events (check-ins, leaves, …).
"""
from __future__ import annotations

import io
import json
import logging
import tarfile
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response

from services.attendance_bulk import run_or_queue
from services.time_utils import (
    DEFAULT_TZ, local_date_str, local_hm, local_now, now_utc, office_tz, to_utc_iso,
)

logger = logging.getLogger(__name__)

# Full backup/restore now enumerates collections at RUNTIME so new modules
# are captured automatically and can never be silently missed again (28 Sep
# 2026 — replaced the old hand-maintained BACKUP_COLLECTIONS list, which had
# drifted and was omitting 22 live collections). Nothing in the app database
# is excluded — only MongoDB's own internal `system.*` collections, which
# can't be dumped or restored as ordinary data.
BACKUP_DENY_PREFIXES = ("system.",)


async def _all_backup_collections(db) -> list[str]:
    """Every application collection currently in the database, sorted."""
    names = await db.list_collection_names()
    return sorted(n for n in names if not n.startswith(BACKUP_DENY_PREFIXES))


# Automatic daily backups live under 7 fixed weekday slots so storage never
# grows past the last 7 days (the object store has no delete API — overwriting
# a fixed path is how we "prune"). Slot = weekday name of the run date.
AUTO_BACKUP_DIR = "backups/auto"
_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


async def build_full_backup(db) -> tuple[bytes, str]:
    """Build a full-database tar.gz snapshot (every collection). Returns
    (bytes, friendly IST-timestamped filename). Shared by the manual download
    and the scheduled auto-backup so both stay identical."""
    buf = io.BytesIO()
    tf = tarfile.open(fileobj=buf, mode="w:gz")
    collections = await _all_backup_collections(db)
    manifest = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "kind": "ych-full",
        "collections": {},
    }
    BATCH = 500
    for name in collections:
        chunks: list[bytes] = [b"[\n"]
        total = 0
        first = True
        async for d in db[name].find({}, {"_id": 0}):
            if not first:
                chunks.append(b",\n")
            chunks.append(json.dumps(d, default=str).encode("utf-8"))
            first = False
            total += 1
            if total % BATCH == 0:
                chunks = [b"".join(chunks)]
        chunks.append(b"\n]")
        payload = b"".join(chunks)
        info = tarfile.TarInfo(f"ych-full/{name}.json")
        info.size = len(payload)
        tf.addfile(info, io.BytesIO(payload))
        manifest["collections"][name] = total
    mpayload = json.dumps(manifest, indent=2).encode("utf-8")
    info = tarfile.TarInfo("ych-full/manifest.json")
    info.size = len(mpayload)
    tf.addfile(info, io.BytesIO(mpayload))
    tf.close()
    fname = f"YCH-Attendance-Backup-{local_now(None).strftime('%Y-%m-%d_%H%M-%S')}.tar.gz"
    return buf.getvalue(), fname


async def stamp_last_backup(db, by: str) -> None:
    """Record when/who took the most recent backup (manual or auto) so the
    dashboard reminder and preflight can flag a stale backup."""
    await db.config.update_one(
        {"id": "last_backup_at"},
        {"$set": {"id": "last_backup_at",
                  "when": datetime.now(timezone.utc).isoformat(),
                  "by": by}},
        upsert=True,
    )


async def run_auto_backup(db) -> dict:
    """Generate a full backup and upload it to this weekday's object-storage
    slot, keeping exactly the last 7 daily snapshots. Called from the cron
    endpoint's background task. Raises on failure so the caller can log it."""
    import asyncio

    from services.object_storage import APP_PREFIX, put_object

    now = local_now(None)
    slot = _WEEKDAYS[now.weekday()]
    data, fname = await build_full_backup(db)
    path = f"{APP_PREFIX}/{AUTO_BACKUP_DIR}/ych-auto-{slot}.tar.gz"
    result = await asyncio.to_thread(put_object, path, data, "application/gzip")
    doc = {
        "id": slot,
        "slot": slot,
        "storage_path": result.get("path", path),
        "filename": fname,
        "size": result.get("size", len(data)),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "created_date": now.strftime("%Y-%m-%d"),
    }
    await db.auto_backups.update_one({"id": slot}, {"$set": doc}, upsert=True)
    await stamp_last_backup(db, "Automatic daily backup")
    logger.info("Auto-backup uploaded: %s (%s bytes)", path, doc["size"])
    return doc


# Safety backup taken automatically right before every restore (merge or
# replace), so a bad restore can be undone. 5 rotating slots — the oldest is
# overwritten. Its list is environment-local: restore never overwrites it.
PRE_RESTORE_DIR = "backups/pre-restore"
PRE_RESTORE_SLOTS = ["1", "2", "3", "4", "5"]
PRE_RESTORE_COLLECTION = "pre_restore_backups"


async def run_pre_restore_backup(db, by: str, source_file: str, mode: str) -> dict:
    """Snapshot the CURRENT database into the next pre-restore slot. Raises on
    failure so the caller can abort the restore before anything is changed."""
    import asyncio

    from services.object_storage import APP_PREFIX, put_object

    taken = {d["slot"]: d.get("created_at", "") async for d in
             db[PRE_RESTORE_COLLECTION].find({}, {"_id": 0, "slot": 1, "created_at": 1})}
    free = [s for s in PRE_RESTORE_SLOTS if s not in taken]
    slot = free[0] if free else min(taken, key=taken.get)
    data, fname = await build_full_backup(db)
    fname = fname.replace("YCH-Attendance-Backup-", "YCH-Attendance-BeforeRestore-")
    path = f"{APP_PREFIX}/{PRE_RESTORE_DIR}/ych-pre-restore-{slot}.tar.gz"
    result = await asyncio.to_thread(put_object, path, data, "application/gzip")
    doc = {
        "id": slot, "slot": slot,
        "storage_path": result.get("path", path),
        "filename": fname,
        "size": result.get("size", len(data)),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "by": by, "source_file": source_file, "mode": mode,
    }
    await db[PRE_RESTORE_COLLECTION].update_one({"id": slot}, {"$set": doc}, upsert=True)
    logger.info("Pre-restore safety backup uploaded: %s (%s bytes)", path, doc["size"])
    return doc


async def _stored_backup_response(doc: dict) -> Response:
    """Stream a backup file kept in object storage with its friendly filename."""
    import asyncio

    from services.object_storage import get_object

    try:
        data, _ctype = await asyncio.to_thread(get_object, doc["storage_path"])
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not fetch backup from storage: {e}")
    return Response(
        content=data,
        media_type="application/gzip",
        headers={"Content-Disposition": f'attachment; filename="{doc.get("filename", doc["slot"] + ".tar.gz")}"'},
    )


async def _attendance_dup_groups(db) -> list[dict]:
    """Groups of attendance rows that share the same (user_id, date) — the
    invariant is one row per member per day. Returns [{_id:{u,d}, ids, n}]."""
    return await db.attendance.aggregate([
        {"$group": {"_id": {"u": "$user_id", "d": "$date"},
                    "ids": {"$push": "$_id"}, "n": {"$sum": 1}}},
        {"$match": {"n": {"$gt": 1}}},
    ]).to_list(100000)


async def _attendance_index_present(db) -> bool:
    async for ix in db.attendance.list_indexes():
        if ix.get("unique") and list(ix.get("key", {}).items()) == [("user_id", 1), ("date", 1)]:
            return True
    return False


async def dedupe_attendance(db) -> dict:
    """Remove duplicate attendance rows so the unique (user_id, date) index
    can enforce the one-row-per-day invariant. Keeps the single best row per
    day — a completed session (has check_out_at) wins, else the earliest
    check-in. Then (re)builds the unique index. Fully idempotent: with no
    duplicates it deletes nothing and just ensures the index exists."""
    groups = await _attendance_dup_groups(db)
    deleted = 0
    for g in groups:
        docs = await db.attendance.find({"_id": {"$in": g["ids"]}}).to_list(1000)
        keep = min(docs, key=lambda d: (
            0 if d.get("check_out_at") else 1,   # completed session first
            d.get("check_in_at") or "9999",       # then earliest arrival
        ))
        losers = [d["_id"] for d in docs if d["_id"] != keep["_id"]]
        if losers:
            res = await db.attendance.delete_many({"_id": {"$in": losers}})
            deleted += res.deleted_count
    index_built = False
    try:
        await db.attendance.create_index(
            [("user_id", 1), ("date", 1)], unique=True, name="uniq_user_date",
        )
        index_built = True
    except Exception as e:
        logger.warning("dedupe: uniq_user_date index still could not build: %s", e)
    return {
        "groups_found": len(groups),
        "rows_deleted": deleted,
        "index_built": index_built,
    }


def make_router(db, require_admin) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/admin/attendance/dedupe-status")
    async def admin_dedupe_status(admin: dict = Depends(require_admin)):
        """How many duplicate attendance days exist and whether the one-per-day
        unique index is already active. Drives the Maintenance card button
        state (nothing to do when groups=0 and index is present)."""
        groups = await _attendance_dup_groups(db)
        return {
            "duplicate_groups": len(groups),
            "duplicate_rows": sum(g["n"] - 1 for g in groups),
            "index_present": await _attendance_index_present(db),
        }

    @router.post("/admin/attendance/dedupe")
    async def admin_dedupe(admin: dict = Depends(require_admin)):
        """One-time maintenance: clean duplicate attendance days (keeping the
        completed / earliest session) and switch on the one-per-day unique
        index. Idempotent — safe to run again; a clean DB just confirms the
        index is active. Removes only duplicate rows, never the real one."""
        result = await dedupe_attendance(db)
        from routes.admin_audit import write_audit
        await write_audit(
            db, actor=admin, action="attendance.dedupe",
            entity_type="attendance", entity_id="(bulk)",
            entity_name="Duplicate attendance cleanup",
            meta=result,
        )
        logger.info("attendance dedupe by %s: %s", admin.get("full_name"), result)
        return result

    @router.post("/admin/attendance/wipe")
    async def admin_wipe_attendance(admin: dict = Depends(require_admin)):
        """Danger zone: delete ALL attendance records. Super Admin runs it
        immediately; any other admin's request is queued for Super Admin
        sign-off in Approvals (Sep 2026 deletion gate)."""
        return await run_or_queue(db, admin, "wipe_all", "Wipe all attendance (admin tool)")

    @router.get("/admin/backup")
    async def admin_backup(admin: dict = Depends(require_admin)):
        """Download a FULL database snapshot — every collection as a single
        tar.gz. Designed for moving data between prod ↔ preview environments.
        Reuses `build_full_backup` so it's identical to the scheduled backup."""
        data, fname = await build_full_backup(db)
        await stamp_last_backup(db, admin["full_name"])
        return Response(
            content=data,
            media_type="application/gzip",
            headers={"Content-Disposition": f'attachment; filename="{fname}"'},
        )

    @router.get("/admin/backup-status")
    async def admin_backup_status(admin: dict = Depends(require_admin)):
        """Last-backup timestamp + staleness flag (for the dashboard reminder)
        and the list of automatic daily snapshots available to download."""
        last = await db.config.find_one({"id": "last_backup_at"}, {"_id": 0})
        days_since = None
        stale = True
        when = (last or {}).get("when")
        if when:
            try:
                dt = datetime.fromisoformat(when)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                days_since = (datetime.now(timezone.utc) - dt).days
                stale = days_since >= 7
            except (ValueError, TypeError):
                pass
        autos = await db.auto_backups.find({}, {"_id": 0}).to_list(20)
        autos.sort(key=lambda a: a.get("created_at", ""), reverse=True)
        pre = await db[PRE_RESTORE_COLLECTION].find({}, {"_id": 0}).to_list(20)
        pre.sort(key=lambda a: a.get("created_at", ""), reverse=True)
        return {
            "pre_restore_backups": pre,
            "last_backup_at": when,
            "last_backup_by": (last or {}).get("by"),
            "days_since": days_since,
            "stale": stale,
            "auto_backups": autos,
        }

    @router.get("/admin/backup/auto/{slot}/download")
    async def admin_auto_backup_download(slot: str, admin: dict = Depends(require_admin)):
        """Stream one automatic daily backup from object storage with its
        friendly filename."""
        doc = await db.auto_backups.find_one({"id": slot}, {"_id": 0})
        if not doc:
            raise HTTPException(status_code=404, detail="No automatic backup for that day")
        return await _stored_backup_response(doc)

    @router.get("/admin/backup/pre-restore/{slot}/download")
    async def admin_pre_restore_backup_download(slot: str, admin: dict = Depends(require_admin)):
        """Stream one before-restore safety backup (to undo a bad restore)."""
        doc = await db[PRE_RESTORE_COLLECTION].find_one({"id": slot}, {"_id": 0})
        if not doc:
            raise HTTPException(status_code=404, detail="No safety backup in that slot")
        return await _stored_backup_response(doc)

    @router.post("/admin/restore")
    async def admin_restore(
        file: UploadFile = File(...),
        mode: str = "merge",
        admin: dict = Depends(require_admin),
    ):
        """Restore FULL database from a backup tar.gz.
        mode='merge'   → insert only docs whose `id` isn't already present
                         (safe — existing records stay intact)
        mode='replace' → wipe every restored collection first, then reload
                         (DANGEROUS — clears current data including admins)"""
        raw = await file.read()
        try:
            tf = tarfile.open(fileobj=io.BytesIO(raw), mode="r:gz")
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Could not open archive: {e}")

        counts: dict = {}
        # Restore EVERY collection present in the archive (except the manifest),
        # derived from the tar itself rather than a code-side list — so a full
        # backup restores fully and future modules need no code change here
        # (28 Sep 2026). Any collection missing from an OLDER archive is simply
        # not touched (never wiped), keeping legacy restores safe.
        collections = sorted({
            base[:-5]
            for m in tf.getmembers()
            for base in (m.name.rsplit("/", 1)[-1],)
            if base.endswith(".json") and base != "manifest.json"
            # This environment's own safety-backup list must survive the restore.
            and base != f"{PRE_RESTORE_COLLECTION}.json"
        })
        from pymongo import InsertOne
        BATCH = 500
        # Preserve the caller's own login across restore. In `replace` mode
        # every collection is wiped before reloading — including `devices`
        # and (if the backup lacks the caller's user row) `users`. Their JWT
        # references those IDs, so the very next request after restore fails
        # with "This device is no longer authorised". Snapshotting the caller
        # here and upserting after the restore keeps them signed in without
        # forcing a re-login on the environment they're restoring INTO.
        # Added 02/2026 after admin reported this exact lockout in preview.
        self_user = await db.users.find_one({"id": admin["id"]}, {"_id": 0})
        self_devices = await db.devices.find(
            {"user_id": admin["id"]}, {"_id": 0},
        ).to_list(50)
        # Parse & validate EVERY file up front so a corrupt archive aborts
        # cleanly before any collection is wiped (no half-restored DB).
        parsed: dict = {}
        for tname in collections:
            member = None
            for m in tf.getmembers():
                if m.name.endswith(f"/{tname}.json") or m.name == f"{tname}.json":
                    member = m
                    break
            fh = tf.extractfile(member) if member else None
            if not fh:
                parsed[tname] = None
                continue
            try:
                docs = json.loads(fh.read().decode("utf-8"))
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"{tname}.json parse failed: {e}")
            if not isinstance(docs, list):
                raise HTTPException(status_code=400, detail=f"{tname}.json must be a JSON list")
            parsed[tname] = docs
        # Archive is valid — snapshot the CURRENT data before touching anything.
        # If that fails, abort: nothing has been changed yet.
        try:
            safety = await run_pre_restore_backup(db, admin["full_name"], file.filename or "upload", mode)
        except Exception as e:
            logger.exception("Pre-restore safety backup failed — restore aborted")
            raise HTTPException(status_code=503,
                                detail=f"Safety backup failed, so nothing was restored or changed: {e}")
        for tname in collections:
            docs = parsed[tname]
            if docs is None:
                counts[tname] = 0
                continue
            col = db[tname]
            if mode == "replace":
                await col.delete_many({})
            added = 0
            # Process in BATCH-sized chunks: one $in lookup for existing IDs +
            # a single bulk_write per chunk → O(docs/BATCH) DB round trips
            # instead of O(docs).
            for i in range(0, len(docs), BATCH):
                chunk = docs[i:i + BATCH]
                for d in chunk:
                    d.pop("_id", None)
                existing_ids: set = set()
                if mode == "merge":
                    ids_in_chunk = [d.get("id") for d in chunk if d.get("id")]
                    if ids_in_chunk:
                        async for row in col.find({"id": {"$in": ids_in_chunk}}, {"_id": 0, "id": 1}):
                            existing_ids.add(row["id"])
                ops = []
                for d in chunk:
                    if mode == "merge":
                        if d.get("id"):
                            if d["id"] in existing_ids:
                                continue
                        # Docs without a stable `id` (legacy sms_log rows etc.)
                        # dedupe by exact content match so re-restoring the
                        # same backup doesn't multiply them.
                        elif await col.find_one(d):
                            continue
                    ops.append(InsertOne(d))
                if not ops:
                    continue
                try:
                    res = await col.bulk_write(ops, ordered=False)
                    added += res.inserted_count
                except Exception as e:
                    # Duplicate-key races: count the successes that did land,
                    # surface a soft warning in the response instead of failing
                    # the whole restore.
                    logger.warning("bulk_write partial failure for %s: %s", tname, e)
                    added += getattr(getattr(e, "details", {}), "get", lambda *_: 0)("nInserted") or 0
            counts[tname] = added
        # ------------------------------------------------------------------
        # Re-attach the caller so their session survives the restore.
        # `replace` mode nuked the devices collection (and possibly the user
        # row too). Upsert both back — idempotent, so merge mode is a no-op.
        # Devices are re-inserted with status="approved" so the very next
        # authenticated request from the admin's browser passes the check in
        # server.get_current_user (device.status must be "approved").
        # ------------------------------------------------------------------
        if self_user:
            # $set (not $setOnInsert) — if the backup contained an OLDER copy
            # of this admin (e.g. pre-promotion role), the restore must not
            # revert it; the acting admin's current snapshot always wins.
            await db.users.update_one(
                {"id": self_user["id"]},
                {"$set": self_user},
                upsert=True,
            )
        for dev in self_devices:
            dev_id = dev.get("device_id")
            if not dev_id:
                continue
            # Force status=approved so the current browser tab stays logged
            # in even if the backup happened to hold a revoked/pending copy
            # of the same device_id.
            payload = {**dev, "status": "approved", "user_id": admin["id"]}
            # Filter by device_id ALONE (the unique index key). Filtering
            # by {device_id, user_id} was blowing up with DuplicateKeyError
            # when the restored backup held the same device_id under a
            # different user_id — upsert then tried to INSERT a second row
            # for a unique key. Rebinding the device to the CURRENT admin
            # is intentional here: they're the one holding this browser.
            # Reported by user 20/02/2026 as "Failed to execute 'json' on
            # 'Response': Unexpected token 'I', Internal S..." because the
            # 500 body was plain HTML, not JSON.
            await db.devices.update_one(
                {"device_id": dev_id},
                {"$set": payload},
                upsert=True,
            )
        return {"mode": mode, "inserted": counts, "safety_backup": safety}

    @router.get("/admin/preflight")
    async def admin_preflight(admin: dict = Depends(require_admin)):
        """Pre-deploy / pre-shift checklist — one call returns ✅ / ⚠️ on the
        handful of things that *must* be configured for the app to behave well.
        Designed for an admin to glance at before pushing Deploy or before
        morning shift, not as a security audit.
        """
        items = []
        office = await db.config.find_one({"id": "office"}, {"_id": 0}) or {}

        has_geo = bool(office.get("latitude") and office.get("longitude") and (office.get("radius_m") or 0) > 0)
        items.append({
            "key": "office_geofence",
            "label": "Office geofence",
            "ok": has_geo,
            "severity": "pass" if has_geo else "fail",
            "detail": (
                f"{office.get('name','Office')} — {office.get('radius_m')}m radius"
                if has_geo else "Set latitude / longitude / radius in Office settings"
            ),
        })

        has_hours = bool(office.get("default_work_start") and office.get("default_work_end"))
        items.append({
            "key": "default_work_hours",
            "label": "Default work hours",
            "ok": has_hours,
            "severity": "pass" if has_hours else "warn",
            "detail": (
                f"{office.get('default_work_start')} – {office.get('default_work_end')}"
                if has_hours else "Athletes will fall back to 09:00 → 17:00"
            ),
        })

        tw = office.get("twilio") or {}
        tw_enabled = bool(tw.get("enabled"))
        tw_ready = bool(
            tw_enabled and tw.get("account_sid") and tw.get("auth_token")
            and (tw.get("messaging_service_sid") or tw.get("default_from_number"))
        )
        items.append({
            "key": "twilio",
            "label": "Twilio SMS / voice",
            "ok": tw_ready,
            "severity": "pass" if tw_ready else "warn",
            "detail": (
                "Enabled and configured" if tw_ready else (
                    "Enabled but missing credentials" if tw_enabled
                    else "Disabled — parent-notify SMS and 8 PM reminder will not send"
                )
            ),
        })

        admin_count = await db.users.count_documents({"role": "admin"})
        items.append({
            "key": "admins",
            "label": "Admin users",
            "ok": admin_count >= 1,
            "severity": "pass" if admin_count >= 1 else "fail",
            "detail": f"{admin_count} admin(s) configured",
        })

        # Backup recency. The /admin/backup endpoint now stamps last_backup_at
        # on the config doc — preflight reads it without making the admin run
        # the actual download.
        last_backup_at = None
        backup_doc = await db.config.find_one({"id": "last_backup_at"}, {"_id": 0})
        if backup_doc and backup_doc.get("when"):
            last_backup_at = backup_doc["when"]
        week_ago = (now_utc() - timedelta(days=7)).isoformat()
        backup_fresh = bool(last_backup_at and last_backup_at >= week_ago)
        items.append({
            "key": "backup",
            "label": "Recent backup",
            "ok": backup_fresh,
            "severity": "pass" if backup_fresh else "warn",
            "detail": (
                f"Last backup: {last_backup_at}" if last_backup_at
                else "No backup recorded — run Backup & Restore once before launch"
            ),
        })

        member_count = await db.users.count_documents({})
        items.append({
            "key": "roster",
            "label": "Roster loaded",
            "ok": member_count > 0,
            "severity": "pass" if member_count >= 5 else "warn",
            "detail": f"{member_count} member(s)",
        })

        has_tz = bool(office.get("timezone"))
        items.append({
            "key": "timezone",
            "label": "Office timezone",
            "ok": has_tz,
            "severity": "pass" if has_tz else "warn",
            "detail": office.get("timezone") or "Defaults to Asia/Kolkata",
        })

        fails = sum(1 for i in items if i["severity"] == "fail")
        warns = sum(1 for i in items if i["severity"] == "warn")
        overall = "ready" if fails == 0 and warns == 0 else ("blocked" if fails > 0 else "warnings")
        return {
            "overall": overall,
            "fails": fails,
            "warns": warns,
            "checked_at": now_utc().isoformat(),
            "items": items,
        }

    @router.get("/admin/summary")
    async def admin_summary(admin: dict = Depends(require_admin)):
        office = await db.config.find_one({"id": "office"})
        today = local_date_str(office)
        total_members = await db.users.count_documents({})
        on_campus = await db.attendance.count_documents({"check_out_at": None})
        pending_leaves = await db.leaves.count_documents({"status": "pending"})
        on_leave_tour = await db.leaves.count_documents({
            "status": "approved",
            "start_date": {"$lte": today},
            "end_date": {"$gte": today},
        })
        late_today = await db.attendance.count_documents({"date": today, "late": True})
        return {
            "total_members": total_members,
            "on_campus": on_campus,
            "pending_leaves": pending_leaves,
            "on_leave_tour": on_leave_tour,
            "late_today": late_today,
        }

    @router.get("/admin/activity")
    async def admin_activity(admin: dict = Depends(require_admin)):
        """Today's events in the office timezone: check-ins, check-outs, leave/tour
        applications, and device access requests. Sorted newest-first."""
        office = await db.config.find_one({"id": "office"})
        today_local = local_date_str(office)  # YYYY-MM-DD in office tz

        # Office tz start-of-today (UTC). We compare against UTC-ISO timestamps stored in DB.
        tz = office_tz(office)
        start_local = datetime.fromisoformat(today_local + "T00:00:00").replace(tzinfo=tz)
        start_utc = to_utc_iso(start_local)

        # Pull today's attendance rows (already keyed by office-local date) — covers check-ins.
        atts = await db.attendance.find({"date": today_local}, {"_id": 0}).to_list(2000)
        # Plus any sessions that *checked out* today even if check-in was earlier (rare overnight case).
        extra_outs = await db.attendance.find(
            {"check_out_at": {"$gte": start_utc}, "date": {"$ne": today_local}},
            {"_id": 0}
        ).to_list(2000)
        all_atts = atts + extra_outs

        # Today's leave/tour submissions (regardless of approval state).
        leaves_today = await db.leaves.find(
            {"created_at": {"$gte": start_utc}}, {"_id": 0}
        ).to_list(2000)

        # Today's device sign-in requests.
        devices_today = await db.devices.find(
            {"created_at": {"$gte": start_utc}}, {"_id": 0}
        ).to_list(2000)

        # Resolve member names in one batch.
        user_ids = set()
        for a in all_atts:
            if a.get("user_id"):
                user_ids.add(a["user_id"])
        for leave in leaves_today:
            if leave.get("user_id"):
                user_ids.add(leave["user_id"])
        for d in devices_today:
            if d.get("user_id"):
                user_ids.add(d["user_id"])
        users = await db.users.find({"id": {"$in": list(user_ids)}}, {"_id": 0}).to_list(2000)
        umap = {u["id"]: u for u in users}

        events: list[dict] = []

        for a in all_atts:
            u = umap.get(a.get("user_id"), {})
            # When the check-in happened at a configured satellite site
            # (e.g. Rowing Academy) the row carries a site_name. Surface it
            # in the activity feed so admins can tell where the session was.
            in_site = a.get("site_name")
            out_site = a.get("exit_site_name") or in_site
            if a.get("check_in_at"):
                events.append({
                    "id": f"checkin-{a['id']}",
                    "type": "check_in",
                    "at": a["check_in_at"],
                    "member_id": a.get("user_id"),
                    "member_name": u.get("full_name", "Unknown"),
                    "member_category": u.get("category"),
                    "member_rank": u.get("rank"),
                    "photo": u.get("photo_thumb") or u.get("photo"),
                    "detail": "Checked in"
                              + (f" · Late {a.get('late_minutes')}m" if a.get("late") else "")
                              + (f" · at {in_site}" if in_site else "")
                              + (" · Off-site" if a.get("out_of_geofence") else ""),
                    "method": a.get("method"),
                    "site_name": in_site,
                })
            if a.get("check_out_at"):
                events.append({
                    "id": f"checkout-{a['id']}",
                    "type": "check_out",
                    "at": a["check_out_at"],
                    "member_id": a.get("user_id"),
                    "member_name": u.get("full_name", "Unknown"),
                    "member_category": u.get("category"),
                    "member_rank": u.get("rank"),
                    "photo": u.get("photo_thumb") or u.get("photo"),
                    "detail": f"Checked out · {a.get('hours', '?')}h"
                              + (f" · at {out_site}" if out_site else "")
                              + (" · Off-site" if a.get("exit_out_of_geofence") else ""),
                    "method": a.get("exit_method") or a.get("method"),
                    "site_name": out_site,
                })
            # Temporary excursions (lunch / errand etc.)
            for e in (a.get("excursions") or []):
                if e.get("out_at"):
                    events.append({
                        "id": f"tempout-{e.get('id', a['id'])}",
                        "type": "temp_exit",
                        "at": e["out_at"],
                        "member_id": a.get("user_id"),
                        "member_name": u.get("full_name", "Unknown"),
                        "member_category": u.get("category"),
                        "member_rank": u.get("rank"),
                        "photo": u.get("photo_thumb") or u.get("photo"),
                        "detail": "Temp exit · " + (e.get("reason") or "")
                                  + (f" · expected {local_hm(office, e.get('expected_return'))}" if e.get("expected_return") else ""),
                    })
                if e.get("in_at"):
                    events.append({
                        "id": f"tempin-{e.get('id', a['id'])}",
                        "type": "temp_return",
                        "at": e["in_at"],
                        "member_id": a.get("user_id"),
                        "member_name": u.get("full_name", "Unknown"),
                        "member_category": u.get("category"),
                        "member_rank": u.get("rank"),
                        "photo": u.get("photo_thumb") or u.get("photo"),
                        "detail": "Returned" + (f" · {int((datetime.fromisoformat(e['in_at']) - datetime.fromisoformat(e['out_at'])).total_seconds() // 60)}m away" if e.get("out_at") else ""),
                    })

        for leave in leaves_today:
            u = umap.get(leave.get("user_id"), {})
            events.append({
                "id": f"leave-{leave['id']}",
                "type": "application",
                "subtype": leave.get("type"),  # leave | tour
                "at": leave.get("created_at"),
                "member_id": leave.get("user_id"),
                "member_name": u.get("full_name", "Unknown"),
                "member_category": u.get("category"),
                "member_rank": u.get("rank"),
                "photo": u.get("photo_thumb") or u.get("photo"),
                "detail": f"Applied for {leave.get('type', 'leave')}"
                          + (f" · {leave.get('start_date')} → {leave.get('end_date')}" if leave.get("start_date") else "")
                          + (f" · {leave.get('location')}" if leave.get("location") else ""),
                "status": leave.get("status"),
            })

        for d in devices_today:
            u = umap.get(d.get("user_id"), {})
            events.append({
                "id": f"device-{d['id']}",
                "type": "access_request",
                "at": d.get("created_at"),
                "member_id": d.get("user_id"),
                "member_name": u.get("full_name") or (f"Unmatched · {d.get('phone')}" if d.get("phone") else "Unknown device"),
                "member_category": u.get("category"),
                "member_rank": u.get("rank"),
                "photo": u.get("photo_thumb") or u.get("photo"),
                "detail": f"New sign-in request · {d.get('device_name') or d.get('platform') or 'device'}",
                "status": d.get("status"),
            })

        events.sort(key=lambda e: e.get("at") or "", reverse=True)
        return {
            "date": today_local,
            "timezone": (office or {}).get("timezone") or DEFAULT_TZ,
            "events": events,
            "counts": {
                "check_in": sum(1 for e in events if e["type"] == "check_in"),
                "check_out": sum(1 for e in events if e["type"] == "check_out"),
                "temp_exit": sum(1 for e in events if e["type"] == "temp_exit"),
                "temp_return": sum(1 for e in events if e["type"] == "temp_return"),
                "applications": sum(1 for e in events if e["type"] == "application"),
                "access_requests": sum(1 for e in events if e["type"] == "access_request"),
                "total": len(events),
            },
        }

    return router
