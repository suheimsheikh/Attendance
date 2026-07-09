# I Showed Up — Changelog

Append-only log of feature/bug shipments. PRD.md holds the static
problem statement + user personas; long-form change history lives here.

---
## 9 Feb 2026 — Code Quality Report P0 + Members icon reshuffle

**User request:** Apply the code-review fixes in priority order
(1. Backend circular import, 2. Hardcoded secret) AND move the
pencil-ruler "file correction" icon to the extreme-left of Members.

### 1. Backend circular import ✅ (P0)
`routes/reports.py` and `routes/auth.py` were both doing lazy inline
`from server import is_super_admin` inside handlers — the classic
"we-know-there-is-a-cycle" pattern that leaves module init order
fragile. Extracted `is_super_admin` + `_SUPER_ADMIN_PHONES` into a new
`services/permissions.py`. Both routers now import it at module top
level. `server.py` re-exports the same names for backwards-compat with
tests that reach for `server.is_super_admin`. No behaviour change.

Files touched:
- `backend/services/permissions.py` — new (33 lines)
- `backend/server.py` — line-172 block replaced with a 3-line
  `from services.permissions import ...` re-export.
- `backend/routes/reports.py` — lazy import removed; top-level import.
- `backend/routes/auth.py` — lazy import + try/except removed.

Verified via curl: `/api/auth/me` returns `is_super_admin: false` for
the standard admin, `/api/reports/hours` returns 137 rows without
`avg_hours` for non-super admins (Hours group gated). Targeted pytest
suite (test_reports_gating_and_ledger + smoke + ui_prefs +
roles_and_admin_corrections) — **44/44 GREEN**.

### 2. Hardcoded-secret false positive in test_smoke_launch.py ✅ (P0)
The line-4 scanner hit was a docstring showing
`TEST_ADMIN_PASSWORD='<your-admin-password>'` as a usage example — the
`<…>` was a placeholder, not a real password. Rewrote the docstring to
just say `Run:  python -m pytest -m smoke -q` and clarified that
credentials come from `TEST_ADMIN_EMAIL` / `TEST_ADMIN_PASSWORD` env
vars via `conftest.py`. Scanners will no longer flag the file.

### 3. Members table — file-correction icon moved to extreme left
Was buried in the right-most "Del" column alongside Delete. Now sits
right next to the Edit pencil in the sticky-left Edit column (which
was widened from `w-10` to `w-16` to fit both). The Del column now
only holds Delete. Column tooltip updated to explain both actions.
- `frontend/src/pages/admin/members/MemberRow.jsx` — merged the two
  icons into the sticky-left `td`.
- `frontend/src/pages/admin/Members.jsx` — `COL_HELP.edit` updated
  and the `<th>` widened.

### 4. Cleanup — dead vars removed
`otApplied` / `otApproved` in `Reports.jsx` were leftovers from the
OT-consolidation ship (line 508-509). Removed. ESLint back to clean
across the frontend.

### 5. P1 hook-deps scan
Ran `react-hooks/exhaustive-deps` across the six files flagged in the
Code Quality Report (`ParentInlineInput.jsx`, `SmsLog.jsx`, `Sites.jsx`,
`Sessions.jsx`, `Roles.jsx`, `Reports.jsx`). **0 warnings** — the report
was based on a stale snapshot from before the 25 Jun 2026 hook cleanup.
Documented as skipped for this pass.


---
## 4 Feb 2026 — Reports overhaul: OT/CO consolidation + super-admin
gating + Attendance drill-down + Ledger PDF downloads

**User requests bundled in this ship:**
1. "OT Served/Applied/Approved needs to be replaced with only OT
   which is the system calculated OT (=served). Same with Comp-off."
2. "Double-click on the attendance columns should show a table with
   the month's data of the said member date wise clearly indicating
   tour and leave and absent etc."
3. "Total hours and average hours should be visible only to me as
   super admin login 9849002111."
4. (Pot improv) "PDF button on Comp-Off Ledger and Leave Ledger
   modals — same style as OT Ledger."

**Backend:**
- `is_super_admin(user)` helper (`server.py`) — checks `mobile`
  against env whitelist `SUPER_ADMIN_PHONES` (default
  `"9849002111"`). Stamped onto `/auth/me` response as
  `is_super_admin: true|false`.
- `models.UserPublic` — new nullable `is_super_admin` field so the
  flag round-trips through the response model.
- `/api/reports/hours/export` — checks `is_super_admin`; strips
  the Hours group (Total h + Avg h columns + grouped-header span)
  for regular admins. Result: 17-col table for admins, 19-col
  table for super admins.
- `/api/reports/attendance-ledger?member_id=X&start=Y&end=Z` —
  new endpoint returning one row per calendar day with `status`
  bucketed as Present / Late / Half day / Leave / Tour / Posting /
  Comp-off / Weekly off / Holiday / Absent. Uses each member's
  configured `weekly_off` (falls back to office default) + the
  holidays master to classify non-attendance days.
- `/api/reports/comp-off-ledger/export` + `/api/reports/leave-ledger/export`
  — PDF/CSV mirrors of the on-screen modals with totals row and
  meta block (same pattern as OT-ledger export shipped earlier
  today).

**Frontend:**
- `Reports.jsx` — Overtime group span 3→1, Comp-Off group span 3→1;
  8-cell OT/CO removed; single bold OT/CO cells. Table minWidth
  1300→1100 px. Hours group header + sub-headers + tds gated on
  `useAuth().user.is_super_admin`. Empty-state colSpan now
  computed dynamically (17 or 19).
- All 8 attendance cells (Pres/Lv/Tour/Off/Late/Half/Abs/Tot) get
  `onDoubleClick` handlers opening the new AttendanceLedgerModal
  scoped to the current report window.
- New `AttendanceLedgerModal.jsx` — read-only drill-down showing
  colored status chips summary + date-wise table.
- `CompOffLedgerModal.jsx` + `LeaveLedgerModal.jsx` — new PDF
  download button in the header (same style as OT Ledger).

**Tests:**
- New: `tests/test_reports_gating_and_ledger.py` (5 tests) covers
  17-col default export, `is_super_admin=false` for default admin,
  attendance-ledger daily rows + range validation.
- Updated: `test_routes_reports.py`, `test_smoke_flows.py`,
  `test_review_iter3.py` to expect the new single-OT/CO shape.
- 27/27 relevant regression tests pass.

**Verified:**
- 4-state end-to-end curl: default admin gets 17 cols, super admin
  (mobile=9849002111) gets 19, reset back to 17. Behavior lint-clean.
- UI screenshot of AttendanceLedgerModal on ABHIRAM shows 9-day
  window with Monday correctly marked "Weekly off".

---


## 4 Feb 2026 — OT Ledger download-as-PDF

Small but useful — admins can now hand a member a printable copy of
their yearly OT ledger for disputes/clarifications.

**Added:**
- `GET /api/reports/ot-ledger/export?member_id=X&year=Y&fmt=pdf`
  (also `fmt=csv`). Reuses the same query as `/ot-ledger` so the
  PDF can never drift from the modal.
- 9-column table mirroring the on-screen modal exactly: Date (dd/
  mm/yyyy), Check-in, Check-out, Early Arrival, Late Departures,
  Total, Early reason, Late reason, Status. Totals row appended
  at the bottom summing all three minute columns.
- Landscape A4, meta block includes Academy, Member, Category,
  Year, Sessions, Total OT, Generated by.
- New "PDF" button in the OT Ledger modal header (only shown when
  `rows.length > 0` — no button on empty ledgers).

**Files:**
- Backend: `routes/reports.py` (`export_ot_ledger`).
- Frontend: `pages/admin/OTLedgerModal.jsx` (button + download-blob
  helper).

**Verified:**
- CSV output for AINUL HAQUE renders as:
  `Date,Check-in,Check-out,Early Arrival,Late Departures,Total,...`
  followed by data row and Totals row (all correct).
- PDF structural analysis: title, meta block (7 fields), 9-column
  table, Totals row — 100% match with acceptance criteria.
- Live UI screenshot confirms the download button next to the
  close icon.
- 21/21 relevant regression tests pass. Lint clean.

---


## 4 Feb 2026 — OT Ledger polish

Small readability pass on the OT Ledger modal (opens on double-click
of any OT cell in the Attendance report).

**Changed (all user-requested):**
- `Early` → **Early Arrival**, `Late` → **Late Departures**. Tooltips
  on both headers explain what the minutes represent (minutes credited
  for arriving before / staying past scheduled work times).
- Date column now renders `dd/mm/yyyy` (matches the rest of the
  Reports PDF output). Old `YYYY-MM-DD` format was hard to scan.
- Split the old `Session` column into two dedicated columns —
  **Check-in** and **Check-out**. Session was just "check-in – check-out"
  crammed into one cell; the two-column form is clearer and matches
  the terminology used elsewhere in the app.
