"""Single-glance Admin Dashboard endpoint.

Aggregates the numbers an admin/head coach needs to see "at a glance"
without clicking through 6 different pages: Now, This Week, This Month,
and an Attention rail.

Zero mutations — pure read-only. All queries are targeted (no full
DB scans) so the endpoint stays snappy even at 200+ members and
10k+ attendance rows.

Wired into server.py near the bottom via app.include_router.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends

from services.time_utils import local_date_str, now_utc


def _has_valid_parent_mobile(u: dict) -> bool:
    for key in ("father_mobile", "mother_mobile", "guardian_mobile"):
        v = u.get(key) or ""
        digits = "".join(c for c in v if c.isdigit())
        if len(digits) >= 10:
            return True
    return False


def make_router(db, require_admin) -> APIRouter:
    router = APIRouter(prefix="/api")

    @router.get("/admin/dashboard")
    async def dashboard(admin: dict = Depends(require_admin)):
        office = await db.config.find_one({"id": "office"})
        today_iso = local_date_str(office)
        today_d = date.fromisoformat(today_iso)
        now = now_utc()

        # ── Bulk-load users once ────────────────────────────────────────
        users = await db.users.find(
            {},
            {
                "_id": 0, "id": 1, "full_name": 1, "category": 1, "role": 1,
                "photo_thumb": 1, "date_of_birth": 1, "created_at": 1,
                "institution": 1, "fleet": 1,
                "father_mobile": 1, "mother_mobile": 1, "guardian_mobile": 1,
            },
        ).to_list(5000)
        users_by_id: dict[str, dict] = {u["id"]: u for u in users}
        athletes = [u for u in users if u.get("category") in ("athlete", "elite")]

        # ================== NOW (live today) ==============================
        open_sessions = await db.attendance.find(
            {"check_out_at": None},
            {"_id": 0, "user_id": 1, "date": 1, "check_in_at": 1, "late": 1,
             "site_id": 1, "site_name": 1},
        ).to_list(5000)

        cat_buckets = {"athlete": 0, "elite": 0, "coach": 0, "staff": 0, "executive": 0}
        # Group live on-campus members by the training location they
        # tapped into. Sessions without a site (legacy pre-Sites data
        # or the main office) roll into "Main Club".
        by_location_map: dict = {}
        for s in open_sessions:
            u = users_by_id.get(s.get("user_id"))
            if u and u.get("category") in cat_buckets:
                cat_buckets[u["category"]] += 1
            sid = s.get("site_id")
            sname = s.get("site_name") or "Main Club"
            key = sid or "__main__"
            bucket = by_location_map.setdefault(key, {
                "site_id": sid,
                "site_name": sname,
                "count": 0,
            })
            bucket["count"] += 1
        by_location = sorted(
            by_location_map.values(),
            key=lambda b: (-b["count"], (b["site_name"] or "").lower()),
        )

        late_today = await db.attendance.count_documents(
            {"date": today_iso, "late": True}
        )

        # Guests use `checked_out_at` (not `check_out_at`) — separate module.
        guests_present = await db.guests.count_documents(
            {"date": today_iso, "checked_out_at": None}
        )

        escorts_present = await db.escort_attendance.count_documents(
            {"date": today_iso, "check_out_at": None, "check_in_at": {"$ne": None}}
        )

        # Absent athletes today — athletes with no attendance today and
        # not covered by an approved leave / tour / break.
        present_today_ids = set(
            await db.attendance.distinct("user_id", {"date": today_iso})
        )
        excused_leaves = await db.leaves.find(
            {
                "status": "approved",
                "start_date": {"$lte": today_iso},
                "end_date": {"$gte": today_iso},
            },
            {"_id": 0, "user_id": 1, "type": 1},
        ).to_list(5000)
        excused_ids = {leave["user_id"] for leave in excused_leaves}

        athletes_absent = sum(
            1 for a in athletes
            if a["id"] not in present_today_ids and a["id"] not in excused_ids
        )

        # Pending approvals across three queues.
        pending_leaves = await db.leaves.count_documents({"status": "pending"})
        pending_overtime = await db.attendance.count_documents(
            {"overtime_status": "pending"}
        )
        pending_devices = await db.devices.count_documents({"status": "pending"})

        # ================== ATTENTION (data-quality signals) ==============
        # Stale open sessions (>36h) — proxy for people who forgot to check
        # out. Same rule the Data Quality dashboard uses.
        stale_cutoff_iso = (now - timedelta(hours=36)).isoformat()
        stale_sessions = sum(
            1 for s in open_sessions
            if (s.get("check_in_at") or "") and s["check_in_at"] < stale_cutoff_iso
        )
        athletes_no_parent = sum(1 for a in athletes if not _has_valid_parent_mobile(a))

        # ================== THIS WEEK (last 7 days incl. today) ===========
        week_start_d = today_d - timedelta(days=6)
        week_start = week_start_d.isoformat()

        week_atts = await db.attendance.find(
            {"date": {"$gte": week_start, "$lte": today_iso}},
            {"_id": 0, "user_id": 1, "date": 1, "late": 1},
        ).to_list(30000)

        # Sparkline: unique members present per day, split staff-side vs athletes.
        # Build a set per (day, category) so a member checking in twice
        # doesn't double-count.
        per_day_athletes: dict[str, set] = {}
        per_day_staff: dict[str, set] = {}
        for r in week_atts:
            u = users_by_id.get(r.get("user_id"))
            if not u:
                continue
            d = r.get("date")
            if u.get("category") in ("athlete", "elite"):
                per_day_athletes.setdefault(d, set()).add(r["user_id"])
            elif u.get("category") in ("coach", "staff", "executive"):
                per_day_staff.setdefault(d, set()).add(r["user_id"])

        sparkline = []
        for i in range(7):
            d_ = (week_start_d + timedelta(days=i)).isoformat()
            sparkline.append({
                "date": d_,
                "athletes": len(per_day_athletes.get(d_, ())),
                "staff": len(per_day_staff.get(d_, ())),
            })

        # Top 5 late-comers this week (distinct days with late=True).
        late_counts: dict[str, set] = {}
        for r in week_atts:
            if r.get("late"):
                late_counts.setdefault(r["user_id"], set()).add(r.get("date"))
        late_ranked = sorted(
            ((uid, len(days)) for uid, days in late_counts.items()),
            key=lambda x: -x[1],
        )[:5]
        top_late = []
        for uid, cnt in late_ranked:
            u = users_by_id.get(uid)
            if not u:
                continue
            top_late.append({
                "member_id": uid,
                "name": u.get("full_name"),
                "category": u.get("category"),
                "photo": u.get("photo_thumb"),
                "late_days": cnt,
            })

        # Birthdays this week (MM-DD match against date_of_birth).
        birthdays = []
        for i in range(7):
            d_ = week_start_d + timedelta(days=i)
            mmdd = d_.strftime("%m-%d")
            for u in users:
                dob = u.get("date_of_birth") or ""
                if len(dob) == 10 and dob[5:] == mmdd:
                    birthdays.append({
                        "member_id": u["id"],
                        "name": u.get("full_name"),
                        "category": u.get("category"),
                        "photo": u.get("photo_thumb"),
                        "dob": dob,
                        "date_this_week": d_.isoformat(),
                    })

        # Camps + Regattas overlapping the coming 7 days.
        week_end = (today_d + timedelta(days=6)).isoformat()
        camps = await db.camps.find(
            {"start_date": {"$lte": week_end}, "end_date": {"$gte": today_iso}},
            {"_id": 0, "id": 1, "name": 1, "start_date": 1, "end_date": 1},
        ).to_list(50)
        regattas = await db.regattas.find(
            {"start_date": {"$lte": week_end}, "end_date": {"$gte": today_iso}},
            {"_id": 0, "id": 1, "name": 1, "start_date": 1, "end_date": 1},
        ).to_list(50)
        events = []
        for c in camps:
            events.append({
                "kind": "camp",
                "id": c.get("id"),
                "name": c.get("name"),
                "start_date": c.get("start_date"),
                "end_date": c.get("end_date"),
            })
        for r in regattas:
            events.append({
                "kind": "regatta",
                "id": r.get("id"),
                "name": r.get("name"),
                "start_date": r.get("start_date"),
                "end_date": r.get("end_date"),
            })
        events.sort(key=lambda e: e.get("start_date") or "")

        # ================== THIS MONTH ====================================
        month_start_d = today_d.replace(day=1)
        month_start = month_start_d.isoformat()

        month_atts = await db.attendance.find(
            {"date": {"$gte": month_start, "$lte": today_iso}},
            {"_id": 0, "user_id": 1, "hours": 1, "overtime_total_min": 1,
             "overtime_status": 1},
        ).to_list(30000)
        staff_hours = 0.0
        ot_minutes = 0
        for r in month_atts:
            u = users_by_id.get(r.get("user_id"))
            if not u:
                continue
            if u.get("category") in ("staff", "coach", "executive"):
                staff_hours += float(r.get("hours") or 0)
            if r.get("overtime_status") == "approved":
                ot_minutes += int(r.get("overtime_total_min") or 0)

        # Leave days consumed this month (type=leave, approved, overlap
        # with the month window).
        month_leaves = await db.leaves.find(
            {
                "status": "approved",
                "type": "leave",
                "start_date": {"$lte": today_iso},
                "end_date": {"$gte": month_start},
            },
            {"_id": 0, "start_date": 1, "end_date": 1, "half_day": 1},
        ).to_list(5000)
        leave_days = 0.0
        for lv in month_leaves:
            try:
                s = max(date.fromisoformat(lv["start_date"]), month_start_d)
                e = min(date.fromisoformat(lv["end_date"]), today_d)
                span = (e - s).days + 1
                if span <= 0:
                    continue
                if lv.get("half_day") in ("FN", "PN"):
                    span = 0.5
                leave_days += span
            except (ValueError, TypeError):
                pass

        # New members this month — created_at YYYY-MM-DD prefix match.
        month_prefix = month_start[:7]  # YYYY-MM
        new_members = 0
        for u in users:
            created = u.get("created_at")
            if isinstance(created, str) and created[:7] == month_prefix:
                new_members += 1

        return {
            "generated_at": now.isoformat(),
            "today": today_iso,
            "now": {
                "on_campus_total": sum(cat_buckets.values()),
                "on_campus_by_category": cat_buckets,
                "on_campus_by_location": by_location,
                "late_today": late_today,
                "absent_athletes_today": athletes_absent,
                "guests_present": guests_present,
                "escorts_present": escorts_present,
                "pending_approvals": {
                    "leaves": pending_leaves,
                    "overtime": pending_overtime,
                    "devices": pending_devices,
                    "total": pending_leaves + pending_overtime + pending_devices,
                },
            },
            "week": {
                "start_date": week_start,
                "end_date": today_iso,
                "sparkline": sparkline,
                "top_late": top_late,
                "birthdays": birthdays,
                "events": events,
            },
            "month": {
                "start_date": month_start,
                "end_date": today_iso,
                "staff_hours": round(staff_hours, 1),
                "ot_hours": round(ot_minutes / 60.0, 1),
                "leave_days_consumed": round(leave_days, 1),
                "new_members": new_members,
            },
            "attention": {
                "pending_leaves": pending_leaves,
                "pending_overtime": pending_overtime,
                "pending_devices": pending_devices,
                "stale_sessions": stale_sessions,
                "athletes_no_parent_contact": athletes_no_parent,
            },
        }

    return router
