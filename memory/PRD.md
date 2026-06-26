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

## Recently Added (Jun 26, 2026)

- **Removed Holidays system; Comp-Off now keyed off weekly-off only** —
  per user decision (and an honest cost/benefit walk-through), the
  public-holiday master list was retired. Comp-off accrual now relies
  solely on attendance on the member's weekly off — either their own
  `weekly_off` (if set on the profile), or the new org-wide
  **Default weekly off** field on Office Settings (default Sunday). The
  fallback means admins don't have to fill `weekly_off` on 42+ profiles
  before comp-off can work. The `compute_comp_off_balance` helper now
  also returns `weekly_off_source: "member" | "office_default"` so the
  UI can later surface that signal.
  Files: deleted `/admin/holidays` page + route + nav entry; rewrote
  `backend/holidays.py` to keep only the comp-off math + read endpoints
  (CRUD/model gone); added `default_weekly_off` to `OfficeConfig`;
  Office Settings page renders the new dropdown with explainer copy.
  Dropped `holidays` collection on dev DB. 190/190 pytest still green.
  Compensating a member who worked on a public holiday is now a manual
  `leave_balance_opening` adjustment (admin's call, no system tracking).

- **Approvals page → unified scrollable table** — `/admin/approvals` now

- **Leave-balance preview + LOP warning in the apply-leave form** —
  every leave application path (self-apply on `/my-leaves`, admin
  "Apply on behalf" with single OR multi member pick) now shows a
  contextual notice block right above Submit. For `type=leave` the
  block renders the live balance (opening − YTD-approved-leave-days)
  vs the requested calendar-day count and flags excess days as
  **"N days will be Loss of Pay (LOP)"** in a red panel. Multi-pick
  renders a per-member table with Remaining + LOP columns. For
  Tour / Comp Off / Late Coming the same slot renders a small blue
  info note (those types don't draw from the balance). Every variant
  closes with **"All leave is subject to admin approval"** — UNLESS
  the admin has toggled Auto-approve, in which case the line becomes
  *"Will be auto-approved on submit (admin override)"*. Backend
  enriches `/api/auth/me` with the live `leave_balance_remaining`
  (was a stored-only field returning null) for the self path; admin
  path reuses the already-loaded `/members` payload.
  New component: `LeaveBalanceNotice.jsx`. Verified e2e with three
  Playwright flows: self-LOP (6 left, applied 8 → 2 LOP), admin
  multi-pick (3 staff, mixed balances → per-row LOP correct), all
  non-leave types render the right contextual copy.

- **Daily-content quotes broadened — no longer sailing-only** —
  replaced `FALLBACK_QUOTES` with 10 universally-resonant picks
  (Jocko, James Clear, Mark Twain, Robin Sharma, Zig Ziglar etc.,
  retaining Isabel Allende's "Show up. Show up. Show up." and one
  sailing proverb for variety). Updated the Gemini system+user prompt
  to drop the sailing/sports bias: "Broader life wisdom preferred
  over nautical clichés; keep it universal, not sailing-specific."
  Dev DB cache cleared so the new style appears immediately on next
  visit. Fresh sample: *"Champions are built through the quiet
  discipline of daily practice."*

- **Bulk-edit on the Members admin table** — end-of-season fleet
  reshuffles, role grants, institution changes etc. that used to take
  hundreds of clicks now take one. Backend gets a new
  `POST /api/members/bulk-update` endpoint backed by a strict allowlist
  (`category` / `role` / `institution` / `fleet` / `weekly_off` /
  `gender` — per-individual fields like name / mobile / opening leave
  balance / photo / password are intentionally rejected). The endpoint
  also self-protects: refuses to demote the signed-in admin via a bulk
  role change.
  Frontend adds a new `BulkEditBar` component (sticky bottom toolbar)
  plus a checkbox column on the Members table. Selection supports
  click-to-tick, **shift-click for Excel-style range select** across the
  currently filtered view, a master checkbox in the header (indeterminate
  state when only some visible rows are picked), and a Clear button. One
  Apply round-trip, optimistic toast, auto-clears the selection. The
  shift-range had a subtle React closure-vs-mutation gotcha: the
  `setSelectedIds` updater is batched and reads `lastClickedIdx.current`
  AFTER the post-set assignment runs, so we snapshot the ref before the
  state update. Verified end-to-end on `/admin/members`: click row 0 →
  shift-click row 5 → 6 selected → Fleet = Opti C → Apply → API confirms
  6 rows updated. 190/190 pytest green.

- **Code-review action items (selective, freeze-respecting):**
  - **Empty catch blocks logged** (`utils.js` TTS, `Leaves.jsx` break modal
    pre-load) — added `console.debug` with context so silent failures
    are diagnosable from devtools. Other empty catches in `utils.js`
    already had inline reasoning comments; left alone.
  - **WhatsNew bullet keys are now content-derived** (`ul-key + first
    24 chars of bullet text`) instead of array indices, so the React
    reconciler diffs bullets correctly across re-renders.
  - **InlineCell refactored** — extracted `<DisplayCell>`, `<EditSelect>`
    and `<EditInput>` helper sub-components from the original 131-line
    monolith. Behaviour identical, complexity drops from ~31 to ~6 in
    the main component, each helper is <40 lines and single-purpose.
    Smoke-tested end-to-end on `/admin/members`: fleet picker select
    still saves "Opti A" → API confirms persistence.
  - **Skipped (legitimate false positives or scope-out):**
    `is True/False` in tests (idiomatic Python — `True`/`False` are
    singletons; ruff/pylint actually *prefer* `is`); hardcoded test
    credentials (these are the documented `admin@attendance.app`
    /`Admin@12345` fixtures from `test_credentials.md`, not real
    secrets); localStorage tokens (explicitly deferred by user pending
    JWT cookie migration post-launch); backend complexity refactors and
    large-component splits (pre-launch freeze — tech debt, not bugs);
    hook-deps (previous session already addressed; the review's line
    numbers reference a pre-refactor state of the files).

- **Members admin table is now inline-editable** — added
  `/app/frontend/src/components/InlineCell.jsx`, a reusable cell-level
  editor (text / number / tel / select). Wired into `Members.jsx` for
  the common edits: **Name** (required), **Category** (renders the
  coloured pill, dropdown picks athlete/coach/staff/executive), **Admin
  role** (renders shield badge, dropdown picks admin/member), **Rank**,
  **Gender**, **Mobile**, **Institution**, **Fleet** (dropdown sourced
  from the fleets master + any in-use labels), and **Leave balance
  opening** (numeric, only for staff + coach since athletes/executives
  show em-dash). Auto-saves on blur (text/number) or change (select);
  Enter commits, Esc cancels. Optimistic local update + revert on error
  + checkmark flash on success. Header now reads "click any cell to edit
  · double-click a row for the full form" — the existing `MemberForm`
  modal stays available for power edits (email, password, photo,
  parent names, work hours, weekly-off). Verified end-to-end with
  curl-driven Playwright: typing into rank persists, dropdown picking
  for category/role updates the row pill, and editing
  `leave_balance_opening` to 14 immediately recomputes
  `leave_balance_remaining` and persists both fields.
- **🐛 Backend: PATCH /members couldn't clear fields** — the handler used
  `{k:v for ... if v is not None}` so explicit nulls in the request body
  were silently dropped. That meant inline-edit cells could SET values
  but never CLEAR them ("blank out the rank" did nothing). Switched to
  `model_dump(exclude_unset=True)` so absent fields stay untouched but
  explicit nulls clear. Modal `MemberForm` is unaffected — it already
  strips empty strings before sending and only retains explicit nulls
  for fields that were already null. All 190 pytest still green.

- **🐛 Twilio "origin returned invalid response" Cloudflare-style toast**
  — `sms.py` was deliberately returning **502** on Twilio API rejections
  (bad creds, unverified number, DLT missing). The k8s ingress / edge
  proxy replaces any 502 from origin with its own generic HTML "origin
  overloaded" page, so the admin never saw the real Twilio error
  ("Unable to create record: Authenticate", "Trial mode — recipient not
  verified", etc.). Switched to **400** for `TwilioRestException`
  (genuinely a client-config error from FastAPI's perspective) and kept
  500 for truly unexpected failures. Now the admin sees Twilio's exact
  rejection message in the red toast.

- **🐛 Twilio first-time-setup auth-token save bug** — `Office.jsx` was
  dropping `auth_token` from the PUT payload on the very first save
  because the gate `editToken && newToken.trim()` required clicking the
  "Change token" button, which only renders once a token is already saved.
  First-time admins typed the token, hit Save, every other field landed
  in the DB, the token silently didn't, and the field rendered empty on
  reload — looked like "the token disappeared". Fix: treat
  `!cfg.has_auth_token` (no saved token yet) as implicit edit mode so the
  input's contents are submitted. Verified end-to-end: cleared
  `office.twilio`, entered fresh creds, save → `has_auth_token: true` +
  masked tail visible + "Change token" button now appears.
- **Apply Break modal is now athletes-only** — the per-member checkbox
  list in `BreakForm` (`/admin/leaves` → "Apply break", scope=Selected
  members) used to mix athletes + coaches + staff + executives. Fleet is
  an athlete-only concept, so the list now filters
  `category === "athlete"` before rendering, the fleet-options derivation
  drops non-athlete fleet leakage, and the labels read "Athletes on break
  (N)" / "Search athletes by name…". Bulk scopes ("All coaches", "All
  staff", "Holiday for everyone") still cover non-athlete breaks, and
  individual coach/staff time-off goes through "Apply on behalf".
  Verified: picker now shows 91 athletes (was 132), fleet pills All / Opti
  A / Opti B / Opti D render from the athlete roster.

- **Members admin table: 3 new at-a-glance columns** — added `Fleet`,
  `Last seen`, and `Leave balance` columns to `/admin/members`. Backend
  `UserPublic` now exposes `last_seen_date` (max attendance.date per user,
  bulk-aggregated), `leave_balance_opening`, and `leave_balance_remaining`
  (opening − YTD-approved-leave-days). Frontend `Members.jsx` renders:
  - **Fleet** — sky pill when assigned, em-dash otherwise.
  - **Last seen** — friendly relative labels (Today emerald / Yesterday / N
    days ago / N≥30 days as absolute date in red / Never in slate-400),
    `today` memoised per render.
  - **Leave balance** — only meaningful for staff + coaches (payroll
    cohort); athletes/executives show em-dash. Numeric `remaining/opening`
    with tone bands (red <0, amber <3, slate otherwise) and a tooltip
    breaking down opening − YTD-taken = remaining.
  - Verified end-to-end: curl confirms all 132 rows carry the 4 fields
    across all 4 categories; screenshot confirms headers + 132 cells
    render without React errors, bucket pills/counts still intact (All
    132 · Coaches 12 · Staff 27 · Executives 3 · Athletes 90 · Admin 4).

## Recently Added (Jun 25, 2026 — pre-launch polish round 2)

Added on top of round 1 (Request-ID, hook deps, etc.).

- **`/api/admin/preflight`** — admin-only readiness check. Returns 7 items
  (office geofence, work hours, Twilio, admin count, recent backup, roster
  size, timezone) with pass/warn/fail severities. Helps confirm everything
  is configured before pushing Deploy.
- **`/api/version`** — no-auth probe returning git SHA, branch, started_at,
  uptime_seconds. Useful for status pages and post-deploy verification.
- **`showApiError(err, fallback)`** helper in `api.js` — surfaces the
  server's `X-Request-ID` as a toast description. Threaded through Login,
  Self check-in, Muster, MyLeaves, Profile, Presence (admin double-click,
  guest check-out). Less-used callsites can opt in later.
- **Friendly photo-too-large message** — KB-based, instructs the user to
  retake the photo. Backend response + frontend client-side check both updated.
- **Routing bugfix**: `/api/members/import-template` now resolves correctly
  (was being captured by `/members/{member_id}` due to registration order;
  returned 404 with "Member not found").
- **Test coverage: 90 → 190 tests** (+18 leaves router, +18 reports router,
  +24 legacy iteration_1 brought back to green after `sailor→athlete`
  rename). 190/190 pass in ~17 s. `last_backup_at` now stamped on
  /admin/backup so preflight can verify backup recency.

## Recently Added (Jun 25, 2026 — pre-launch polish)

Final touch-up before July 1 launch. No structural changes (refactor frozen).

- **Request-ID middleware** — every API response carries `X-Request-ID`;
  every server log line is tagged `rid=<12-hex>`. Client may supply its
  own (hardened against log-injection: 64-char cap, `[A-Za-z0-9_-]` only).
  Health-check (`/api/health`) is excluded from the access log.
- **`api.js` ApiError** now exposes `requestId` pulled from the response
  header — frontend can surface it in error toasts for support hand-off.
- **React Hook dependency cleanup** (P2 from review #1 — finally done).
  Fixed 6 stale-closure warnings via `useCallback` + correct `useEffect`
  deps in: `Devices.jsx`, `Leaves.jsx`, `Overtime.jsx`, `Payroll.jsx`,
  `Reports.jsx`.
- **Regression**: 90/90 pytest pass; testing agent ran 24/24 backend + 10/10
  frontend smoke = 100 % green.

## Recently Added (Feb 2026 — refactor pass #1)

Pre-launch (July 1) refactor to split the two largest monoliths and grow
test coverage. Zero behavioural change.

- **Presence.jsx** 924 → 444 lines. Extracted into 7 files under
  `/app/frontend/src/components/presence/`: `constants.js`, `GeoLine.jsx`,
  `SessionTimeline.jsx`, `MemberCard.jsx`, `Column.jsx`, `GuestStrip.jsx`,
  `SkeletonBoard.jsx`. Verified rendering 132 members across 6 columns,
  all chips/badges/expand-buttons intact.
- **Backend `services/`** (new package). 7 modules with pure helpers:
  - `time_utils.py` — tz-aware now / iso / office_tz / local_*
  - `geo.py` — `haversine_m`
  - `phone.py` — `normalize_phone`, `phone_key`
  - `photo.py` — `check_photo_size`, `make_thumbnail` (+ PIL bomb guard)
  - `auth_utils.py` — `hash_password`, `verify_password`, `create_token`
  - `attendance_calc.py` — `compute_late`, `compute_overtime_in/out`,
    `excursion_seconds`, `open_excursion`, `parse_expected_return`
  All re-exported from `server.py` so callers don't break.
- **`parents_import_utils.py`** (already moved last session) gained 17 unit tests.
- **`server.py` 4093 → 3611 lines** after extracting:
  - `routes/leaves.py` — `POST/GET/PATCH /api/leaves`, `/leaves/mine`, `/leaves/group`. Exposes `enrich_leaves` for the reports router.
  - `routes/reports.py` — `/reports/hours`, `/reports/payroll`, `/reports/daily`, plus the CSV/PDF exports. `_pdf_from_table` + `_csv_response` helpers moved here too. `reportlab` and `csv` imports dropped from `server.py`.
- **`/api/presence`** got `# GATHER` / `# RESOLVE` / `# RENDER` banner comments so the 440-line function is navigable without full extraction. Behaviour identical.
- **Test coverage**:
  - 81 unit tests covering `services/*` + `parents_import_utils` — **97%** line coverage.
  - 9 smoke tests in `tests/test_smoke_flows.py` exercise admin login → presence → muster → leave approval → reports CSV.
  - **90/90 tests pass in 3.5 s**.
  - Added `pytest.ini` + `.coveragerc` for repeatable `pytest --cov` runs.
- **Verified**: backend healthy, frontend renders Presence/Muster/Members, all extracted routes return correct shapes.

### Refactor backlog (deferred, lower-risk batches)
- Split the other 60 routes in `server.py` (auth, members, devices, attendance,
  presence, overtime, admin/* — into `routes/auth.py`, `routes/members.py`,
  `routes/devices.py`, `routes/attendance.py`, `routes/presence.py`,
  `routes/admin_backup.py`, etc.). Same factory pattern, ~3-4 hours.
- Full extraction of `/api/presence` into `_gather_presence_data() → _resolve_member() → _render_response()` (currently just has phase-banner comments).
- Migrate `compute_hours_report` and `_send_checkout_reminders` to a
  `services/reports_compute.py` + `services/notifications.py`.

## Recently Added (Feb 2026 — code review pass #2)
- **P0 correctness fixes**
  - Deleted stale QR routes left over from the QR retirement: `POST /api/attendance/checkin`, `POST /api/attendance/checkout`, `POST /api/office/regenerate-qr`. Stripped `qr_token` from `/api/office` and `office_qr`/`office_name` from `/api/admin/cards`.
  - Removed duplicate `/api/admin/snapshot/import` (was a stale copy of `/admin/restore` missing `breaks`+`fleets`).
  - Fixed N+1 in `/api/presence`: `late_coming` leaves are now bulk-fetched once and looked up via dict, not queried per absent member.
  - Phone-login matcher now uses a denormalised `mobile_last10` indexed field — one keyed `find_one` instead of a full collection scan + Python-side suffix match. Backfilled at startup; stamped on member create + on mobile change.
  - Twilio SMS / Voice calls are now `await asyncio.to_thread(...)` so the sync SDK no longer blocks the event loop for 300-800 ms per send.
  - `/api/admin/backup` now streams JSON in 500-row chunks per collection; `/api/admin/restore` uses chunked `$in` lookups + `bulk_write` instead of per-doc `find_one`+`insert_one`. Removes the OOM ceiling.
  - `_make_thumbnail` now guards against PIL decompression bombs (`Image.MAX_IMAGE_PIXELS = 8M` + explicit catch).
  - `update_member` Optional-role demote check no longer silently bypasses when `body.role is None`.
- **P2 perf**
  - Member Excel import switched from per-row `find_one` + `insert_one` to a single `$in` existence check + `insert_many`. Big wins for 100+ row imports.
  - Presence Board polling now gated on `document.visibilityState`: backgrounded tabs pause, focused tabs catch up instantly.
  - Admin pages (Reports, Backup, Members, Calendar, Devices, Leaves, etc.) lazy-loaded via `React.lazy + Suspense` — athlete bundle (login + self check-in) is now noticeably smaller.
- **P3 quality**
  - Migrated startup/shutdown to FastAPI **lifespan context manager** (`@app.on_event` is deprecated).
  - Extracted a `_schedule_daily(label, get_hm, fn)` helper; the midnight auto-checkout and 8 PM checkout-reminder loops are now one-liner wrappers.
  - Moved parents-import helpers (`norm_name`, `fuzzy_score`, `norm_mobile`, `clean_name`) to a new `parents_import_utils.py` module.
  - Moved `from sms import DEFAULT_PARENT_TEMPLATES` to the top of `server.py`.
  - `downloadBlob` validates `content-type` so a 401/500 doesn't silently save an HTML error page as CSV.
  - `refreshMe` no-ops when no token is present (avoids 401 noise after a cross-tab logout).
  - `speakLateMessage` race fixed (no more double-call when `voiceschanged` fires after the safety timeout).
  - Presence Board memoises `today` once per render; the date stepper handlers reuse it.
  - All silent `try/except: pass` blocks now `logger.debug(...)` or `console.debug(...)`.
- **Verification**: testing agent ran 19/19 backend + 7/7 frontend smoke tests — **100% pass**, no regressions.
- **Still deferred** (separate planning sessions): JWT→httpOnly cookies migration, rate-limiting on auth, full `server.py` modular refactor, `Presence.jsx` split into `components/presence/`, splitting the 437-line `/api/presence` endpoint into gather/resolve/render phases.

## Test Credentials
See `/app/memory/test_credentials.md` — admin@attendance.app / Admin@12345 (or phone `9849002111` for OTP-bypass).