- New **Totals** row at the bottom sums Early Arrival minutes, Late
  Departures minutes, and Total across every session shown. Sticky
  at the bottom of the scroll area so long ledgers stay easy to read.

**Files:**
- `frontend/src/pages/admin/OTLedgerModal.jsx` — headers, date fmt,
  session split, totals row + `fmtDDMMYYYY` helper.

**Verified:**
- UI screenshot on AINUL HAQUE (1 session, 1h 31m early arrival)
  confirms every change: `02/07/2026 · 02:29 · 12:32 · 1h 31m · — · 1h 31m`
  data row + `Totals · 1h 31m · — · 1h 31m` footer row.
- Lint clean.

---


## 4 Feb 2026 — Reports: Escort columns removed + PDF/CSV mirror screen

**User requests:**
1. "Attendance reports under Reports need not contain the last two
   columns on Escorts (Not sure why they are there)."
2. "The PDF when printed should be exactly the same as what's on
   screen including filters."

**Fixed:**
- Removed the `Escorts` grouped header and its two sub-columns
  (`Dut` = escort days, `Ovr` = overstays) from the on-screen
  attendance table. The table minWidth trimmed from 1420 → 1300 px
  to reclaim the space. Empty-state colspan updated 25 → 23.
- Rewrote the PDF/CSV export at `/api/reports/hours/export` so the
  output is a 1:1 mirror of the on-screen table:
  - 21 columns matching the on-screen sub-headers exactly:
    Member, Cat, Pres/Lv/Tour/Off/Late/Half/Abs/Tot,
    Open/COff/Total/Avld/Close, OT Srvd/Appl/Apprv,
    CO Srvd/Appl/Apprv, Tot h/Avg h.
  - Grouped super-header row (Attendance/Leave/Overtime/Comp-Off/
    Hours) with matching pastel tints (emerald/amber/violet/sky/
    indigo) — same visual chunking as the screen.
  - Meta block now shows every active filter: Category, Fleet,
    Institution. Was previously Category + Fleet only.
  - Landscape A3 (was A4) so the 21 columns fit without clipping
    the Member name column. 7pt body font for the wide grid.
- Backend endpoint now accepts `institution` query param and
  handles the `elite` category chip as a distinct filter (the
  Reports.jsx UI has them client-side too).
- Frontend `exportAttendance` sends institution + category (incl.
  elite) to the endpoint so the PDF matches the on-screen chips.

**Helper upgrade:**
- `_pdf_from_table()` gained three optional params: `grouped_
  headers` (list of `(label, span, tint_hex)` tuples for the super-
  header row), `pagesize_override` (for A3), and `font_size`.
  Legacy calls (daily leave export) unchanged.

**Tests refreshed:**
- 5 legacy tests that hardcoded the OLD column headers ("Name",
  "Category", "OT Hrs", "Attendance %") were updated to the new
  contract ("Member", "Cat", "OT Apprv", grouped headers).
- 23/23 relevant tests pass (5 updated + 18 prior).

**Files:**
- Backend: `routes/reports.py` (`_pdf_from_table`, `export_hours`).
- Frontend: `pages/admin/Reports.jsx` (escort cols removed, all 3
  filters sent to export).
- Tests: `test_ishowedup_api.py`, `test_review_iter3.py`,
  `test_routes_reports.py`, `test_smoke_flows.py`.

**Verified:**
- PDF structure analyzer confirms grouped super-headers, 21 sub-
  headers matching screen, no Escort columns, all filter meta.
- UI screenshot: on-screen table shows Attendance/Leave/Overtime/
  Comp-Off groups only, Escorts group gone.
- Lint clean on both changed files.

---


## 4 Feb 2026 — Per-user UI preferences (cross-device sync)

Follow-on to the collapsible sidebar. Sidebar collapse (and any
future UI toggle) now syncs across every device the admin logs in
from — no more re-collapsing MASTERS/SYSTEM on the phone every
time.

**Added:**
- `GET  /api/me/ui-prefs` — returns the current user's prefs blob
  (`{}` when unset).
- `PATCH /api/me/ui-prefs` — merge-patches; null values un-set a
  key; 4 KB size cap enforced with 413.
- `frontend/src/hooks/useUiPrefs.js` — shared hook. Optimistic
  local apply + localStorage cache + debounced (400 ms) server
  flush. Server load on mount is the cross-device truth; falls
  back gracefully when unauth / offline.
- Layout.jsx sidebar collapse now backed by useUiPrefs (was raw
  localStorage). Same UX, now cross-device.

**Verified:**
- 6/6 new pytest tests (`test_ui_prefs.py`) + 12 previous role/
  correction tests → 18/18 pass.
- End-to-end UI: collapsed MASTERS + SYSTEM, waited for debounce,
  cleared localStorage entirely, hard-reloaded → sidebar came back
  with both sections collapsed (`aria-expanded="false"` verified).
  Proves the state is loaded from the server, not the browser cache.
- Lint clean on all 3 touched files.

**Files:**
- Backend new: `routes/prefs.py`, `tests/test_ui_prefs.py`.
- Backend changed: `server.py` (router registration).
- Frontend new: `hooks/useUiPrefs.js`.
- Frontend changed: `components/Layout.jsx` (adopt hook).

---


## 4 Feb 2026 — Independent sidebar scroll + collapsible sections

**Independent scrolling:**
- Wrapper changed from `min-h-screen flex` → `h-screen overflow-hidden flex`;
  sidebar and main both get `h-screen`. Result: sidebar stays fully
  anchored (user avatar + Sign out always visible at the bottom)
  while the main content scrolls independently.
- Mobile header stops using `sticky top-0` — main region now owns the
  scroll; header is a flex `shrink-0`.

**Collapsible section headers (pot-improv):**
- Every non-Member section header (Coaches / Chef / Admin / Masters /
  System) is now a `<button>` with a chevron. Click to collapse or
  expand — child items hide with no animation delay.
- State persisted in `localStorage` under `ishowedup_sidebar_collapsed`
  as a JSON array of section keys. Survives reloads.
- Member section deliberately stays always-open — it's the only
  section guaranteed to be visible for every user role and doubles
  as the visual anchor for the sidebar identity.
- New `SectionHeader` component below `NavItem` in `Layout.jsx`;
  supports `tone` prop ("cyan" default; "amber" for chef).

**Verified:**
- UI screenshot confirms MASTERS collapsed to a single row (chevron
  right), other sections open (chevron down), and the sidebar avatar
  + Sign out block is anchored to the bottom while main content
  scrolls independently.
- 12/12 pytest regression pass, lint clean.

---


## 4 Feb 2026 — Sidebar restructure: Coaches / Admin / Masters / System

**Changed:**
- Removed **Training Locations** from the sidebar; added a prominent
  card at the top of Office Settings that links to `/admin/sites`.
  The route itself is unchanged.
- Renamed sidebar section **Coach → Coaches** and reordered items to
  Muster Roll → Chef's View → Presence (per user spec 4 Feb 2026).
- Chef's View now visible under **Coaches** for coaches too (not just
  chefs/admins). Backend `require_chef_or_admin` widened to accept
  `category=="coach"`; frontend `RequireChefOrAdmin` route guard
  matches.
- Split the previous single **ADMIN** section into 3 groups:
  - **ADMIN** — Calendar, Dashboard, Manage Members, Reports,
    Approvals, Access Requests, Leave Balances, SMS Log.
  - **MASTERS** — Institutions, Fleets, Categories, Roles.
  - **SYSTEM** — Office Settings, Data Quality, Category Health,
    Escort Photo Cleanup, Audit Log, Backup & Restore.
- Vertical compression: nav item height `h-10 → h-9`, section header
  padding `py-2.5 → py-1.5`, icon `17 → 16`, font `text-sm → 13px`,
  gap `mb-0.5 → mb-px`. About 15-20% less vertical space overall.

**Files:**
- `backend/server.py` — `require_chef_or_admin` widened.
- `frontend/src/App.js` — `RequireChefOrAdmin` widened to accept coaches.
- `frontend/src/components/Layout.jsx` — split NAV_ADMIN into
  NAV_ADMIN + NAV_MASTERS + NAV_SYSTEM; NAV_COACH reordered + carries
  Chef's View; compressed NavItem sizing.
- `frontend/src/pages/admin/Office.jsx` — Training Locations shortcut
  card at top.

**Verified:**
- 12/12 pytest regression tests still pass.
- UI screenshots confirm sidebar shape matches user spec exactly on
  both /admin/dashboard and /admin/office.
- Lint clean on all 4 changed files.

---


## 4 Feb 2026 — Roles master + Chef role + Admin-filed corrections

**Feature 1 — Roles Master (Phase 1 of RBAC):**
- New `roles` collection with 3 seeded system rows: `admin`, `chef`,
  `member`. Unique index on `key` + upsert-safe seeding.
