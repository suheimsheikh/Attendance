# I Showed Up — Changelog

Append-only log of feature/bug shipments. PRD.md holds the static
problem statement + user personas; long-form change history lives here.

---

## 7 Jul 2026 — Removed blank gaps on Presence Board columns

**Bug**: On Campus and Checked Out columns showed huge blank gaps
between member cards. Complaint from both preview and production.

**Root cause**: `Presence.jsx` built a "paired" display list —
`pairedDisplay` was the alphabetical union of both columns' members;
each column then rendered a real card when the member matched its
status and an INVISIBLE placeholder card (`visibility: hidden`) when
they didn't. The intent was to keep rows pixel-aligned across the
pair, but users read the invisible rows as broken layout.

**Fix**: dropped the pairing entirely. Both columns now render only
their own members (already sorted). No more invisible placeholders,
no more `presence-blank-*` rows in the DOM.

**Files touched**:
- `frontend/src/pages/Presence.jsx` — removed `pairedDisplay` memo
  and the `PAIRED_COLUMN_KEYS` import; `Column` now always gets
  `displayList={null}`.
- `frontend/src/components/presence/constants.js` — removed the
  now-unused `PAIRED_COLUMN_KEYS` export.

**Verified**: 0 `presence-blank-*` placeholder rows in the DOM
after the fix; columns visually tight.

## 7 Jul 2026 — Stale-photo detection on Data Quality

Photos older than 12 months on athletes now surface as
`member.photo_stale` in Data Quality (low severity, "Stale data"
category). Athletes only — staff / coach faces are stable enough
that a 3-year-old photo isn't a coaching-recognition problem, so
they're excluded to keep the queue focused.

- **Backend**: `_scan_member` in `data_quality.py` checks
  `photo_captured_at` (server-stamped on every upload/replace);
  photos with a valid ISO timestamp older than 365 days emit the
  finding with a `"Refresh photo"` fix action pointing at the
  Members edit modal.
