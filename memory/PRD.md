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
| P2 | `?include_photos=0` bandwidth optimization on `/api/presence` (3-4MB → ~100KB). |
| P2 | PWA install prompt ("Add to Home Screen") for Coaches/Staff. |
| P2 | Add "Institution" filter pills to Muster Roll & Reports. |
| P2 | More inline-editable fields on the Members table (currently photo + parent mobiles only). |
| P2 | A/C/S/E breakdown row on Muster column headers (mirroring Presence). |
| P2 | **Consultant coaches tracking** — see "Open Design — Consultant coaches" section below. |
| P2 | SMS OTP hardening for new-device approval (Twilio India ~₹0.30/SMS, ~₹50/yr at current scale). |
| P2 | Selfie verification at device approval (admin compares fresh capture side-by-side with stored photo). |
| P2 | Auto-revoke devices stale for >30 days. |
| P3 | Combined "Audit log" view that lists every device action chronologically across all tabs. |
| P3 | Migrate user emails from `@sailors.local` → `@athletes.local` (cleanup). |
| P3 | WebP logo variants for faster loading. |
| P3 | Split `server.py` (3000+ lines) into focused routers (`routes/devices.py`, `routes/attendance.py`, `routes/reports.py`, etc.). |

## Open Design — Consultant coaches (deferred, P2)

**Problem**: Consultant coaches (not employees) work on-site, off-site, and often abroad. Current `geo-toggle` enforces the YCH geofence, so consultants get marked Absent every day even though they're actively working. We need to track their attendance, hours-worked, tour days, and campus presence.

**Three approaches, in order of effort**:

**A. Minimal (~1 hour) — "Off-site session" toggle**
- Add `engagement_type: "employee" | "consultant"` field on the user (default `employee`).
- For `consultant` users, the Check-In page shows a 3-button mode picker:
  - **On Campus** → normal GPS check-in (unchanged).
  - **Remote** → check-in bypasses geofence; status reads "Working Remote".
  - **Tour / Abroad** → check-in with a one-line "where" note (e.g. "Auckland NZ", "Online from Bangalore"); status reads "On Tour".
- Each session still records `check_in_at` / `check_out_at`, so hours-worked totals work as-is.
- Presence Board: new cyan "Remote" status + existing orange "Tour" + small "Consultant" chip.

**B. Standard (~3 hours)** — everything in (A), plus:
- Admin Reports → "Consultant hours" tab with per-consultant on-campus / remote / tour split, location notes, by week or month.
- CSV/PDF export of any month for billing.
- Filter on Presence Board: "Show consultants only".

**C. Full (~6 hours)** — everything in (B), plus:
- `engagement` collection: `start_date`, `end_date`, `hourly_rate_inr`, `currency`, `scope` per consultant (multiple engagements possible).
- Invoice helper: month-end, draft an invoice line per consultant (hours × rate).
- Approval queue: consultant submits month → admin reviews → locks records.
- Time-off tracking (paid vs unpaid) per engagement.

**Recommendation**: Start with **(A)** — covers 90% of "did my Auckland coach actually work Tuesday?". Layer (B) on later if month-end tallying becomes a pain. Data model from (A) supports (B) without migration.

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

- **Camps (Approach A) shipped (Feb 2026)**: New `camps` collection + module `/app/backend/camps.py`. Endpoints: `GET/POST /api/camps`, `GET/PATCH/DELETE /api/camps/{id}`. Each camp carries `start_date`, `end_date`, `start_time`, `end_time`, `days_of_week` (any subset of mon-sun; empty = all 7), `member_ids` (explicit enrollment) and/or `institution` (any athlete of that institution). Optional `late_grace_minutes` overrides the office default.
  - `compute_late()` now accepts an optional `camp` argument that overrides the member's work_start.
  - `presence()` does a single bulk fetch of today's camps, then resolves per-member overlay during the loop. Both the absent-vs-not_due branch AND the live `late` recompute apply the overlay.
  - **Bug fix**: athletes with `category=athlete` AND no `work_start` AND no active camp today now resolve to `status=not_due` ("No camp scheduled today") instead of being silently marked Absent. Verified on JHANVI/SAANVI PARISE.
  - Frontend: new admin page `/admin/camps` with calendar pickers, days-of-week chips, athletes multi-select (filtered by institution + name search), grace override, notes. Sidebar entry added between Institutions and Payroll.

## Recently Added (June 2026)
- **Photo thumbnails for list endpoints (June 2026)**: Added `photo_thumb` field on users + `check_in_photo_thumb`/`check_out_photo_thumb` on attendance sessions. Every photo write (`POST /members/me/photo`, `POST /members/{id}/photo`, `PATCH /members/{id}`, every check-in/check-out via `perform_toggle`) now also generates a 96 px JPEG thumbnail server-side using Pillow. List-style endpoints — `/api/presence`, `/api/muster/list`, `/api/admin/overtime`, `/api/admin/sessions`, `/api/today/timeline`, `/api/members` — return only the thumbnail in the `photo` field. The full photo remains the source of truth in the DB and on `/api/me`, `/api/members/{id}` (admin), and `/api/members/{id}/card` (for printable ID cards). Startup backfill regenerates thumbnails for any existing user/photo missing one — ran on 80 users at first boot. **Result: `/api/presence` payload dropped from ~3-4 MB to 333 KB (10x reduction) for 149 members.**

- **Code review pass (June 2026)**: Single-batch fix of every actionable code-review item:
  - **Mongo indexes added**: `users.mobile`, `attendance.{user_id,date}`, `attendance.check_out_at`, `leaves.{status,start_date,end_date}`, `leaves.{user_id,status}` — hot-path queries (`/presence`, `/auth/phone`, `/admin/overtime`) no longer collection-scan.
  - **`update_member` photo regen** now only stamps `photo_thumb` + `photo_captured_at` when the photo bytes actually changed (was resetting the yearly-refresh timer on every member edit).
  - **Muster bulk check-in** now passes the active camp to `compute_late` — stored `late_minutes` is correct for camp athletes (Reports were showing stale values).
  - **`daily-content` timezone fix** — quote/word now flips at office-local midnight (was server UTC midnight, so IST users saw new content at 05:30 IST). Reads the office timezone from config on each request.
  - **`/api/members` list** returns thumbnails too — admin Members page dropped from ~4.5 MB to ~450 KB.
  - **`CORS_ORIGINS` env var** is now actually read (was hardcoded `"*"`).
  - **Lint cleanup**: all 27 ruff blockers fixed (F541, F811, E701, E741 — renamed `l` → `leave` everywhere). `daily_content.py` imports moved to module-top (was per-call).
  - **Avatar fallback**: failed image loads now degrade to initials block instead of broken-image glyph.
  - **SelfieCapture mirror fix**: front-camera snapshot is now mirrored to match the preview (was saving a left-right flipped image vs what the user saw).
  - **Mobile sidebar**: body scroll is locked while the drawer is open (was scroll-bleeding on iOS Safari).

  Still deferred (separate planning sessions): rotate production secrets, JWT→httpOnly cookies migration, rate-limiting on auth, full `server.py` modular refactor, expanded pytest coverage for camps/regattas/guests/thumbnails.

## Test Credentials
See `/app/memory/test_credentials.md` — admin@attendance.app / Admin@12345 (or phone `9849002111` for OTP-bypass).