- Admin CRUD at `/api/masters/roles`; every authenticated user can
  list (so the Member form dropdown works).
- System rows locked from delete + deactivate; label/description
  editable. Custom roles are selectable in the Member form but
  behave like `member` for permissions until full RBAC ships (Q2).

**Feature 2 — Chef Role:**
- New role for kitchen staff. Superset of `member`:
  - Read access to `/api/admin/meals-today` (Chef's View).
  - Read access to `/api/muster/*` (portion planning at cut-off).
  - Read access to `/api/presence` (situational awareness).
  - Explicitly blocked from admin-only routes (members, categories,
    roles CRUD, dashboard etc.) — returns 403.
- Backend: new `require_chef_or_admin` dep on meals-today;
  `require_coach_or_admin` and `_can_muster` widened to accept chef.
- Frontend: new `RequireChefOrAdmin` route guard; `RequireMuster`
  widened. Layout sidebar shows a "CHEF" section (Chef's View +
  Muster + Presence) when `user.role === "chef"`; skips the ADMIN
  section entirely.

**Feature 3 — Admin-filed Corrections (same workflow):**
- `POST /api/corrections` now accepts optional `on_behalf_of` when
  the caller is admin. Row is stored against the target member
  (`requester_id`) but audit fields `filed_by_admin_id` +
  `filed_by_admin_name` record the filing admin.
- `_decide_one` enforces filer ≠ approver — same admin gets 409
  when trying to approve/reject their own on-behalf request.
- Admins bypass the 7-day retro window (they typically file late
  precisely because a member missed it). Non-admins unchanged.
- Non-admins passing `on_behalf_of` get 403 (no silent fallback).
- Frontend: PencilRuler icon on every member row in Manage Members
  → opens `CorrectionRequestModal` pre-scoped to that member with
  a sky "File on behalf of ___" banner and "Requires a different
  admin to approve" hint. Admin can also file for themselves or
  pick any member from a search-as-you-type list.
- `AdminCorrections` list now shows a sky "Filed by admin: <name>"
  badge on rows with `filed_by_admin_id` set.

**Files:**
- Backend new: `routes/roles.py`, `tests/test_roles_and_admin_corrections.py` (12 tests).
- Backend changed: `server.py` (Literal + helper + registration + seed hook), `routes/corrections.py` (on_behalf_of + filer≠approver), `routes/muster.py` (_can_muster widened), `routes/meals.py` (require_chef_or_admin), `routes/auth.py` (Literal widened).
- Frontend new: `pages/admin/Roles.jsx`.
- Frontend changed: `App.js` (guards + route), `components/Layout.jsx` (NAV_CHEF), `components/CorrectionRequestModal.jsx` (onBehalfOfMember prop + picker), `pages/admin/Members.jsx` (wire + modal), `pages/admin/members/MemberRow.jsx` (pencil-ruler action), `pages/admin/AdminCorrections.jsx` (badge), `pages/admin/MemberForm.jsx` (role dropdown fetched from master).

**Verified:**
- Backend: 12/12 new pytest tests + 32/32 relevant existing (correction/muster/meal/role) tests pass.
- Frontend: testing_agent_v3_fork iter 23 — 100% acceptance on all 6 user-facing scenarios (Roles CRUD, chef nav + route gating, MemberForm dropdown, admin on-behalf filing, second-admin rule, self-filing unchanged). No blocking issues.
- Lint clean across all 12 touched files.
- UI screenshot confirms Roles page renders with the 3 seeded system rows and lock badges.

**Non-blocking review notes (deferred, not blocking):**
- Extract shared `KIND_LABELS/KIND_TINT` from Corrections modal + list + MyCorrections into `data/correctionKinds.js`.
- Fix pre-existing hydration warning "whitespace text nodes cannot be a child of `<table>`" on `/admin/members`.
- Consider event delegation on the Members table when >500 rows (currently 136).

---


## 4 Feb 2026 — Elite squad sweep: 4 hotspot fixes + pragma suppression

Follow-on to the Muster/Fleet-assign Elite fix. Used the newly-shipped
Category Health tool to hunt down and fix the remaining places where
Elite squad members were silently mishandled.

**Fixed (real bugs):**
- `frontend/pages/Presence.jsx` — "missing photo on campus" strip now
  includes Elite athletes in the drainage queue.
- `frontend/pages/admin/Camps.jsx` — camp enrollment picker now shows
  Elite squad members so admins can enroll them into camps.
- `frontend/pages/admin/MemberForm.jsx` — Fleet dropdown now surfaces
  for Elite category (previously hidden; existing Elite members like
  Badrinath already had fleet=International 420 set via a workaround).
- `frontend/pages/admin/calendar/DayDetailModal.jsx` — camp enrolled-
  count on the calendar day drill-down now counts Elite members.

**Added:**
- `frontend/hooks/useAthleteLikeKeys.js` — shared, memoised hook that
  fetches `is_athlete_like=True` category keys once per page load.
  Now used by Presence, Camps, DayDetailModal (MemberForm reuses the
  categories master it already loads). Any future custom athlete-like
  category propagates through all 4 sites without a code change.

**Scanner improvements (`/api/admin/category-health`):**
- Added `cat-health-ok` pragma support (like `# noqa`). Same-line OR
  within 3 lines above the match — lets legitimate false-positives
  be marked with an inline rationale.
- Excludes the scanner's own file and CategoryHealth.jsx (self-refs).
- Skips lines starting with comment prefixes (`#`, `//`, `*`, `"""`,
  `'''`, `/*`) so descriptive prose doesn't false-trigger.

**Pragma-annotated (verified false positives):**
- `backend/routes/reports.py:204/269` — `category` is a query-param
  string, not a DB field; actual filter uses `athlete_like` set.
- `frontend/pages/admin/members/helpers.js:47` — explicit multi-key
  handling of athlete + elite, intentionally correct.
- `frontend/pages/admin/MemberForm.jsx:218` — defensive fallback for
  pre-categories-load; dynamic `is_athlete_like` check is primary.

**Verified:**
- `/api/admin/category-health` returns `warn_count: 0, hotspot_count: 0`
  (was 8 warn before this pass).
- Lint clean on all 6 changed files + the new hook.
- Full report/muster/camp/fleet regression suites (62 tests) pass.
- UI screenshot: Category Health page renders the clean state
  ("codebase is clean") with emerald success card.

---


## 4 Feb 2026 — Admin → Category Health diagnostic page

Follow-on to the Muster + Fleet-assign Elite fix. Admin can now spot
future regressions of the same class WITHOUT waiting for a user
complaint.

**Added:**
- `GET /api/admin/category-health` (admin-only, read-only). Returns:
  - `athlete_like_keys` — the ground-truth list from `categories` master
  - `categories` — key/label/count/is_athlete_like/meal_eligible/active
  - `hotspots` — file:line:snippet grep of every code path still
    hardcoding `category == "athlete"` across backend + frontend
  - Skips comments, docstrings, test dirs, and the diagnostic files
    themselves to keep signal high.
- New sidebar item **Admin → Category Health** (`ShieldAlert` icon).
- New page `/admin/category-health` with 3 stat cards + categories
  roster + filterable hotspots list.

**Current preview scan:** 8 warn hotspots — most legitimate follow-ups
already flagged in the previous CHANGELOG entry; two are UI/helpers
that already handle both athlete + elite (acceptable false positives
for a grep-based tripwire).

**Verified:**
- Curl smoke: `/api/admin/category-health` returns
  `{athlete_like_keys: [athlete, elite], hotspot_count: 8, warn: 8}`.
- UI screenshot confirms stat cards, categories table, and hotspots
  list render correctly.
- Lint clean on both backend and frontend.

---


## 4 Feb 2026 — Elite squad members visible in Muster + Fleet bulk-assign

**Bug reported:** "Badrinath and Ravikumar are not showing up in muster"
(both are `category=elite`, not `category=athlete`).

**Root cause:** Muster and Fleet-assign hardcoded `category: "athlete"`,
silently excluding every Elite squad member. Reports/Dashboard already
used the correct `is_athlete_like=True` lookup — muster + masters were
missed.

**Fixed:**
- `backend/routes/muster.py` — `/api/muster/athletes`,
  `/api/muster/checkin-bulk`, `/api/muster/checkout-bulk` now resolve
  athlete-like keys from `categories` master (fallback to
  `{athlete, elite}`).
- `backend/routes/masters.py` — `/api/fleets/assign` uses the same
  dynamic lookup, so Elite athletes are now bulk-assignable to any
  fleet (Opti A, ILCA 4, 420, etc.).
- `frontend/pages/admin/Fleets.jsx` — "Assign athletes" modal roster
  now shows every athlete-like category, not just plain `athlete`.

**Verified:**
- API smoke: Badrinath, Ravikumar, Aravind now appear in
  `/api/muster/athletes?mode=checkin`.
- Bulk assign against Elite member returned `modified: 1` (was `0`
  before).
- Full muster + fleet regression suites pass (56 muster tests +
  2 fleet/master tests, all green).

**Latent bugs with the same pattern (NOT fixed this pass — flagged):**
- `backend/breaks.py:93` — `is_athlete = category == "athlete"`
  excludes Elite from break scoping.
- `backend/holidays.py:102` — Elite treated as leave-tracked (opposite
  of intent).
- `backend/routes/data_quality.py:306` — Elite skipped in
  photo-captured checks.
- `backend/routes/auth.py:53,59,226` — Signup/roster imports still
  restrict to the 4-value Literal without `elite`.
- `backend/server.py:1436,3067` — CSV import default + dashboard
  bucketing.

Recommend a follow-up sweep to apply the athlete-like helper
everywhere before the next payroll / photo-audit cycle.

---



## 9 Jul 2026 — Code review triage (round 2): no new fixes needed

External code review re-ran and returned the same findings as
6-Jul-2026. Verified all previously-applied fixes are intact and no
new violations were introduced by any file touched this session.

**Prior fixes still in place:**
- `server.py:885` — `hashlib.sha256` (not md5) ✓
- `tests/test_smoke_launch.py:4` — expanded docstring with
  "placeholder" clarification ✓

**Confirmed false positives (documented in ESLint config):**
- `Sites.jsx:29 — useEffect missing 'load'` — intentional on-mount-
  only; adding `load` either loops or requires a useCallback shim
  that defeats the intent.
- `ParentInlineInput.jsx:36,37 — missing setName/setMobile` — React
  guarantees useState setters are stable; allow-listed.
- The other 178 "missing deps" findings are the same allow-listed
  patterns (module singletons, callback locals, setState setters).

**Deferred to ROADMAP (already tracked):**
- localStorage → httpOnly cookies (P2 security).
- Component & function complexity splits — server.py, MyLeaves,
  Reports, Muster, Members, Presence, CorrectionRequestModal,
  EventConflictNotice, InlineCell (P3 maintenance).
- `holidays.py`, `daily_content.py`, `breaks.py`, `guests.py` router
  complexity (P3, alongside server.py modular refactor).
- Hook-dep-count hotspots — Reports.jsx:224, BulkEditBar.jsx:34,
  auth.jsx:103 (P3, part of the split work).
- Style-only: `is` for constant comparison (Python idiomatic —
  false positive on `is None`), nested ternaries readability,
  type-hint coverage (long-term).

Zero new `console.log` calls introduced by the 9 files touched this
session — all diagnostics use `.debug/.error/.warn` (allow-listed).

---

## 9 Jul 2026 — Presence: wider columns, taller rows

Follow-up on the Off Campus merge: with 4 columns instead of 5, each
column can be ~35% wider on XL screens. Coach request also asked for
more rows visible before the internal scroll kicks in.

- **Grid**: Presence.jsx swapped `xl:grid-cols-5` → `xl:grid-cols-4`.
  Column width jumps ~280 px → ~380 px on a 1920-wide viewport —
  enough breathing room for the full name, institution chip, and
  Training Location chip to sit on one line each.
- **Vertical**: Column.jsx bumped column body from
  `max-h-[calc(100vh-220px)] min-h-[120px]` →
  `max-h-[calc(100vh-160px)] min-h-[220px]`. Reclaims ~60 px of
  vertical space per column (about 2 extra rows visible pre-scroll)
  and stops short columns (like an empty Off Campus) looking stubby.

Verified live: On Campus column now shows 4 full rows before scroll
(was ~3), site chips + institution chips + rank chip all fit on the
name-row without truncation.

---

## 9 Jul 2026 — Presence: scope=all break was wiping On Campus column

User report: "I entered a break in preview and the presence on campus
data has disappeared."

Root cause: the presence-resolution chain evaluated `elif brk:` before
`elif sess:`, so any active break that applied to a member forced
`status = on_leave` even when they had a live check-in session. On
preview a `scope=all` break covering today pushed all 133 members
into the Away column, leaving On Campus empty.

**Fix — physical check-in now beats a scheduled break.** Reordered the
elif branches in `server.py`:

- Live session (`sess`) is now matched **before** `brk`.
- Break context is preserved as an overlay in the `detail` string —
  e.g. "Since 06:03 · on break: General Break" — so coaches see the
  anomaly (someone came in on a rest day) without losing them from
  the roster.
- Members with no live session on a break-day still fall through to
  the `elif brk:` branch and appear under Away, unchanged behaviour.

Verified live on preview: was 0 on_campus / 130 on_leave; is now
35 on_campus / 95 on_leave. New regression test
`test_scope_all_break_does_not_wipe_on_campus` creates a temporary
scope=all break, asserts the previously-on-campus roster survives,
and cleans up. 22 smoke tests pass (was 21 — new test joined the
core suite).

---

## 9 Jul 2026 — Presence: merge Stepped Out + Checked Out into "Off Campus"

User request: "In presence show Stepped out and checked out in the
same column, Merge them and show diff contrasty colours for each."

- `COLUMNS` (constants.js): the two independent columns collapsed into
  a single **Off Campus** column. Follows the same pattern as the
  earlier Tour + Leave → Away merge (8 Jul 2026) so admins reclaim
  horizontal space for the operationally-important columns.
- `STATUS_TO_COLUMN`: `temp_out` and `exited` both now route to
  `off_campus`.
- New `OFF_CAMPUS_STATUS_STYLE` in `constants.js` — cyan pill for
  Stepped Out (in-day pause, coming back), slate pill for Checked
  Out (done for the day). Deliberately cross-hue so the two states
  read at a glance even before the pill text.
- `MemberCard.jsx`: renders the per-status pill on the name line
  (same slot as the Tour/Leave pill) plus a row background tint
  matching the pill hue.
- `Column.jsx`: header now shows a Stepped-Out vs Checked-Out split
  with dimmed-when-zero chips, mirroring the Away column's split.
- 4 presence columns total now (was 5): On Campus, Off Campus, Away,
  Absent. Escort mini-panels inside each column keep their existing
  temp_out / exited bucketing — separate visualisation, untouched.

---

## 9 Jul 2026 — Code review triage: applied fixes + policy re-confirmations

External code review dropped a fresh batch of findings. Actionable
items applied; the rest are either false positives or already tracked
on the post-launch ROADMAP:

**Applied:**
- **Weak crypto (`server.py:885`)** — swapped MD5 → SHA-256 for the
  photo-URL cache-busting fingerprint. The hash is not
  security-sensitive (10-char URL tag for cache invalidation) but the
  swap eliminates the static-analysis noise. Verified cache tags still
  round-trip cleanly.
- **Docstring clarity (`tests/test_smoke_launch.py:4`)** — the
  "hardcoded secret" finding was a false positive on a `<pw>`
  placeholder in the run-command example. Expanded the doc block so
  future readers (and scanners) see this is a placeholder pointing to
  the local `.env` / CI secret store, never a committed password.

**Confirmed false positives (no change):**
- **Missing hook deps (180 instances)** — the ESLint config's
  docstring already enumerates the four known-safe patterns external
  tools misread as missing deps: `setState` functions from `useState`,
  module-level singletons (`api`, `toast`, `navigate`), ref `current`
  values, and local variables captured inside callback bodies. All
  three files touched this session (Reports.jsx, MyCorrections.jsx,
  CorrectionRequestModal.jsx) lint clean under our config.
- **Console statements (28 instances)** — grep across `src/` (excl.
  `components/ui`) shows zero `console.log`; every remaining call is
  `console.debug` / `.error` / `.warn`, all explicitly allow-listed in
  the ESLint config for diagnostic + ErrorBoundary paths.
- **Smoke test "hardcoded secret"** — see above; docstring only.

**Deferred to post-launch ROADMAP (already tracked):**
- `localStorage` token storage → `httpOnly` cookies (P2, security).
- Component & function complexity refactors (server.py, MyLeaves,
  Reports, Muster, Presence, Members) — P3, maintenance.
- Hook-dep-limit hotspots (Reports.jsx:224 useMemo with 7 deps,
  BulkEditBar.jsx:34, auth.jsx:103) — P3, part of the component-split
  work.
- `holidays.py`, `daily_content.py`, `breaks.py`, `guests.py` router
  complexity — P3, alongside the `server.py` modular refactor.

446 backend tests + 21 launch-day smoke tests still green after the
crypto swap.

---

## 8 Jul 2026 — My Corrections: fresh application picker for existing rows

Follow-up on yesterday's "Raise correction" button: the amber hint that
told members to "open the specific row" was a papercut. Replaced with
an inline row picker so all four row-required kinds (time_adjust,
leave_date_change, leave_cancel, leave_type_change) work end-to-end
from the fresh-application flow.

- **Backend**: new `/api/me/corrections/candidates` returns the
  requester's last-7-day attendance rows plus every approved leave
  overlapping the window. Trimmed projection — only the fields the
  picker labels need.
- **Modal**: fetches candidates on open (skipped when the caller
  already bound `entityId`). A kind-aware `<select>` swaps in for the
  amber hint — attendance rows for `time_adjust`, leaves for
  `leave_*`. Picking a row auto-fills `target_date` so the 7-day
  window check is always in sync. If the requester has no eligible
  rows (fresh member, no recent activity), the hint stays.
- Submit gates on picker selection when the kind needs a row.
- Verified end-to-end: admin user with one seeded attendance row saw
  `2026-07-09 · 09:15 → 17:45` in the picker and target date snapped
  correctly on select. 446 backend tests still pass.

---

## 8 Jul 2026 — My Corrections: raise a fresh correction

Follow-up on the just-shipped My Corrections page: coaches noticed
there was no way to file a correction from the page itself — they had
to navigate back to Check-in / Leave/Tour to hit the raise flow. Added
a **"Raise correction"** button in the tab bar and a mirror on the
empty-state placeholder.

- `CorrectionRequestModal` now opens all 5 kinds in the dropdown when
  launched generically (no `entityType` locked by the caller). For
  kinds that need an existing row to correct (time_adjust, leave_*),
  a small amber hint below the dropdown tells the member to open the
  specific row for the fastest turnaround. `missed_checkin` — the one
  kind that materialises a new row — works fully from this generic
  entry point.
- On successful submit, the page auto-refreshes to the Pending tab
  and the newly-raised row shows immediately.

---

## 8 Jul 2026 — Reports: section background contrast + Member "My Corrections" page

Two smaller polish items rolled in together:

**Reports: stronger section tints.** Group column backgrounds bumped
from `bg-{color}-50/30` (barely visible) to `bg-{color}-200/50` so the
Attendance / Leave / Overtime / Comp-Off / Hours / Escorts groups read
as distinct color bands even across the zebra rows. Screenshot-verified
on the Staff & Coaches view — visual grouping now reads at a glance.

**"My Corrections" page.** Coach request "bring all correction requests
by a member under member in the main menu and all approvals under
approvals". Approvals side already consolidated (Approvals page has
Leaves / Overtime / Check-ins / Corrections tabs). New member-side
`/my-corrections`:

