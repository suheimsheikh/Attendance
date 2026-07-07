# I Showed Up — Changelog

Append-only log of feature/bug shipments. PRD.md holds the static
problem statement + user personas; long-form change history lives here.

---

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
