# I Showed Up — Browser-based Campus Attendance App

## Original Problem Statement
> Need to create a new app called I-showed-up that needs to take all the code and database from the Attendance app (attendance-app-220) I already created which was a mobile app but this needs to be a browser based app.

## Source
- Existing FastAPI/MongoDB backend reused verbatim from GitHub repo `suheimsheikh/Attendance`.
- MongoDB data migrated via `mongorestore` from user-provided `attendance_db_export.tar.gz` — 1 admin user, 1 office config, 6 leaves, 1 attendance, 0 devices.

## Architecture
- **Backend:** FastAPI + Motor + MongoDB. Same `server.py` (1333 lines) — port-direct reuse. JWT auth. Located at `/app/backend/server.py`.
- **Frontend:** React 19 + CRA + craco + Tailwind CSS + React Router 7 + sonner toasts. Lucide icons. Located at `/app/frontend/src`.
- **DB:** MongoDB (`mongodb://localhost:27017`, `DB_NAME=test_database`). Same name as source — data migrated 1:1.

## Tech Stack Differences vs Mobile
| Concern              | Mobile (Expo)              | Web (this app)                       |
|----------------------|----------------------------|--------------------------------------|
| QR scan              | `expo-camera`              | `html5-qrcode` (webcam)              |
| Geolocation          | `expo-location`            | `navigator.geolocation`              |
| Device ID            | `expo-secure-store` UUID   | `localStorage` UUID (`web-…`)        |
| Token storage        | `expo-secure-store`        | `localStorage`                       |
| Excel up/download    | `expo-document-picker`     | HTML `<input type=file>` + blob DL   |
| QR code render       | `react-native-qrcode-svg`  | `react-qr-code`                      |

## User Personas
- **Admin** — manages members, approves devices/leaves, configures office geofence, prints QR cards, runs reports.
- **Member (sailor/staff/coach)** — signs in via phone (browser-approved by admin) or via admin email login, checks in/out (QR or GPS), views own stats, applies for leave/tour.

## What's Implemented (Jan 2026)
### Backend (reused, verified ✅)
- `/api/auth/login` — admin email/password login
- `/api/auth/phone` + `/api/auth/phone/status` — passwordless phone login with admin approval polling
- `/api/auth/me`
- `/api/members` CRUD, `/api/members/me/photo`, `/api/members/import-template`, `/api/members/import` (Excel)
- `/api/admin/devices` (list/approve/reject/revoke)
- `/api/office` GET/PUT, `/api/office/regenerate-qr`
- `/api/attendance/checkin`, `/checkout`, `/geo-toggle`, `/mark-member`, `/scan-card`, `/status`
- `/api/admin/attendance/toggle/{id}`
- `/api/leaves` (mine, all, decide), `/api/presence`, `/api/me/stats`, `/api/admin/summary`
- `/api/reports/hours` + export (CSV / PDF), `/api/reports/daily` + export
- `/api/admin/cards`

### Frontend (new web build)
- **Auth:** Login page with phone-login + collapsible admin email form; pending-approval polling UI.
- **Layout:** Persistent dark slate sidebar (desktop) + mobile hamburger drawer. Role-aware navigation.
- **Member pages:** Presence Board (with status filters, live refresh, stat cards), Check-In/Out (QR scan + GPS modes, off-site reason flow, geofence display), My Leaves (apply leave/tour modal), Profile (avatar upload, weekly/monthly stats, recent attendance).
- **Admin pages:** Console (5 KPIs + 8 quick actions), Members (search, CRUD, force check-in/out), Leave Approvals (filter+approve/reject), Access Requests (approve devices into new or existing members), Office Settings (geofence pick-here button, timezone, late grace), Office QR (print-ready with regenerate), Member Cards (print all personal QRs), Reports (hours + daily, CSV/PDF export), Import Members (xlsx upload).
- **UX:** Light theme with dark slate/graphite brand, semantic status colors (emerald on-campus, orange tour, amber leave, gray exited), accessible via `data-testid` on every interactive element.

## Backlog / Next Steps
| Priority | Item |
|----------|------|
| P1 | Frontend end-to-end smoke test (manual or testing-agent run) to confirm scanner, geolocation, and admin flows in a real browser session. |
| P2 | Add validators on `LeaveCreate` (date format + start≤end) — minor backend gap noted by testing agent. |
| P2 | Add a `members/{id}/reset-card` endpoint (regenerate personal QR if a card is lost). |
| P2 | Optional UI polish: skeleton states for admin pages, empty-state illustrations. |
| P2 | Migrate existing user emails from `@sailors.local` → `@athletes.local` (cleanup). |
| P2 | PWA install prompt ("Add to Home Screen") for Coaches/Staff. |
| P2 | Add "Institution" filter pills to Muster Roll. |
| P3 | WebP logo variants for faster loading. |
| P3 | Split `server.py` (>2600 lines) into focused routers. |