- New page `MyCorrections.jsx` — pending / approved / rejected tabs
  with tab-pill counts. Read-only; corrections are still raised from
  the modal on Check-in and Leave/Tour rows.
- Route + lazy-import wired in `App.js`.
- Sidebar entry added under NAV_MEMBER with a live badge fed by a 60-s
  poll against `/api/me/corrections?status=pending`. Skipped for
  escort tokens (they have no corrections page). Icon: `PencilRuler`.

---

## 8 Jul 2026 — Reports: Leave ledger drill-down modal

Coach request: "Double click on the leave cols should show all the
leave date like diff rows chronologically of Leave applied, Leave
availed Leave rejected and totals thereof."

- New backend endpoint `/api/reports/leave-ledger?member_id&year`
  returns every leave-type application for the year, sorted
  chronologically, tagged as `applied` (pending) / `availed`
  (approved) / `rejected`. Header totals surface the split plus
  Opening / Taken YTD / Remaining so the modal is a self-contained
  leave audit for the year.
- New frontend `LeaveLedgerModal.jsx` — chronological table with
  Start · DOW · End · Days · Kind · Reason · Admin note. Double-
  clicking Open / Total / Avld / Close in the Reports Leave section
  opens the modal. COff still opens the comp-off ledger — it's a
  separate pool. Verified live with HASSAN MOHD (30-day leave) and
  AINUL HAQUE (1-day availed on Moharam).