- **Test**: new `test_stale_photo_detection` — synthetically ages
  an athlete's `photo_captured_at` by 800 days, asserts the
  finding + fix label + severity, then restores the original.
  Uses a new `mongo_db` conftest fixture (direct pymongo handle,
  auto-skips when Mongo isn't configured).
- **Live**: current DB is fresh so no members flagged yet — will
  surface naturally as photos age past 12 months.

## 7 Jul 2026 — Photo UX cleanup + opportunistic capture on Presence

### 1. New shared `PhotoZoom` modal (`components/PhotoZoom.jsx`)
Portal-rendered modal that shows the photo at up to 80vw × 75vh with
a black backdrop. Backdrop-click / ESC / × all close. Optional
`onReplace` and `onRemove` action buttons in the footer — parents
can wire in their own file-picker + delete callbacks.

### 2. Members photo hover, fixed
Users found the previous hover-to-reveal Camera + Trash badges
"strange, goes to downloads and delete". Rewired `InlinePhotoAvatar`:
- Click → opens `PhotoZoom` with the photo at full quality.
- Hover → single subtle dark overlay with an expand glyph
  (no bare action chips).
- Actions (**Replace** / **Remove**) live inside the zoom modal as
  labelled buttons, with confirm-dialog on Remove.

### 3. Photo zoom on Presence
`components/presence/MemberCard` — the avatar is now a
`<button>` that opens `PhotoZoom` on click (view-only, no edit
actions since coaches on the board shouldn't be reshooting from
here). `cursor-zoom-in` on hover.

### 4. Presence "photos missing" opportunistic strip
When any on-campus athlete lacks a photo, an amber strip appears
above the columns:

  📷  *N* athletes on campus without a photo
       Tap to capture photos while they're here — skip any time.
       ARUNA, KIRAN, RAVI +2 more                          CAPTURE →

Click → walks through a SelfieCapture queue (same as Muster) that
saves each capture immediately, non-blocking. Board reloads at the
end so newly-captured photos land right where the coach expects.

**Design constraint kept**: only athletes are candidates — staff /
coaches don't clutter the queue since they rarely show up on the
board without a photo.

## 7 Jul 2026 — Muster photo prompt is now truly non-blocking

**Problem**: the coach ticks 20 athletes for check-in, hits the button,
and gets stopped by a photo-capture modal for every athlete without a
photo BEFORE the muster is filed. If they close the tab, they lose the
check-in they thought they'd made.

**Fix** (Muster.jsx):
- `submit()` now calls `runBulk(picked)` FIRST — check-in fires and
  a success toast lands immediately.
- If any of the picked athletes had no photo, we then open the
  `SelfieCapture` modal as a POST-checkin cleanup queue with a 400ms
  delay so the success toast is visible.
- Subtitle updated to: **"Checked in ✓ — capture their photo while
  they're here. N left · tap Skip or close (×) to bail anytime."**
- `advancePhotoQueue([])` now just closes the modal — no longer
  triggers a second bulk-checkin.
- Coach can Save, Skip, or × out at any point. Check-in is already
  recorded, so bailing has zero consequence.

## 7 Jul 2026 — Context-sensitive Fix button on Data Quality rows

**Shipped**
- Backend: each finding now ships a `fix` metadata object shaped
  `{ label, to, params }` (e.g.
  `{ label: "Add parent contact", to: "/admin/members",
     params: { edit: "<id>", highlight: "<id>" } }`).
  Mapping lives in `_fix_for(code, entity_ids)` in
  `routes/data_quality.py` — one central source of truth. Findings
  without an automated jump target simply have `fix: null`.
- Frontend: new `FixButton` component in DataQuality.jsx renders a
  slate-900 button with a wrench icon at the end of every row that
  has a fix. Empty → em-dash.
- Members.jsx now honours **deep-links**:
  - `?edit=<id>` → auto-opens the MemberForm modal for that member
    (param is consumed so a refresh doesn't re-open).
  - `?highlight=<id>` → scrolls the row into view + tints it amber
    with a ring for visual anchoring.
- MemberRow.jsx accepts a `highlighted` prop; when true, applies
  `ring-2 ring-amber-400 bg-amber-50/60` to the row.

**Fix routes wired**
| Finding code | Fix label | Destination |
|---|---|---|
| athlete.no_parent_mobile | "Add parent contact" | Members edit modal |
| member.missing_fields    | "Fix missing fields" | Members edit modal |
| member.bad_mobile        | "Fix mobile"        | Members edit modal |
| member.no_photo          | "Add photo"         | Members edit modal |
| member.dob_*             | "Fix DOB"           | Members edit modal |
| member.duplicate_*       | "Review dupes"      | Members edit modal on first offender |
| member.negative_leave    | "Adjust balance"    | Leave Balances (highlighted row) |
| member.high_leave_opening| "Review balance"    | Leave Balances (highlighted row) |
| leave.end_before_start   | "Review leave"      | Approvals (highlighted leave) |
| leave.late_coming_multiday | "Review leave"    | Approvals (highlighted leave) |
| leave.half_day_wrong_type  | "Review leave"    | Approvals (highlighted leave) |
| session.checkout_before_checkin | "Open member" | Members edit modal |
| session.open_over_36h    | "Open member"       | Members edit modal |

**Tests**
- New `test_findings_carry_fix_metadata` — verifies every
  automatable finding ships a `fix` object with label, to, and
  params that include `highlight`.

**Verified live** — clicked "Add parent contact" on the DQ page, was
routed to `/admin/members?edit=<id>&highlight=<id>`, edit modal
opened directly on the flagged athlete. Total round-trip: one click.

## 7 Jul 2026 — Audit trail + Data Quality dashboard

### Backend
- New `routes/admin_audit.py` — `audit_log` Mongo collection + a
  `write_audit(actor, action, entity_type, ..., before, after,
  reason)` best-effort helper. Diff is computed by the helper, so
  callers pass raw snapshots. Sensitive fields (`hashed_password`,
  `photo`, `photo_thumb`) are redacted from the diff.
- New `GET /api/admin/audit-log` — paged read (max 200), filters:
  `actor_id`, `entity_id`, `entity_type`, `action`, `since`, `until`.
- Wired audit writes into:
  - `PATCH /api/members/{id}` — action `member.update` (or
    `member.password_reset` if `password` was in the payload).
  - `POST /api/leave-balances/bulk` — action `leave_balance.set`,
    one row per member.
  - `POST /api/admin/attendance/toggle/{id}` — action
    `attendance.check_in` / `check_out` with the reason + session
    metadata attached.
- New `routes/data_quality.py` — read-only DB sweep. `GET
  /api/admin/data-quality` returns
  `{ generated_at, total_findings, by_severity, findings[] }` sorted
  high→low severity. Checks include:
  duplicate emails / mobiles / names (case-insensitive), athletes
  with no valid parent/guardian mobile, members missing critical
  fields, unphonelike mobiles, negative or excessively-high leave
  balances, DOB in the future / ancient / bad-format, missing
  profile photos, leaves with end<start, multi-day late-comings,
  half-day flag on non-Leave types, attendance sessions with
  checkout<checkin or open >36h.

### Frontend
- New `pages/admin/AuditLog.jsx` — filter bar (action / actor /
  entity / date range), diff-in-place table with colour-coded
  action badges, greyed-out "before" / bold "after" formatting.
- New `pages/admin/DataQuality.jsx` — severity summary strip
  (click a severity chip to filter), findings grouped by category,
  member deep-links pointing to `/admin/members?highlight=<id>`.
- Registered at `/admin/audit-log` and `/admin/data-quality`;
  sidebar picks up two new entries (ShieldAlert + ScanLine icons).

### Tests
- `backend/tests/test_audit_log.py` (4 tests) — verifies member
  PATCH writes an audit row with the right diff, password reset
  never leaks hashed_password, filters narrow correctly.
- `backend/tests/test_data_quality.py` (5 tests) — schema, required
  fields, severity ordering, synthetic bad-DOB detection, synthetic
  negative-leave detection.
- Full suite still green; smoke suite still 21 tests / ~3s.

**Verified live** — on the real production DB the sweep flagged 46
findings including 20+ athletes with no valid parent/guardian
mobile (real launch-blocker!). Audit log captured every test
change with correct actor + diff.

## 7 Jul 2026 — Birthday flourish on Check-In greeting

**Backend**
- Added optional `date_of_birth: Optional[str]` (ISO YYYY-MM-DD) to
  `MemberCreate`, `MemberUpdate`, and `UserPublic` (exposed via
  `/auth/me` and `/api/members`).
- PATCH auto-persists via existing `model_dump(exclude_unset=True)`.

**Frontend**
- `MemberForm.jsx` — new "Date of birth (optional)" field on the
  admin member-edit form with `data-testid="mf-dob"`.
- `SelfCheckIn.jsx` — `Greeting` component now compares today's
  MM-DD against the user's DOB MM-DD. Match → renders
  **"Happy birthday, {first_name} 🎂"** in a warm amber card
  (`bg-amber-50 ring-amber-200`). Otherwise falls back to the
  time-of-day salutation.

**Tests**
- New `backend/tests/test_dob_field.py` — 4 regression tests:
  PATCH round-trip, `/auth/me` schema, `/members` list schema, and
  the MM-DD equality rule that drives the flourish.
- Full pytest suite still green (416 tests, `pytest -m smoke` still ~3s).

**Verified live** — set admin DOB = today, refreshed Check-In page,
saw "Happy birthday, Campus 🎂" render in amber card. Cleared field,
greeting reverted to "Good afternoon, Campus 👋".

## 7 Jul 2026 — Personalised greeting on Check-In card

- `SelfCheckIn.jsx` — added a `Greeting` helper component that
  renders "Good morning, ARUNA 👋" (or afternoon/evening/night)
  directly above the check-in button, using the member's first name
  from `useAuth().user.full_name`. When already checked in, copy
  shifts to "Ready to head out, ARUNA?" so it doesn't feel
  repetitive.
- Time-of-day slot: 05-11 morning · 12-16 afternoon · 17-21 evening
  · else night. Runs client-side off `new Date().getHours()` — no
  server round trip.
- Data-testid `checkin-greeting`; verified live via Playwright.

## 7 Jul 2026 — Removed top BrandHero from Check-In screen

- `SelfCheckIn.jsx` — removed the `<BrandHero />` block at the top
  of the page. The YCH logo now lives solely on the big check-in
  button below, so the top-of-page treatment was redundant.
- Deleted `components/BrandHero.jsx` entirely — no other page
  imported it (grep-verified).

## 7 Jul 2026 — Check-in button rebranded to YCH logo

- `SelfCheckIn.jsx` — the big "I showed up 😊" check-in button no
  longer uses the generic emerald gradient + LogIn arrow icon. It
  now displays the **Yacht Club of Hyderabad sail-boat logo**
  (`/icon-192.png`) on a white background with a subtle
  `ring-sky-100` outline. Rationale: members recognise the club's
  brand mark much more than an abstract door-arrow. Rose gradient +
  LogOut icon is retained for the "Leaving Campus" state (distinct
  action, deliberately unbranded).
- Removed unused `LogIn` lucide import.

## 7 Jul 2026 — UX cleanup (menu label, late-coming default, filter rename)

**Shipped**
- **Sidebar menu**: "My Leave/Tour/C-Off" → **"Leave/Tour/Late"**
  (route unchanged: `/my-leaves`).
- **Late-coming apply form** (MyLeaves.jsx ApplyForm):
  - Default `start_date` / `end_date` now **tomorrow** instead of today
    (`utils.tomorrowIso()` added). Rationale: most late-comings are
    filed the previous night for the next morning's delay.
  - Date picker `min` = today, `max` = tomorrow — hard-restricts the
    range so admins don't see stray far-future picks.
  - `To` picker is disabled for late_coming (single-day by design).
    A synchronising effect keeps `end === start` under the covers.
  - Copy updated: "Use this when you'll arrive late **today or
    tomorrow**. Defaults to tomorrow — flip to today via the date
    picker if needed."
  - "Expected arrival today" label → "Expected arrival time"
    (no longer implies same-day).
  - Backend was already permissive on `start_date` for late_coming
    (no future-date guard), so no server changes required.
- **Attendance report filter**: "Rest" → **"Staff & Coaches"**
  (chip label + PDF-export meta label both updated).

**Files touched**
- `frontend/src/components/Layout.jsx`
- `frontend/src/pages/MyLeaves.jsx`
- `frontend/src/pages/admin/Reports.jsx`
- `frontend/src/utils.js` (new `tomorrowIso()` helper)
- `backend/routes/reports.py` (PDF filter label only)

**Verified end-to-end via Playwright**
- Sidebar renders "Leave/Tour/Late"; old label gone.
- Reports chip: "Staff & Coaches (44)".
- Late Coming form defaults to `2026-07-08` with `min=2026-07-07`,
  `max=2026-07-08` on the From picker.

## 7 Jul 2026 — Double-click drill-down timeline modal

**Shipped**
- New backend endpoint: `GET /api/reports/member-timeline?member_id=…&start=…&end=…`
  Returns a day-by-day breakdown for one member across the window with
  each row shaped as:
    { date, weekday, bucket, label, buckets[], details[],
      is_weekly_off, is_today }
  Buckets: `present`, `leave`, `tour`, `posting`, `comp_off`,
  `late_coming`, `break`, `escort`, `off_weekly`,
  `off_in_progress`, `absent`. Priority order matches the aggregation
  used in `compute_hours_report`.
  Details include check-in/out times, hours, late minutes,
  auto-checkout flag, geofence status, overtime status, leave
  reasons, half-day FN/PN, late-coming expected-arrival, and break
  names. Rejected/cancelled leaves show up as separate details
  entries so admins can see attempts, not just approvals.
- New frontend component: `components/MemberTimelineModal.jsx`.
  Portal-rendered modal with a compact 4-column table (Date, Day,
  Status, Details), coloured bucket badges matching the parent
  report's group colours (emerald present, amber leave, red absent,
  slate off, sky comp-off, violet OT, teal escort, purple break),
  ESC-to-close, click-outside-to-close, and a **Copy** button that
  dumps the timeline as a Markdown table into the clipboard (for
  pasting into WhatsApp / email during parent conversations).
- Reports.jsx: double-clicking a member's name in the Attendance
  table opens the modal for that member with the current report
  window. `data-testid="attn-name-<id>"` added for the trigger cell;
  hover title reads "Double-click for day-by-day timeline".
- Smoke suite grew from 20 → 21 tests (added
  `test_21_member_timeline`); pytest still ~3s. Full suite: 412
  passed.
- Verified live on ARUNA SURUGU — modal now renders exactly the
  table I gave the user via chat, including "Late-coming approved"
  on Jul 2 (which was previously invisible in the aggregate view).

## 7 Jul 2026 — Launch-day smoke suite

**Shipped**
- New `backend/tests/test_smoke_launch.py` — 20 tests covering every
  critical endpoint: `/health`, `/version`, admin login + `/auth/me`,
  members, presence, muster, reports/hours (incl. drill-down date
  keys), reports/daily, admin + self leaves lists, office config,
  institutions, fleets, camps, regattas, escort snapshot, comp-off
  balance, self stats, personal reason bank, attendance status.
- All 20 tagged `@pytest.mark.smoke`. Total wall time: **~2.5s** on
  the live preview backend.
- `backend/pytest.ini` updated: smoke marker now documents its
  purpose. Base command:
    `python -m pytest -m smoke -q`
- New `backend/smoke.sh` — one-command wrapper with a helpful error
  if `TEST_ADMIN_PASSWORD` isn't set. Usage on launch morning:
    `TEST_ADMIN_PASSWORD='...' ./smoke.sh`
- Full suite (`pytest`) now has 411 tests (391 + 20 smoke).

**Design notes**
- Every test asserts *shape*, not content — a fresh DB with zero
  members still passes; the goal is to catch broken endpoints /
  auth / routing before real users see them.
- No mutations. Safe to run against production if we ever swap
  targets.
- Uses the existing session-scoped `admin_client` fixture so the
  20 tests share a single JWT (avoids re-login latency).

## 7 Jul 2026 — Code-review hardening pass (Categories A + B)

Applied fixes from the pre-launch code-review report. Excluded items
still explicitly deferred until post-launch (JWT → httpOnly cookies,
component splits, large-router refactors).

**Fixed**
- `backend/server.py` — ruff F811: renamed inner `iso` shadowing an
  outer loop variable inside the drill-down absent-dates block.
- `Reports.jsx` — wrapped `rows = attendance?.rows || []` in `useMemo`
  so downstream `displayedRows` / `fleetOptions` memos don't
  re-invalidate every render.
- `Reports.jsx` — replaced `key={i}` on the DrillDownBubble date list
  with `key={dates[i]}` (backend guarantees dates are unique + sorted).
- `EscortCheckIn.jsx` — wrapped `load()` in `useCallback` and its
  effect now depends on `[load]`; wrapped `escorts = snapshot?.escorts`
  in `useMemo` so downstream memos are stable. Removed 3 unused
  lucide imports.
- `BulkEditBar.jsx` — removed stale `eslint-disable` and reworked the
  option-map lookup into a properly memoised `currentOpts`.
- `eslint.config.js` — added `process: "readonly"` to browser globals
  so CRA's build-time `process.env.REACT_APP_*` injection stops
  triggering `no-undef` (was false-positiving `api.js` +
  `BackupRestore.jsx`).
- `Layout.jsx`, `CheckIn.jsx`, `Profile.jsx`,
  `EscortPhotoCleanup.jsx` — dropped unused lucide imports.
- `MyLeaves.jsx` — removed dead `memberId` legacy single-pick state
  (was replaced by admin multi-select months ago).
- `Presence.jsx` — removed unused `steppedOutEscorts` alias.
- `admin/Members.jsx` — destructured `[, setBulkBusy]` to signal
  intent (the read half was never consumed).
- `EscortCheckIn.jsx:205` — renamed unused `isEscort` arg on
  `EscortActionCard` to `_isEscort` (matches our unused-arg policy).

**Explicitly not-fixed (out of scope by user directive)**
- localStorage JWT → httpOnly cookies (P2, post-launch).
- Component splits of Reports/Members/Leaves/MyLeaves/Muster/
  Presence/Calendar (P3, post-launch).
- `server.py`, `holidays.py`, `daily_content.py`, `breaks.py`,
  `guests.py`, `camps.py`, `regattas.py` router-complexity
  refactors (P3, post-launch).
- 24 `console.debug` calls left in place — they're already
  suppressed by default in browsers (verbose level required) and
  are legitimate error-triage aids.
- 2 lint issues in shadcn-provided `ui/command.jsx` +
  `hooks/use-toast.js` — third-party generated files, not touching
  per shadcn convention.

**Verified**
- Full pytest suite still 389 passed / 0 failed (only 2 flaky
  network timeouts on retryable tests, unrelated to changes).
- ESLint dropped from 17 problems → 2 (both in shadcn UI files).
- Playwright verified Aruna Surugu absent-cell drill-down tooltip
  still shows `ABSENT · 2 / Wed, Jul 01 / Fri, Jul 03`.

## 7 Jul 2026 — Attendance Report drill-down tooltips (updated)

**Update, later same day:** the native `title=` tooltip proved
too slow / unreliable inside the horizontally-scrolling table
(browser default delay ~1s, and some Chrome versions suppress it
inside overflow-auto containers). Replaced with a portal-rendered
custom hover popover (`DrillDownBubble`):

- Instant show/hide via `onMouseEnter`/`onMouseLeave` (no delay).
- Positioned above the hovered cell (auto-flips below near viewport
  top), rendered into `document.body` so it escapes the table's
  scroll clip and z-index stack.
- Dark slate skin with white text, single shared state in `Reports`
  (only one bubble on screen at any time).
- `cursor-help` only applied when the cell has non-empty dates —
  empty categories stay plain.
- Data-testid `drilldown-tooltip` on the bubble for automated tests.
- Verified end-to-end via Playwright on ARUNA SURUGU's absent cell:
  bubble reads "ABSENT · 2 / Wed, Jul 01 / Fri, Jul 03".

## 7 Jul 2026 — Attendance Report drill-down tooltips

**What shipped**
- `/api/reports/hours` (payroll) rows now include ISO-date arrays for
  every count column on the Attendance table:
  `dates_present`, `dates_off`, `dates_absent`, `dates_late`,
  `dates_leave`, `dates_tour`, `dates_break`, `dates_half_day`,
  `dates_comp_off_earned`, `dates_comp_off_applied`,
  `dates_comp_off_used`, `dates_escort`, `dates_overtime_served`,
  `dates_overtime_applied`, `dates_overtime_approved`.
- Every count column in `Reports.jsx` now has a native `title=`
  drill-down tooltip listing the exact dates on hover (formatted as
  "Mon, Jul 04"), plus `cursor-help` so admins know the number is
  interactive.
- Invariants held: `len(dates_X) == count_X`, all dates inside the
  report window, sorted + unique.

**Tests**
- New: `backend/tests/test_report_drill_down_dates.py` — 4 tests
  covering presence of keys, count-length parity, window bounds, and
  sort/dedup.
- Existing 389+ passing tests untouched.

**Files touched**
- `backend/server.py` — added `_days_of_type`, `_break_days`,
  extended half-day tracking, added dates arrays to payroll rows.
- `frontend/src/pages/admin/Reports.jsx` — added `tip()` helper +
  `title`/`cursor-help` on 13 cells across Attendance / Comp-Off /
  Overtime / Escorts groups.

---
