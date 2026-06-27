# Changelog — I Showed Up

Each section lists what's in **preview** but hasn't been deployed yet, so you
can skim it before pressing Deploy. Once you redeploy, move that block under
the dated "Released" header at the bottom and reset the "Unreleased" section.

---

## 🚧 Unreleased — pending deploy to `i-showed-up.ychyderabad.com`

### ⚠️ Camp/Regatta conflict chip on Approvals + Apply (June 27, 2026)

Approving (or applying for) leave during your own camp or regatta is now caught at the point of decision.

- New backend endpoint **`GET /api/leaves/event-conflicts`** — returns `{camps, regattas}` overlapping the date window. Camps are gated by **institution match AND member-roster** (when roster is set), so a sailor on the Agape Sat-Sun roster requesting leave during that camp's window is flagged. Regattas are org-wide (no per-user roster in the current schema) and returned as informational. Non-admins can only query for themselves; admins can pass `user_id=...`.
- New frontend component **`<EventConflictNotice />`** — collapsible card with two-tone palette:
  - 🟥 **Red** when a camp roster conflict is detected (e.g. *"⚠ Possible camp/regatta conflict · 1 camp they're rostered into · 2 regattas during this window"*) — admin should think twice.
  - 🟧 **Amber** when only regattas overlap (informational only — confirm with the applicant).
- Wired into:
  - **MyLeaves Apply form** — shows below the Overlap notice so the applicant catches their own foot-gun before submitting.
  - **Admin Approvals detail row** — renders full-width on a new line below the Overlap + Balance grid, expanded by default for high visibility.
- Multi-pick admin "Apply on behalf" suppresses the notice (rosters differ across members).
- Iter6 polish:
  - `data-testid="stat-tour-days-ytd"` (no trailing dash) now resolves on the My Leave dashboard.
  - Cleared the React "key spread on `<StatCard>`" console warning.
- Verified by iter7 testing agent: **221/221 pytest** (213 + 8 new) — zero issues found.


### 🆕 Overlap visibility + Comp-Off & Tour columns on Leave Balances (June 26, 2026)

- **Sidebar** — `Leave/Tour` renamed to **`Leave Tour Approvals`**.
- **Apply Leave form** — whenever Leave or Tour is selected and dates are picked, a new collapsible *Overlap* notice shows who else is on Leave / Tour during the same window (grouped by type, pending rows tagged `P`). The applicant sees this **before** submitting so two coaches don't accidentally request the same week off.
- **Approvals table** — every Leave/Tour/Comp-Off row now has a chevron expander. Opening it reveals a side-by-side detail row with **(a) the same Overlap notice** and **(b) the applicant's live Comp-Off + Paid Leave pools** plus the waterfall ladder the approval will draw on (e.g. "Approving will draw 2 from Comp-Off + 3 from Paid Leave + 1 LOP"). Balance fetches lazy — only when the row is opened — and cache per applicant so re-expanding is instant.
- **Leave Balances** admin page — table rebuilt with three column groups: **Paid Leave** (Opening / Used / Balance), **Comp-Off** (Accrued / Used / Available — year-to-date, computed from attendance ∩ weekly-off), and **Tour Days** (year-to-date). Plus a totals strip across the top with three colour-coded cards that respect the active search filter.
- New backend endpoint **`GET /api/leaves/overlap`** — accepts `start_date`, `end_date`, optional `exclude_user_id`, optional `leave_id`. Returns a safe summary (no reasons). Available to any authenticated user.
- Backend **`GET /api/leave-balances`** extended with `comp_off_accrued`, `comp_off_used`, `comp_off_available`, `tour_days` per row.
- Verified by iter5 testing agent: **210/210 pytest green** + 4/4 UI flows confirmed end-to-end.

### 🩹 Inline error banners above Save buttons (June 26, 2026)

Errors on form submissions used to surface as a top-of-screen red toast
that fades in ~4s — easy to miss when you're staring at the Save button.
Every primary action now also shows a **persistent inline red banner
directly above the Save / Submit button**, so the failure message stays
in your line of sight until you fix it or dismiss it. The banner shows
the full server message (incl. verbatim Twilio rejection text), the
matching X-Request-ID for support, and an **X** to dismiss.

Wired into:
- **Office Settings** — main settings save + **Twilio panel** (save, test SMS, test voice). The Twilio rejection seen in production (*"Trial accounts cannot send messages to unverified numbers…"*) now sits right above the Save row.
- **Leave / Tour / Comp-off apply form** (self & admin "Apply on behalf").
- **Login** — phone-continue, admin-email login, new-user profile form.
- **Member add/edit** form.
- **Calendar** — Regatta form + Break form.
- **Camps** add/edit form.
- **Fleets** — fleet edit form + Assign-athletes bulk modal.
- **Institutions** add/edit form.
- **Guest check-in** modal.