---

## 8 Jul 2026 — OT ledger: split Early reason vs Late reason

Coach request: "In the overtime ledger both reasons for early and late
need to be mentioned."

Historically the attendance row carried a single `overtime_reason` that
was overwritten on check-out — so a member who logged an early-in
reason and later a late-out reason ended up with only the second in the
ledger. Fixed at storage + display:

- Storage: `_geo_toggle` now stamps `overtime_early_reason` on the
  early-in path and `overtime_late_reason` on the late-out path.
  Legacy `overtime_reason` is kept for backward compat with pre-8-Jul
  rows + downstream readers.
- Supplemental-reason branch (check-out with no new late OT but a fresh
  reason) attributes the text to whichever half is missing a reason,
  early first.
- `/api/reports/ot-ledger` projects both new fields.
- `OTLedgerModal` splits the Reason column into two — Early reason and
  Late reason — with a graceful fallback: rows that only have the
  merged legacy field attribute it to whichever half actually recorded
  minutes. Modal max-width bumped 3xl → 4xl to fit the extra column.

---

## 8 Jul 2026 — Reports: Comp-off ledger drill-down modal

Coach request: "A double click on the comp off col for anybody should
create a window with all the comp off dates and DOW."

- New backend endpoint `/api/reports/comp-off-ledger?member_id&year`
  returns a merged timeline of Earned (attendance + tour on the
  member's weekly-off, minus posting windows), Applied (pending
  comp-off leaves), and Approved (approved comp-off leaves). Each row
  carries `date`, `dow`, `kind`, `qty`, and a note.
- New frontend `CompOffLedgerModal.jsx` — mirrors OTLedgerModal styling.
  Double-clicking any of the three comp-off cells (Earned / Applied /
  Approved) on Reports opens the modal for that member. Header
  surfaces totals: Earned · Applied · Approved · Available.

---

## 8 Jul 2026 — Reports: Elite pill · OT-only filter · Leave column redesign

Three coach-requested tweaks on the Attendance report:

1. **Elite pill** — new dedicated filter chip between Athletes and Staff &
   Coaches. Matches `r.category === "elite"` literally so it isolates the
   18-strong Elite cohort without leaking regular athletes. Athletes pill
   still shows the combined 91 (athlete + elite) count.
2. **OT > 0 filter** — replaces the previous Comp-off > 0 toggle. Filters
   to rows with any non-zero OT signal this month (served / applied /
   approved). Matches the shift in admin usage: OT auditing surfaces more
   often than comp-off spelunking.
3. **Leave columns: Open · COff · Total · Avld · Close** — expanded from
   3 columns to 5. `COff` is comp-off available YTD (accrued − used),
   fetched from `/api/leave-balances` and merged client-side; it adds to
   the leave pool so `Total = Open + COff` and `Close = Total − Avld`.
   Cells stay blank when all three of Open / COff / Avld are zero so
   athletes (Breaks workflow) don't clutter the leave view with `0`s.

Table `minWidth` bumped 1300 → 1420 to accommodate the two new columns.
"No data" `colSpan` bumped 23 → 25. No backend changes.

---



## 8 Jul 2026 — Reports: Staff & Coaches filter no longer leaks Elite athletes

User report: "In the staff and coaches filter a lot of athletes appear."

Root cause: both `Reports.jsx` and the backend `/reports/payroll` +
`/reports/hours/export` compared `r.category === "athlete"` literally.
Elite members carry `category="elite"` (with `is_athlete_like=true` in
the categories master), so all 18 Elites bled into the "Staff & Coaches"
pill. Custom admin-added athlete-like categories would have done the
same.

Fix — both layers now consult `is_athlete_like` instead of hard-coding
the literal `athlete` key:

- Backend: `routes/reports.py` gains an `_athlete_like_keys(db)` helper
  that queries `db.categories` for every `is_athlete_like: True` key.
  `?category=athlete` and `?category=rest` on `/reports/payroll` +
  `/reports/hours/export` filter by set membership.
- Frontend: `Reports.jsx` fetches `/api/masters/categories` on mount,
  computes `athleteLikeKeys`, uses it in the filter blocks + pill count
  computation.
- Regression guard: `test_payroll_category_rest_excludes_athlete_like`
  in `test_routes_reports.py` locks the invariant against future drift.

Verified on the prod-preview dataset (73 athletes + 18 elite + 25 staff
+ 11 coach + 6 executive): Staff & Coaches pill now returns 42 rows
(was 60), Athletes pill returns 91 (was 73).

---



## 8 Jul 2026 — ESLint config: encode false-positive policy

In response to a code-review report that flagged 157 "missing hook
deps" + 27 "console statements" — most of which were false positives
— the ESLint config now explicitly encodes what's safe and what isn't
so future audits read our policy instead of firing noise.

- `eslint.config.js` docstring — enumerates the four known-safe
  patterns that external tools misread as missing deps: setState
  functions from useState, module-level singletons (`api`, `toast`,
  `navigate`), ref current values, and local variables inside
  callback bodies.
- New `no-console` rule with `allow: ["debug", "error", "warn"]` —
  our `console.debug` diagnostics + ErrorBoundary `console.error`
  are legitimate and won't get flagged. `console.log` still warns
  (that's the one that shouldn't ship).
