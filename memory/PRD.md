# I-showed-up — Product Requirements & Session Log

## Original problem statement
Port the "Attendance" mobile app for the youth competitive sailing academy (Yacht Club of Hyderabad) to a web-based app called "I-showed-up". Smooth operation for staff payroll tracking and sailor attendance. Requires audit logging, geolocation check-ins, single-glance admin dashboard, Muster Roll, self-check-ins, leaves, camps/regattas tracking, Meals/Pantry Stock tracking (Vendors, WAC pricing, drill-downs), and WhatsApp roster reporting.

## Live app
- Preview: https://attendance-portal-56.preview.emergentagent.com
- Production: https://i-showed-up.ychyderabad.com  ⚠️ **live prod — no auth/schema changes without explicit user approval**

## Tech stack
- React (CRA), TailwindCSS, Recharts 3.6.0, lucide-react, sonner
- FastAPI, Motor (Mongo), Pandas + Openpyxl for Excel I/O
- Gemini via Emergent LLM key (`daily_content` word/quote of the day)
- Twilio SMS (user's key), Web Share API + `whatsapp://` intents

## Roles / seed accounts
- Admin: `admin@attendance.app / Admin@12345`
- Super Admin phone: `9849002111`
- Chef role: seeded per member category
- See `/app/memory/test_credentials.md`

## Session log

### Feb 2026 (this session) — Meals Calendar polish + backend complexity pass + Kitchen Analytics UX + prod hotfixes

#### UI polish (Meals Calendar / Analytics Panel)
- Default date window = earliest available data → today (was current-month only). Backed by new `GET /api/meals/meal-calendar/bounds`.
- Meals KPI pills and analytics stat pills compacted to single-row icon-inline layout.
- Removed right-column donut + monthly-totals charts; expanded remaining Daily-trend + DOW-bar to full width.
- Fullscreen chart adds inline stat strip (Avg/Highest/Lowest/Days/Grand/BF:L:D).
- Trend chart: BF / L / D thin lines + bold Total line. Removed 7-day MA (redundant with DOW chart).
- Total line dot rendering: filled emerald dot + halo for days with per-person meal_records (source = "muster"); no dot for aggregate-only spreadsheet days. Backend adds `has_muster` flag to `/meal-calendar` response.
- Header trimmed: removed "Menu Master download" button; rename "Import (.xlsx)" → "Import Daily Meals (.xlsx)".
- Camp/Regatta/Break timeline strip now honours `days_of_week` — Sat/Sun-only camps render as per-weekend slivers instead of one solid bar. Backend `_pack` in `/meal-calendar/events` now includes days_of_week.
- Click any Total dot → **Meals Roster popup** listing every member who ate that day, grouped by category, with BF/L/D dots per row. Backed by new `GET /api/meals/day-attendees?date=`.
- Click any event band → **Event Details popup** showing name, dates, day-span, weekday chips (highlighted for Sat/Sun camps), level, location, institution.

#### Backend complexity refactor (23 helper extractions, 100 pytest cases)
Zero behaviour changes. All 6 affected endpoints verified live + via Playwright.

| Module | Extracted helpers | Tests |
|---|---|---|
| `holidays.py` | `_bucket_leave_rows` guard-clause + `_tally_approved_leave` | 12 |
| `daily_content.py` | `_is_valid_generated`, `_generate_or_fallback`, `_build_doc`, `_cache_daily_content` | 11 |
| `holidays.py` | `_absent_days_ytd` flattened + `_split_comp_off_sources` + `_expand_ranges_to_isos` | 14 |
| `routes/data_quality.py` | `_find_duplicates` (replaces 4 near-identical loops) | 8 |
| `routes/dashboard.py` | `_hydrate_top_users`, `_pack_events` | 10 |
| `routes/reports.py` | `_classify_timeline_day` + 5 hoisted constants | 12 |
| `routes/meals.py` | `_earliest_check_in_before`, `_covering_session_check_in` (meals_today) | 16 |
| `routes/meals.py` | `_weighted_rate_lookup`, `_kitchen_daily_series`, `_kitchen_item_rows`, `_kitchen_cat_pct` | 17 |

Test file locations:
- `/app/backend/tests/test_bucket_leave_rows.py`
- `/app/backend/tests/test_daily_content_helpers.py`
- `/app/backend/tests/test_holidays_helpers.py`
- `/app/backend/tests/test_find_duplicates.py`
- `/app/backend/tests/test_dashboard_helpers.py`
- `/app/backend/tests/test_timeline_classifier.py`
- `/app/backend/tests/test_meals_today_pickers.py`
- `/app/backend/tests/test_kitchen_analytics_helpers.py`
- `/app/backend/tests/test_day_attendees_hardening.py`   ← prod hotfix

#### Kitchen Analytics UX upgrade (matches Meals Calendar)
- **Default "All" preset**: window now spans earliest pantry activity → today. Backed by new `GET /api/meals/kitchen-analytics/bounds`.
- **Click a day on the Daily-trend chart** → detail popup listing every purchase / issue line for that day (item, category, vendor, qty, rate, amount + bulk-uploaded rows separately). Backed by new `GET /api/meals/pantry-day-detail?date=&kind=`.
- **Fullscreen expand** on Daily-trend cards (Purchases + Consumption) — Maximize icon opens the chart in a full-viewport modal.

#### Prod hotfixes (require redeploy)
- **`meal_day_attendees` 500** — sort key was calling `.lower()` directly on category/institution/user_name; a legacy prod row with a non-string value crashed. Hardened with `str(v).lower()` + try/except + per-field fallback. 6 pytests in `test_day_attendees_hardening.py`.
- **Chart-click wrong-date** — the Kitchen Analytics purchases-trend and Meals Calendar total-line click paths used `clickX / wrapperWidth` to compute the data index, which drifts by the Y-axis label width (up to ~60px each side on the dual-axis Kitchen chart). Rewritten to use Recharts' `activeDot.onClick` which carries the exact hovered `payload.date` — always shows the date the user visually clicked.

Full suite runs in **1.77s**. Frontend regression verified via `testing_agent_v3_fork` iter 49: 100% pass, no console errors, all 6 screens render + interact correctly.

### Sep 2026 — Code review fixes (5-meal rollout follow-through)
- `MealsAnalyticsPanel.jsx`: metrics memo, trend lines, DOW bars, slot-mix pills and day-roster popup now cover all 5 slots (was summing BF/L/D only → understated grand total vs Consumption KPI).
- `Meals.jsx`: added `midmorning` colour. `MealsCalendar.jsx`: 6-pill KPI grid responsive, Total pill de-duplicated colour.
- `meals.py` xlsx import: legacy 3-column sheets now write `midmorning=0, snacks=0` so stored `total` stays a true 5-slot sum on overwrite.

### Sep 2026 — Code review + hardening (see CHANGELOG 08 Sep 2026)
- Embed auth header-only (`X-Embed-Key`), EMBED_KEY-only, short TTL; key scrubbed from URL.
- PayCraft month lock now enforced on portal-native correction/leave writes (`services/grid_lock.py`).
- Cross-check tab sticky header done. Lint: 0 errors.

### Sep 2026 — DAR (Daily Activity Report) — see CHANGELOG 09 Sep 2026
- Mandatory DAR at self check-out for staff/coach/executive (per-member `dar_exempt`), stored per person/day,
  searchable admin viewer + CSV, Missed-DAR report, `dar_missed` in grid totals + `/api/dar/report` for PayCraft
  (payroll deducts a day per miss), WhatsApp share to configurable DAR group.
- WhatsApp check-in share caption includes geo distance.

### Sep 2026 — Executive Tasks — see CHANGELOG 09 Sep 2026
- Group-visible to-dos with deadlines/assignment, personal recurring checklists (daily/DOW/monthly), Today card +
  reminders after check-in, Share-my-day, ticks flow into DAR prefill; site name shown on check-in/out everywhere.
- Backlog from this: extend Tasks to staff/coaches (user said "for now only executives"); SMS/WhatsApp scheduled reminders.

### Sep 2026 — Elite DAR opt-in · modal dirty-guard · Task widget · Rules sign-off (CHANGELOG 09 Sep)
- Note for prod deploy: every staff/coach/executive (incl. admin accounts with those categories) is redirected to /rules once to accept v2026-09.

### Sep 2026 — Editable rules · save-guard rollout · Tasks for coaches (this session)
- **Edit Rules In-App**: admins get an "Edit rules" button on /rules → inline `RulesEditor` (edit section headings + rules one-per-line, add/remove sections, bump version). Version bump auto-forces re-sign (acceptances are version-keyed). Backend `PUT /api/admin/rules` already existed; this added the UI. Editor has its own discard-guard + validation (no empty/headed-only sections). Backend verified via curl: bump → accepted 0 / full roster pending; revert restores.
- **Save Guard everywhere**: extended `TopSaveButton` + `useDirtyForm` (Esc/backdrop/X discard-confirm, amber dirty-glow) to FleetForm (Fleets), InstForm + EscortForm (Institutions), ApproveDialog (Devices), and ApplyForm (MyLeaves). MyLeaves submit now also re-checks `noticeBlocked` since the top button bypasses the disabled bottom button.
- **Tasks for Coaches**: `TASK_CATEGORIES = {"executive","coach"}` — coaches join the SAME shared team board (execs + coaches see each other's to-dos). Layout nav + `/tasks/today` query enabled for admin|executive|coach. New `RequireTasks` route guard in App.js redirects everyone else home (staff no longer sees the /tasks shell). `TaskProgressCard` relabelled "Team tasks today". Verified: coach curl access to all task endpoints, testing_agent iter55 100% pass, staff regression (no nav, 403).
- Coach test account added: `coach.test@example.com / Coach@12345`.
- Deploy: `.gitignore` no longer ignores `.env` files (deploy system needs them present). deployment_agent → PASS.

### Sep 2026 — DAR ✗ column on the attendance Grid (this session)
- Added a right-sticky "DAR" totals column (sub-label "Miss") to the admin Calendar Grid, sitting just left of the P (Present) column at sticky offset right-[244px]. Shows a red "✗N" for members with N missed DARs in the grid's month, blank for 0. Backend `dar_missed` already flowed in grid row totals (`reports.py` ~1316) — this surfaces it.
- Double-clicking a DAR cell deep-links to the DAR report's Missed tab pre-set to the grid's month and scrolls/highlights that member's row (`DarReport.jsx` now reads `tab`/`member`/`month` URL params via useSearchParams). Selectors: `cal-total-dar-<id>`, `dar-tab-missed`, `dar-missed-row-<id>`.
- Sticky offsets: LT=0, EO=34, OT=68, TR=108, LV=142, AB=176, P=210, DAR=244. Grid colSpans bumped +7→+8. testing_agent iter56: 100% pass, no overlap, ledger-modal regressions OK.

### Sep 2026 — High-contrast zebra across all reports (this session)
- Q: the payroll-facing "staff attendance register print" = **The Grid** (sidebar → The Grid / Reports). Calendar Grid tab → **PDF** button gives the printable per-member×per-day register (P/AB/LV/TR/OT/DAR totals) — the rules call this "the single source of truth for payroll". Attendance tab → PDF/CSV gives the monthly summary. Endpoints: `/reports/calendar-grid/export`, `/reports/hours/export`.
- Strengthened zebra to a significant-contrast band (even rows solid `bg-slate-200`, odd `bg-white`, hover `bg-sky-50`) across every report surface: Calendar Grid rows (`CalendarGridTab.jsx`, was faint slate-50), Attendance table (`AttendanceTab.jsx`, was slate-200/80 — colored group columns use /50 alpha so the darker even-row base now bands through), Leave Balances (`LeaveBalances.jsx`, dirty/active highlights still win), DAR Missed table (`DarReport.jsx`, flagged-member row still wins with sky-100+ring), Meals Report details list + monthly table (`MealsReport.jsx`), and the Daily Leave/Tour lists (`SectionList.jsx`). All className-only, compiles clean.

### Sep 2026 — LOP in payroll register + PayCraft feed + grid fits screen (this session)
- **Calendar Grid PDF/CSV export** now includes an **LOP** total column and a **DAR X** (missed-DAR) column, and the legend lists `LP=Loss of pay` + `DAR X=missed DAR` (`reports.py` calendar-grid/export). Day widths trimmed to 7mm and totals to 9 columns so the wider table still fits A3 landscape. Verified via curl: CSV headers include LOP + DAR X; PDF returns valid 200.
- **PayCraft `/leave-balances` key feed** returns a **`lop_month_days`** field per member — the loss-of-pay days for the requested month (`?month=YYYY-MM`, defaults to current month). Response also carries the resolved **`month`** ("2026-09") + human-readable **`month_label`** ("September 2026") at the top, and each row echoes **`lop_month`** so every LOP value is self-describing when finance imports it into a payroll sheet (knows exactly which cycle it covers). Computed by reusing the grid engine (`router.grid_impl` exposed from reports.py → `_GRID_IMPL` in server.py), so the number is the EXACT same LP the admin grid shows (curl-verified: zero mismatches vs grid). Existing `balances` shape untouched; admin (non-key) path unaffected. (Replaced the earlier `lop_ytd_days` YTD field on user request — payroll wanted per-cycle month LOP.)
- **On-screen Calendar Grid now fits without horizontal scroll**: Reports container widened to `max-w-none`, day columns 28px→24px (`w-6`), sticky Member column 160px→132px. Table is ~1158px wide — fits at 1536/1920 with slack (testing_agent iter57: 100%, scrollWidth==clientWidth, all 30/31 days visible, totals intact, 2-letter codes readable).
- Note: the payroll "attendance register print" = The Grid → Calendar Grid tab → PDF (per-member×per-day register); Attendance tab → PDF/CSV = monthly summary.

### Sep 2026 — LP totals column + thin column separators on the on-screen grid (this session)
- Added a dedicated **LP** (loss-of-pay) totals column to the on-screen Calendar Grid right-sticky strip, positioned immediately left of LV (pink, `cal-total-lop-<id>`); removed the old cramped LOP pill badge on the LV cell. Strip is now 9 columns: DAR, P, AB, LP, LV, TR, OT h, EO, LT (offsets DAR=278…LT=0). `t.lop` = count of `LP` day-cells that month (same source as the PDF). testing_agent iter58: 100%, aligned, values correct, still no horizontal scroll.
- Added **thin vertical separators** between every totals column: `border-l border-slate-200` on the shared cell `base` + both header rows; DAR keeps its stronger `!border-l-2 border-slate-300` divider (totals-vs-days boundary). Borders are inside the fixed 34px cells (border-box) so no offset shift.
- Fixed the LV tooltip wording (now "Leave + Comp-off") since LOP has its own column.

### Sep 2026 — App-wide code review fixes (this session)
- **[MEDIUM] PayCraft feed 500 on bad month** — `/leave-balances?key=&month=` now validates `month` against `^\d{4}-(0[1-9]|1[0-2])$` and returns a clean **400** (was an unhandled 500 from `calendar.month_name[int(...)]`). Verified: `2026-13`/garbage → 400, `2026-09` → 200.
- **[MEDIUM] Rules sign-off integrity** — `PUT /admin/rules` now **rejects (400)** editing the rule TEXT without bumping the version (acceptances are version-keyed, so a silent same-version edit would leave staff marked as accepting wording they never saw). No-op resaves (same content) still succeed; text edit + new version works. Frontend RulesEditor pre-warns before hitting the backend. Audit now records before/after sections + `content_changed`.
- Reviewer LOW notes were non-issues: the 9-column grid sticky-offset math is consistent (0/34/68/108/142/176/210/244/278), `_GRID_IMPL` module-global is import-time (no None/timing risk), key endpoints use constant-time compare (rate-limiting is P3).
- KNOWN/BY-DESIGN: the grid `leave` total intentionally includes LP days (backward-compat) AND LP has its own column — on the printed register don't sum "Leave + LOP" (double-counts). Payroll should read the feed's `lop_month_days` / `balances`, not the printed Leave+LOP sum. Left as-is to keep screen ↔ print ↔ feed numbers consistent.

### Sep 2026 — Performance: PayCraft feed speedup (this session)
- Optimised `GET /api/leave-balances?key=` (the PayCraft server-to-server feed):
  1. Added lightweight `compute_pay_balances()` in holidays.py — returns ONLY paid-leave + comp-off available, skipping the expensive `_absent_days_ytd` YTD walk (3 queries + ~250-day loop per member) that `compute_balance_summary` runs but the feed never used. Values byte-identical.
  2. Parallelised the per-member balance loop with `asyncio.gather` + `Semaphore(16)` and ran the month-grid engine concurrently with it (were serial).
- Result: server compute ~0.135s → ~0.078s (~42%); end-to-end via ingress ~0.30s → ~0.19s (~37%). Balances/LOP verified identical to before; admin (non-key) path, bad-key 401, no-auth 403, bad-month 400 all regression-pass.
- Confirmed `GZipMiddleware` (minimum_size=500) is already enabled app-wide, so large JSON payloads (grid/reports) are compressed over the wire. No further change needed there.

### Sep 2026 — Suggestions feature (any user) (this session)
- New **Suggestions** item in the main member menu (`Layout.jsx` NAV_MEMBER, Sparkles icon) → `/suggestions` page (`pages/Suggestions.jsx`), route wrapped in RequireMember (all real app users; escorts excluded like /rules & /profile).
- Any signed-in user can submit an idea (text + optional area tag) and see their own past suggestions with a status badge + any admin note. Admins get an extra "All suggestions" tab to view everyone's, with a per-row status dropdown (new / planned / in_progress / done / declined) and counts.
- Backend `routes/suggestions.py` (`suggestions` collection, uuid id): `POST /api/suggestions`, `GET /api/suggestions/mine`, `GET /api/admin/suggestions` (admin, +counts), `PATCH /api/admin/suggestions/{id}` (admin, status/admin_note, audit-logged). Wired in server.py after the rules router.
- Verified: backend curl (submit, mine, admin list+counts, PATCH, non-admin 403, bad-status 400) + testing_agent iter59 100% (nav item, submit+toast+refresh, admin all-tab, admin-note propagation).

## Backlog (prioritised)

### P1 — user-requested, not blocked
- **Pantry CSV export** — spreadsheet download alongside Print/PDF on Meals/Pantry Report
- **Weekly Meal-Skip Pattern** — per-weekday overrides for members who skip specific weekdays (Sunday-off drivers)
- **Payslip PDF + Payroll worksheet CSV** for staff
- **Group-Photo Muster check-in** — coaches take one wide shot, run face-recognition, bulk check-in
- **Menu-vs-Actual / Expected Consumption** — ON HOLD until user supplies updated Diet & Recipe files
- **Phase 3 Consumption cross-check** — Qty issued vs meal counts × per-item norms
- **Menu-planner pre-fill** — pick tonight's menu, auto-fill issue quantities from portion norms

### P2 — user-requested, needs clarification
- **Phase 2 Profile data additions** — BLOCKED on exact list of fields (medical / sizing / emergency contacts?)
- Audit logging enhancement for Purchases
- Future-dated purchases
- Monthly attendance certificate PDF for Athletes
- Production data wipe/reset

### P3 — future
- Migrate existing user emails from `@sailors.local` → `@athletes.local`
- SMS OTP hardening
- Regatta "locked / manually edited" flag
- DMS input mode toggle for Training Location coordinates
- **Wiki module** — deferred; option (a) in-app wiki with Claude-drafted articles vs (b) self-hosted MediaWiki. Real Wikipedia editing declined (notability + AI-content policy risk).
- **Role-based sidebar restructure** — proposed but PENDING user decision:
  - Coach: trim Kitchen to Meals Muster + Chef's View (drop Pantry Stock, Kitchen Analytics, Meals Calendar)
  - Chef: hide Escorts Check-in/Out; retain full Kitchen access
  - Members: no changes

## Known behavioural quirks (locked by tests)
- `escort` bucket is **NOT** in ACCOUNTED — escort-duty alone on a workday still classifies as absent (verified by pytest lock; matches pre-refactor).
- Meals Calendar terminology: frontend says "Consumption" everywhere per user request; backend keys still say `issues` / `meal_issues` — DO NOT rename to avoid migration risk.
- Auth stays in localStorage (HttpOnly cookie migration was considered but explicitly SKIPPED — would log out live prod users).

## Data health snapshot (as of 21 Aug 2026)
- Meals data: 01 Jun 2026 → 21 Aug 2026 (spreadsheet imports Jun-Jul; live muster 08-20 Aug)
- Data Quality: 171 findings (29 high, 26 medium, 65 low, 51 info); 4 duplicate categories flagged
- Kitchen analytics window (Aug): ₹76,233 across 67 items in 168 line entries

