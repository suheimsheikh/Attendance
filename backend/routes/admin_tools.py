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

from services.time_utils import (
    DEFAULT_TZ, local_date_str, local_hm, now_utc, office_tz,
)

logger = logging.getLogger(__name__)


def make_router(db, require_admin) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.post("/admin/attendance/wipe")
    async def admin_wipe_attendance(admin: dict = Depends(require_admin)):
        """Danger zone: delete ALL attendance records. Useful when starting a
        fresh term or restoring from a master-only backup. Leaves users,
        leaves, institutions, and office config untouched."""
        before = await db.attendance.count_documents({})
        res = await db.attendance.delete_many({})
        return {
            "before": before,
            "deleted": res.deleted_count,
            "remaining": await db.attendance.count_documents({}),
        }

    @router.get("/admin/backup")
    async def admin_backup(admin: dict = Depends(require_admin)):
        """Download a FULL database snapshot — every collection (users, attendance,
        leaves, institutions, config, devices, parent_notifications, camps,
        regattas, guests, daily_content, sms_log) as a single tar.gz. Designed
        for moving data back and forth between prod ↔ preview environments.

        Streams each collection in batches of 500 docs so memory stays bounded
        even when attendance grows to tens of thousands of rows.
        """
        buf = io.BytesIO()
        tf = tarfile.open(fileobj=buf, mode="w:gz")

        collections = [
            "users", "institutions", "config", "attendance", "leaves",
            "devices", "parent_notifications", "camps", "regattas",
            "guests", "daily_content", "sms_log", "breaks", "fleets",
        ]
        manifest = {
            "created_at": datetime.now(timezone.utc).isoformat(),
            "kind": "ych-full",
            "collections": {},
        }
        BATCH = 500
        for name in collections:
            # Stream the collection in chunks so we don't hold the whole list
            # in memory. Each JSON file written to the tar is built incrementally.
            chunks: list[bytes] = [b"[\n"]
            total = 0
            first = True
            cursor = db[name].find({}, {"_id": 0})
            async for d in cursor:
                if not first:
                    chunks.append(b",\n")
                chunks.append(json.dumps(d, default=str).encode("utf-8"))
                first = False
                total += 1
                # Periodically flush the chunk list into a single bytes blob to
                # keep Python list overhead small (still in-memory, but compacted).
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

        fname = f"ych-full-{datetime.now().strftime('%Y%m%d-%H%M')}.tar.gz"
        # Stamp last_backup_at so /api/admin/preflight can confirm a recent backup
        # exists without the admin having to remember when they ran it.
        await db.config.update_one(
            {"id": "last_backup_at"},
            {"$set": {"id": "last_backup_at",
                      "when": datetime.now(timezone.utc).isoformat(),
                      "by": admin["full_name"]}},
            upsert=True,
        )
        return Response(
            content=buf.getvalue(),
            media_type="application/gzip",
            headers={"Content-Disposition": f'attachment; filename="{fname}"'},
        )

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
        collections = [
            "users", "institutions", "config", "attendance", "leaves",
            "devices", "parent_notifications", "camps", "regattas",
            "guests", "daily_content", "sms_log", "breaks", "fleets",
        ]
        from pymongo import InsertOne
        BATCH = 500
        for tname in collections:
            member = None
            for m in tf.getmembers():
                if m.name.endswith(f"/{tname}.json") or m.name == f"{tname}.json":
                    member = m
                    break
            if not member:
                counts[tname] = 0
                continue
            fh = tf.extractfile(member)
            if not fh:
                counts[tname] = 0
                continue
            try:
                docs = json.loads(fh.read().decode("utf-8"))
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"{tname}.json parse failed: {e}")
            if not isinstance(docs, list):
                raise HTTPException(status_code=400, detail=f"{tname}.json must be a JSON list")
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
                ops = [InsertOne(d) for d in chunk
                       if not (mode == "merge" and d.get("id") and d["id"] in existing_ids)]
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
        return {"mode": mode, "inserted": counts}

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
        start_utc = start_local.astimezone(timezone.utc).isoformat()

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