Row-level quick actions (Approve / Reject / Delete) keep the existing
toast pattern — they're fire-and-forget and don't have a Save target.

New building blocks for future forms:
- `components/FormErrorBanner.jsx` — drop-in red banner component.
- `hooks/useFormError.js` — `{ error, requestId, clear, setMessage, setFromApi }` hook.

### 🛠 Fixes & visibility (June 25, 2026 — round 3)

- **Members page now treats "Admin" as a role, not a category.** Previously
  a coach who was also an admin disappeared from the "Coaches" bucket and
  was double-counted in "Admins". Fixed: category pills (Coaches / Staff /
  Executives / Athletes) sum to the total, and a separate "Admin role"
  chip filters across all categories. An admin-coach now appears under
  "Coaches" AND lights up the Admin chip. Each member row also carries an
  "Admin" badge next to their category pill.
- **Multi-session chip on the Presence Board.** If a member checks in,
  checks out, then checks in again later the same day, you'll see a
  small indigo "🔄 N sessions" chip on their card. Helps you spot
  legitimate split shifts vs accidental double check-ins at a glance,
  without changing the existing allow-multiple-sessions behaviour.

### 🔬 Safer launch (June 25, 2026 — round 2)

- **Pre-launch checklist on tap.** Hit `/api/admin/preflight` (admin-only)
  and get a ✅ / ⚠️ breakdown of office geofence, work hours, Twilio
  credentials, admin count, recent backup, roster size, timezone — so the
  Deploy button is never pressed with something missing.
- **Build identity probe.** `/api/version` (no auth) returns git SHA,
  branch, container start time, and uptime. Useful for "what's actually
  live right now?" — paste it into a status page or check after Deploy.
- **Cleaner error toasts.** When an API call fails, the red toast now
  shows the matching Request ID underneath, e.g. `Request ID: 1ff8c2e321bc`.
  Read it back to support over the phone and we can grep server logs
  straight to your exact request.
- **Friendlier "photo too large" message.** Instead of `413 photo too
  large (256000 bytes; max 250000)`, you get
  *"That photo is too big (250 KB). Try retaking it — the limit is 244 KB.
  Most modern phone cameras will work if you crop or use the front camera."*
- **Routing fix.** `/api/members/import-template` was being captured by
  `/members/{member_id}` (registration order) and returning 404 instead
  of the template Excel. Fixed — literal route now wins.

### 📋 Test suite tripled (104 new tests this session)

- `tests/test_services_*` — 81 unit tests (97 % coverage) on the helpers
  extracted to `services/`.
- `tests/test_routes_leaves.py` — 18 end-to-end tests for the new leaves
  router (create / approve / reject / group / file-on-behalf).
- `tests/test_routes_reports.py` — 18 tests for hours / payroll / daily
  + CSV / PDF export shapes.
- `tests/test_smoke_flows.py` — 9 critical-flow tests.
- `tests/test_ishowedup_api.py` — 21 legacy tests, brought back to green
  by fixing `sailor → athlete` literal mismatch.
- **190/190 pass in ~17 s.**

### 🪟 Final pre-launch polish (June 25, 2026 — round 1)

- **Trace every coach complaint to logs.** Every API response now carries
  an `X-Request-ID` header. If a coach reports "the board froze at 9:14",
  you (or support) can ask them to read the request ID off the network panel
  / error toast and grep server logs straight to the offending request line.
  Log lines look like `rid=1ff8c2e321bc GET /api/presence -> 200 28ms`.
  Health-check pings are intentionally excluded from the access log to
  keep it readable.
- **React Hook dependency cleanup.** Fixed 6 stale-closure warnings across
  Devices, Leaves, Overtime, Payroll, and Reports admin pages. Filter
  pills + month pickers + tab switches all use `useCallback` + `useEffect`
  with correct deps now — no more risk of a filter ignoring the most
  recent state in production.
- **Full regression pass.** 24/24 backend + 10/10 frontend tests pass.
  No behavioural regressions.

### 🧱 Refactor (zero user-visible change, big maintainability win)

Pre-launch tidy-up — splits the monolith files so each one can be opened,
read, and fixed without scrolling for a minute. The app behaves identically;
this just makes future bug fixes faster and safer.

- **Presence Board page** split into 7 focused files (was a single 924-line
  React file). The page logic stays in `Presence.jsx` (now 444 lines); the
  member card, column, session timeline, guest strip, geo line and
  skeleton-loader each live in their own file under `components/presence/`.