- Added `src/components/ui/**` to `ignores` — shadcn/ui primitives
  are vendored third-party code that carries 3 upstream errors
  (`no-unstable-nested-components`, `cmdk-input-wrapper`); we don't
  own or maintain them.

**Impact**: Zero behaviour change to the running app. Purely a
documentation + policy-clarification pass so the next external code
review reads our config and skips ~180 known-false-positive findings.

---


## 8 Jul 2026 — Away column: two-toned row backgrounds

Follow-up polish on the Tour+Leave merge — rows inside the "Away"
column now carry distinct row-level tints so the two statuses read
as almost-separate columns visually while sharing one physical column:

- Tour → light **orange-50** bg (hover **orange-100**)
- Leave → light **amber-50** bg (hover **amber-100**)
- Late-flag still wins over the away tint (red-50 takes precedence).
- `components/presence/MemberCard.jsx` — the `lateBg` helper is now
  a small 3-way branch: late → red / away-tour → orange / away-leave
  → amber / everything else → plain-white with slate hover.

**Impact**: zero new tests needed; the row backgrounds are a pure CSS
tint driven by data already on `m.status` + `columnKey`.

---


## 8 Jul 2026 — Presence Board: merged Tour+Leave, tighter rows

Presence Board went from 6 columns to 5 by merging **Tour + Leave**
into a single **"Away"** column. This frees up horizontal space for
the operationally-important columns (On Campus, Checked Out, Stepped
Out, Absent) and pairs with a row-height compression so more members
scroll into view on the same screen.

- `components/presence/constants.js` — dropped the old Tour/Leave
  entries; added a merged `away` column plus `STATUS_TO_COLUMN` map
  (`on_tour` → `away`, `on_leave` → `away`) and `AWAY_STATUS_STYLE`
  chip config (orange Tour vs amber Leave with dot indicators).
- `pages/Presence.jsx` — bucketing routes both statuses through the
  new map; grid layout `xl:grid-cols-6` → `xl:grid-cols-5`.
- `components/presence/MemberCard.jsx` — renders a tiny "Tour" or
  "Leave" pill next to the name for rows in the Away column so admins
  can still tell the two statuses apart at a glance. Compressed
  padding: `px-3 py-2.5` → `px-3 py-1.5` (Detailed) / `px-3 py-1.5`
  → `px-2.5 py-1` (Compact). Avatar size 34 → 32 (Detailed) / 28
  (Compact). Import `AWAY_STATUS_STYLE` from constants.
- `components/presence/Column.jsx` — header of the "Away" column
  shows a **Tour n · Leave n** split so the merge preserves visibility
  of both totals. Category breakdown gets an **Elite (E rose)** chip;
  Executive letter changed to X to avoid the clash. `data-testid=
  "column-away-split"` + `column-away-tour-count` + `column-away-leave-count`
  for the new chips.
- `components/presence/SkeletonBoard.jsx` — grid updated to 5 cols.

**Impact:** 5-column layout means each column widens by ~20%. Row
compression + smaller avatars fit roughly 30% more members per screen.
Full Presence data-testid contract preserved — no test regressions.

**Tests**: 459/460 pass (`./ci.sh --all`), no new tests needed —
existing presence tests exercise the flow.

---


## 8 Jul 2026 — Check-in approvals, unified Approvals queue,
Categories master CRUD, tiered test suite

Four related shipments in one session:

### 1. Check-in approval workflow (non-blocking)
Every check-in with `late=true` OR `out_of_geofence=true` is now
stamped `approval_status="pending"` at ingest time (both self and
muster paths). The check-in **still succeeds immediately** — hours
count, appears in reports — but sits in an admin review queue so
anomalies get an audit-trail eyeball.

- `routes/checkin_approvals.py` (new):
  - `GET /api/admin/checkin-approvals?status=pending|approved|rejected|all`
    — hydrates full_name/photo_thumb/institution/fleet in one query.
  - `POST /api/admin/checkin-approvals/{id}/decide` — body
    `{decision, note}`. Rejections require ≥3-char note. Both
    decisions audit-logged as `checkin_approved` / `checkin_rejected`
    with before/after `approval_status` diff.
  - `GET /api/admin/approvals-summary` — aggregated pending counts
    across leaves, overtime, devices, checkins → powers sidebar badge.

### 2. Unified "Approvals" landing (rename + badge)
- Sidebar: `Leave Tour Approvals` → **`Approvals`** with a **persistent
  amber-tinted background + ring**, and a **rose/amber count pill**
  (leaves + OT + devices + checkins, polling every 60 s). Renders
  "99+" for values >99.
- `/admin/approvals` page — new 3rd tab **"Check-ins"** alongside
  Leaves and Overtime. New `pages/admin/CheckinApprovals.jsx` renders
  per-row approve/reject controls, quick-pick reason (via geo_reason
  quote if present), and flag chips (Late/Off-site + distance).
- Old dual-endpoint fetch replaced by one `/approvals-summary` call
  — 3× fewer network trips per poll.

### 3. Categories master — full CRUD
- Extended `routes/meals.py` with:
  - `POST /api/masters/categories` — admin creates a new category
    (validates key regex + color from allowed palette).
  - `PATCH /api/masters/categories/{id}` — updates label / color /
    flags / sort_order / active. Deactivating a seeded category is
    blocked (409) since attendance rules branch on their keys.
  - `DELETE /api/masters/categories/{id}` — blocked for seeded keys
    AND while >0 members reference it.
  - `GET /api/masters/categories?include_inactive=true` — hydrates
    `member_count` + `is_seeded` per row for the admin UI.
- New `pages/admin/Categories.jsx` — list + inline form modal (key
  locked on edit, 6-color palette, Meal-eligible + Athlete-like flags,
  sort-order). Delete disabled with tooltip on seeded rows and rows
  with members.
- Sidebar entry (`ShieldAlert` icon) between Fleets and Training
  Locations.

### 4. Tiered test suite for faster iteration
- New `slow` pytest marker for the 4 tests that dominate wall-time
  (~60 s combined): sites CRUD lifecycle, meals cutoff narrow-pool,
  reason-bank cap-at-50, dashboard non-admin rejection.
- New `backend/ci.sh` runner:
  - `./ci.sh`           → **fast tier (~70 s)**, `-m "not slow"`
  - `./ci.sh --all`     → **full suite (~140 s)** — pre-deploy gate
  - `./ci.sh --smoke`   → smoke (~3 s)
- Full suite still runs in the deploy pipeline. Iterative development
  uses the fast tier (2× speedup) — safe: only excludes long
  end-to-end lifecycles that are exercised by the full suite before
  every deploy.

**Tests**: 459/460 pass in full run (1 pre-existing state-dependent
skip in test_review_iter2). Fast tier: 441/441 pass in 69 s.

---


## 8 Jul 2026 — Geo-aware check-ins: off-site warn + reason, permission
banner, muster stamps coach GPS

Every check-in path is now geo-aware. Members and coaches are told
which training location they landed at, warned when they're outside
any geofence, prompted for a reason on off-site self check-ins, and
alerted upfront if the browser has blocked location. Muster batches
carry the coach's GPS on every stamped attendance row.

**Backend**
- `POST /api/muster/checkin-bulk` and `/muster/checkout-bulk` now
  accept optional `latitude` + `longitude`. When present, the server
  resolves the site via the same `_resolve_site_for` helper the
  single-user check-in uses; each attendance row is stamped with
  `latitude`/`longitude`/`site_id`/`site_name`/`out_of_geofence`/
  `distance_m`/`geo_unavailable` (checkout also stamps mirrored
  `exit_*` fields). Response echoes the batch's resolved location so
  the frontend can toast "Mustered N at Rowing Academy". `(0, 0)`
  remains the sentinel for "GPS not obtained" — falls back gracefully.
- Router factory `routes/muster.make_router` gained `resolve_site_for`
  as its 4th parameter (wired in `server.py`).
- `POST /api/attendance/geo-toggle` already accepted `reason` — now
  actually used by the frontend and persisted as `geo_reason` on the
  attendance row when `out_of_geofence=True`.

**Frontend**
- `hooks/useGeoPermission.js` (new) — reactive geolocation-permission
  state (`granted` / `prompt` / `denied` / `unsupported`) via the
  Permissions API, listens to `change` events.
- `components/GeoPermissionBanner.jsx` (new) — surfaces on `denied`
  with browser-specific fix hints (Chrome, Safari iOS/desktop, Firefox
  detected via UA).
