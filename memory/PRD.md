# Attendance — Product Requirements Document

## Original Problem Statement
Build a mobile "Attendance" app for a sailing academy to track **entry/exit of sailors, staff and coaches**. Recognition was requested via face recognition or QR; user chose **QR check-in + GPS geofence (within 100m of office)** with a **photo upload** at check-in (no face recognition). The app produces **attendance + hours-on-campus reports** (weekly/monthly), records **leave & tour applications** from handheld, and shows a **live presence board** visible on every phone (who is on campus / has exited / on tour / on leave) with photos. Also a daily **early-morning report** of who is on tour (and where) and on leave (and till when).

## Architecture
- **Frontend:** Expo React Native (expo-router file-based routing), SDK 54. Design: "iOS-Native Clean", Dark Slate/Graphite brand, semantic status colors. Bottom-tab nav (Board / Check-In / Profile-or-Admin).
- **Backend:** FastAPI + MongoDB (Motor). JWT auth (admin + member roles), bcrypt hashing, idempotent admin seed.
- **Key libs:** expo-camera (QR scan + photo), expo-location (geofence), react-native-qrcode-svg (office QR), expo-file-system + expo-sharing (CSV/PDF export), react-native-keyboard-controller, reportlab (PDF).

## User Personas
1. **Admin (office):** seeds at startup. Manages members, displays/regenerates the Office Station QR, approves leave/tour, exports reports.
2. **Member (sailor/staff/coach):** logs in to check in/out (scan office QR + geofence + photo), apply for leave/tour, view their hours.

## Core Requirements (static)
- QR + geofence check-in/out with photo; hours-on-campus computed per session.
- Live presence board (status: on_campus / exited / on_tour / on_leave) with photos, auto-refresh, shared across devices.
- Leave & tour applications with approval workflow.
- Reports: weekly/monthly hours + attendance %, daily leave & tour (early-morning) report, CSV/PDF export.