- **Backend helpers** moved into a new `services/` package — time/timezone,
  geo math, phone normalisation, photo thumbnailing, password + JWT,
  late/overtime/excursion computation. 81 unit tests cover these helpers
  with **97% line coverage**.
- **Leave + Reports routes** moved out of `server.py` into `routes/leaves.py`
  and `routes/reports.py` (same factory pattern as the existing camps,
  breaks, sms modules). `server.py` shrank from 4093 → 3611 lines.
- **9 critical-flow smoke tests** added (`tests/test_smoke_flows.py`) that
  exercise admin login → presence → muster check-in / check-out → leave
  filing + approval → reports CSV download. Runs in 1.8 s; the test
  whichever runs after every deploy.
- **Presence Board endpoint** got navigation banners (`# GATHER` → `# RESOLVE`
  → `# RENDER`) so the 440-line function is easier to read end-to-end.

### 🛠 Performance & hardening (code-review pass)

- **Faster Presence Board** — the bigger your absent list, the bigger the win:
  the "late-coming notice" lookup used to run one Mongo query per absent
  athlete; now it's a single batched read.
- **Faster phone login** — the matcher now uses an indexed last-10-digit
  field instead of scanning every user. Imperceptible at <500 members,
  pays off the day the academy grows.
- **Faster member imports** — the Excel/CSV import path does one bulk
  insert per file instead of one round-trip per row.
- **Backup safety** — `/admin/backup` and `/admin/restore` now stream rows
  in batches of 500 and use bulk-writes on restore, so the container won't
  OOM if attendance grows to tens of thousands of rows.
- **Background SMS** — Twilio sends are now offloaded to a worker thread,
  so a slow Twilio response no longer freezes other requests for everyone.
- **Image safety** — added a decompression-bomb guard so a malicious 50 KB
  PNG can't expand into multi-GB memory during thumbnail generation.
- **Smaller athlete bundle** — admin-only pages (Reports, Backup, Members,
  Calendar…) are now code-split and downloaded on demand, so athletes who
  only ever open Self Check-In get a smaller payload.
- **Quieter background tabs** — the Presence Board polls every 15 s only
  while the tab is visible. Hidden tabs pause and refresh on focus.

### 🧹 Removed (cleanup after QR retirement)

- Stale routes `POST /api/attendance/checkin`, `POST /api/attendance/checkout`,
  `POST /api/office/regenerate-qr`, and `POST /api/admin/snapshot/import`
  (a duplicate of `/admin/restore`) are gone. `qr_token` no longer appears
  in `/api/office`. The "Office master" QR card on `/admin/cards` is gone.
- Personal member QR cards stay — those are used by the proxy
  "scan-card" check-in flow and were never tied to the office QR.

### 🆕 New features

- **Fleet master** — new admin page at `/admin/fleets` (sidebar → **Fleets**).
  Create / edit / rename / archive boat classes. Renaming cascades to every
  athlete in that fleet and to any breaks that target the fleet. Includes a
  bulk "Assign athletes" modal so an admin can populate a fleet's roster
  with checkboxes instead of editing each athlete one-by-one.
- **Fleet field for athletes** — Manage Members → athlete edit form now has a
  Fleet dropdown sourced from the Fleet master (free-text fallback for legacy
  values). Used as filter pills on the Presence Board, surfaced inside the
  **Apply Break** form (new scope "One fleet" + filter chips when picking
  selected members), and visible throughout the app.
- **Apply Break in Leave/Tour admin** — the Leave/Tour page now has an
  "Apply break" button next to "Apply on behalf". Same modal as the Calendar,
  so admins don't need to leave the approvals flow to apply a rest day.
- **Daily Sessions merged into Presence Board** — Presence now has a date
  picker (with **‹ ›** prev/next-day arrows) so you can browse any past day,
  and every row has a chevron to expand an inline timeline (check-in →
  step-outs → returns → check-out → hours logged, with the auto-closed badge
  if midnight cron closed it). The separate Admin Console "Daily sessions"
  tile is retired; the old URL redirects.
- **Breaks & Holidays** — new collection + Calendar action "Apply break". Mark a
  day off for everyone, all athletes / coaches / staff, one institution, or a
  hand-picked group. Affected members render under the **Leave** column on the
  Presence Board with "On break · {name}" instead of being marked Absent. Backed
  by `/api/breaks` CRUD.
- **Calendar consolidation** — Camps menu item retired from the main sidebar;
  Camps and Breaks are now created from the Calendar page (`New camp`,
  `Apply break`, `New regatta` buttons). Day-detail modal shows all three.