## Recently Added (Feb 2026)
- **YCH branding & color palette**: Navy / Teal / Coral / Gold / Sky CSS variables across the app.
- **Parent / Guardian contact (Feb 2026)**: Added `father_mobile`, `mother_mobile`, `guardian_mobile` to `UserPublic`, `MemberCreate`, `MemberUpdate`. Admin can enter all three in the Member Form. A reusable `ParentContact` popover (sky-blue phone chip) renders next to every athlete name on **Presence Board**, **Muster Roll**, **Members list**, and **Reports → Hours**, exposing one-tap `tel:` (Call) and `sms:` (Message) actions for each parent on file. Backend endpoints `/api/presence`, `/api/muster/athletes`, `/api/reports/hours` now include the parent numbers.
- **Bilingual auto-SMS notifications (Feb 2026)**: One-tap "Notify parents" + "Late SMS" buttons on the Presence Board:
  - Opens the device's native SMS app pre-populated with all parent numbers (zero send-cost) and a **bilingual English + Telugu** message body that includes the current admin contacts and the logged-in coach's mobile as call-back numbers.
  - **`not_arrived`**: appears on Absent-column rows once `now > work_start + parent_notify_grace_minutes` (default 30, configurable in `OfficeConfig`).
  - **`late`**: appears on On-Campus rows that were checked in past `work_start + late_grace_minutes`.
  - Dispatches are recorded in a new `parent_notifications` collection so each athlete only gets one "not arrived" + one "late" SMS per day (`POST /api/parent-notify/dispatch`); the button auto-replaces with a muted "SMS sent" pill once dispatched.
  - Presence response now also returns `admin_contacts`, `notify_grace_minutes`, and per-row `notify_due`/`notified_today` flags.

- **MemberForm save fix (Feb 2026)**: `PATCH /api/members/{id}` was returning **HTTP 422** when admins edited a member because the form sent `gender: ""` / `weekly_off: ""` strings — both are Pydantic `Literal` types and reject empty strings. `MemberForm.jsx` now strips every `""` value from the payload before dispatch (backend treats absent == unchanged). Verified end-to-end via curl: raw form → 422 with `literal_error`; stripped payload → 200, role flips to admin and back cleanly.
- **Persistent bilingual daily content (Feb 2026)**: Replaced the once-per-day floating quote with a permanent card on the Check-In page that alternates EN+TE motivational quotes and English-Telugu word-of-the-day. Generated daily by **Gemini 3.1 Pro Preview** via the Emergent Universal Key, cached in MongoDB `daily_content` (one call per day across all users). Static fallback pool prevents UI breakage if the LLM is unreachable. New endpoint: `GET /api/daily-content`. Kind alternates by date ordinal parity (odd → word, even → quote).
- **Yearly photo refresh + forced capture (Feb 2026)**: `UserPublic` now exposes `photo_captured_at`; both photo-write endpoints stamp it. New `GET /api/me/photo-status` returns `{has_photo, captured_at, days_since, needs_photo, reason}` with a 365-day refresh threshold. `SelfCheckIn.jsx` now hits this endpoint and forces the existing `SelfieCapture` modal whenever `needs_photo=true`, with subtitle copy that differentiates `missing` (first-time) vs `expired` (yearly refresh). Verified end-to-end for all three states.
- **Presence per-category column breakdown (Feb 2026)**: Each Presence Board column now shows tiny A·N / C·N / S·N / E·N chips under the total, color-keyed to category (sky/emerald/amber/violet). Empty categories render at 40% opacity for fast scanning. Verified live: 23 on-campus = 18 athletes + 4 coaches + 1 staff.
- **Executive category (Feb 2026)**: Added `executive` as a new value to the category Literal across `MemberCreate`, `MemberUpdate`, `DeviceApproveIn`, `PhoneLoginIn`, and `valid_cats` in the import path. Frontend wired through: `categoryLabel`, Members bucket pill (violet), MemberForm/Devices/Login category dropdowns, Reports category filter, and the Presence per-column breakdown. Muster remains athletes-only by design (Executives don't appear there). Verified end-to-end via curl: POST `/api/members` with `category: executive` → 200; PATCH → 200; list aggregation reports the new bucket.
- **Muster row institution chip (Feb 2026)**: Each Muster athlete row now displays a compact sky-tinted institution chip (max-w-110, truncated) inline with the name — no extra vertical space. Rank moves to a now-conditional second line that's hidden when not present.
- **Presence institution chips, GPS distances & "Check Out" rename (Feb 2026)**: `/api/presence` projection was missing `institution`, so every row showed `null`. Added it to both the Mongo projection and the result dict. Presence rows now render a sky chip with the institution next to the name. `describeGeo()` rewritten so distance (`X m on-site` / `X km off-site`) always leads, with the muster verifier appended after a `·` separator. Renamed the "Left" column to "Check Out".
- **Late-by-1-second indicator (Feb 2026)**: Set `late_grace_minutes = 0` in office config (was 15). The `compute_late` threshold is now at `HH:MM:00.000`, so any check-in even one second past work_start triggers the late badge. The badge itself changed from orange to red, and the member's name renders in red on the row.
- **Guest check-in / check-out (Feb 2026)**: New module `/app/backend/guests.py` adds 4 endpoints: `POST /api/guests/checkin` (name + photo), `POST /api/guests/{id}/checkout`, `GET /api/guests/today`, `DELETE /api/guests/{id}`. Permitted for coaches and admins via the new `require_coach_or_admin` dependency. Stored in a separate `guests` collection (not `users`) — no logins or attendance records. Frontend: new `GuestCheckInModal.jsx` with mandatory photo capture (reuses `SelfieCapture`), a violet "Guest" pill on the Presence header showing active count, and a new "Guests" column at the rightmost position with active visitors at top and "Checked out today" at the bottom in dimmer text. Only visible to admins and coaches.
- **Double-click-to-edit on Presence (Feb 2026)**: New endpoint `GET /api/members/{id}` (admin only) returns the full member doc. Admins double-clicking any Presence row open the existing `MemberForm` modal prefilled with the member's profile — same UX as the Members page. Coaches see no cursor change and the action is a no-op for them.

## Test Credentials
See `/app/memory/test_credentials.md` — admin@attendance.app / Admin@12345 (or phone `9849002111` for OTP-bypass).
