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
| P1 | "Wipe attendance for today only" button (alongside existing full DB wipe). |
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

- **BUGFIX: members couldn't appear in Presence after check-in (June 2026)**: Members without a profile photo (69 of them) were blocked by a *mandatory* selfie before check-in. In `SelfCheckIn.jsx` the selfie modal's Skip/×/Esc (`onClose`) only closed the modal **without** checking in — and if the camera was unavailable the member was stuck. Result: they tapped "I showed up" but never appeared on the Presence board. Fix: `onClose` now calls `skipSelfieAndCheckIn()` which proceeds with the check-in (photo stays optional; they're nudged again next time). The geo-toggle/presence backend was confirmed healthy throughout. Reproduced and verified in-browser (Skip → "Currently on campus"). Muster's coach-driven flow already proceeded on skip, so it was unaffected.


- **Apply-on-behalf discoverability + tooltips (June 2026)**:
  - **Apply on behalf**: The admin "Leave Approvals" page (`/admin/leaves`) already had an "Apply on behalf" button (multi-member picker, institution filter, auto-approve toggle, type Leave/Tour/Comp-Off/Late-Coming, date range, reason → posts to `/leaves/group`). It was only reachable from the Admin Console; added it to the **admin sidebar** ("Leave Approvals", `nav-leave-approvals`) so admins can quickly file leave for a member who forgot.
  - **Tooltips**: Added descriptive `title` tooltips (native, robust across the app's scroll/overflow containers) to sidebar nav items (each with a purpose-specific tip), mobile menu & logout, and the primary controls across Check-In/Out, Muster, Members, Backup & Restore, Leave Balances, and Leave Approvals (approve/reject/apply-on-behalf).


- **Admin daily checklist + comp-off balance (June 2026)**:
  - **Admin login checklist**: `GET /api/admin/checklist` returns 8 live-status items (camps today, outstation events, special timings, holiday, pending leave/tour, pending comp-off, pending devices, members missing photos) + `dismissed` flag. `POST /api/admin/checklist/dismiss` records a per-admin/per-day dismissal in `checklist_dismissals`. Frontend `AdminChecklist.jsx` modal mounts in `Layout` for admins, shows on every login/load until "Done for today" is clicked (each row has live count/status badge, tick checkbox, and an arrow to jump to the relevant page). "Remind me later" closes without dismissing.
  - **Comp-off balance (auto-earned)**: A comp-off day is earned automatically whenever a member has attendance on a day that was their `weekly_off` OR a campus holiday (`schedule_exceptions`). `GET /api/me/comp-off` & `GET /api/members/{id}/comp-off` return `{earned, used, pending, balance, earned_days[]}`. `create_leave` now blocks a `comp_off` request when requested days exceed the available balance. Frontend `MyLeaves.jsx`: a clickable comp-off balance card that expands to list the earned (worked off-day/holiday) dates, and the Apply form shows the live balance and blocks over-spend. Verified end-to-end via curl (holiday on a worked date → +1 earned; 0-balance apply → 400) and screenshots.


- **Schedule overrides & holidays (June 2026)**: New `/app/backend/schedule.py` module + `schedule_exceptions` collection + a `weekly_overrides` field on the office config doc. New admin page **"Schedule & Holidays"** (`/admin/schedule`).
  - **Weekly overrides**: per-weekday start/end time (e.g. every Sunday 08:00 instead of 06:00). `GET/PUT /api/schedule/weekly`.
  - **Schedule exceptions**: `kind="holiday"` (date or range, nobody expected → everyone `not_due` "Holiday — {name}", never Absent, camps suspended, check-in still allowed) or `kind="timing"` (one-off date/range with a different start/end time). `GET/POST/PATCH/DELETE /api/schedule/exceptions`.
  - **Precedence** (campus-wide, applies to everyone incl. overriding active camps): holiday > one-off date timing > weekly override > camp > personal work_start > office default. Threaded into `compute_late` (new `day_start` arg) via `_compute_late_for()` at all check-in/muster paths, and into `/api/presence` (new `day_schedule` field in response).
  - Frontend: `Schedule.jsx` (weekly grid + holiday/timing list & form with type toggle), sidebar entry, and a Presence-board banner (rose for holidays, amber for special timings). Verified end-to-end via curl (holiday → 0 absent; timing 23:30 → 0 absent/not_due; validation) and screenshots.


- **Camps & Regattas — outstation events (June 2026)**: Renamed the "Camps" admin page → **"Camps & Regattas"** and extended the `camps` collection with two fields: `kind` (`"camp"` | `"outstation"`, default `camp`) and `location` (free-text). 
  - **Camp** = existing local training schedule (times + days drive late/absent for enrolled athletes; now also carries an optional location). `start_time`/`end_time` are required for camps.
  - **Outstation event** = a travel window covering a date range at a `location`, enrolling a **mixed group** (athletes → "regatta", coaches/staff → "tour"). Times/days/grace are not used. `camps.py` gained `resolve_member_outstation()`; `resolve_member_camp()` now excludes outstation-kind so they never act as a training schedule.
  - **Presence overlay**: a new highest-priority branch in `/api/presence` marks enrolled members `status="on_tour"` with detail `"At regatta · {location}"` (athletes) or `"On tour · {location}"` (coaches/staff) for the entire event range — auto-excused, never "Absent", no check-in required. Coexists with the legacy per-person `leaves type="tour"`.
  - Frontend `Camps.jsx`: Camp/Outstation type toggle, Location field (MapPin), conditional time/days/grace (hidden for outstation), member picker includes all categories for outstation (Staff/Coach badges) vs athletes-only for camps, kind/location badges on list rows. `Calendar.jsx` guards the time display for outstation entries. Verified end-to-end via curl (athlete+coach enrolled → correct on_tour labels; camp time validation) and screenshot.


- **Tap-to-zoom avatars on Presence Board (June 2026)**: New endpoint `GET /api/members/{id}/photo-full` (any authenticated user) returns the full-resolution photo on demand (falls back to thumbnail if no original). Presence rows wrap the avatar in a clickable button (`presence-avatar-zoom-{id}`); clicking opens a full-screen `PhotoZoomModal` that seeds with the thumbnail instantly then swaps in the full-res image, with member name, close button (Esc / backdrop click), and a loading spinner. Keeps list payloads light while letting coaches/admins inspect a member's face up close. Verified end-to-end via screenshot tool.



- **Security fix — auto-provisioned password hardening (June 21 2026)**: Device-login users auto-created at admin device-approval (`server.py` `approve_device`) previously got `hashed_password = hash_password(phone_digits)` — a guessable password paired with a predictable email (`{phone}@attendance.app`), enabling account takeover via the email/password form. Now hashed from `secrets.token_urlsafe(32)` (added `import secrets`). Verified: logging in with phone-as-password returns 401. These users only ever authenticate by approved device, so no UX impact.
  - ⚠️ STILL OPEN (not yet approved by user): the **member-import** path (`server.py:1340`) still defaults a member's password to their phone digits when the import sheet omits a password, and the **existing ~149 seeded members** already carry phone-as-password hashes in the DB. Email/password login is admin-only in practice (members use phone+device), but a full close-out needs: (1) randomize the import default, (2) one-off rotation of existing weak password hashes. Awaiting user go-ahead.

### Investigation note — "Waiting for approval" mass lockout (June 21 2026)
- Root cause: device approval + auth token are stored in browser `localStorage`, which is **scoped per origin/hostname**. The preview URL hostname changed (fork/continuation), so every member's browser landed on a "new" origin with empty storage → looked like an unapproved new device → "Waiting for approval", while the admin (on the current origin) saw an empty pending queue. Backend/DB/admin queue all verified healthy. No member login attempts reached this backend on June 21 (only admin activity), confirming members were hitting a different/stale origin.
- Recommended permanent fix: **Deploy** to a stable URL so approvals persist. (Pending user decision.)


### Duplicate-member cleanup + prevention (June 21 2026)
- **Symptom reported:** "Preethi showing twice in absent despite being on the tour list." Root cause = duplicate user accounts. When a member imported WITHOUT their own mobile later logs in by phone, the matcher (`_match_user_by_phone`, only checks `mobile`) finds no match → `approve_device` created a brand-new account. The duplicate has no leave/tour, so it shows as Absent.
- **Part 1 — data cleanup (DONE):** Merged exact-name duplicates Preethi Kongara + Asif Ahmed (moved phone/devices/attendance/leaves to the real record, deleted the dup). Then a fuzzy scan (difflib ratio >= 0.88) found 3 spelling-variant dups; deleted the empty duplicates keeping the active record: PREETI→PREETHI KONGARA, RANJEETH→RANJEET KARMAKAR, KEERTHIKA ANDEL→Keerthika Andol (user chose "Andol" spelling). Verified each person now appears once in /api/presence (Preethi = on_tour · Germany). NOTE: live-DB edits done via one-off motor scripts; no test pollution left.
- **Part 2 — recurrence prevention (DONE, tested):** `DeviceApproveIn` gained optional `link_user_id`; `approve_device` now links an unmatched device to an EXISTING member (and backfills that member's `mobile` from the device phone) instead of creating a duplicate. Frontend `admin/Devices.jsx` ApproveDialog adds a searchable "Link to an existing member" picker (search box → member results; falls back to create-new). Verified via curl (members count unchanged, device re-pointed, mobile backfilled) and screenshot.
- **Follow-up idea:** consider storing a normalized `mobile_key` and doing fuzzy-name dedupe at import time to stop variants entering in the first place.


### Unified "Leave & Overtime" screen (June 21 2026)
- Consolidated 3 admin menu items (Leave Approvals + Overtime Approvals + Leave Balances) into ONE screen `pages/admin/LeaveManagement.jsx` with tabs **Requests / Overtime / Balances** (reuses the existing tested `Leaves`, `Overtime`, `LeaveBalances` components as panels). Sidebar now has a single "Leave & Overtime" entry → `/admin/leave-management`. Old routes `/admin/leaves`, `/admin/overtime`, `/admin/leave-balances`, `/admin/group-leave` now `<Navigate>`-redirect to the unified screen with the right `?tab=`.
- Active tab is held in **local state** (seeded once from `?tab=`), NOT derived live from the URL — because `Overtime.jsx` rewrites search params for its own date/status filters, which previously reset the tab back to Requests. Important gotcha if more child screens are added.
- **Balances tab now shows comp-off** alongside annual leave. `GET /api/leave-balances` extended with `comp_earned/comp_used/comp_pending/comp_balance` per member (computed in bulk: one read each of holidays, all attendance dates, comp_off leaves — avoids N per-member ledger calls). Table column "Comp-off Bal." shows balance + "{earned} earned · {used} used · {pending} held" subtext. Edit-and-save of annual opening unchanged, admin-only.
- Verified via curl (comp fields present) + screenshots (all 3 tabs render, switching holds, old route redirects).


### Daily Sessions surfaced in sidebar (June 21 2026)
- User questioned whether "Today's Activity" (Console `ActivityFeed`) and "Daily Sessions" (`/admin/sessions`) are redundant with Presence. Conclusion: keep both. Today's Activity = time-ordered event log (check-ins/outs, temp exits, applications, access requests) which user said they need. Daily Sessions = per-person, per-date in/out timeline + hours (the ONLY place to review a PAST day; user had "nowhere" for this). It was orphaned (no menu link) → added a sidebar entry "Daily Sessions" (ListTree icon) → `/admin/sessions`. No logic change to the page itself; just made it reachable. Verified it loads with live data.

### YAI 2026 events imported into Regattas (June 21 2026)
- Scraped all 28 events from https://www.yai.org.in/events.html and inserted into the `regattas` collection (managed on the Calendar page; renders in the Regattas list + calendar grid). Mapping: level=international if name has International/Asian/World/Eurasia else national; host_org=organising club; notes=YAI category + "Source: YAI 2026 calendar"; country=India. Deduped by name+dates. Result: 30 total regattas (8 international, 22 national). Verified via /api/regattas + Calendar screenshot.

### Admin checklist — overtime row added (June 21 2026)
- Added a 9th item to `GET /api/admin/checklist`: "Pending overtime approvals" — count of attendance sessions with `overtime_total_min>0` and `overtime_status=="pending"`, linking to `/admin/leave-management?tab=overtime`. Frontend `AdminChecklist.jsx` renders items generically so it shows automatically. Now covers all approval queues: leave/tour, comp-off, overtime, devices (+ camps, outstation, timings, holiday, missing photos). Verified via API.

### Admin checklist — auto-hide cleared rows (June 21 2026)
- `AdminChecklist.jsx`: rows that are "clear" (count 0, or status None/No) are auto-hidden so admins see only actionable items. Header shows live "N items need your attention". Cleared rows collapse behind a "Show N cleared items" toggle. When nothing is pending, shows an "All set for today" empty state. Frontend-only change (no backend). Verified via screenshot: 5 actionable shown, 4 cleared hidden, toggle reveals all 9.

### Half-day leave + Sailors parent-contact import (June 21 2026)
- **Half-day leave (Leave & Comp-off, single date):** Added Office config forenoon/afternoon session timings (defaults 09:30-13:30 / 13:30-17:30). Leave docs carry `half_day` (forenoon/afternoon); deducts 0.5 via new `_leave_units()` helper used in leave-balances, comp-off ledger + bulk. Backend validates half-day only for single-date Leave/Comp-off (400 otherwise). Presence shows "Half day (forenoon/afternoon)", excused whole day. Frontend: Office settings session-timing inputs; MyLeaves/admin apply form Session selector (Full/Forenoon/Afternoon) shown when eligible; half-day badge in lists. Verified via curl (0.5 deduction, multi-date rejected 400). Frontend compiles.
- **Sailors details 2026 import:** Parsed 95 rows from xlsx (cols: inst, name, gender, DOB, DOJ, father/mother/guardian names+contacts). Stored father_mobile/mother_mobile/guardian_mobile + dob + date_of_joining (numbers for parent-SMS use only, NOT login). 87 existing members updated, 6 net-new created (8 created minus 2 name-order dups merged: Katravath Sravan, Kounik Vardhan). 13 Agape Home members have NO contact numbers in source. Rainbow Home kids share warden guardian # 9000525148. 84 members now have >=1 parent/guardian contact. Total users 141. SMS SENDING NOT YET WIRED (needs Twilio) — numbers stored only, per user.