- **Full data Backup & Restore** moved out of Admin Console into the main
  sidebar. The archive now contains **every** collection (members + photos,
  attendance, leaves, devices, camps, regattas, **breaks**, parent
  notifications, SMS log, etc.) so you can clone prod ↔ preview cleanly.
  Replace-mode is automatically blocked on production to prevent wipes.
- **Coming up this week** banner on the Admin Console — colored chips for any
  camp / break / regatta active or starting in the next 7 days, LIVE pill on
  in-progress events, tap to open the full calendar.
- **Monthly Attendance report** — new columns: Present · Leave · Tour ·
  Comp-Off · Absent · **Total accounted / Span**. Quick-pick chips for
  *This month*, *Last month*, *Last 7 days*. Break days fold into Leave; CSV
  and PDF exports updated to match.
- **Forgot-to-check-out SMS reminder** — daily cron at the office-local time
  set in Office Settings (default 20:00). Sends one SMS per member with an
  open session, idempotent via `reminder_sent_at`. Admins can also fire it
  manually via "Send now (test)".
- **Auto-checkout audit badge** — Daily Sessions admin page now shows an
  *Auto-closed* badge on rows that the midnight cron closed automatically,
  plus a new *Auto-closed* count card.
- **Parent fuzzy-match Excel import** (carried over from prior session, still
  awaiting end-to-end verification on the deployed site).

### ✨ UI polish

- **Admin Console retired** — Presence Board is now the admin landing page.
  The OT/comp-off pending banners now sit at the top of Presence (admin-only,
  auto-hide when empty); the "Coming up this week" strip is also on Presence
  (collapsible, default closed, visible to coaches too). The redundant
  summary cards are gone. `/admin` redirects to `/presence`.
- **Admin Console slimmed down** — removed the redundant "Today's Activity"
  feed (same info is now in the Presence Board's expandable timelines and
  the Approvals / Access Requests sidebar counters). Console now shows just
  the OT/Comp-off banners, the "Coming up this week" strip, and the summary
  cards.
- **Sidebar reshuffle** — "Approvals" renamed to **"Leave/Tour"** (clearer
  for non-tech staff). **Leave Balances** moved out of Admin Console into
  the main sidebar alongside Leave/Tour.
- **Admin Console** — "Import members" tile removed (was a one-time setup
  shortcut). Parent/Guardian Excel import moved to a small **"Import parents"**
  button on the Members page header where it lives alongside the data it edits.
- **Presence Board — context chips on every card**: how many step-outs the
  member did today (`N×`), how many more days left on leave/tour (`Nd more`),
  and how many consecutive days they've been absent (`Nd absent`, max 30-day
  lookback). Weekly-off days are skipped in the absent streak counter.
- **Presence Board cards** — institution chip moved off the name line so long
  names like "ESWA SURAGAJYOTHI" / "PREETHI KONDAKARI" no longer get clipped
  by the institution badge. Name + parent-phone icons sit on row 1; rank ·
  category · institution chip sit on row 2.
- **Members page** — Parents/Guardian column widened; full parent names like
  "SHIVA SHANKAR GUNDLANARUA" now display without truncation. When no parent
  name is set, compact **F / M / G** square badges show instead of the long
  "Father / Mother / Guardian" labels.
- **Coach menu order** — Muster Roll now sits above Presence in the sidebar.

### 🛠 Reports / data accuracy

- **Monthly Payroll restricted to staff & coaches** — athletes & executives
  don't draw a salary and are filtered out of `/api/reports/payroll`. Drops
  the listing from 132 rows to 41.
- **Leave Balances** is now **staff-only**. Athletes, coaches and executives
  don't consume a numeric leave quota, so they're hidden from the list (and
  the `/api/leave-balances` endpoint). Subtitle on the page clarifies the
  scope.
- Hours & Attendance now counts an **open** session (still checked-in, no
  check-out yet) as a Present day for today, so the afternoon report no longer
  looks like nobody showed up. Hours total still only includes closed sessions
  (correct), so totals stay accurate.

### 🔒 Safety guards

- Backup & Restore **Replace** mode is disabled on the production host with
  an amber notice — prevents accidentally wiping live data.

### 🏗 Plumbing

- New backend module `breaks.py` with `Break` model + helpers used in
  `presence()` to override member status.
- Presence pipeline now applies break overlay alongside the existing camp /
  leave overlays.

---

## Released

<!-- When you deploy, paste the Unreleased block here under a "## 2026-MM-DD"
     heading and clear the Unreleased section above. -->
