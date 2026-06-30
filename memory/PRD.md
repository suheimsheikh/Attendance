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
| P2 | SMS OTP hardening for new-device approval (Twilio India ~₹0.30/SMS, ~₹50/yr at current scale). |
| P2 | Selfie verification at device approval (admin compares fresh capture side-by-side with stored photo). |
| P2 | Auto-revoke devices stale for >30 days. |
| P3 | Combined "Audit log" view that lists every device action chronologically across all tabs. |
| P3 | Migrate user emails from `@sailors.local` → `@athletes.local` (cleanup). |
| P3 | WebP logo variants for faster loading. |
| P3 | Split `server.py` (3000+ lines) into focused routers (`routes/devices.py`, `routes/attendance.py`, `routes/reports.py`, etc.). |

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

- **Unified Leave system — Comp-Off + Paid Leave waterfall** (26 Jun 2026) —
  members no longer pick between "Leave" and "Comp Off" when applying.
  They apply once for **Leave** and the backend deducts in a fixed
  ladder: Comp-Off balance first → Paid Leave second → anything left
  recorded as **LOP**. The leave document carries the stamped split
  (`comp_off_used`, `paid_leave_used`, `lop_days`) so balances stay in
  sync without re-deriving from business logic on every read.
  - Backend (already in place from prior fork): `holidays.compute_balance_summary`
    + `holidays.split_leave_days`; `routes/leaves.create_leave` stamps
    the split when `type=="leave"`. New endpoints
    `GET /api/me/leave-summary` and `GET /api/members/{id}/leave-summary`
    return the unified shape `{comp_off, paid_leave, total_available, weekly_off, weekly_off_source}`.
  - Frontend (this iteration): `MyLeaves.jsx` ApplyForm dropped the
    "Comp Off" button — type grid is now 3-col (Leave / Tour / Late
    Coming). The form fetches the unified summary on open and on
    admin single-pick. `LeaveBalanceNotice.jsx` rewritten to render
    two pool pills (Comp-Off available, Paid Leave available) + a
    waterfall preview line ("This request will deduct **X** from
    Comp-Off + **Y** from Paid Leave + **Z LOP**") + LOP banner +
    the approval-policy line. Admin multi-pick falls back to the
    legacy per-member LOP table. Athlete category renders the
    "Breaks workflow" info block. Testids:
    `waterfall-preview`, `pool-comp-off`, `pool-paid-leave`,
    `leave-balance-info-nonleave`, `leave-balance-multi`,
    `leave-balance-athlete`, `leave-balance-loading`.
  - Verified end-to-end by iter4 testing agent (10/10 new backend
    tests + 18/18 existing route tests + UI smoke on self-apply
    and admin Apply-on-behalf). Pytest suite still 190/190 green.
  - Also fixed a latent NameError: `routes/leaves.py` referenced
    `_days_inclusive` without importing it from `holidays`.


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

## Recently Added (Feb 2026 — Calendar.jsx extraction)

- **Calendar.jsx 4-file extraction** (29 Jun 2026, 997 → 379 lines, -62%)
  - `calendar/helpers.js` (49 lines) — LEVEL_STYLE, LEVELS, DOW_KEYS,
    SCOPES, ymd, startOfMonth, endOfMonth, addMonths, scopeLabel.
  - `calendar/DayDetailModal.jsx` (173 lines) — bottom-sheet/modal
    listing all events for one clicked day.
  - `calendar/RegattaForm.jsx` (112 lines) — modal for create/edit
    regatta.
  - `calendar/BreakForm.jsx` (305 lines) — adaptive break-scope picker
    with institution / fleet / per-member sub-forms.
  - Parent `Calendar.jsx` now owns: data fetch, month grid composition
    (camps + regattas + breaks per day), the bottom CRUD lists, the
    "Import from YAI" CTA. Re-exports `BreakForm` for `Leaves.jsx`
    which imports it cross-page.
  - Verified end-to-end: all 7 page testids present (yai-import,
    camp-add, break-add, regatta-add, cal-prev, cal-next,
    calendar-grid), 42 cells rendering, RegattaForm + BreakForm
    modals open with full scope picker, backend regression
    39/39 (iter11-14 + smoke) green.

- **Three big-component extractions complete** — Members ✓ Presence ✓
  Calendar ✓. Total lines reduced: 2228 → 1156 (-48%) across the
  three pages.

## Recently Added (Feb 2026 — Presence.jsx extraction)

- **Presence.jsx slimmed via 2-file extraction** (29 Jun 2026,
  478 → 366 lines, -23%)
  - `components/presence/PresenceHeader.jsx` (136 lines) — title, date
    picker triplet (prev / picker / next / "Today" badge), late-only
    toggle, absent chip, guest CTA, members count chip, refresh
    button. Pure presentation; parent owns state + dispatches.
  - `components/presence/FleetFilterRow.jsx` (38 lines) — pill row
    for fleet filtering. Renders null when no fleet labels are
    present among loaded members.
  - Parent Presence.jsx now owns data-fetch, polling, byColumn
    bucketing, pairedDisplay, escortsByStatus, and the column grid.
  - Zero behaviour change — all 12 header/fleet testids preserved
    and verified end-to-end (date navigation, historical mode toggle,
    "Today" button return, refresh, guest CTA, late filter, fleet
    chips, search input, column grid).
  - Backend regression: 78/78 pytest pass (iter11-14 + smoke +
    routes_leaves + ishowedup_api).

## Recently Added (Feb 2026 — iter15 P2/P3 polish)

- **PAIRED_COLUMN_KEYS reconciled with implementation** (29 Jun 2026)
  - `constants.js` declared `{on_campus, exited}` as the paired pair —
    so the same alphabetically-sorted union renders in both columns
    with `visibility: hidden` placeholders for non-matching rows,
    keeping the two columns scroll-locked at row-level.
  - `Presence.jsx` had drifted to pair `temp_out + exited` instead.
    The implementation now correctly builds `pairedDisplay` from
    `[...byColumn.on_campus, ...byColumn.exited]`. Stepped Out is
    no longer paired (renders only its own members + escorts).

- **Muster sticky breakdown bar** (29 Jun 2026)
  - New sticky bar above the muster list (`data-testid="muster-breakdown"`)
    showing chips: B (boys), G (girls), ◇ (unspecified), ✓ N in
    (already-in count — check-in mode only), ☑ N (picked, > 0 only).
  - Chips respect the institution filter + search box live.
  - Uses sky/pink/slate tones so it visually mirrors the Presence
    column breakdown row.
  - A/C/S/E literal mapping wasn't possible (Muster is athletes-only) —
    gender pivot was the natural analogue.

- **Members.jsx 5-file extraction** (29 Jun 2026, 753 → 411 lines, -45%)
  - `members/MemberRow.jsx` (248 lines) — single-row `<tr>` template,
    all mutations via parent callbacks.
  - `members/MemberBucketFilters.jsx` (76 lines) — bucket chips + admin
    toggle + institution dropdown.
  - `members/ParentInlineInput.jsx` (68 lines) — parent mobile editor.
  - `members/helpers.js` (64 lines) — BUCKETS / BUCKET_BY_KEY / bucketOf /
    GENDER_LABEL / lastSeenLabel / leaveBalanceLabel / isInteractive.
  - Parent `Members.jsx` now owns data-fetch + mutation state only.
  - Zero behaviour change — all 14 inline-edit testids per row
    preserved (133 rows × 14 = 1857 selectors verified by iter15).
  - Verified end-to-end by iter15 testing agent: 39/39 backend
    regression (iter11-14 + smoke) pass; Playwright confirms all
    three changes work with the live 133-member roster.
  - **Known cosmetic warning**: React hydration log warning
    `<span> cannot be a child of <option>` surfaces somewhere on
    Members page render. Functionality intact, browser strips the
    span on hydration. Tagged P3 — couldn't pinpoint by grep in
    iter15 (all `<option>` literals across the codebase use plain
    `{o.label}` text). Likely fires from a non-Members component
    that happens to mount alongside (Calendar/MemberForm/BulkEditBar).
    Cleanup needs a deeper render-time inspection.

## Recently Added (Feb 2026 — escorts in all three status columns)

- **Escorts now show up in On Campus + Checked Out + Stepped Out**
  (29 Jun 2026)
  - Backend (`/api/presence`): `escorts_present` no longer filters by
    `check_out_at: null` — it returns EVERY escort attendance row for
    today, tagged with a new `status` field
    (`on_campus` / `temp_out` / `exited`) and a `check_out_at` field
    (null when not exited). Status precedence: `exited` > `temp_out`
    > `on_campus`.
  - Frontend (`Presence.jsx`): new `escortsByStatus` memo buckets
    `escorts_present` by status; each column receives only its own
    bucket via `escorts={escortsByStatus[col.key] || null}`. Other
    three columns (tour/leave/absent) always receive `null`.
  - Frontend (`EscortsStrip`): now filters to `on_campus + temp_out`
    only — exited escorts disappear from the strip (they're already
    visible in the Exited column).
  - Frontend (`Column.jsx` — EscortRowsSection): exited rows show
    `In HH:MM → Out HH:MM` (both timestamps); on-campus/temp-out
    rows show `since HH:MM` (unchanged). The escort sub-section was
    hoisted OUT of the `displayList ? : members` branching so paired
    columns (Exited via PAIRED_COLUMN_KEYS) also render it — was a
    bug caught by iter14 testing agent where the Exited column's
    breakdown chip and count badge correctly accounted for escorts
    but no escort rows were rendered.
  - The "Es N" breakdown chip + total column count badge (members +
    escorts) work unchanged in all three columns.
  - Verified end-to-end: iter14 testing agent — 30/30 backend tests
    pass (10 new iter14 + 5 iter11 regression + 12 iter12+iter13);
    post-fix Playwright smoke confirms all three column sub-sections
    render (`column-escorts-on_campus`, `temp_out`, `exited` each = 1).

## Recently Added (Feb 2026 — expected-return-time badge)

- **Colour-coded ETA pill on stepped-out rows** (29 Jun 2026)
  - Backend (`/api/presence`):
    - Member rows in `temp_out` now carry `expected_return_time` (local
      HH:MM derived from the ISO `expected_return`) in addition to the
      pre-existing `expected_return` (ISO) and `overdue_minutes`.
    - Escort rows in `escorts_present` now carry the full triple:
      `expected_return` (anchored ISO), `expected_return_time` (HH:MM),
      and `overdue_minutes`. The parser handles BOTH storage shapes —
      escort excursions store raw HH:MM, member excursions store ISO.
      Raw HH:MM is anchored to today in the office tz (Asia/Kolkata)
      to compute overdue_minutes against `now_utc()`.
  - Frontend: new shared `ExpectedReturnPill.jsx` component (renders
    null when no ETA). Tone branching:
    - GREEN (`bg-emerald-100`): not overdue, >15 min away
    - AMBER (`bg-amber-100`): overdue 1–5 min OR future within 15 min
    - RED (`bg-red-100`): >5 min overdue
    Text format: "Due HH:MM" with optional "· Xm late" suffix.
    Tz-safety: uses server-provided absolute ISO (`expected_return`)
    for the amber-approaching window — Date.parse / Date.now subtract
    is tz-stable regardless of the admin's browser tz. HH:MM fallback
    only when no ISO is supplied.
  - Pill renders on THREE surfaces:
    - `MemberCard` (`presence-due-{member_id}`) — only when columnKey
      is `temp_out`
    - `Column.EscortRowsSection` (`column-escort-due-{escort_id}`) —
      inside the Stepped Out column sub-section
    - `EscortsStrip` (`strip-escort-due-{escort_id}`) — on the strip
      row, to the right of the cyan "stepped out" chip
  - Verified end-to-end by iter13 testing agent: 6/6 backend pytest
    pass, RED / AMBER / GREEN / no-ETA all verified across all three
    surfaces; iter11+iter12+smoke (23/23) regression unchanged.
    Post-iter13 tz-safety fix: now passes ISO through all three call
    sites; iter11+iter12+iter13 (20/20) green after the change.

## Recently Added (Feb 2026 — escort step-out surfaced in Presence column)

- **Stepped-out escorts now appear inside the Stepped Out column**
  (29 Jun 2026)
  - The escort step-out facility itself (button + form + temp-exit /
    return endpoints) already shipped earlier — this iteration only
    adds the *second* visible surface so coaches see escorts in the
    same column as stepped-out members.
  - Frontend (`Presence.jsx`): new `steppedOutEscorts` memo filters
    `data.escorts_present` by `temp_out` and is passed to the Column
    component via the new `escorts` prop ONLY for
    `col.key === 'temp_out'`. Other five columns can never accidentally
    receive escorts.
  - Frontend (`Column.jsx`): new `EscortRowsSection` sub-component
    renders a teal-bordered "Escorts" sub-section at the bottom of
    the column (after all member rows). Each row has avatar, name,
    institution, since-time, and the step-out reason in cyan. An
    additional "Es N" chip joins the per-category breakdown row
    (only when escortList.length > 0). The column count badge sums
    `members.length + escorts.length`.
  - Stepped-out escorts now appear TWICE — in the EscortsStrip (roster
    view, cyan chip) and inside the Stepped Out column (status view).
    Intentional: the two surfaces answer different questions.
  - Verified end-to-end by iter12 testing agent: 6/6 backend regression
    tests for step-out + return endpoints pass; frontend Playwright
    confirms the sub-section, Es chip, combined count, historical-view
    suppression, and other-columns-unaffected guarantees.

## Recently Added (Feb 2026 — escort presence + muster lock)

- **Escorts now visible on /presence** (29 Jun 2026)
  - Backend: `/api/presence` now returns an `escorts_present` array
    alongside the existing `members` / `counts` / `guest_*` fields. One
    row per active escort whose `escort_attendance` row for today has
    `check_in_at` set and `check_out_at` null. Each row carries
    `{attendance_id, escort_id, name, institution, photo, check_in_at,
    athletes_count, temp_out, temp_out_reason}`. Heavy base64 selfies
    are excluded. Historical views (`?on=<past-date>`) return `[]` —
    escort attendance isn't reconciled into past-day reads.
  - Frontend: new teal `EscortsStrip` component (mirrors `GuestStrip`)
    renders above the six-column grid. Header carries the institution
    name + count badge; rows show name, institution, in-time, athletes-
    count chip, and a cyan "stepped out" chip when an escort has an
    open excursion. Skipped on historical views.

- **Muster locks already-checked-in athletes** (29 Jun 2026)
  - Backend: `/muster/athletes?mode=checkin` now KEEPS athletes who
    are currently on campus (previously hidden), each marked with
    `already_checked_in=true` and `check_in_at=<iso>`. Approved
    leave/tour rows still filter out entirely. `mode=checkout`
    unchanged. The `checkin-bulk` endpoint already had a defence-
    in-depth "already checked in" skip — kept for safety.
  - Frontend (`Muster.jsx`):
    - Locked rows render with `bg-slate-50 opacity-60 cursor-not-
      allowed`, a pre-ticked grey checkbox, an "In · HH:MM" pill,
      and no "Add photo" button.
    - `toggle()` refuses to add locked rows to the picked set; a new
      `tickable` memo excludes them from `toggleAllVisible` and the
      `allVisiblePicked` check.
    - The muster-summary line now reads
      "&lt;tickable&gt; athletes to check in · &lt;locked&gt; already in
      · &lt;picked&gt; ticked".
  - Verified end-to-end by iter11 testing agent: 8/8 backend contract
    tests pass, both UI surfaces verified in headless playwright.

## Recently Added (Feb 2026 — escort selfie thumbnails)

- **Captured photo now visible as a thumbnail on the kiosk** (29 Jun 2026)
  - Backend: `/escort-attendance/today` now applies the existing
    `_strip_selfies` helper (was inline-stripping selfies), so every
    row surfaces `has_check_in_selfie` / `has_check_out_selfie`
    boolean flags. Selfies remain stripped from the list payload —
    no perf regression on the kiosk list.
  - Backend: new `GET /escort-attendance/{att_id}/selfie?kind=in|out`
    returns `{data_url: '<base64>'}` for lazy fetch. Auth gate:
    admin / coach / the escort whose row it is (a foreign-escort
    token gets 403). FastAPI `Literal["in","out"]` rejects invalid
    `kind` with 422 automatically. 404 distinguishes "row missing"
    from "no selfie on file" via the detail string.
  - Frontend (`EscortCheckIn.jsx`):
    - `SelfieThumbnail` component: 56×56 preview, label badge,
      tap-to-zoom full-screen modal. Resolution order = local
      data URL → lazy `/selfie` fetch → null. Cancellation token
      prevents stale state writes on unmount.
    - `EscortActionCard` hoists `justCapturedIn` / `justCapturedOut`
      state so the just-submitted photo shows IMMEDIATELY on the
      next render (no API round-trip), and `OnCampusActions` /
      `CheckedOutRecap` render the thumbnail(s) inline.
    - Recap shows TWO thumbnails (Check-in + Check-out) when both
      photos are on file.
  - Verified end-to-end by iter10 testing agent: 12/12 backend
    contract tests pass, all 3 UI surfaces (on-campus card,
    zoom modal, recap dual thumbs, no-thumb empty state) verified.

## Recently Added (Jun 28, 2026 — code review action items)

- **Test credentials moved to env vars** — `test_review_iter2`, `iter3`,
  `test_ishowedup_api`, `test_smoke_flows`, `test_routes_leaves`,
  `test_unified_leave_iter4` now read `TEST_ADMIN_EMAIL` /
  `TEST_ADMIN_PASSWORD` / `TEST_ADMIN_MOBILE` from the environment with
  the documented `admin@attendance.app` / `Admin@12345` / `9849002111`
  fallback that mirrors `conftest.py`. The login literals no longer
  appear inline; an ops user can re-point the suite at a different
  test pool without editing files.
- **Dead top-level imports removed from `server.py`** — `math`, `bcrypt`
  (used via `services.auth_utils`), `base64`, `PIL.Image` (used via
  `services.photo`), `typing.Tuple`, `zoneinfo.ZoneInfo`, and the
  unused `from holidays import compute_comp_off_balance` re-import.
  The intentional re-exports from `services/*` for backwards
  compatibility (`iso`, `MAX_PHOTO_BYTES`, `OVERTIME_THRESHOLD_MIN`,
  `_hm_to_minutes`, etc.) are now explicitly marked `# noqa: F401`.
- **`holidays.compute_balance_summary` extraction** — the 113-line
  row-bucketing loop is now a `_bucket_leave_rows(rows, today)` helper
  returning a 6-key dict. The main function drops from ~110 lines to
  ~40, and the loop is unit-testable in isolation. Semantics unchanged
  — 13/13 unified-leave + iter6 leave-summary tests pass.
- **Empty catch blocks in `utils.js` now log** — the two intentional
  swallows in the GPS `watchPosition` flow (clearWatch race + onProgress
  callback throws) now emit `console.debug` with the error message so
  silent failures are discoverable in devtools without polluting console.

### Code review findings explicitly NOT applied (with reasoning)
- **`is True` / `is False` in tests** — flagged as a "comparison anti-pattern"
  in 106 instances. This is actually idiomatic Python: `True` and `False`
  are singletons and `is` is preferred over `==` for them (both ruff
  and pylint agree). PRD has documented this previously. Skipping.
- **localStorage → httpOnly cookies migration** — flagged as a security
  hardening. User has explicitly deferred this to a dedicated session
  (PRD line item "Still deferred: JWT→httpOnly cookies migration").
  Touching auth without a planned migration risks logging out every
  active session. Skipping.
- **`Members.jsx` (613 lines), `Presence.jsx` (430 lines),
  `Calendar.jsx` (387 lines), `EventConflictNotice.jsx` (127 lines)
  component splits** — large mechanical refactors with no behaviour
  change; high regression risk on a live-deployed app. PRD already
  marks Members/Presence component extraction as P3 backlog. Skipping
  until a dedicated session.
- **165 nested ternaries** — Tailwind class-name selection is the
  primary offender, where nested ternaries are the standard idiom
  (e.g. `tone === "red" ? "text-red-600" : tone === "amber" ? "text-amber-700" : "text-slate-500"`).
  Extracting these to functions adds indirection without readability
  gain. Skipping.
- **`breaks.make_router` / `daily_content.make_router` complexity** —
  these are FastAPI router factories; the closure-captured `db` +
  `dep` arguments make extraction non-trivial (would force a module-
  scoped state pattern). The route handlers inside them are flat.
  Skipping the wrapper complexity score.
- **React hook dependency warnings (114 claimed)** — ESLint `react-hooks/
  exhaustive-deps` returns clean across all `pages/admin/*` files. These
  were fixed in the Jun 25 pre-launch polish session (see PRD). The
  report appears to be running against a stale snapshot.

## Test Credentials
See `/app/memory/test_credentials.md` — admin@attendance.app / Admin@12345 (or phone `9849002111` for OTP-bypass).

## Recently Added (Jun 28, 2026)

- **Escort module polish — 3 enhancements shipped** (28 Jun 2026):
  1. **Recent visits strip** — each active escort row in `EscortManager`
     (Institutions page → Escorts modal) renders a compact strip of the
     last 5 check-in dates with friendly labels (Today / Yesterday /
     Nd ago / "5 Jul"), hover tooltips show in/out times. Backend:
     `GET /api/escorts/{id}/recent-visits?limit=5` (auth-required, dates
     only, no selfies).
  2. **One-click Invalidate** — admins get an amber Ban-icon button on
     active escorts (`data-testid="escort-invalidate-{id}"`). Confirms,
     then calls `POST /api/escorts/{id}/invalidate` which flips status
     to `left` + stamps `ended_at`, `invalidated_by`, `invalidated_at`.
     Previously-issued escort JWTs get 401'd on the very next request
     via the `get_current_user` status gate.
  3. **Institution-scoped Muster for escorts** — `_can_muster` now
     permits `is_escort=true` sessions. `/muster/athletes`,
     `/muster/checkin-bulk`, and `/muster/checkout-bulk` filter by
     `athlete.institution == escort.institution` for escort callers.
     Foreign-institution athletes in the bulk request are silently
     skipped with `reason="outside your institution"`. Admin/coach
     paths are unchanged (no institution restriction). Frontend:
     `RequireMuster` and the sidebar now allow escorts onto `/muster`
     (Presence still admin/coach-only).
  - Verified end-to-end by iter9 testing agent: 14/14 new backend
    contract tests pass, full pytest suite 233/233 green, admin UI
    invalidate flow verified on a real institution.

- **Code review pass (28 Jun 2026)** — broad cleanup, zero behaviour change:
  - **Mongo indexes for the escort module** — added `escorts.id` (unique),
    `escorts.mobile_last10`, compound `(status, institution)` on escorts,
    compound `(escort_id, date)` on `escort_attendance`, and a plain
    `date` index for the today/purge queries. These were missing since
    the Escorts launch; the kiosk active-list + escort-token muster
    + idempotent check-in lookups are now indexed.
  - **Frontend lint clean** — fixed unescaped quotes on Payroll header,
    removed 3 dead `eslint-disable-next-line` directives in
    Institutions and EscortCheckIn. Only remaining lint warnings are
    in the vendor `components/ui/*` shadcn files (intentional).
  - **Backend test-suite lint clean** — moved the `athlete` pytest
    fixture from `test_smoke_flows.py` to `tests/conftest.py` so
    cross-file imports no longer trip ruff F811 in `test_routes_leaves`.
    Removed dead `inserted_total` and `me` locals (F841). Renamed the
    `l` loop variable to `item` in `test_unified_leave_iter4.py` (E741).
    `ruff check backend/` is now silent.
  - **Audit findings noted, deferred to dedicated sessions**:
    rate-limit / lockout on `/auth/login`, JWT→httpOnly cookie migration,
    `server.py` modular split (~4200 lines), `Calendar.jsx` and
    `Members.jsx` component extraction. All P2 polish, none are
    blockers.

- **server.py modular router refactor — Phase 1 (28 Jun 2026)** —
  ~1280 lines carved out of `server.py` into 5 new modules under
  `/app/backend/routes/` (server.py: 4316 → 3033 lines, ~30%
  reduction). Pattern: each module exposes `make_router(...)` factory
  receiving callable deps; no import cycles. Shared Pydantic model
  `UserPublic` moved to `/app/backend/models.py`.
  - `routes/auth.py` — `/auth/login`, `/auth/me`, `/auth/phone`,
    `/auth/phone/status`, full `/admin/devices/*` queue
    (approve/reject/revoke/reinstate). Trusted-phone cinch + admin
    self-recovery logic preserved verbatim.
  - `routes/office.py` — `/office` GET+PUT (Twilio token masking +
    twilio sub-doc strip on PUT), `/admin/checkout-reminder/send-now`,
    `/changelog`.
  - `routes/masters.py` — `/institutions` (CRUD + rename cascade),
    `/fleets` (CRUD + rename cascade to users AND breaks), and
    `/fleets/assign` bulk reassign.
  - `routes/muster.py` — `/muster/athletes`, `/muster/checkin-bulk`,
    `/muster/checkout-bulk` (escort institution-scoping intact;
    already-checked-in greying preserved).
  - `routes/admin_tools.py` — `/admin/attendance/wipe`,
    `/admin/backup`, `/admin/restore`, `/admin/preflight` (7-item
    checklist), `/admin/summary`, `/admin/activity` (event feed).
  - Iter16 testing agent: 34/34 contract tests + 75/75 broader
    regression = 109/109 GREEN. Zero behaviour changes detected.
    Hydration warning `<span> in <option>` no longer reproduces in
    browser console — likely fixed by prior Members/Presence/Calendar
    component extractions.

- **Tour-day → Comp-off accrual for Staff/Coaches/Executives (28 Jun 2026)** —
  `compute_comp_off_balance` in `/app/backend/holidays.py` now ALSO walks
  every approved `tour` row for non-athletes; each tour date that
  matches their effective weekly_off adds +1 to `accrued` with
  `kind: "tour_weekly_off"` in the breakdown. Athletes are the only
  category excluded (they use the Breaks workflow). Idempotent against
  double-counting when attendance + tour cover the same date, and
  against overlapping approved tours. Pending tours do NOT accrue.
  Coverage: `/app/backend/tests/test_comp_off_tour_accrual.py` — 9/9
  passing (updated from staff-only after user feedback).

- **Multi-site geofence (28 Jun 2026)** — additional geofenced
  locations (e.g. neighbouring Rowing Academy) where check-ins are
  treated as on-site. The main office stays in `OfficeConfig`; sites
  are an additive list managed via `/api/sites` CRUD (admin-only
  mutations).
  - New helper `services/geo.py::resolve_site(office, lat, lng, sites)`
    picks the CLOSEST active geofence and returns
    `(site_id, site_name, distance_m, out_of_geofence)`. Inactive
    sites are ignored. If point is inside no geofence at all →
    `out_of_geofence=True` (still informational — never blocking).
  - `perform_toggle` (QR / scan-card / mark-member) and `_geo_toggle`
    (member self-service) both call this helper and stamp `site_id` +
    `site_name` (and `exit_site_id` + `exit_site_name`) on the
    attendance row. Backward-compatible: `site_id=None` ⇒ main office
    won, identical to pre-multi-site rows.
  - `/api/admin/activity` events carry `site_name` and append
    `· at <site_name>` to the human-readable `detail`.
  - New admin page `/admin/sites` (sidebar entry between Fleets and
    Office Settings) — create/edit/delete with name, lat/lng (with
    "Use my current location" geolocation shortcut), radius_m (1–4999),
    active toggle, and optional notes. Deleting a site preserves the
    site_name on historical attendance rows so old reports stay
    readable.
  - Coverage: `/app/backend/tests/test_geo_multi_site.py` — 8/8
    passing. Iter17 testing agent: 11/11 backend contract tests +
    65/65 regression (incl. iter16) GREEN. Frontend bug found
    (useFormError exposes setMessage not setError) — fixed in same
    session, re-screenshot confirms 0 console errors and successful
    save with validation.

- **Leave Balances "X (Y from tours)" sub-line (28 Jun 2026)** —
  `/api/leave-balances` admin endpoint now ALSO walks approved tour
  rows and credits weekly_off dates inside them (same rule as
  `compute_comp_off_balance`). New response fields per row:
  `comp_off_accrued_from_attendance` and `comp_off_accrued_from_tours`
  (which sum to `comp_off_accrued`). The admin `/admin/leave-balances`
  page surfaces `from_tours` in two places:
  1. Header strip Comp-Off card → orange "✈ Y from tours" sub-line
     when > 0.
  2. Accrued column cell → tiny orange "+Y tour" sub-pill underneath
     the total.
  This closes the gap between `/api/me/comp-off-balance` (which uses
  `compute_comp_off_balance` and already showed the tour split) and the
  admin page (which had its own inline accrual loop). Verified end-to-end:
  4 real members in the preview DB now show tour-derived comp-off
  correctly (2 coaches + earlier test users since cleaned up).
