# I Showed Up — Changelog

Append-only log of feature/bug shipments. PRD.md holds the static
problem statement + user personas; long-form change history lives here.

---

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