- `components/OutOfGeofenceModal.jsx` (new) — 5 quick-pick reason chips
  ("At an unlisted training venue" / "GPS drift" / "Regatta" / "Boat
  maintenance off-site" / "Coach-led outing") + required 3+ char
  textarea. Distance shown human-friendly (auto km >1000 m).
- `utils.js` — new `haversineMeters()` + `resolveNearestSite()` helpers
  mirror the backend geofence math so the modal can fire BEFORE
  hitting the server.
- `SelfCheckIn.jsx` — GPS permission banner, pre-flight local
  resolution, modal prompt on out-of-geofence CHECK-INS (not checkouts),
  reason passed to backend, success toast now reads
  "Checked in at <site_name>" for satellite-site hits.
- `Muster.jsx` — coach's GPS captured (8s budget) on submit, sent in
  payload; `window.confirm` on off-site with human-formatted distance;
  toast "Mustering at <site_name>" on in-geofence.

**Tests**
- `backend/tests/test_muster_gps.py` (new — 4 tests): backward compat
  without GPS, off-site flagging with far coords, checkout with GPS,
  `(0,0)` sentinel handled as geo-unavailable.
- `backend/tests/test_review_iter22.py` (added by testing agent, 3
  tests): satellite-site site_name propagation to `/api/presence`,
  `geo_reason` persisted when out, `geo_reason` omitted when in.
- Testing agent iter22: **72/72 backend pass**, **100% frontend**
  incl. Playwright verification of modal, banner, and reason submit.
  Code-review comments: minor polish only (distance formatting +
  no-GPS documentation applied post-review).

---


## 8 Jul 2026 — Location-wise check-ins on Presence + Admin Dashboard

Members' training-location context now surfaces everywhere it matters
so coaches can answer "who's at Rowing Academy right now?" without
opening the map. Additive to the existing single-session-per-day
workflow (no check-out/check-in dance needed).

**Backend**
- `GET /api/presence` — every member entry now carries `site_id` +
  `site_name` (both null for off-status members, so exited/absent/
  on_leave rows don't leak stale site data). Response gets a new
  top-level `by_location` array grouping on_campus + temp_out members
  by their check-in site with counts and by-category breakdown; null
  sites fold into "Main Club".
- `GET /api/admin/dashboard` — `now.on_campus_by_location` mirrors the
  same shape (minus by_category — dashboard only shows totals).
- Both responses always include the key (empty array on days with no
  on-campus members) so the frontend guards are simple.

**Frontend**
- `components/presence/LocationFilterRow.jsx` (new) — pill row that
  self-hides when < 2 distinct locations (single-site day). Deep-link-
  aware via `?location=` URL param.
- `pages/Presence.jsx` — imports `useSearchParams`, adds `locationFilter`
  state seeded from URL, includes location predicate in `byColumn`
  filter (skipped on historical views), syncs URL with `replace:true`
  on toggle so refresh keeps the filter.
- `components/presence/MemberCard.jsx` — small emerald 📍 chip with the
  site_name next to the existing institution chip.
- `pages/admin/Dashboard.jsx` — new "ON CAMPUS BY LOCATION" chip strip
  below the Now tiles (hidden when empty). Each chip is a `<Link>` to
  `/presence?location=<encoded_site_name>` so admins click through to
  the pre-filtered board in one tap.

**Tests**
- `backend/tests/test_presence_by_location.py` — 3 new contract tests
  guarantee the new keys exist on both endpoints and that off-status
  members don't leak site info.
- Testing agent iter21: **86/86 backend pass** (regression + new).
  Code review: clean, non-blocking nits only.

---


## 8 Jul 2026 — Editable meal cut-off + Training Locations rename

**Meal cut-off moved to Office Settings** (was hardcoded 07:00). Admins
can now tune when breakfast eligibility closes without a code change
— tighten to 06:45 on regatta days, loosen on holidays, etc.

- `OfficeConfig.meal_breakfast_cutoff: str = "07:00"` added (Pydantic
  default protects existing docs → no backfill needed).
- `routes/meals.py` resolution order: **explicit ?cutoff (validated) →
  office.meal_breakfast_cutoff → 07:00 default**. An explicit bad query
  400s (catches frontend bugs); a bad office value silently falls back
  (so admins can still open the page and fix the setting).
- Response payload now includes `configured_cutoff` alongside the
  effective `cutoff`, so the Chef's View can show the office default
  even when an override is active.

**Frontend**
- `pages/admin/Office.jsx` — new "Breakfast eligibility cut-off"
  section (data-testid `of-meal-breakfast-cutoff`) with time picker +
  explanatory hint. Placed between Half-day windows and Forgot-checkout
  reminder.
- `pages/admin/ChefsView.jsx` — cut-off picker starts empty and
  hydrates from `response.cutoff` on first load. Picker `title`
  tooltip shows "Office setting: HH:MM (change on Office Settings)"
  so admins know where to change the default.

**Training Locations rename** — multi-location training with lat/long/
geofence-radius already existed as **Sites** (full CRUD, additive to
office geofence, resolved on every check-in). Renamed sidebar entry,
page heading, form title, empty state, and toast copy to
**"Training Locations"** for discoverability. No schema or route
changes; the URL is still `/admin/sites`.

**Tests** — 13/13 meals-related tests + full 62/62 regression pass.
Testing agent iter20: **100% backend + 100% frontend**, incl. E2E
verification of picker hydration under 06:45 override.

---


## 8 Jul 2026 — Chef's View + Categories master + "Elite" category

New `/admin/chefs-view` under the Members section of the sidebar —
one screen the chef checks in the morning to plan the day's meal
count. Also introduces "Elite" as a first-class category so the
kitchen (and future features) can distinguish elite squad athletes.

**Backend**
- New collection **`categories`** — seeded on startup with the 5
  canonical categories (athlete, elite, coach, staff, executive)
  including per-row `color`, `is_athlete_like`, `meal_eligible`,
  `sort_order`. Elite is `is_athlete_like=True`.
- New file `routes/meals.py`:
  - `GET /api/masters/categories` — signed-in users read the seeded
    master (powers the Members-form dropdown).
  - `GET /api/admin/meals-today?date=YYYY-MM-DD&cutoff=HH:MM` — admin-
    only. Returns members whose earliest check-in on the target day
    is at or before the cut-off (default **07:00** office-local),
    grouped by category. Payload: `{today, cutoff, generated_at,
    categories[], counts{}, total, members[]}` where each member
    carries `id / full_name / category / photo_thumb / institution /
    fleet / check_in_at`.
- **`ATHLETE_CATEGORIES = {"athlete", "elite"}`** constant added to
  `services/attendance_calc.py` — used across `server.py`,
  `holidays.py`, `routes/dashboard.py` so elite kids follow the same
  rules as athletes: Breaks workflow (not leaves), no leave-balance
  opening, no comp-off accrual, no OT accrual, expected daily.
- Pydantic `category` Literal widened to `athlete | elite | coach |
  staff | executive`.
- Dashboard aggregator (`routes/dashboard.py`) now includes an
  `elite` bucket in `on_campus_by_category`.

**Frontend**
- New page `pages/admin/ChefsView.jsx`:
  - 6 big bold colored **tickets** (Tailwind cards, coloured per
    category via master `color` key): Athletes/sky · Elite/rose ·
    Coaches/emerald · Staff/amber · Executives/violet · Total/slate.
  - Date picker + cut-off time picker + Refresh + **Print** button
    (with `@media print` CSS that hides the toolbar).
  - Drill-down grouped by category — Avatar + name + institution·fleet
    + HH:MM check-in. Live **search** (name / institution / fleet).
  - In-flight guard to prevent duplicate refresh races.
  - 20+ `data-testid`s across every ticket, row, and control.
- Sidebar: new "Chef's View" entry (`ChefHat` icon) between Manage
  Members and Leave Tour Approvals.
- Members master: `Elite` added to inline category dropdown and to
  the top filter chip bar; `leaveBalanceLabel` treats Elite same as
  Athlete (em-dash — they use Breaks, not leaves).

**Tests** — all green
- `backend/tests/test_meals.py` — 7 new contract tests: categories
  seed, auth gate, payload shape, cutoff-widens invariant, invalid
  cutoff/date rejection, member-field completeness.
- `backend/tests/test_review_iter19.py` (added by testing agent) —
  5 tests: PATCH member to elite, leave-balances regression,
  dashboard 5-buckets, E2E tag→bucket-move→revert.
- 12/12 meals tests pass; 61/61 full smoke+dashboard+meals+ot+leaves
  regression pass.
- Testing agent iter19: **100% backend + 100% frontend**.

---


## 7 Jul 2026 — Single-glance Admin Dashboard

New `/admin/dashboard` landing page for admins and head coaches —
a one-screen overview of the club's day, week, and month without
clicking through six tabs. Also made this the default admin landing
(bare `/admin` now redirects here).

**Backend** — new file `routes/dashboard.py`
- Endpoint: `GET /api/admin/dashboard` (admin-only). One targeted
  fan-out, no full scans. Bulk-loads users (up to 5k) once, then runs
  narrow queries per zone.
- Returns four zones in one payload:
  - **now** — on-campus total + A/C/S/E breakdown, late today, absent
    athletes (present set ∪ approved-leave set), guests present,
    escorts on campus, pending-approvals (leaves + overtime + devices).
  - **week** — 7-day sparkline (unique athletes vs unique staff per
    day), top 5 late-comers (distinct late-days), birthdays this week,
    camps + regattas overlapping the coming 7 days.
  - **month** — staff hours MTD (coach + staff + executive), approved
    OT hours, approved leave-days consumed, new members joined.
  - **attention** — pending leaves / OT / devices / stale sessions
    (open >36 h) / athletes without any parent contact.
- Wired into `server.py` next to the data-quality router.

**Frontend** — new file `pages/admin/Dashboard.jsx`
- Left main column: three stacked SectionCards (Now / This week /
  This month) with 6/2/4 clickable StatTiles. SVG dual-line sparkline,
  top-late list with Avatars + category chips, birthdays, and
  camps/regattas list.
- Right rail: Attention list (5 rows, all linking to their queue
  pages) + Shortcuts grid (6 nav buttons).
- Auto-refresh every 60 s while tab is visible, with an in-flight
  guard so slow networks can't double-fire. Manual Refresh button too.
- 32 `data-testid`s across every tile, list, chip, and nav link so
  the automated suite can drive precise assertions.
- Sidebar (`Layout.jsx`) — new "Dashboard" entry (`Gauge` icon) at the
  top of `NAV_ADMIN`. `/admin` redirects to `/admin/dashboard`.

**Tests**
- New `backend/tests/test_dashboard.py` — 3 contract tests: auth
  gate (401/403), bogus-token rejection, and deep payload-shape
  invariants (7-day sparkline, sorted top-late, pending-total sum,
  attention/now cross-check, non-negative-int guarantees).
- Testing agent (iter18) added `test_review_iter18.py` covering
  non-admin token rejection and regression on 4 admin endpoints.
- Frontend testing agent: all 32 data-testids present, click-throughs
  correct, no console errors, no regressions on Presence/Muster/
  Members/Reports/Approvals. 100% pass.

---


## 7 Jul 2026 — OT-eligibility checkbox per member

Admins can now opt individual members out of OT accrual regardless
of category — for salaried supervisors, contractors, or anyone
whose contract doesn't include overtime.

**Backend**
- New optional `ot_eligible: bool` field on `MemberCreate`,
  `MemberUpdate`, and `UserPublic` (`models.py` + `server.py`).
- `services/attendance_calc.py` — `compute_overtime_in` and
  `compute_overtime_out` now short-circuit and return `(0, "")` when
  `member.get("ot_eligible") is False`. `None` / `True` preserve the
  pre-existing category-based rule (staff/coach/executive accrue,
  athletes never do). Opt-out semantics keep existing data intact.

**Frontend**
- New checkbox on the Members edit modal (`MemberForm.jsx`) labelled
  "Include this member in Overtime calculation". Sub-copy explains
  when to uncheck. `data-testid="mf-ot-eligible"`. Defaults to true
  for legacy members with the field unset.

**Tests**
- New `backend/tests/test_ot_eligible.py`:
  - PATCH round-trip (True → False → True).
  - `/auth/me` exposes the field.
  - Direct unit test on `compute_overtime_in` / `_out` proving the
    gate works and category-based exclusion of athletes still wins.

## 7 Jul 2026 — Zebra striping on Attendance Report

**Reports table** (`Reports.jsx`): every alternate row now carries a
subtle `bg-slate-100/60` tint so the eye tracks across the 23
columns without losing its place. Group column tints (`bg-emerald-50/30`,
`bg-amber-50/30`, etc.) layer on top so the visual grouping stays
intact. The two sticky left columns (Member + Cat) inherit the row's
zebra tint so the pinned half stays visually aligned with the
scrolling half.

Hover swapped from `bg-slate-50` → `bg-sky-50` so it reads as
"currently-highlighted row" instead of fighting the zebra.

## 7 Jul 2026 — Code-review hardening pass #2

Applied every fix in the second code-review report that didn't overlap
with the post-launch deferral list.

**Fixed**
- `MemberTimelineModal.jsx:216` — replaced `key={i}` on the
  `details.map` with a composite key derived from `type +
  (status | check_in_time | expected_arrival)` so React reconciles
  correctly when a day's details reshuffle (a check-in row and a
  leave row can coexist on the same date).
- `auth.jsx` — wrapped the AuthProvider context value in `useMemo`
  so `useAuth()` consumers don't re-render every time the provider
  re-renders.
- `Presence.jsx` — hoisted the inline `[...on_campus, ...temp_out]`
  array passed to `<EscortsStrip escorts=…>` into a memoised
  `escortsForStrip`. Prevents EscortsStrip's memoisation from being
  invalidated every render.
- `components/InlinePhotoAvatar.jsx` — removed unused `Camera`
  lucide import.
- Backend tests: `ruff --fix` cleaned up 13 unused imports across
  `test_version_endpoint.py`, `test_services_*`, and a handful of
  legacy test files.

**Explicitly NOT-fixed (still deferred per prior user directive)**
- localStorage JWT → httpOnly cookies (P2, post-launch).
- Component splits of Members / Reports / Muster / MyLeaves /
  Presence (P3, post-launch).
- Python router-complexity refactors: `holidays.py`,
  `breaks.py`, `daily_content.py`, `guests.py`, `regattas.py`,
  `camps.py` (P3, post-launch).
- 242 nested-ternary occurrences (P3, mostly stylistic; would
  bloat the codebase 3-5%).
- TypeScript migration (large scope; not planned pre-launch).
- The report's "hardcoded secret" flag on
  `tests/test_smoke_launch.py:4` — false positive; that's a
  docstring showing the shell invocation with `<pw>` as a
  placeholder.

**Verified**
- ESLint: 0 real issues remaining. 3 blocking errors are all in
  shadcn-provided ui/ files (calendar.jsx unstable-nested-components,
  command.jsx unknown-property) — third-party generated, not
  touching per convention.
- 40 focused tests green (audit + DQ + DOB + drill-down + smoke).

## 7 Jul 2026 — Compact / Detailed density toggle on Presence

New icon button in the Presence header flips every column between
two densities:

- **Detailed** (default) — the existing rich card layout with sub-
  line (rank · category · institution chip), status chips
  (ExpectedReturnPill, excursions, sessions, days-remaining,
  half-day, late, overdue, notify), and GeoLine.
- **Compact** — photo, name, parent-contact icon, expand toggle
  only. Row padding shrinks from `py-2.5` to `py-1.5`. Everything
  else is hidden via `.hidden`.

Preference persists to `localStorage["presence.density"]` so it
survives refresh + browser restart. Button icon and label swap so
the button always shows the density you'd get by clicking it
("Detail" while in compact, "Compact" while in detail).

**Files touched**:
- `Presence.jsx` — `density` state + `toggleDensity` (persisted).
- `presence/PresenceHeader.jsx` — new toggle button after the
  members-count pill.
- `presence/Column.jsx` — passes `density` down to MemberCard.
- `presence/MemberCard.jsx` — `compact` prop hides sub-line, chip
  strip, and GeoLine; tightens vertical padding.

**Verified live**: On-campus column jumped from ~15 visible rows
to ~131 in compact mode; `localStorage['presence.density']` = "compact"
after toggle.

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

## 2026-06 — Full-codebase code review + critical fixes

**Review scope**: backend (server.py + all routes) & frontend, prioritizing
security, bugs, performance, quality. 466-test suite used as regression gate.

**Fixed (P1)**
- Merge-restore duplicated `sms_log` rows: docs had no `id` field so
  merge dedup could never skip them. Fix: `id` added at insert (sms.py),
  startup backfill for legacy rows, and content-match dedup fallback in
  `/api/admin/restore` for id-less docs (protects old backups too).
- Email/password backdoor: users auto-created via device approval got
  `password = phone digits` (guessable). Now random uuid hex; one-time
  startup backfill randomizes existing weak hashes (guarded by
  `sec_backfill_phone_pwd` config marker).
- Brute-force protection on `POST /api/auth/login`: 5 failed attempts per
  (ip,email) in a 15-min sliding window → 429. Backed by new
  `login_attempts` collection + index. Success clears the counter.

**Fixed (P2)**
- `Presence.jsx` `byColumn` useMemo missing `isHistorical` dep.
- `ChefsView.jsx` `cats`/`membersRaw` wrapped in useMemo (render-stable deps).

**Verified clean**
- All API endpoints auth-gated (only /members/{id}/photo public by design,
  UUID-keyed cacheable thumbs); no ObjectId leaks; no $regex injection;
  CORS `allow_credentials=False`; device_id uses crypto.randomUUID;
  ESLint: only stock shadcn use-toast warning remains.
- Full pytest suite: 466/466 passed post-fix.

**Known/deferred (unchanged)**: JWT in localStorage (P2 post-launch),
server.py size + large component splits (P3), `<option>` hydration warning
not reproducible in current codebase (no nested spans found).
