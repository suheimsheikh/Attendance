# Changelog — I Showed Up

Each section lists what's in **preview** but hasn't been deployed yet, so you
can skim it before pressing Deploy. Once you redeploy, move that block under
the dated "Released" header at the bottom and reset the "Unreleased" section.

---

## 🚧 Unreleased — pending deploy to `i-showed-up.ychyderabad.com`

### 🪟 Final pre-launch polish (June 25, 2026)

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