## Implemented (2026-06-10 → 2026-06-14)
- **EAS native build setup for staff field testing (2026-06-14):** Configured the app for Expo EAS cloud builds so staff can run the real camera-QR + GPS check-in on their phones (web/console alone can't field-test). Added `frontend/eas.json` (development/preview/production profiles; `preview` = standalone APK for staff). Updated `frontend/app.json` with `android.package` + `ios.bundleIdentifier` (`com.attendance.mobile`) and registered `expo-camera` / `expo-location` config plugins with permission strings. Installed `expo-dev-client` + `expo-device@8.0.10`. Build env `EXPO_PUBLIC_BACKEND_URL` is a placeholder the user sets to their DEPLOYED backend URL. Full step-by-step in `/app/EAS_BUILD.md`. Validated: expo config resolves (package/bundle/plugins), JSON valid, web preview still 200. Note: EAS builds run on Expo cloud from the user's machine with their Expo login (Save to GitHub / download first) — cannot be run inside the Emergent container.
- **Code review + deploy-readiness hardening (2026-06-14):** (1) Gated the one-tap "Enter as Admin (demo)" login to `__DEV__` only — hidden in production builds (no public admin shortcut on deploy). (2) CORS `allow_credentials=False` (app uses Bearer tokens, not cookies) — spec-correct with `allow_origins=["*"]`. (3) DB query optimizations to remove N+1 / unbounded reads: `list_members` projection excludes password hashes; `_match_user_by_phone` scans `{id,mobile}` then fetches the single match; `presence` batches open-sessions + today's leaves + a last-checkout aggregation (4 queries vs per-user); `compute_hours_report` batches one ranged attendance query grouped in memory. Verified: 23 pytest pass, presence/members/hours 200, phone login intact, board renders. Deployment scan: all app-code checks pass; only remaining flag is the supervisor `--tunnel` flag in the READONLY platform-managed supervisord.conf (injected by the deploy pipeline — not editable by app code).
- **Check out from anywhere / off-campus checkout (2026-06-14):** New `POST /api/attendance/remote-checkout` lets an already-checked-in user end their session **without the gate QR** when off campus. Reason is **optional** (many users can't type English); uses the device GPS and flags the exit off-site (`exit_method="remote"`, `exit_out_of_geofence`) when outside the geofence. Available to **all members**. UI: "Check out from anywhere" button on the Check-In screen (only when checked in) → bottom sheet with optional reason → "Check out now". Guarded (400 if not checked in). No midnight auto-checkout (user declined). Verified via curl (checkin→remote checkout no-reason→off-site→status, + not-checked-in 400) and screenshot of the full mobile flow.
- **Batch QR printing (2026-06-14):** Console → **Office QR** now has **Print Master QR** (office gate QR on its own page) and **Print All Member Cards** (one print-ready sheet with every member's personal QR card — name, rank/category, code, scan hint; 3-up grid). New backend `GET /api/admin/cards` returns office_qr + all members' personal_qr in one call. Printing uses the `qrcode` lib to generate images in a new browser tab + auto `window.print()` (web/desktop console only). Verified via screenshot: office popup (1 QR + token) and members popup (3 QR cards with names) both render.
- **Passwordless phone + admin-approval login (2026-06-14):** New auth flow — users sign in with their **phone number** (no password). First login registers the device (name/model captured via `expo-device`) and creates a pending request; admins approve in **Console → Access Requests** or mobile **Admin → Access Requests**, after which the device stays logged in (~2yr, revocable). Pre-designated admins (phone+role=Admin) log in **instantly**; known members get one-tap device approval; unknown numbers require admin to set name/role/category (creates the user). Phone matching is digit-tolerant (last-10). Email+password kept as bootstrap fallback. Backend: `/auth/phone`, `/auth/phone/status`, `/admin/devices` (+approve/reject/revoke), device-bound JWT verified against `devices.status`. Verified end-to-end (backend pytest `tests/test_phone_auth.py` 9/9 + frontend flows). Devices collection wiped for a clean start.
- **Designate Admins (2026-06-14):** Member add/edit form (desktop Console + mobile) now has an **Access Level (Member/Admin)** selector. `MemberUpdate` accepts `role` so existing members can be promoted/demoted; backend blocks self-demotion ("cannot remove your own admin access"). Lets the user create multiple admins who open the desktop Console on a laptop browser. Verified via curl (create-as-admin, login, promote/demote, guard) + console UI screenshot.
- **Laptop access clarified (2026-06-14):** The "QR code" users saw is Emergent's *Try-on-mobile* preview helper, not part of the app. The web build already serves the Admin Console on wide laptop browsers; permanent access comes from Deploy (auto permanent URL, no DNS required; custom domain optional via Link domain).
- JWT auth (admin+member), role-based access; demo members CLEARED — only admin remains for the user to populate.
- Office config + **Office Settings screen**: manual latitude/longitude, geofence radius (10–100m), and default working hours (HH:MM).
- **Per-member custom timings** (work_start/work_end) + **mobile number** field, editable in member form.
- **Bulk Excel import**: downloadable .xlsx template (with Instructions sheet) + upload/parse → creates members; blank email auto = `<mobile>@attendance.app`, blank password = mobile, blank timings = office default; returns created accounts + skipped-row reasons.
- Check-in/out: QR validation + haversine geofence + base64 photo + hours; out-of-geofence stores location + mandatory reason (off-site flag).
- Personal QR cards for phone-less people (proxy scan-in/out by anyone).
- Presence board (filters, off-site flag, auto-refresh), member profile (hours), leave/tour apply + admin approvals, reports (hours + daily leave/tour, CSV/PDF export).
- In-app role switcher (admin can preview member view), one-tap admin quick login.
- Verified: 14/14 master-data backend tests + prior suites; all frontend screens render.

## Compatibility
- iOS 15.1+ and Android 7.0+ (phones & tablets). Needs camera + location. Web/Expo Go preview can't use real camera/GPS/file-picker — a "Simulate at office" switch covers preview testing; full check-in/import on device or installed build.

## Backlog / Remaining
- **Deferred (user-requested):** WhatsApp companion channel — daily morning tour & leave report to a WhatsApp group, admin alerts on new leave, leave requests via bot (needs WhatsApp Business Cloud API).
- **P1:** Real GPS + camera scan/photo + OS file-picker require a native build (not testable in Expo Go web).
- **P2:** Late-arrival flagging using timings (needs office timezone), lost-card recovery (regenerate personal QR), member self-photo, calendar history, date-picker for leave dates, auto check-out at midnight, import row cap + stricter time/mobile validation, split server.py into routers.

## Next Tasks
- User to set real Office Settings (lat/long) and bulk-import their members, then test on a published build.

## Next Tasks
- Gather feedback; optionally add member self-photo capture and a calendar history view.
