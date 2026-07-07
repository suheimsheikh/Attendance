# I Showed Up — Changelog

Append-only log of feature/bug shipments. PRD.md holds the static
problem statement + user personas; long-form change history lives here.

---

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
