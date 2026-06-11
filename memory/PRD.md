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

## Implemented (2026-06-10)
- JWT auth (admin+member), role-based access, seeded admin + 6 demo members.
- Office config (lat/lng/radius/QR token), regenerate QR.
- Check-in/out: QR validation + haversine geofence + base64 photo + hours computation.
- **Out-of-geofence check-in:** if outside the radius, stores actual GPS location + a mandatory reason; flagged "Off-site" on the board.
- **Personal QR cards (people without phones):** every member has a unique permanent `personal_qr`; admin can view/print each card; anyone with the app can scan a member's card to check them in/out (proxy), recording who scanned.
- Presence board with filter chips, summary stats, off-site flag, auto-refresh (15s) + pull-to-refresh.
- Member management (create/edit/delete + view QR card), member profile with weekly/monthly hours + recent logs.
- Leave/tour apply, my-applications, admin approvals (pending/approved/rejected).
- Reports screen: hours (week/month) + daily leave/tour, CSV & PDF export via share sheet.
- Verified: 49/49 backend pytest pass; all frontend screens render.

## Compatibility
- iOS 15.1+ and Android 7.0+ (phones & tablets). Needs camera + location. Web/Expo Go preview can't use real camera/GPS — a "Simulate at office" switch covers preview testing.

## Backlog / Remaining
- **Deferred (user-requested, revisit later):** WhatsApp companion channel — auto-send the early-morning tour & leave report to a WhatsApp group, notify admins on new leave requests, and allow leave requests via a WhatsApp bot. Requires WhatsApp Business Cloud API setup (Meta verification, registered number, approved templates).
- **P1:** Real GPS + camera scan/photo require a native build (not testable in Expo Go web).
- **P2:** Lost-card recovery (regenerate personal QR), member self-photo from profile, calendar history, date-picker for leave dates, auto check-out at midnight safeguard, restrict member visibility of others' emails, split server.py into routers.

## Next Tasks
- Gather feedback; optionally add member self-photo capture and a calendar history view.
