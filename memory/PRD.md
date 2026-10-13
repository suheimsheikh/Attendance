# I-showed-up — Product Requirements & Session Log

## USER PREFERENCES (PERMANENT — apply to EVERY reply)
- When done with any task, end with a short bullet summary: "What you asked → What I changed" (one bullet per ask; flag anything not done or done differently).
- Respond in English. Pay = number of payable days only — never add salary/amount figures.
- Live data: never modify real members/attendance/issues without explicit approval.


## Latest change (Jun 2026) — Leave/Tour report: reliable one-time daily lock
- Bug: after one admin posted the daily Leave/Tour list to WhatsApp, the prompt kept reappearing for other admins. Root cause: both posters (`LeaveReportPrompt.jsx` modal + `dashboard/RosterStatusChip.jsx` "Post now") called `/leave-report/mark-posted` AFTER `shareToWhatsApp(...)`; on mobile the OS share sheet backgrounds the tab and the trailing request was dropped, so the day was never locked.
- Fix: lock the day FIRST (`mark-posted`), THEN open WhatsApp, in both entry points. Matches the existing "tap = done" decision. Backend lock (`leave_report.py`, `$setOnInsert` upsert, first admin wins) was already correct and verified e2e (first admin wins, second sees posted, no overwrite).

## Latest change (Jun 2026) — Late-arrival reason prompt
- Self check-in now ASKS WHY when a member is late. `SelfCheckIn.jsx` computes `lateInfo` client-side (now > work_start + office grace, non-hourly only); when late, auto check-in is suppressed so the member sees an amber "Reason for being late (required)" ReasonPrompt (testid `late-reason`) and taps in manually.
- **Mandatory:** reason is now REQUIRED. Frontend disables the check-in button (`lateBlocked`) and blocks `handleToggle` until a reason is entered; backend `_geo_toggle` rejects a late SELF check-in with no reason via `400 LATE_REASON_REQUIRED:<min>` (admin/proxy `by=<id>` paths exempt).
- **Quick-picks:** the late prompt reuses `ReasonPrompt`→`ReasonPicker`, which already renders "Your previous reasons" chips from `/api/me/reasons`; late reasons are saved to that same personal bank, so repeat reasons are one tap next time.
- Reason sent as `late_reason` on `/api/attendance/geo-toggle`; stored on the attendance row only when `late` is true. Surfaced to admins in the Grid LT tooltip (`grid.py` cell_meta) and profile-details late list (`server.py` `late_this_month_list[].reason`).
- Early-out reason prompt already existed (`earlyOutInfo`, `early_out_reason`) — unchanged.
- Verified e2e: no-reason late check-in → 400; with-reason → 200 and stored.

## Original problem statement
Port the "Attendance" mobile app for the youth competitive sailing academy (Yacht Club of Hyderabad) to a web-based app called "I-showed-up". Smooth operation for staff payroll tracking and sailor attendance. Requires audit logging, geolocation check-ins, single-glance admin dashboard, Muster Roll, self-check-ins, leaves, camps/regattas tracking, Meals/Pantry Stock tracking (Vendors, WAC pricing, drill-downs), and WhatsApp roster reporting.

## Live app
- Preview: https://youth-regatta-app.preview.emergentagent.com
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

### 12 Oct 2026 — Absentee WhatsApp dispatch: coaches + camp-days (Phase 1, shipped)
- Reused the existing daily absentee-dispatch prompt; two gates added, minimal diff:
  - `routes/muster.py` `/muster/absent-dispatch` GET+POST now allow **admins OR coaches** (category=coach, non-escort), gate to **camp days** (`fetch_camps_active_on`), and require coaches to be **checked in today**. GET returns `is_camp_day` + `eligible`; POST 400s off-camp and 403s an un-checked-in coach. Removed the dead `_require_admin` helper.
  - `Layout.jsx`: mount the prompt for coaches too (`isAdmin || category==='coach'`).
  - `AbsentDispatchPrompt.jsx`: bail unless `is_camp_day && eligible`; "sent by" fallback wording.
- Unchanged (per plan): once-per-day group-wide sent flag, message content (Absent·Late·Leave·Tour·LOP), 10:00 cut-off, WhatsApp share-sheet flow, per-device "Not now".
- Verified via curl end-to-end: admin eligible on camp days / silent off-camp; coach eligible only when checked in; coach POST sets the shared flag; non-camp POST→400. Frontend compiles. Phases 2 (manual button, group hint) & 3 (per-parent messaging via WA Business API / SMS) deferred.

### 12 Oct 2026 — Prod "refresh" banner nagging forever (fixed)
- Symptom: production continuously showed the red "new version available" banner, even after refreshing.
- Root cause: `routes/office.py _cached_version()` fell back to `boot-<timestamp>` (container start time) when neither `APP_VERSION` env var nor a `.git` dir was present — which is the case in the deployed image. With multiple replicas (or any pod restart), each pod returned a DIFFERENT `boot-...`, so the frontend's 5-min `/api/version` poll flapped between pods → banner never cleared. (Frontend `VersionPoller.jsx` logic was fine.)
- Fix: replaced the clock fallback with a DETERMINISTIC md5 content-hash of the backend source (`*.py` in backend root + routes/ + services/). Identical across every replica of the same build; changes only when backend code changes; last-resort returns the constant "app", never the clock. Verified: identical hash across two separate processes; `/api/version` still returns the git SHA in preview.
- ⚠️ Needs a REDEPLOY to take effect in prod (the deploy that was in-flight when this was reported does NOT include the fix). Optional best practice: have the deploy set `APP_VERSION` to the git SHA for the cleanest signal.

### 12 Oct 2026 — Half-day leave: partial cell shading + one-time dedupe button (shipped)
- **Half-day shading**: a half-day leave Grid cell is now partially shaded — TOP half for first-half (FN), BOTTOM half for second-half (PN). Frontend-only change in `calendar-grid/gridHelpers.jsx` `GridCell()` (LV/LP + `meta.half_day`): light-amber `<td>` with an absolute half-height overlay (amber-300; rose-400 for LP), `data-testid=grid-cell-halfday-<iso>`, `data-half-day=FN|PN`. Backend already supplied `cell_meta[iso].half_day`. Verified: testing_agent iteration_117 (100%) + authenticated screenshot (LV total also = 0.5).
- **One-time dedupe button**: admin-only Maintenance card on the Backup & Restore page ("Clean duplicates & enable safeguard") → `POST /api/admin/attendance/dedupe` (+ `GET .../dedupe-status`) in `admin_tools.py`. Keeps the completed/earliest session per day, deletes duplicate copies, then builds the unique index. Idempotent; audit-logged. Verified: testing_agent iteration_116 (100%, button disabled/"Already clean" when 0 dups + index on). ⚠️ Run once on PRODUCTION (the page button) to clean prod's legacy duplicates and switch on the one-per-day guard there.
- **Screenshot auth**: authenticated screenshots now use JWT injection (UI login + networkidle were unreliable) — recipe saved in `/app/memory/screenshot_auth_tip.md`.

### 12 Oct 2026 — Ponytail review fixes #2/#3/Muster/#1 (follow-through, shipped)
User approved actioning the held items. All done + verified:
- **#1 Dedupe & enforce (DONE):** ran `scripts/dedupe_attendance.py --apply` on preview (removed 8 loser rows across 7 groups, kept completed sessions); the unique index `attendance.uniq_user_date` now **builds and enforces** (verified present + a duplicate insert raises DuplicateKeyError). ⚠️ PRODUCTION still needs the same: run the dedupe `--apply` on prod then redeploy so the index builds there too (the defensive guard logs a warning until then).
- **#2 Half-day leave on the Grid (DONE):** `_grid_impl` now counts a half-day LV cell as **0.5** in both `leave` and `payable` totals (single-day half-days; only when the cell is actually LV, i.e. no attendance). Verified live: half-day LV → leave 0.5 / payable 1.5, matching the 0.5 balance deduction. Members who worked the other half (cell P/LT) are unaffected. CSV/PDF export + totals strip render the fraction fine.
- **#3 Cross-year leave (DONE):** `holidays._bucket_leave_rows` + `_tally_approved_leave` now prorate paid/LOP by the in-year day fraction (new `_days_in_window`); queries widened to overlap. Applied to all three balance paths: member summary (`compute_balance_summary`), PayCraft feed (`compute_pay_balances`), and the admin Leave Balances page (`server.py list_leave_balances`). Verified: a 29 Dec→2 Jan leave counts only its 2 in-2026 days. In-year leaves unchanged (fraction=1); no-bounds call keeps old maths (back-compat).
- **Muster parity (DONE):** `/muster/absent-report` already filtered athletes to camp-expected only; added the missing pre-joining (NJ) exclusion so not-yet-joined athletes/coaches are never flagged absent — now mirrors the Grid.
- Tests added: `tests/test_attendance_one_per_day.py` (index enforcement now passes), `tests/test_cross_year_leave.py`. Regression: 130+ pytest pass (holidays, half-day, comp-off, grid OT, smoke, presence parity).

### 12 Oct 2026 — App-wide "Ponytail" review fixes (shipped + warnings)
Ran a read-only app-wide audit (ponytail.dev methodology). Actioned:
- **#1 Duplicate attendance day (concurrency) — code shipped, index deferred.** All four check-in insert paths (self geo `attendance_actions.py`, console/card, muster bulk `muster.py`, admin correction `corrections.py`) now catch `DuplicateKeyError` and return the normal "already checked in" response. Added a DEFENSIVE unique index `attendance.uniq_user_date (user_id, date)` in `_seed_database` (wrapped in try/except — logs a warning and continues if legacy duplicates block it, never crashes startup). Added review-only `scripts/dedupe_attendance.py` (dry-run default; keeps the completed/richest row per day). ⚠️ The index will NOT enforce until existing duplicate rows are removed — preview has **7 groups / 8 rows**; production likely has some too. Needs explicit approval to run `scripts/dedupe_attendance.py --apply` then redeploy.
- **#4 Tests — shipped.** `tests/test_attendance_one_per_day.py`: index-aware uniqueness test (skips with an actionable message until dups cleaned) + API guard test (second same-day check-in → 400 ALREADY_CHECKED_IN, still exactly one row).
- **#6 Blocking file I/O — shipped.** `/api/changelog` read offloaded via `asyncio.to_thread`; recipes one-time seed now uses `with open(...)` (fixed a leaked file handle).

Held/declined with warnings (would risk live-payroll regressions):
- **#2 Half-day leave Grid count** — NOT changed. The Grid paints a half-day leave as a full `LV` (counts 1 payable/1 leave) while the balance deducts 0.5. BUT the PayCraft feed's balances come from `holidays.compute_pay_balances` (correct 0.5) and only `lop` flows from the Grid — so payroll balances are NOT wrong; only the on-screen/printed register count is simplified. Changing it alters the live payroll register (policy decision) — awaiting explicit approval.
- **#3 Cross-year leave** — NOT changed. A leave starting in prior Dec running into Jan is excluded from the new year's balance (query filters `start_date >= Jan 1`), so balance can read slightly high. A correct fix needs per-year day-splitting (the `paid_leave_used` stamp is whole-leave, so naively widening the query would double-count December into the new year). Minor edge; awaiting approval.
- **#5 "Dead imports"** — NOT removed. The flagged imports in `routes/reports/common.py` and `routes/meals/common.py` are intentional RE-EXPORT hubs (siblings do `from routes.meals.common import json, asyncio, DuplicateKeyError, ...`). ruff F401 is a false positive here; deleting them would break sibling imports. Declined to avoid a build-breaking regression.
Verified: 65+ pytest pass (smoke, meal muster, presence, corrections); backend boots clean; changelog endpoint OK.

### 12 Oct 2026 — Presence ↔ Grid parity for athletes (bug fix, shipped)
- **Report**: "In Presence, Away is also showing non-camp athletes. Presence and Grid should reflect the same truth."
- **Root cause** (in `routes/presence_board.py`): athlete-like members are tracked ONLY on camp days (Grid blanks a non-camp athlete and excludes them from totals). Presence only applied that hide-rule in the no-session/no-leave branch, so a non-camp athlete with an approved leave/tour or a scope-break slipped into the merged "Away" (on_leave + on_tour) column. Live data confirmed it: with NO camp active today, 11 athlete-like members showed in Away (10 on a break, 1 elite on leave).
- **Second latent bug found + fixed**: Presence passed the FULL weekday name (`"saturday"`) to `camp_active_on`, which compares against stored SHORT `days_of_week` keys (`"sat"`) — so every day-of-week-filtered camp (e.g. the Agape Sat/Sun weekend camp) silently never matched in Presence. Switched to `camps.WEEKDAY_KEYS` (mon..sun) to match the Grid.
- **Fix**: a single top-of-loop guard (runs before the leave/tour/break branches) now mirrors the Grid exactly for athlete-like members: hide them when outside their joining/leaving window (Grid NJ/LF) OR when not expected at a camp today AND no physical check-in (Grid blank). A real check-in still surfaces them (Grid P/LT). Removed the now-redundant inner hide. Added `joining_date` to the presence projection.
- **Verified**: Presence athlete set == Grid "tracked" (non-blank, non-NJ/LF) athlete set with **0 mismatches** on 2026-07-11, 2026-07-18 (weekend camp) and 2026-08-20 (weekday camp); live board today shows 0 athlete-like in Away (54 members vs 65 before). New pytest `tests/test_presence_grid_parity.py` (4 cases) + existing presence/dashboard suites all green. ⚠️ Needs REDEPLOY (no data/schema change).

### 12 Oct 2026 — Presence Board split (Refactor #5, shipped)
- Moved the big read-only `GET /api/presence` Presence Board endpoint (plus its private `_make_absence_streak_computer` helper + `_WEEKDAY_KEY` constant) OUT of the monolithic `server.py` into a new module **`backend/routes/presence_board.py`** — `make_router(db, get_current_user)`, wired via `app.include_router` near the bottom of server.py. ZERO behaviour change: identical JSON shape, identical route path. server.py shrank ~718 lines (3144→2432).
- The pre-existing `routes/presence.py` (ephemeral heartbeat + `/meals/focus` row-focus signals) is a DIFFERENT concern and was left untouched — hence the new file is `presence_board.py`.
- Regression anchor: captured `/api/presence?on=<date>` for 2026-10-06 / 2026-09-15 / 2026-08-20 BEFORE the move and confirmed **byte-identical** AFTER (historical views are deterministic). Live "today" view matched too (65 members, same counts).
- New pytest `backend/tests/test_presence_board_split.py` (shape, counts-sum-to-total invariant, full member key set + null site on off-status rows, historical determinism, by_location only-present). All green alongside existing `test_presence_by_location.py` + `test_presence_break_precedence.py`.
- Independent verification: testing_agent iteration_115 → **100% backend + 100% frontend, zero issues**. Confirmed sibling heartbeat endpoints (`/presence/online`, `/presence/public`, `/presence/ping`) and the Admin Dashboard `now.on_campus_by_location` aggregate were unaffected.
- Note: `parent-notify/dispatch` was deliberately left in server.py (out of scope). ⚠️ Needs REDEPLOY to reach production (no data/schema/auth change).


### 06 Oct 2026 — Member Archive · Leave policy · Athlete camp-absent · WhatsApp (this session)
Twelve user requests across 4 areas (all tested; backend curl-verified, frontend testing_agent iter 81 = 95%, no issues in new code):
- **(A) Members Archive + approval-gated delete/archive + actions-left**
  - New reversible `archived` state on users (distinct from ex-member/`leaving_date`). Hidden from EVERY roster surface: `/members` (default; `?include_archived=true` for the archived view), grid (`reports._grid_impl`), presence, muster (checkin roster + absent/late/daily-roster), leave-balances (admin + PayCraft feed), members-api feed, cards, hours report.
  - Endpoints: `POST /api/members/{id}/archive`, `POST /api/members/{id}/unarchive`, `DELETE /api/members/{id}` (now approval-aware). **Super Admin** archives/deletes directly; a **regular admin** only *requests* it → a pending correction (`entity_type="member"`, kind `member_archive`/`member_delete`, `needs_super_admin=True`) in the unified Approvals screen; a Super Admin approves → applier runs (`routes/corrections.py`). Non-super filer gets 403 if they try to approve their own.
  - Members UI: all controls (Edit · File-correction · Archive/Unarchive · Delete) in ONE left sticky "Actions" column; far-right Del column removed. Member sticky offset `left-16`→`left-28`. New `archived-view-toggle`.
- **(B) Leave policy** — removed the hard advance-notice BLOCK (anyone may apply anytime incl. backdated). Short-notice = applied ≤3 days before start (or backdated): first **2 per calendar month** use the normal paid ladder; the **3rd+ auto-forced to LOP** (`short_notice`/`short_notice_lop` stamped on the leave, split overridden). Frontend: `leave-short-notice-warning` soft amber banner, submit never disabled. Four-eyes: an admin who filed a leave on behalf cannot approve it (`decide_leave` 403). "Who applied / who approved" shown on MyLeaveRow + Approvals row (`filed by …`, short-notice tag).
- **(C) Athletes absent only if expected at a Camp** — grid `_classify` final branch → `_absent_or_blank`: athlete-like members get `AB` only on dates they're an enrolled participant of a camp/regatta covering that date (via `camps.camp_active_on`/`camp_applies_to`); otherwise the cell is BLANK (excluded from totals). Same rule filters `/muster/absent-report` (non-expected athletes never flagged absent / never parent-notified). Employees unaffected. Verified: July (Agape Sat/Sun camp) members get AB only on camp days; Sept (no camps) = 0 athlete AB.
- **(D) WhatsApp** — `shareCheckinToWhatsApp({noPhoto})`: check-OUT share is now text-only. New `share-stepout-btn` (text-only step-out post) on the "Returning to campus?" card. Admin's own check-in share appends a `*Today's attendance summary*` block (on leave / on tour / LOP / absent) via `/muster/daily-roster` + `/muster/absent-report`. New `AbsentDispatchPrompt` (mounted in Layout for admins): once/day, at/after 10:00 local, if absentees/leave/tour exist, a dismissible modal nudges sending the day's summary to the WhatsApp attendance group (localStorage-gated per day).
- Known/out-of-scope (pre-existing, flagged by testing_agent): Add-member form shows a bare "Request failed" on a 422 (e.g. empty weekly_off, or reserved-TLD email like .local/.test). Not changed — unrelated to this work & live-prod sensitive.


### 25 Sep 2026 — Wages in the Consumption view (cont.)
- Answered "where to enter wages": Meals → **Expense report** tab → **Kitchen Overheads** card (Super-Admin only; monthly wage bill + optional incidentals + "Backfill ₹75,000 to all months").
- Extended the request to the **Consumption** page (main menu → `MealsCalendar.jsx`, `/api/meals/meal-calendar`): wages now sit BETWEEN purchases and issues and are folded into cost/meal.
  - Backend `meal_calendar_list`: added per-day `wage_cost` (apportioned via `_overhead_daily_map`) and totals `wage_cost`, `wage_cost_per_meal`, `purchase_cost_incl_wages`, `issue_cost_incl_wages`, `purchase_cost_per_meal_incl_wages`, `issue_cost_per_meal_incl_wages`. Raw `purchase_cost_per_meal`/`issue_cost_per_meal` kept for back-compat.
  - Frontend `MealsCalendar.jsx`: KPI strip now Purchase → **Wages** → Issue → **₹/Meal (incl. wages)**; table gained a violet **Wages ₹** column between Purchase and Issue; per-month + footer ₹/Meal now = (issue + apportioned wages) ÷ meals.
  - Verified (curl): Sep 2026 issue ₹73.53 + wage ₹58.00 = ₹131.53/meal. Screenshot confirms KPIs + column. Frontend compiles clean.
  - Minor known nuance: KPI/footer wage totals (backend, apportioned over all calendar days in range) can differ slightly from the sum of visible month sub-rows on ranges with no-data days — the KPI/footer are authoritative. Not chased.
- ⚠️ Needs REDEPLOY; prod seeded via the Backfill button after deploy.



### 25 Sep 2026 — Kitchen Overheads → fully-loaded cost/meal
- Need: enter monthly kitchen staff wage bill (+ optional incidentals) so cost-per-meal is fully loaded, not food-only. User choices: monthly lump-sum wage bill; incidentals mostly already flow through purchases (Gas/Cleaning are purchase categories); apportion EQUALLY per day across the month; blended across all meals; Super-Admin-only edit; backfill ₹75,000/month.
- Backend (`routes/meals.py`): new `meal_overheads` collection `{month, staff_wages, incidentals, note, updated_by, updated_at}`. Endpoints: `GET /meals/overheads` (list, chef/admin view + `can_edit`), `GET /meals/overheads/{month}`, `PUT /meals/overheads/{month}` (Super-Admin), `POST /meals/overheads/backfill` (Super-Admin, idempotent, default_wages 75000, fills months present in meal_records lacking an entry). Super-admin gate via `is_super_admin` + require_admin.
- `meal_expense_report` now apportions each month's overhead equally per day (`_overhead_daily_map`), adds per-day `overhead`/`total_expense`, and totals: `overhead_total`, `expenses_with_overhead`, `food_cost_per_meal`, `overhead_cost_per_meal`, `total_cost_per_meal` (fully-loaded). Existing `avg_cost_per_meal` kept FOOD-ONLY for backward compat.
- Frontend (`MealExpensesTab.jsx`): Super-Admin `OverheadEditor` card (wage bill + incidentals + Save + "Backfill ₹75,000 to all months"); read-only line for non-super. Summary cards now show Food Expenses, Kitchen Wage Bill (apportioned), Food Cost/Meal, and Fully-loaded Cost/Meal. CSV + print header updated with loaded figures.
- Verified: backend curl (Sep 2026 → food ₹137,565.65 + overhead ₹75,000 → fully-loaded ₹187.78/meal; food ₹121.52; overhead ₹66.25); super-admin gate (admin OK, non-super rejected); UI screenshot shows editor + all 5 cards. PREVIEW SEEDED via backfill (2026-08, 2026-09 @ ₹75,000). Frontend compiles clean.
- PROD seeding: super admin clicks "Backfill ₹75,000 to all months" in production after deploy (I can't reach the prod DB from preview). ⚠️ Needs REDEPLOY.



### 22 Sep 2026 — External roster API (Athlete Health Dashboard)
- Added a server-to-server bearer-token path to `GET /api/members` for an external "Athlete Health Dashboard" to pull the roster + parent/guardian phones nightly. Reuses the codebase's existing external-key convention (hmac.compare_digest), NOT a new auth system.
- New env `MEMBERS_API_TOKEN` (backend/.env). New helpers `valid_members_api_token`, `_bearer_from_header`, `_last10_digits`. Branch sits ABOVE the JWT check (the same Authorization header would otherwise be parsed as a failing JWT), below the `?key=` payroll branch.
- Response: `{"members":[...]}`. Each member: `id, name, role, guardian_name, guardian_phone (+guardian_mobile/guardian_number aliases), mother_name/mother_phone/mother_mobile, father_name/father_phone/father_mobile, contacts[] {role,name,phone}, phone (guardian→mother→father→self fallback)`. Phones normalised to last-10 digits. WHITELISTED projection — never exposes PIN/password/hashed_password/attendance. Returns all non-left members (123).
- Verified via curl: valid token → 200 (123, all fields, no sensitive keys leaked); no token → 401; wrong token → 401. Regression OK: admin-JWT path still returns the UserPublic list (frontend), PayCraft `?key=` still returns rows.
- ⚠️ Needs REDEPLOY so the token/endpoint work in production. Token value delivered to user in chat for their app's `ATTENDANCE_API_TOKEN`.



### 22 Sep 2026 — Off-site place name in WhatsApp (reverse geocoding)
- Request: use GPS to say roughly WHERE a person checks in/out from, with a place name. User choices: OpenStreetMap/Nominatim (free, no key), WhatsApp message only, OFF-SITE check-ins only, short area name.
- New `backend/services/geocode.py` → `reverse_geocode_area(lat,lng)`: Nominatim `/reverse` (jsonv2, zoom 16, addressdetails), custom User-Agent per policy, coord-rounded in-process cache (~11 m), 4 s timeout, best-effort (None on failure). Builds "<locality>, <city>" from address parts. httpx already in requirements (0.28.1) — no dep change.
- `server.py` `_geo_toggle`: for OFF-SITE (out_of_geofence and GPS present) check-in → store `place_name`; check-out → store `exit_place_name`; both returned in the toggle response (as `place_name`). On-site / no-GPS → None (no lookup). Runs only for the handful of off-site punches/day, so well inside Nominatim limits.
- Frontend: `formatCheckinCaption` new `placeName` param → appends `📍 <area>` ONLY when off-site; `shareCheckinToWhatsApp` + `lastAction` + persistent `status.session` all carry it.
- Verified: service (Charminar→"Panjeshah, Hyderabad", Hitech City→"Madhapur, Hyderabad"), full API off-site check-in (7.3 km away → `place_name` returned + stored), caption (`… ⚠️ 7.3 km from YCH Head Office (OFF-SITE) · 📍 Panjeshah, Hyderabad`), on-site shows no place. Backend healthy, frontend compiles. Temp data cleaned.
- Minor: OSM attribution kept out of the short WhatsApp line by design (internal ops message); data © OpenStreetMap noted in the service. ⚠️ Needs REDEPLOY for production.



### 22 Sep 2026 — "Site shows wrong" → GPS-not-working fix
- Report: Manoj checked out yesterday and it said "YCH Head Office" — wrong. Root cause (verified from his row): his phone sent NO GPS fix (`latitude`/`longitude` null, `geo_unavailable=true`, `distance_m` null). In `_geo_toggle` (server.py:2700-2705) the no-GPS branch sets `nearest_label = office.name` and `out_of_geofence=false`, so the app FALSELY showed the office name and "on-site" for any check-in where location wasn't captured. Affects ~20-30% of check-ins (phones failing to get GPS). Confirmed only ONE geofence exists (0 satellite sites) — not an overlap issue.
- User decision: show a big red dot + "GPS Not working" everywhere (incl. WhatsApp). GPS-reliability itself deferred (separate task).
- Fix (mostly frontend display, driven by the already-stored `geo_unavailable` flag → retroactively correct for historical rows like Manoj's):
  - Backend: added `geo_unavailable` to both `/attendance/geo-toggle` return dicts (check-in + check-out) so the client knows immediately. No stored-data changes.
  - `SelfCheckIn.jsx`: `siteLine` → "🔴 GPS Not working" when `geo_unavailable`; status banner no longer claims "Currently on campus"; checked-in hero shows a prominent red-dot "GPS Not working" badge (`checked-in-gps-fail-line`) instead of a site; toast + `lastAction` carry `geoUnavailable`.
  - `shareWhatsApp.js` `formatCheckinCaption`: new `geoUnavailable` param → renders "🔴 *GPS Not working*" instead of a fake "at <site>".
  - Presence board `GeoLine.jsx`: label "GPS unavailable" → "GPS Not working", tone amber → red (added `red` tone to GeoChip).
  - Verified: caption (`🏁 MANOJ MAJJI · OUT: 18:52 · 🔴 *GPS Not working*`), and a temp no-GPS checked-in staff shows the red badge + "CHECKED IN · 🔴 GPS NOT WORKING" banner (screenshot). Normal geo-available check-ins still show the site. Frontend compiles clean. Temp data cleaned.
- ⚠️ Needs REDEPLOY to reach production.



### 22 Sep 2026 — Code review fixes (hourly-wager payroll consistency)
- Full read-only code review (code_review_agent) of the session's changes + broader app. No HIGH/CRITICAL. Two MEDIUM payroll-consistency gaps found & fixed:
  - **[MEDIUM] Profile OT parity** — `_profile_details_for` (`server.py:3914-3915`) still summed raw `overtime_total_min`, so an hourly-wager member saw 0 OT on their Profile while the Grid/ledger/report credited their hours. Now uses `_session_ot_minutes(user, s)` for month + YTD. Verified: Grid `totals.ot_minutes` == Profile `overtime.month_minutes` == 360 for a test hourly coach.
  - **[MEDIUM] PayCraft leave feed unaware of hourly-wager** — `/api/leave-balances?key=` rows now carry `hourly_wager` + `pay_basis` ("hourly"/"salaried") so the payroll consumer can skip leave/weekly-off/LOP for hourly wagers. Additive only — existing balance numbers unchanged. Also added `hourly_wager` to `compute_hours_report` rows (Reports Attendance tab). Verified feed row shows `hourly_wager:true, pay_basis:"hourly"`.
- Review confirmed clean: auth/key gates (`hmac.compare_digest`, 503-when-unconfigured), WhatsApp share/DAR gating (buttons mutually exclusive, no stale closure), lint clean. LOW items left as-is (re-scroll after temp-out is cosmetic; ledger rounding already shares `session_ot_minutes`). Multiple-sessions/day is moot under the one-check-in-per-day rule.
- Regression: 78 pytest (OT + holidays) pass. Admin (non-key) leave path untouched.
- NOTE: decision left to payroll side — whether to zero hourly-wager leave/LOP or just honour `pay_basis`. App exposes the flag; it does not change grid classification for them (avoids altering the shared Grid everyone sees).



### 22 Sep 2026 — Share button pulse + LATE in WhatsApp message
- Follow-ups to the persistent-share fix (same `SelfCheckIn.jsx` / `shareWhatsApp.js`):
  - **Impossible to miss** (chosen over forced auto-open, which browsers block after the async check-in): the persistent "Share to WhatsApp" button now auto-scrolls into view the first time a checked-in screen loads and plays a 3× emerald ring-pulse (`.wa-attention` keyframe in `index.css`, respects `prefers-reduced-motion`). No forced pop-up.
  - **Late flag in the message**: `formatCheckinCaption` now adds `🔴 *LATE by N min*` on check-in shares (WhatsApp has no coloured text; red dot + `*bold*` is the closest to "red"). Late/late_minutes flow from `lastAction` (fresh) and `status.session` (reopened). Checkout shares unaffected.
  - Verified: caption via node (`✅ NAME · IN: 05:41 · 🔴 *LATE by 41 min* · 📍 12 m from …`), and a temp late checked-in coach on a fresh load shows the pulsing button + "Late by 41 min" line, no layout break. Frontend compiles clean. Temp data cleaned up.
- OPEN (needs a concrete example): "site sometimes shows wrong". Confirmed null `site_name` is BY DESIGN (member inside the main office fence → site_name None → card shows office name). Real wrong-site risk is overlapping geofences (a satellite site radius covering the office) — `services/geo.resolve_site` picks the nearest fence the member is inside, so a boundary GPS fix can match the wrong one. Awaiting: which member/day, shown-vs-correct site, and whether sites have overlapping radii.



### 22 Sep 2026 — Persistent WhatsApp share on check-in (bug fix)
- Report: coaches Laxman & Sravan "did not get the WhatsApp forward link on check-in" this morning; others did. Both had valid self check-ins recorded.
- Root cause: the green "Share to WhatsApp" button on the check-in success screen was driven by transient React state (`lastAction`), so it only existed in the same session immediately after tapping check-in. Anyone who reopened/reloaded the app while checked in (the screenshot they sent shows the re-opened checked-in view) lost the button entirely. Not category- or member-gated.
- Fix (`pages/SelfCheckIn.jsx`, frontend-only): added a **persistent** "Share to WhatsApp" button inside the green "You're checked in" hero card, rendered whenever `status.checked_in` and sourced from the persistent `status.session` (check_in_at, site_name, off-site/distance). New reusable `shareCheckinToWhatsApp()` builds the caption from `lastAction` OR `status.session`, attaches fresh selfie → stored photo → text-only. The old transient button now only handles CHECKOUT shares (`lastAction?.action === "checkout"`) so there's no duplicate. testids: `share-checkin-persistent-btn` (persistent), `share-whatsapp-btn` (checkout).
- Verified: temp checked-in staff member, fresh page load → persistent green "Share to WhatsApp" button visible in the checked-in hero (screenshot confirmed). Frontend compiles clean (only pre-existing Layout/useRowFocus eslint warnings). Temp member + data cleaned up.
- ⚠️ Frontend-only change — must be REDEPLOYED for Laxman/Sravan (on production) to get it.



### 21 Sep 2026 — Hourly-wager pay → OT channel
- User request: occasional coaches (who study, attend sporadically, get NO leave / weekly-off pay) should be paid purely for hours actually worked. Mark them per-member; their daily hours (check-in→check-out only) flow to payroll through the existing OT channel, rounded to the nearest half hour (5h44m→5.5h, 5h45m→6.0h, half rounds up). Standard early-in/late-out OT is suppressed for them (no double-count). All confirmed via ask_human.
- New per-member flag **`hourly_wager`** (MemberCreate/MemberUpdate/UserPublic + create doc). Frontend: "Hourly wager" checkbox on MemberForm (`mf-hourly-wager`, shown for staff/coach/executive only), mirrors the dar_required conditional pattern.
- Single source of truth: `services/attendance_calc.session_ot_minutes(member, session)` — hourly wagers → `round_half_hour_minutes(hours*60)`; everyone else → stamped `overtime_total_min`. `compute_overtime_in/out` now short-circuit to 0 for hourly wagers (suppresses standard OT at the stamp).
- Routed through EVERY payroll-facing OT consumer: `compute_hours_report` (Reports Attendance `overtime_hours_served` + dates_overtime_served), Grid `_grid_impl` totals.ot_minutes + per-cell tooltip ot_minutes (added `hours` to the grid attendance projection), OT ledger + PDF/CSV export (synthetic per-day rows via `_hourly_wager_ot_rows`, reason "Hourly wage — Xh worked"), and dashboard top-OT / MTD-OT. `/api/grid` external key feed (PayCraft) picks it up automatically via totals.ot_minutes.
- The stored `hours` field = pure check-in→check-out (excursions NOT subtracted, server.py ~2733) — matches user's "actual check-in/out times only".
- Verified e2e (throwaway coach, 3 injected days 5.83/5.73/8.08h): Grid ot_minutes=1170 (6.0+5.5+8.0h), payroll overtime_hours_served=19.5, OT ledger total=1170 with per-day rows; cleaned up after. Existing 64 OT/holiday pytests still pass; non-hourly members unaffected. Frontend compiles clean.
- No production data mutated (consumer-layer computation only — fully reversible by toggling the flag). NOTE: payroll applies the hourly rate on their side; the app only passes the hours as OT.


### 21 Sep 2026 — Integration Grid daily IN/OUT punches
- User request: "Expose daily IN/OUT punch times in the /api/grid API (for our integration key)". Preferred contract: date-keyed `cell_meta` inside each member row, preserving `cells`, `totals`, `work_start`, `work_end`; key-only access and `category=all`/individual filters. User confirmed the existing office timezone (Asia/Kolkata).
- `GET /api/grid?month=YYYY-MM&key={GRID_API_KEY}` now fills every date's `cell_meta` with its exact Grid `code`. Worked codes P/LT/HD include `in` and `out` as zero-padded local HH:MM; missing punches are null. All code-only days (WO/HO/LV/TR/PS/CO/BK/AB/LP/NJ/LF/blank) omit punch fields, including stale punches on pre-joining dates and leave/off manual overrides.
- Missing-checkout/synthetic auto-close timestamps are not exported as punches. Explicit `missing_checkout=False` restores a corrected real checkout even if a legacy auto-close flag remains. Naive correction timestamps are interpreted as office-local; offset-aware timestamps are converted normally.
- Existing key authentication/EMBED_KEY compatibility remains unchanged, with no session or `/api/dar` request needed. No keys, auth implementation, records, schemas or payroll calculations changed. Private UI tooltip notes are not added to the integration response.
- Fixed integration-only exact-category filters: staff/coach/executive/custom keys now select their category rather than silently returning all. Omitted/all and legacy athlete/elite/rest/payroll buckets keep their existing meanings. Fleet/institution filters preserved. Admin UI metadata and filters untouched.
- Architecture: `backend/services/grid_punches.py`, `backend/grid_models.py`; `reports._grid_impl` adds optional internal `with_punch_times=False` enabled only by external `/grid`. Uses the SAME existing attendance map and query, no new network request or per-member DB query. Pydantic aliases/exclude-unset preserve null versus omitted punch fields.
- Verification: **46 feature/profile/Grid OT tests passed**. Existing-key/no-login requests tested; missing/invalid key still 401; EMBED_KEY works; August and September full legacy payload snapshots match after excluding `cell_meta`; August admin Grid payload matches completely. Real AINUL HAQUE 01 Aug punches 09:22–18:01; 06 Aug TR code only. App-load smoke passed; no frontend change. No mocked product integrations.
- Broader old late-count parity test revealed a **pre-existing data/report discrepancy**, not introduced here: SACHIN SINGH (`82ed06b2-9c39-43f4-9e12-73802e5fc135`) has joining_date 04 Sep but a late attendance row on 01 Sep. Existing Grid correctly says NJ (late total 248); legacy payroll report counts that row (249). Pre-change snapshot proves the same difference. Do NOT alter Grid totals or delete/change this attendance without user approval. This one old global-parity test remains failing pending confirmation of correct joining/attendance dates or separately approved payroll-report alignment.
- Reports: `test_reports/iteration_75.json` (initial 29/30), `test_reports/grid_api_verification_75.json`, `test_reports/pytest/iter75_grid_external_verified.xml` (46/46 targeted checks). Integration instructions: `memory/grid_api_contract.md`.
- Next: consumer reads `rows[].cell_meta[date].in/out` using its existing key. P1: confirm the pre-joining record discrepancy separately. Optional future enhancement: ISO punch timestamps for unambiguous overnight shifts (HH:MM contract intentionally unchanged).

### 21 Sep 2026 — Admin member profiles + full-month attendance register
- User request: "When admins select My Profile they should be able to see the profile of any employee. Also my profile should show all days of the month under recent attendance including time in and out and leave and tour etc. Max details like as if the gridline of the specific employee". User explicitly confirmed **include athletes**.
- Admin My Profile now has an always-available searchable member picker covering staff, coaches, executives, athletes and elite; direct person-to-person switching, own-profile reset, loading/error/retry states and URL-based member selection. No 30-result cap. Selected member photo is returned using the existing thumbnail URL helper.
- Replaced the 15-session Recent Attendance list with a full-month daily register. Defaults to office-local current month; previous/next/current month controls, month input and `?month=YYYY-MM` deep links. Selected month survives member switching. Every calendar date renders, including empty, future, weekly-off, holiday, joining/leaving and break days.
- Day status and totals use the **same payroll Grid engine**, including leave/tour/posting/comp-off/LOP and manual overrides. No alternate attendance classification or payroll formula was introduced. Existing MTD/YTD cards remain current-period and explicitly labelled; register totals belong to its selected month.
- Daily details include all stored sessions, in/out, hours (zero preserved), late/early minutes, overtime, DAR filed/missing/pending status, location/method, off-site reasons, correction flags, step-out intervals, leave status/reason/half-day/approver/date range and balance split. Missing-checkout auto-closures never display as a real checkout or earned hours. Future approved/pending leave remains visible in details without changing Grid codes.
- New read-only endpoints: `GET /api/me/attendance-month`, `GET /api/admin/members/{member_id}/attendance-month` (optional `month`). Existing user/admin dependencies enforce scope; member-id query spoofing on self endpoint cannot expose another member. Scoped profiles also support former members excluded from the main grid. No auth behavior, schema, production data or attendance writes changed.
- Architecture: new `backend/profile_models.py`, `backend/services/profile_attendance.py`, `backend/routes/profile_attendance.py`; existing `reports._grid_impl` gains optional internal `member_id` filter. Frontend split into `pages/profile/MemberProfilePicker.jsx`, `MonthlyAttendance.jsx`, `AttendanceDayRow.jsx`, `AttendanceDayDetails.jsx`, composed in `Profile.jsx`.
- Verified: testing agent iteration 74 admin/UI/grid checks; follow-up **16/16 pytest passes, 0 skipped**, all 28/29/30/31-day month lengths, role isolation, detailed synthetic records, former member, current/historical grid parity. Browser checks confirm real non-admin self-only profile despite spoofed URL; no horizontal overflow at 320/768/1024/1440; month navigation; real session/step-out/tour details; member-search and register error/retry recovery. JSX lint clean. Fixed duplicate current-month request revealed by error-state testing.
- Preview-only QA account created through existing admin API; current credentials in `memory/test_credentials.md` and `backend/.env.profile-test`. All synthetic attendance/leave/override fixtures removed and temporary QA former-member state restored. Old coach/DAR/executive test credentials returned 401; **do not reset real accounts**. No mocked product integrations.
- Follow-up reports: `test_reports/iteration_74.json`, `test_reports/profile_attendance_verification_74.json`, `test_reports/pytest/iter74_profile_attendance_verified.xml`.
- P0 for this request: none remaining. P1/P2 unrelated backlog unchanged. Optional next enhancement: downloadable monthly individual attendance PDF.

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

### Sep 2026 — Task manager edit facility (this session)
- Added inline **edit** to both Tasks tabs (backend PATCH `/todos/{id}` + `/checklists/{id}` already existed; this was the missing UI):
  - **To-dos** (`TodosTab.jsx`): pencil button (`todo-edit-btn-<id>`) → inline editor for title, deadline, assignee, notes with Save/Cancel (`todo-edit-*` testids). Editable by owner, creator or admin.
  - **Checklists** (`ChecklistsTab.jsx`): pencil button (`checklist-edit-<id>`) repurposes the top form into edit mode (banner `checklist-editing-banner`, Save + Cancel), editing title / recurrence / days-of-week / day-of-month; preserves the item's active/paused state. Editable by owner or admin (form now shows for admin editing another member's item).
- Verified: backend curl (todo title/due/notes; checklist title/recurrence/dows) + testing_agent iter60 100% (edit save, cancel discard, recurrence switch, add/toggle/pause/delete regressions).

### 19 Sep 2026 — Deletion sign-off (this session)
- Bulk attendance deletions (wipe-all, data-quality delete fixes) gated: Super Admin runs now, others queue to Approvals as `bulk_delete` corrections. Correction payload validated at filing. Approvals shows elapsed days.

### 19 Sep 2026 — Off-site stamping fix · proxy DAR gate · late-day counter (this session)
- Off-fence check-ins no longer carry a real site name (was "Rowing Academy" for far-away HO check-ins); stamped as "Off-site" bucket with nearest name kept for copy. Prod needs `scripts/offsite_site_name_fix.py` once.
- DAR required → no check-out via ANY path (self, admin console, card, Muster bulk).
- Check-in hero + toast: "Late by N min (Nth late day this month)".
- OPEN: production DB snapshot shows self check-outs without DAR on 09–12 Sep even though the server gate exists in code → production likely running a build older than 12 Sep; user should redeploy.

### 15 Sep 2026 — Code review fixes (this session)
- Back-dated stock valuation gate, inside-any-fence geo resolution, server-side off-site proof enforcement for self check-ins, /admin/sessions missing_checkout hours, non-finite input guards. See CHANGELOG.

### 15 Sep 2026 — Stock Take first-count opening balances (this session)
- Stock Take rows with no cost history show a Rate ₹/unit input; saving with a rate sets the item's opening balance (qty+rate as-of count date) so stock value is right from day one. Print sheet gained Rate column + write-in rows.

### 15 Sep 2026 — Vahini Nagar geofence + Maps-link paste (this session)
- Site "Vahini Nagar" (17.465895, 78.495148, 100 m) added in preview via API; **user must add it in production via Admin → Sites**.
- Sites form gained a "Google Maps link or lat,lng" field that auto-fills coordinates — the "provision to add more locations" the user asked for.
- Pending from earlier: Super-Admin gate on bulk attendance deletions / wipe tool (P0).


## Backlog (prioritised)

### P1 — user-requested, not blocked
- **Data confirmation before payroll alignment** — SACHIN SINGH joining date 04 Sep 2026 versus a late punch dated 01 Sep; Grid excludes it as NJ, legacy payroll counts it. Existing Sep late counts differ by one (248/249). Preserve totals/records until the user confirms dates or approves a separate report fix.
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


---
## Update 13 Jun 2026 — WhatsApp parent notifications (P1, shipped)
Delivery mechanism: free `wa.me` deep links (no Meta API; groups stay manual — Meta cannot post to groups).
- Absent + Late one-tap parent notify on Muster (bilingual Telugu+English), per parent (F/M/G).
- Shared server-backed ✓ tracking (notify_log) so no double-messaging across coaches; resets daily.
- Editable templates in Office Settings (absent/late × TE/EN, placeholders {name}{academy}{day}{time}{minutes}).
- Parent Notify Log page (admins + coaches) = proof of contact INITIATED (no delivery receipt).
Key endpoints: /muster/absent-report, /muster/late-report, /notify/parent, /notify/today, /notify/log, /notify/templates.
Backlog (P2, optional): message preview before opening; "notify all remaining" stepper; per-athlete notify-log detail; template reset-to-default button; notify_log index if volume grows; full-auto via Meta Cloud API (see memory/whatsapp_integration_guide.md — note Meta blocks proactive sends outside 24h window).

---
## Update 25 Jun 2026 — Consumption wage totals + Backfill fix (bug fix, shipped)
Problem: In Consumption (MealsCalendar), per-month **Wages ₹** subtotals varied month-to-month even though the kitchen wage bill is a fixed ₹75,000/month.
Root causes & fixes:
1. Wage was apportioned across ALL calendar days of the month but only summed over days that had meal data (empty days hidden by default) — so totals shrank/varied by how many days were logged. **Fix:** `GET /api/meals/meal-calendar` now spreads each month's full wage bill equally across that month's meal-data days within the range, so any month with an entry sums to exactly the bill (₹75k stays ₹75k) and day-rows sum to the month header. `₹/Meal (incl. wages)` = (issue cost + full monthly bill) ÷ meals served.
2. `POST /api/meals/overheads/backfill` only scanned `meal_records` (muster marks). Months whose data lives only in `meal_daily_counts` / `meal_issues` (e.g. Jun/Jul 2026 spreadsheet imports) were never seen → "0 months backfilled". **Fix:** backfill now scans `meal_records` + `meal_daily_counts` + `meal_issues`, validates `^20\d{2}-(0[1-9]|1[0-2])$` (guards against a bad `0026-06` purchase date).
Data action: backfilled ₹75,000 for Jun & Jul 2026 (Aug & Sep already present). All four months now show ₹75,000 in Consumption.
Files: `backend/routes/meals.py` (meal_calendar_list wage block ~L4954; backfill_overheads ~L510), `frontend/src/pages/admin/MealsCalendar.jsx` (Wages ₹ th tooltip).
Verified via curl (admin=super-admin, mobile 9849002111). NOTE: expense-report endpoint still uses calendar-day apportionment (unchanged) — only the Consumption view was in scope.

---
## Update 25 Jun 2026 — Cost-per-meal denominator, ₹/Athlete-day, and data red flags (feature, shipped)
User requests: (1) cost-per-meal should use only Breakfast+Lunch+Dinner (snacks cost far less, shouldn't dilute); (2) add "cost per athlete per day" in Consumption; (3) red-flag incomplete daily data at entry time (warn only, 25% outlier threshold).

Implemented:
- **₹/Meal denominator = main meals (BF+L+D)** across all figures (per-day, per-month, KPI, incl-wages). Backend adds `totals.main_meals`.
- **₹/Athlete/day** — new KPI + Consumption table column + footer. `cost_per_athlete_day = issue_cost_incl_wages ÷ (main_meals/3)` (assumes 3 main meals/athlete/day = 3× ₹/meal). Backend adds `athlete_days`, `cost_per_athlete_day`.
- **Data red flags (warn-only):**
  - New `GET /api/meals/day-flags?date=` → full single-day set via `_compute_day_flags`: missing_main_meal, no_headcount, counts_no_consumption, issue_no_price, negative_stock, purchase_zero_rate, headcount_outlier (>25% vs trailing 28-day avg).
  - `meal-calendar` per-day rows now carry a lightweight `flags[]` (completeness only — outliers omitted there to avoid flagging ~every row).
  - Daily-entry screen (MealEntryTab) shows an `entry-flags-banner` for the selected day (refetched on day change + after each save).
  - Consumption table shows a `FlagBadge` (⚠️ + count, rose=high/amber=medium) per day; days with flags but no headcount now also surface in the grid (row filter includes `d.flags?.length`).
- **New helper** `_effective_meal_counts` (manual daily-counts row wins, else muster distinct-users).

Files: `backend/routes/meals.py` (_compute_day_flags, _effective_meal_counts, /meals/day-flags, meal_calendar_list per-meal + flags), `frontend/src/pages/admin/MealsCalendar.jsx` (helpers, FlagBadge, ₹/Athlete column+KPI, row filter), `frontend/src/pages/admin/MealEntryTab.jsx` (dayFlags banner).
Testing: iteration_76.json — 100% backend + frontend, no issues. Backend tests at `backend/tests/test_meal_flags_and_calendar.py` (4, passing). Verified ₹/Meal=₹85.50, ₹/Athlete/day=₹256.49 (≈3×), all 4 months show ₹75,000 wages, banners + badges render.
Note: per-day rows use `wage_cost` key (not `wages`).

---
## Update 25 Jun 2026 — Price Movers (commodity price trend overview) (feature, shipped)
User request: a graphic to show which commodities are rising vs falling in price (line/price graph), under Analytics.

Implemented a new **"Price Movers"** tab in Purchases & Issues (Kitchen area) + sidebar link (`/admin/meals-report?tab=movers`):
- **Backend** `GET /api/meals/price-movers?days=&end=` — per item, weighted-avg purchase rate in the current window [end-days+1, end] vs the previous equal-length window; returns change_pct, base/cur rate, cur qty/spend, a per-date rate sparkline, and rising/falling/new counts + avg change. Window 3–365 days, default 30.
- **Frontend** `MealPriceMoversTab.jsx`: window selector (7/14/30/60/90d) + as-of date; KPIs (getting dearer / cheaper / new / avg change); a diverging horizontal bar chart (red = dearer to the right, green = cheaper to the left) of top 15 movers; two lists (biggest increases / drops) with rate sparklines; a full table. Clicking any item opens the existing `ItemPriceTrendDrawer` for full purchase history.
Files: `backend/routes/meals.py` (price_movers ~L2203), `frontend/src/pages/admin/MealPriceMoversTab.jsx` (new), `frontend/src/pages/admin/MealsReport.jsx` (tab wired), `frontend/src/components/Layout.jsx` (sidebar link in both kitchen nav arrays).
Verified: backend curl (32 rising / 21 falling / 43 new over 30d); UI screenshots of chart, lists, and drill-down drawer.
KNOWN CONSIDERATION: an extreme outlier (e.g., Cucumber +1173% caused by a bad ₹1.29/kg baseline purchase on 2026-08-13) stretches the bar-chart X-axis and compresses other bars. Could optionally clamp the domain / exclude anomalies — deferred. The feature usefully surfaces such data-entry anomalies.

---
## Update 25 Jun 2026 — Masters consolidation + Analytics nutrition cleanup (UX, shipped)
- **Masters consolidation**: All master-data screens (Manage Members, Institutions, Fleets, Categories, Roles) are now TABS inside a single `/admin/masters` page (`frontend/src/pages/admin/Masters.jsx`, ?tab= deep-linking). The sidebar's 5 separate entries + the "MASTERS" sub-header are replaced by one "Masters" item (Layout.jsx). Old individual routes (`/admin/members` etc.) are retained for backward-compat with in-app links. Route added in App.js (RequireAdmin). NAV_ATTENDANCE_MASTERS array removed.
- **Analytics nutrition**: Removed the Purchases-side Nutrition block (meaningless — nutrition only shown for what was CONSUMED/Issues now). Added explanatory captions under every Analytics chart (spend/category/top-items + all 4 nutrition charts) and a data-source note. Calorie data source documented: per-item `nutrition` override on meal_items, else `backend/services/nutrition_seed.py` (per-100g table, name-matched); qty→grams×per-100g. Coverage badge clarified.
- Files: `frontend/src/pages/admin/KitchenAnalyticsTab.jsx` (Caption helper, captions, purchases-nutrition removed), `frontend/src/pages/admin/Masters.jsx` (new), `frontend/src/App.js`, `frontend/src/components/Layout.jsx`.
Verified via screenshots (Masters tabs switch: Members/Fleets/Roles; single Nutrition block on Analytics).

OPEN QUESTIONS (awaiting user):
- Chef's View: keep / merge into Meals Muster / delete (my rec: keep — it's presence-based plate planning, distinct from Meals Muster's manual consumption record).
- App-wide tooltip/caption pass: which screens to prioritise (Consumption, Grid, Dashboard, DAR, Reports) and whether to add ⓘ info-icon tooltips vs captions only.

---
## Update 25 Jun 2026 — E2E code review fixes + hybrid wage apportionment (shipped)
Ran a read-only end-to-end code review (`code_review_agent`). Fixes applied:
1. **[HIGH → user-approved change] Consumption wage apportionment is now HYBRID.** Previously the full monthly kitchen bill (₹75,000) was spread only over the days-with-data in range, so a PARTIAL month (default "All days" view always includes the incomplete current month; also "Last 30d") loaded the whole month's wages onto the few elapsed days → ₹/meal-incl-wages and ₹/athlete/day spiked early in a month. User chose option (c): a COMPLETED month still shows the full ₹75,000 (spread across its meal-data days in range), but the CURRENT in-progress month is prorated to elapsed days (`bill × today.day ÷ days_in_month`). Future months → ₹0. New `_effective_bill(mk)` helper in `meal_calendar_list`. Verified via curl (today=2026-09-25): Sep=₹62,500 (75k×25/30), Aug=₹75,000, Jun=₹75,000. `local_date_str(None)` used (office-default tz) to match codebase convention.
2. **[MEDIUM] Price Movers blank screen** — `MealPriceMoversTab.jsx` empty-state gated on `known.length===0` (items with a computable % change), so a window where EVERY item was brand-new (no baseline) hid the KPIs + whole table. Now gated on `data.movers.length===0`; new items render as "NEW".
3. **[LOW] Duplicate React keys/test-ids** in the MealEntryTab day-flags banner — now keyed by `code+index` (`entry-flag-<code>-<i>`).
4. **[LOW] Dead code** — removed unused `n_days` in the pantry forecast helper (`meals.py` ~L3085).
Files: `backend/routes/meals.py` (meal_calendar_list wage block), `frontend/src/pages/admin/MealPriceMoversTab.jsx`, `frontend/src/pages/admin/MealEntryTab.jsx`.
Tests: updated `backend/tests/test_meal_flags_and_calendar.py::test_meal_calendar_wages_hybrid_apportionment` (dynamic: completed months=75k, current month=prorated). All 4 pass.
⚠️ Needs REDEPLOY to reach production. Kept as display-metric-only; no stored data mutated.
NOTE (by-design edge): slicing a PAST completed month partially (e.g. Aug 1–10 only) still shows the full ₹75k across those days — consistent with the "a month sums to its bill" preference; only the current/incomplete month was in scope for the fix.

---
## Update 25 Jun 2026 — App-wide explanatory tooltips + better graph captions (feature, shipped)
User request: "Add explanatory tooltips across ALL sections so staff can better understand each figure. IMPROVE the graph captions."
- **New reusable `InfoTip` component** (`frontend/src/components/InfoTip.jsx`): a small ⓘ icon built on the shadcn Radix tooltip (amber skin). Self-contained TooltipProvider (drop-in anywhere), opens on hover (desktop) + focus (tap on touch), and `onClick` does `preventDefault + stopPropagation` so tapping it inside a `Link`/table row never navigates. testid `info-tip` or `info-tip-<id>`.
- **Wired into shared components** so coverage is broad with few edits:
  - Dashboard: `StatTile` (hint), `AttentionRow` (hint), `SectionCard` (titleHint) → every "Now/This week/This month/Attention" tile + section title now has a plain-language explanation.
  - Consumption `MealsCalendar` `KpiPill` → renders InfoTip from its existing rich `title` text (all 8+ KPI pills).
  - Price Movers `Kpi` (hint) → all 4 KPIs.
  - The Grid `CalendarGridTab` → a "Legend" label with an InfoTip explaining every right-hand totals column (P/AB/LP/LV/TR/OT/EO/LT/DAR).
  - Reports `AttendanceTab` → grouped column headers (Attendance/Leave/Overtime/Comp-Off/Hours).
  - `LeaveBalances` → grouped headers (Paid Leave/Comp-Off/Tour).
  - Kitchen Analytics `StatPill`/`BannerStat` (hint) → banner Total/Distinct Items/Line Entries + nutrition Total kcal/Protein/Carbs/Fat/Fibre.
  - `DarReport` → Missed column header.
- **Graph captions improved**: `MealsAnalyticsPanel` daily-trend + day-of-week charts now have explanatory captions; `KitchenAnalyticsTab` "Spend trend" chart gained a caption (purchases vs consumption wording).
- Verified: `testing_agent` iteration_77 — 100% frontend pass, 0 console errors, CRITICAL no-navigation-on-click confirmed on Dashboard, tooltip counts confirmed on every section. Frontend compiles clean.
- ⚠️ Frontend-only — needs REDEPLOY to reach production.
- Backlog (optional): a single root `TooltipProvider` instead of one-per-icon (minor perf polish); more sections can adopt `InfoTip` the same way (Presence, Muster, Self Check-in, Meals Report tables) if the user wants deeper coverage.

---
## Update 25 Jun 2026 — Purchase price-outlier warning (feature, shipped)
User request: "When price data is being entered warn about outliers. If more or less than 5% of the previous purchase price then warn the user before accepting."
- **Backend** `GET /api/meals/items/last-rates?before=YYYY-MM-DD` (chef/admin) → `{rates: {item_id: {rate, date}}}` = each item's most-recent purchase rate STRICTLY BEFORE the given date (rate back-computed from amount÷qty when a line has no explicit rate). `meals.py` just before `price_movers`.
- **Frontend** `MealPurchasesTab.jsx`: loads baselines for the selected date; `outlierFor()` flags any entered rate whose deviation from the previous rate is strictly greater than ±5% (`OUTLIER_PCT=5`).
  - Inline: an amber/red ⚠ marker (`purchase-outlier-<itemId>`) next to the rate input + amber ring on the input.
  - On Save: if any outliers, a confirmation modal (`purchase-outlier-modal`, "Unusual prices detected") lists each outlier with Previous ₹ / New ₹ / % change; user can "Go back & fix" (`purchase-outlier-cancel`) or "Save anyway" (`purchase-outlier-confirm`). No outliers → saves immediately. Baselines refresh after save.
- Verified: `testing_agent` iteration_78 — 100% frontend pass (inline marker, amber ring, strict >5% boundary — 5% exactly shows NO marker, modal with per-item rows, cancel = no save, confirm = saves, no console errors). Backend test `test_item_last_rates_before_date` added (5/5 pass). Curl-verified endpoint (123 items before 2026-09-01).
- ⚠️ Needs REDEPLOY. Note: warning fires whenever an outlier value is present at Save (even on re-saving a day with a pre-existing outlier) — matches the literal request. Backend already rejects future-dated purchase saves (400).

---
## Update 25 Jun 2026 — Kitchen nav cleanup (UX, shipped)
User request: delete the "Monthly grid" tab under Purchases & Issues; remove "Compare Items" and "Price Movers" from the main sidebar (they remain as tabs under Purchases & Issues).
- `MealsReport.jsx`: removed the **Monthly grid** tab (TABS entry + render + the whole `MonthlyGridTab` component and its now-orphaned `MonthlyGridTab`-only helpers `MEAL_ORDER`, `currentMonth`, and the `CalendarDays` import). A stale `?tab=monthly` bookmark now folds back to the default Daily-entry tab (no blank body). `compare` and `movers` tabs are untouched.
- `Layout.jsx`: removed the two sidebar links "Compare Items" (`?tab=compare`) and "Price Movers" (`?tab=movers`) from both nav arrays; dropped the now-unused `LineChart`/`TrendingUp` icon imports. The "Purchases & Issues" sidebar link is unchanged.
- Verified via screenshot: tab bar shows Daily entry · Stock Master · Wastage · Stock Take · Cross-check · Daily counts · Expense report · Analytics · Compare items · Price Movers · Procurement plan · Vendors (no Monthly grid); sidebar no longer lists Compare Items / Price Movers. Frontend compiles clean.
- Backend `/meals/monthly-grid` endpoint left in place (harmless, unreferenced by UI now). ⚠️ Needs REDEPLOY.

---
## Update 25 Jun 2026 — Dead-code removal + safe cleanup (chore, shipped)
Read-only lint sweep (pyflakes backend, ESLint frontend) → removed only genuinely-dead code (zero behaviour change):
- **Backend unused imports/vars**: `routes/reports.py` (unused `datetime`; dead local `from reportlab.lib.pagesizes import A3` inside the hours-export fn — the real A3 import lives in the grid-export fn), `routes/attendance_repair.py` (unused `local_date_str`), `services/scope.py` (unused `Iterable`), `scripts/subcategories_seed.py` (unused local `id_to_name`).
- **Removed the now-orphaned `GET /meals/monthly-grid` endpoint** (~93 lines) — it only powered the deleted Monthly-grid UI tab; no other frontend/backend/key consumer. Now returns 404.
- **KEPT** `server.py`'s "unused" imports — they are an INTENTIONAL re-export/compat layer explicitly annotated `# noqa: F401` (`from server import compute_late` etc.). Not dead code.
- **Frontend**: earlier nav cleanup already removed the only unused imports (`LineChart`/`TrendingUp`/`CalendarDays`/`MEAL_ORDER`/`currentMonth`); ESLint now reports 0 `no-unused-vars`. The lone CRA build warning is a pre-existing `react-hooks/exhaustive-deps` note (left as-is — changing hook deps risks behaviour).
- **Fixed 2 brittle/stale unit tests**: hybrid-wage test now prorates on Asia/Kolkata (was UTC → 1-day drift near IST midnight); `_kitchen_daily_series` rounding test no longer over-constrains the row shape (helper legitimately carries a per-category `cat` map).
- Verified: backend restarts clean (health 200, meal-calendar/last-rates 200, monthly-grid 404, no errors); 105/105 local unit tests pass. ⚠️ Needs REDEPLOY.

---
## Update 26 Jun 2026 — Future approved leave/tour now shows on the Grid (bug fix, shipped)
User report: "When leave is applied for and displayed in the Grid, the days after the current day should also show LV. So also for TR etc where applicable."
- Root cause: in `_grid_impl._classify` (`routes/reports.py`), `if iso > today_iso: return ""` blanked EVERY future date BEFORE the approved-leave lookup, so approved leave/tour falling after today never rendered.
- Fix: extracted the leave-matching into a shared `_leave_code(uid, iso)` helper (returns LV/TR/PS/CO or the LP overlay) and used it in BOTH the normal branch and the future branch — future dates now render the planned leave/tour code, or stay blank when there's none (future WO/HO/AB still stay blank until the day elapses).
- Payroll safety: the right-hand totals (present/absent/leave/tour/late/lop) are now counted over ELAPSED days only (`iso <= today`), so future planned-leave display cells never inflate the month's figures. Critically the `lop` total feeds the PayCraft `/leave-balances` LOP figure (server.py ~L1661) — future LOP must not be docked early; totals are byte-identical to pre-fix (future was previously blank).
- Also fixed a latent shadowing bug: the old inline loop reassigned the outer `end_d` (`end_d = date.fromisoformat(...)`); the helper uses a local `_end`.
- Verified (curl, month 2026-09, today 26th): GANDHINATHAN P / KARTHIKEYAN SK / PRASAD show future LV cells (29–30 etc.) while their `leave` totals count elapsed only (4/8/0). 0 mismatches between totals and elapsed cell-counts. Frontend screenshot: future LV renders orange in cols 27–30, non-leave future days stay blank, no layout break. TR/PS/CO use the same path (no future tour in current data, but logic identical).
- Regression: fast unit suite 43/43 pass. Two grid tests fail but are PRE-EXISTING and unrelated: `test_grid_late_matches_payroll` = the known "Payroll vs Grid late-count variance" open issue (LT never occurs on future cells, so this fix cannot change LT totals); `test_grid_external_iter75` needs a seeded QA member absent from this preview. ⚠️ Needs REDEPLOY.

---
## Update 26 Jun 2026 — Hard stock guard on kitchen issues (feature, shipped)
User request: "When issuing any item from the kitchen it should not allow if there is no stock or stock below the issue quantity." Decision: HARD block, including items with no recorded stock, with an instruction on where to enter stock.
- New nested `_assert_issue_stock(d, lines)` in `routes/meals.py`. Available = `opening + Σpurchases − Σ(other issues) − Σwastage + Σadjustments` up to `d` (the day's own stored issue for the item is added back since the save replaces it). Any line whose qty exceeds available → HTTP 400 listing each short item (need X, only Y in stock) + instruction: "Enter opening stock in Purchases & Issues → Stock Master (edit the item → Opening stock), or record a purchase in Purchases & Issues → Daily entry, before issuing." Items with no stock resolve to 0 available and are blocked too (negatives clamped to 0 in the message).
- Wired into BOTH issue write paths: `PUT /meals/issues/{date}` (MealIssuesTab full-replace) and `PATCH /meals/issues/{date}` (MealEntryTab per-line auto-save). Wastage/purchase PATCH endpoints deliberately untouched (out of scope).
- Frontend already showed on-hand + rose over-issue highlight per row; both screens surface the 400 via `showApiError`. No frontend change needed.
- Verified (curl + screenshot, office-today 2026-09-26): over-issue Bread 500 vs 12 → 400 with message; issue Atta (on_hand −17) → 400; within-stock Bread 2 → 200; UI shows the block toast; test doc deleted from Mongo (no data left behind). Fast unit suite 38/38 pass on affected files.
- ⚠️ Needs REDEPLOY.
- Idiot-proofing roadmap surfaced to user (soft warnings vs hard blocks) — see finish summary; candidates: unusually-large issue qty vs 30-day avg (warn), wastage > stock (warn/block), zero-rate purchase with qty (warn), negative-number guards, extend ±5% price outlier to issues/wastage.

---
## Update 26 Jun 2026 — Stock Master crash fix + 4 kitchen/payroll improvements (shipped)
1. **BUG (Stock Master crash on item click)**: `MealNodeDetail.jsx` `TYPE_META` had no entry for the `adjustment` event type (emitted by Stock-take), so `TYPE_META[ev.type].cls` threw "Cannot read properties of undefined (reading 'cls')" for any item with a stock-take adjustment. Added `adjustment → "Stock-take"` + a `FALLBACK_META` so no event type can ever crash the ledger. Verified: ledger drawer opens fine.
2. **Stock Take last buying rate (read-only)**: `MealStockTakeTab.jsx` now loads `/meals/items/last-rates` and shows each item's most-recent purchase rate (read-only) in the Rate column (fallback to weighted-avg), incl. the printable count sheet. Items with no history keep the editable opening-rate input.
3. **Stock Master item search**: added a `masters-search` box to `MealMastersTab.jsx` that filters the tree by item name, auto-expands matching categories and hides empty ones. Verified.
4. **Late-count parity (known Issue 2 FIXED)**: `compute_hours_report` now excludes late punches dated before `joining_date` / after `leaving_date` from `late_days`, matching the Grid's NJ/LF exclusion. Verified: payroll late total == grid late total (274==274); `test_grid_late_matches_payroll` passes.
5. **Big-Qty soft warning (non-blocking)**: new `_issue_qty_warnings(d, lines)` flags any issue qty > 3× the item's avg-per-issuing-day over the prior 30d (needs ≥3 days history). Returned as `warnings[]` from both issue write paths (PUT + PATCH); frontends (`MealIssuesTab`, `MealEntryTab`) show them as `toast.warning`. Save is NOT blocked.
- Verified: backend parses/restarts clean; fast unit suite 48/48 pass; frontend compiles. ⚠️ Needs REDEPLOY. Big-Qty warning validated by logic/parse (not yet triggered with live data — safe, non-blocking).

---
## Update 26 Jun 2026 — Regression + code review + low-risk fixes (shipped)
- **Regression (testing_agent iter79)**: 100% pass — backend 5/5 pytest, frontend all critical UI checks, 0 console errors, no leftover seed data. Covered stock hard-block, big-qty warning, last-rates, Stock Master crash + search, stock-take rates, purchase outlier, grid future-leave + totals parity, late-count parity, removed-endpoint 404s, nav/tooltip audit.
- **Code review (code_review_agent, app-wide)**: NO confirmed CRITICAL/HIGH/MEDIUM defects — all session changes traced correct (stock-guard add-back math, `_leave_code` LP-tail byte-equivalence, elapsed-only totals, late-parity projection, frontend null-guards). Fixed all actionable LOW findings:
  1. Removed stale `/meals/monthly-grid` tests from `test_meal_muster.py` (3 cases + docstring/section comments) — the endpoint was intentionally removed and now 404s, so these would have failed CI. Confirmed: no live frontend references `monthly-grid` anywhere; consumers (PayCraft leave-balances, CSV/PDF export) count from `totals` not `cells`, so future-leave display cells never over-count.
  2. PATCH `/meals/issues` now validates unknown `item_id` BEFORE the stock guard → clear "Unknown item_id" 400 instead of a confusing "not enough stock". Verified via curl.
  3. Big-Qty warning toasts now use a stable `id` (`isswarn-<msg>`) so the debounced auto-save re-toast replaces rather than stacks.
  - Left as noted (NOT low-risk): splitting the 5.5k-line `meals.py` / `_grid_impl`; and the rare back-dated `opening_stock_as_of` over-count edge (changing it risks the common path).
- Verified: fast unit suite 49/49 pass; `test_meal_muster.py` collects clean; frontend compiles. ⚠️ Needs REDEPLOY.

---
## Update 26 Jun 2026 — Kitchen Audit Log + Kitchen Data Health (features, shipped)
- **Kitchen Audit Log** (`/admin/kitchen-audit`, sidebar under Kitchen): reuses the shared `write_audit`→`audit_log` system. Meals router now takes `write_audit` (wired from server.py) and logs `meals.*` actions on the transactional saves: issue save/edit, purchase save/edit, wastage save/edit, stock-take. New `GET /api/meals/audit-log` (chef/admin) returns `meals.*` rows newest-first with since/until/action/actor filters. Frontend `KitchenAuditLog.jsx` = filterable table (When/Type/What/By/Details). NOTE: forward-looking — only captures changes made from now on.
- **Kitchen Data Health** (`/admin/kitchen-health`, sidebar): new `GET /api/meals/data-health` (chef/admin) computes, as-of-today, items with negative stock, no-stock-untracked (no opening + no purchase → issuing blocked) and low stock. Frontend `MealsDataHealth.jsx` = 3 KPI cards + drill-down lists with fix instructions. Verified live: 25 negative / 15 untracked / 61 low.
- Files: `backend/routes/meals.py` (_audit helper + 7 hooks + 2 endpoints), `backend/server.py` (pass write_audit), `frontend/src/pages/admin/KitchenAuditLog.jsx` + `MealsDataHealth.jsx` (new), `App.js` (routes), `Layout.jsx` (2 sidebar links, both nav arrays).
- Verified: backend parses/restarts clean, both endpoints 200, audit row captured on a save (then cleaned up), both pages render via screenshot, frontend compiles. Item-master change auditing (create/rename/deactivate/rate) NOT yet wired — fast follow-up. ⚠️ Needs REDEPLOY.

---
## Update 25 Jun 2026 — Grid "Today" column highlight + MealEntryTab refactor step 1 (shipped)
- **Grid Today column**: the calendar grid now draws a full-height sky-blue vertical outline down today's column (header day-number, weekday sub-header, and every member's body cell), plus a top cap on the header — so the "Today" column is obvious at a glance while scanning. Implemented via inset box-shadows (`TODAY_COL` in `gridHelpers.jsx`) so alignment is untouched. `isToday` threaded from `dayHeaders` → `dayCells` → `GridCell`/`GridTimeCell`. Files: `calendar-grid/gridHelpers.jsx`, `CalendarGridTab.jsx`. Verified via screenshot (col 26 outlined).
- **Refactor (approach a — incremental, live-safe)**: pure extraction from the 1650-line `MealEntryTab.jsx` (now 1353 lines) into a new `admin/meal-entry/` folder — `helpers.js` (todayISO/addDays/num/inr), `RowVendorPicker.jsx`, `AddVendorInlineModal.jsx`, `DailyTotalsHistoryModal.jsx`. Zero behavior change; removed now-unused icon imports. Verified: compiles clean, Daily-entry grid renders, DailyTotalsHistoryModal opens with live data.
- Remaining refactor backlog (P1, do one module per turn, verify each): (1) split MealEntryTab's 3 grid bodies (Purchases/Issues/Wastage) into sub-components; (2) split the 1163-line `MealMastersTab.jsx`; then approach (b) targeted cleanup of remaining pain points.

---
## Update 25 Jun 2026 (cont.) — MealMastersTab split + component map (shipped)
- **Refactor step 2 (approach a)**: pure extraction from the 1163-line `MealMastersTab.jsx` (now ~648 lines) into `admin/meal-masters/` — `helpers.js` (fmt/fmtRs/UNIT_OPTIONS/COL_GRID), `InlineEditors.jsx` (InlineEdit/InlineNum/InlineRate/InlineDate/InlineUnit), `AddItemForm.jsx`, `ItemRow.jsx`, `NutritionEditorModal.jsx`. Zero behavior change. Verified: compiles, Stock Master tree renders 152 item rows with inline editors + nutrition modal.
- **Regression found & fixed (testing_agent iter80)**: an orphaned JSX comment (the "Day totals mini-table" block in `MealEntryTab.jsx`) was missing its `{/*` opener and leaked as visible prose above the Daily-entry totals cards. Restored the exact original opener; verified 0 occurrences on the live page. All other flows (Grid Today outline, daily-totals modal, masters tree, nutrition modal) passed.
- **Component map added**: `/app/memory/component_map.md` — routing + Meals/Grid module → file map, subfolder conventions, backend layout. Use it to land changes in the right small file first-try.
- Remaining refactor backlog (P1): split MealEntryTab's 3 grid bodies (Purchases/Issues/Wastage) into sub-components; both orchestrators are still >600 lines. Then approach (b) targeted cleanup. Suggested guard: add a lint/grep check for `*/}` without a matching `{/*` to catch stranded-comment extraction bugs.

---
## Update 25 Jun 2026 (cont.) — Split Daily-entry item row into cell-groups (shipped)
- **Refactor (approach a)**: extracted the per-item `<tr>` from `MealEntryTab.jsx` (now ~1140 lines, from 1650 at session start) into `meal-entry/EntryItemRow.jsx`, itself split into four scannable cell-groups — `LeadCells`, `PurchaseCells`, `IssueCells`, `WastageCells`. All four share ONE validated `ctx` bundle (parent setters/refs/data/focus helpers) so there is no per-prop drift. Parent map is now ~25 lines instead of ~250. Zero behaviour change; removed now-unused RowVendorPicker/StickyNote imports from the parent.
- Verified LIVE end-to-end: expanded Fruits (7 rows), all cell-group testids present (vendor/onhand/purch/issue/wastage), typed qty=2·rate=50 → amount ₹100 computed + auto-saved, then reverted; backend `daily-totals` confirms today `purchase_lines: 0` (production data clean). Compiles with only the pre-existing hooks-deps warning.
- Component map updated (`/app/memory/component_map.md`). Remaining refactor backlog: both orchestrators still >600 lines but now well-organised; approach (b) targeted cleanup next. Suggested guard still open: lint/grep for `*/}` without matching `{/*`.

---
## Update 25 Jun 2026 (cont.) — Grid mobile responsiveness fix
- **Bug**: On phones (<768px) The Grid's left-sticky serial+name columns (160px) and the right-sticky 9-column totals strip (~312px) exceeded the viewport and overlapped — the totals painted over member names, leaving them as a single unreadable letter.
- **Fix**: gated all 27 right-sticky declarations (9 in `calendar-grid/GridRowTotals.jsx`, 18 header `<th>`s in `CalendarGridTab.jsx`) to `md:` — i.e. `sticky right-[Npx]` → `static md:sticky md:right-[Npx]`. Below md the totals scroll with the day cells (name column stays sticky + readable); at md+ behaviour is identical to before. CSS-only, zero JS/behaviour change.
- Verified: 390px shows full names + scrollable day grid; 1280px totals strip still `position: sticky` (unchanged). Members page (`/admin/members`) checked — already responsive (roster table scrolls horizontally, no page overflow), no change needed.

---
## Update 25 Jun 2026 (cont.) — Kitchen Audit Log: full before→after detail
- **Ask**: audit log should show "a lot more fields and exactly what change was made".
- **Backend** (`routes/meals.py`): added `_line_diff()` + `_diff_meta()` helpers that compute a per-item change list (added / changed / removed with field-level before→after) between a day's old and new `lines`. Wired into ALL kitchen write paths: issue save+edit, wastage save+edit, purchase save (lines PUT — was previously UNAUDITED) + edit, and stock-take (per-item opening/variance). Also NEWLY audit item-master edits (`meals.item.edit` — name/unit/opening/rate/min/norm/category/active/nutrition with before→after) and deletes (`meals.item.delete`). Diff stored in `audit_log.meta.changes` (+ `meta.counts`).
- **Frontend** (`KitchenAuditLog.jsx`): rows now expandable; each shows a `+added / changed / −removed` summary, and on expand an item-by-item list e.g. "Atta · Min level: ~~999 kg~~ → 0 kg" with struck old value, bold new value, ₹ for money fields, units for qty fields. Added Item edited/deleted to the Type filter.
- Verified: curl PATCH item → audit `meta.changes` correctly populated; frontend screenshot shows the expanded before→after row. Backend restarts clean.
- NOTE on tests: `pytest` meal suite has 5 pre-existing/environmental failures (stale soft-delete-200 expectation vs intended 409 hard-refuse; live-preview-DB data state for purchase-categories 409 / low-count / chef-reorder permission) — NOT caused by these changes (no status-code/permission edits).

## Answered (informational)
- **Nutrition/calorie chart**: lives in Purchases & Issues → **Analytics** sub-tab ("Nutrition of food consumed"). Underlying per-item calorie/macro data entered via the 🔥 flame button on each **Stock Master** item (per-100g editor).
- **Diet chart & recipes**: NO entry screen exists yet (on-hold P0 feature awaiting the updated diet chart & recipes).

---
## Update 26 Jun 2026 — Recipes module (weekly menu tree + AI micronutrients) [shipped]
- Absorbed the combined menu workbook into MongoDB and built a new **Recipes** page under Kitchen (`/admin/recipes`, sidebar in both NAV_KITCHEN + NAV_COACH_KITCHEN).
- Collapsible, deeply-indented tree **Day → Meal → Dish → Ingredient** with live macro (kcal/C/P/F/Fib) + micronutrient totals at every level. Micros: Iron, Calcium, Sodium, Potassium, Magnesium, Zinc, Vitamin D, Vitamin B12 — shown per dish serving.
- Full CRUD at all four levels incl. creating new branches (add day/meal/dish/ingredient, rename, delete with cascade). Generic NodeModal drives all forms.
- **Claude micro-fill** (`claude-haiku-4-5-20251001` via Emergent LLM key, emergentintegrations): stores per-100g values on each ingredient; dish totals = per100 × grams/100. A name-keyed cache (`menu_micro_cache`) means each distinct ingredient hits the LLM once. Adding/editing an ingredient auto-fills (cache-first); a "Fill micronutrients with AI" button bulk-fills missing ones in repeatable batches (POST /recipes/fill-micros?limit=). 
- Backend: `routes/recipes.py` (collections `menu_days`, `menu_meals`, `menu_dishes` [ingredients embedded], `menu_micro_cache`); mounted in server.py after meals. Seed at `backend/seed_recipes.json` (8 days/50 meals/149 dishes/399 ingredients), auto-loaded on first tree GET. Generator: `menu_src/build_seed.py`.
- Verified: tree render + expand all levels (screenshots), CRUD add/edit/delete via curl (200s, cascade), AI fill returns correct values (Banana K 716mg/200g, Spinach Fe 2.7/Ca 99 per100). 
- Downloadable combined workbook still at `frontend/public/combined_menu.xlsx` (+ `combined_menu_v3.xlsx`).

## Update 27 Jun 2026 — Recipes header/labels/weights polish [shipped]
- Column labels: `C/P/F/Fib` → `Carbs / Prot / Fats / Fibre` (kcal kept). Micros keep symbols + units (mg/µg).
- Two-tier sticky header: group titles row (**Macro Nutrients** amber / **Micro Nutrients** indigo) above the column-label row; entire header block is `sticky top-0`.
- Colours: macro cells amber-tinted, micro cells indigo-tinted; weight cell emerald(g)/sky(ml).
- New **Weight** column at start of numeric strip — shows grams and ml separately (stacked), aggregated dish→meal→day (backend `_dish_weight` + `weight_g`/`weight_ml` in tree totals).
- Removed toolbar **Add day** button AND day-level **Delete day** action (fixed 7-day week); rename-day kept.
- Verified: curl tree returns weight_g/weight_ml; screenshot confirms grouped sticky header + aligned columns.

## Update 27 Jun 2026 (cont.) — Recipes per-level colours + Expand/Collapse-all
- Per-level row colours with a coloured left rail (border-l-4): Day=emerald, Meal=sky, Dish=amber, Ingredient=white/slate.
- New toolbar toggle `recipe-toggle-all` — "Expand all" / "Collapse all" (opens/closes every day+meal+dish at once via allIds useMemo).
- Header sticky made fully opaque (removed translucent/backdrop-blur), z-30 + shadow. VERIFIED sticky under real mouse-wheel scroll with all 149 dishes / 399 ingredients expanded — header stays pinned. If it appears non-sticky for the user it is a stale/cached bundle or the deployed prod build (needs redeploy).

## Update 27 Jun 2026 (cont.) — Recipes: editable weights, Print, Menu-vs-Actual, Legend
- **Ingredient weight column**: each ingredient's qty moved out of the name text into an inline-editable cell in the Weight column (number input + g/ml select), commits via PUT on blur/Enter and reloads tree totals. Verified persistence (200→77→restore). Component `InlineWeight` in Recipes.jsx.
- **Print menu**: per-day printer button (`printDay`) opens a clean printable HTML sheet (meals→dishes→ingredients w/ weights + macros + day total) and triggers window.print().
- **Menu vs Actual** (`POST /api/recipes/menu-vs-actual`): map each weekday→real date + servings; planned = ingredient amount × servings, matched to `meal_items` by normalised name; actual = summed `meal_issues` qty for those dates. Unit conversion via UNIT_BASE (g/kg/mg, ml/l). Returns per-item planned/actual/diff/% + OVER(>+10%)/UNDER(<-10%)/OK, and a list of unmatched ingredient names to rename in the recipe. Frontend `MvaModal`. Verified: 21 matched / 10 unmatched on 2026-06-20 @ 50 servings.
- **Colour legend**: inline chip row (Day=emerald, Meal=sky, Dish=amber, Ingredient=slate).

## Update 27 Jun 2026 (cont.) — Menu-vs-Actual: strict name+unit match + guided fix
- Matching now requires BOTH exact (normalised) name AND compatible unit dimension. Response key renamed `unmatched`→`mismatches`, each {name, count, reason:"name"|"unit", pantry_name, pantry_unit, ing_unit, suggestions}.
  - reason "name": no pantry item with that normalised name.
  - reason "unit": name matches but pantry unit is not convertible / wrong dimension vs recipe g/ml (e.g. Banana=dozen, Bread=packet, Oil=L(vol) vs g). Excluded from the comparison table.
- Help: `difflib` closest-match suggestions (name → any item; unit → items with compatible dimension). New `GET /api/recipes/pantry-items` feeds a datalist. New `POST /api/recipes/rename-ingredient {from_name,to_name}` renames every matching recipe ingredient to the exact pantry name (+ refills micros), used by inline "Fix" controls in the mismatch panel. `onChanged` reloads the tree.
- Verified: 18 results / 13 mismatches (10 name + 3 unit) on 2026-06-20 @ 50 servings; rename no-op returns updated:0; UI panel shows both reason types with prefilled suggestions + Fix.

## Update 27 Jun 2026 (cont.) — Recipe↔Stock match badges + Stock-take ledger clarity
- **Recipe tree match indicator** (Recipes.jsx): each ingredient now shows a badge — green "✓ <PantryName>" when it matches a Stock Master item by normalised name (unit compatible), amber "<PantryName> · unit <u>" when name matches but unit dimension differs, rose "no stock match" when nothing matches. Pantry fetched via GET /recipes/pantry-items; JS normName mirrors backend _norm; UNIT_DIM mirrors UNIT_BASE. Component `MatchBadge`.
- **Stock-take verified working E2E**: counting Atta=30 (system −17) posts a +47 adjustment → on_hand=30; ledger row shows it. Root of user confusion: count sheet's "System on-hand" column shows the PRE-count value (−17); variance is +47; resulting on-hand is the counted 30. Their earlier attempt hadn't persisted (meal_adjustments was empty).
- **ItemDetailPanel (Stock Master → click item) clarity** (MealNodeDetail.jsx): added a "Stock-take" summary chip (net adjusted qty), adjustment rows now show signed qty (violet +/−) and "Counted X vs system Y · by", and empty-state text now mentions stock-takes.

## Update 27 Jun 2026 (cont.) — Stock-take "use last rate" one-tap
- MealStockTakeTab: for needs_rate items, a "use ₹X" link under the rate input pulls the item's last-purchase rate (from /meals/items/last-rates) into the field with one tap. Shown ONLY when a last rate > 0 exists (blank → no button); never sets zero (guarded, and save already omits rate ≤ 0). Verified: Corn Flour → tap fills 60; 35/55 needs_rate items have a last rate.

## Update 27 Jun 2026 (cont.) — Fix false "negative stock" data flag (Daily Entry)
- Bug: `_compute_day_flags` negative_stock check (routes/meals.py) compared the day's issue qty against ONLY the previous day's on-hand (`onhand_prev`), ignoring SAME-DAY purchases. Buying and consuming an item the same day (e.g. fresh Chicken) always tripped "issued X but only Y on hand" regardless of entry order.
- Fix: available = prev-day on-hand + same-day purchases (summed from pur_lines). Genuine oversell (issued > prev + same-day purchases) still flags.
- Verified: Chicken 2026-07-01 (prior 0, purchased 12, issued 12) now clean; also 07-05, 07-08 clean; day-flags endpoint returns 0 negative_stock.

## Update 27 Jun 2026 (cont.) — Issue valuation = max(WAC, latest) + confirm hard block
- Issue rate change (routes/meals.py _stock_snapshot): added latest-purchase-rate per item; issue_rate = max(avg_rate WAC, latest rate). issued_value = issued_qty × issue_rate (never undervalues issues — e.g. Chicken WAC 192.31 but latest 298 → issues costed at 298). on_hand_value stays WAC-based (issued_cost_wac) so remaining stock value stays accurate. New row field `issue_rate`.
- Hard block at entry already exists (`_assert_issue_stock`, called on POST + PATCH /meals/issues) and is same-day-safe (on-hand as of day d includes same-day purchases). Verified: issuing 999kg chicken → HTTP 400 shortage error.
- Flags recheck: only negative_stock had the same-day bug (fixed to add same-day purchases). issue_no_price uses the same-day snapshot (safe); other flags don't depend on prior-day stock ordering.
- All backend-only; needs redeploy for production.

## Update 27 Jun 2026 (cont.) — Daily Entry: resist inconsistent issue entries inline
- Bug: on a stock-shortage 400 the issue autosave kept the typed value on screen and retried forever, so the grid showed a quantity the ledger never accepted ("app does not resist").
- Fix (MealEntryTab.jsx flushIssues): on ApiError status 400, snap the offending item(s) back to the last server-confirmed value (savedIssues baseline), stop retrying, and show the server shortage message. Network/5xx still retry. savedIssues baseline set on load + updated on each successful save.
- Inline consistency (EntryItemRow.jsx): available = start-of-day on-hand + today's purchase qty (purchase-before-issue). Red border + commit-time warning now use this (no false flag when buying+issuing same day). Matches server guard.
- Null-the-row: added a clear "×" button on the issue cell (shown when qty>0) that nulls the issue, triggers save (removes the line) and recalculates stock, so a wrong entry can be nulled and re-entered.
- Server hard-block (_assert_issue_stock) already returns 400 for oversell (verified: 999kg chicken → 400). Backend + frontend in preview; needs redeploy for prod.

## Update 06 Oct 2026 — SAFE refactor batch S1–S6 shipped (see CHANGELOG)
- DONE 06 Oct 2026: M1 members routes, M3 scheduler, M4 meals package split (see CHANGELOG).
- DONE 06 Oct 2026: meal-calendar end-date fix, Roster Status Chip, Reports package split (M5), Attendance split phase 1, Auto-issue suggestions from Recipes × Muster (see CHANGELOG).
- DONE 06 Oct 2026: Attendance split phase 2, auto-issue unit conversions (grams_per_unit), previous-day headcount prefill, PUT meal-calendar + escort purge-bulk 422 fixes.
- Remaining refactor candidates: M6 MealEntryTab auto-save hook · M7 SelfCheckIn/Office GPS + share hooks.
- Auto-issue follow-ups (ideas): per-dish 'cooked for' override, 'auto-suggested' marker on saved issues for Menu-vs-Actual adherence, same-weekday-last-week headcount option.
- P0 Parent Notifications count badge: ON HOLD per user (06 Oct 2026).
- DONE 06 Oct 2026: Grid 'Pay' = payable days total (first totals column) + EO/Pay in legend. User rule: the app never stores/computes salary amounts (PayCraft does payroll).

## Update — Ponytail-style over-engineering audit (report only, no code changed)
- Ran ponytail-audit rules (ponytail.dev, full level) across backend + frontend. 22 findings, net ~-3,600 lines, -44 deps possible. Awaiting user pick ("fix 1, 3, 5...") before applying anything.

## Update 06 Oct 2026 — Ponytail cleanup + shared format helpers + academy timezone (iteration_91, all pass)
- Deleted: 44 unused shadcn ui files + hooks/use-toast.js, 44 unused npm deps, AdminOvertimeBanners/BulkEditBar, constants/testIds, formatAbsentParentMessage; backend shadowed /api/version handler, OvertimeDecisionIn, active_leave_for, break_active_on, fetch_regattas_overlapping, _today_str, unused params (is_auto_approve, group_colors, unitemised).
- utils.js is the single source: todayIso/addDaysIso/isoDaysAgo/monthStartIso/academyToday/academyDateOf use the Office-settings timezone (setAcademyTz in auth.jsx warmStatic + Office save). money(n, dp, empty) / rupees().
- Rule: Meals/Stock table cells show amounts without ₹; ₹ lives in column headers. KPI cards/tooltips/sentences keep ₹. Empty qty = "—" everywhere.
- Fixed along the way: UTC-date bugs (toISOString) in MealsAnalyticsPanel segments, Correction modal min/max, Muster/Escort share dates, export filenames.
- Not changed (out of scope): AbsentDispatchPrompt 10am gate still uses device-local hour. Pre-existing pytest fixture debt: leave tests that self-approve now 403 (2-admin rule).

## Update 06 Oct 2026 — Test-suite triage + D-items investigation (no app code changed)
- Full pytest: 69 fail/err of ~1,070. All 68 (excl. log-noise test) ALSO fail on pre-cleanup commit ccc978c (verified by running old code side-by-side on :8002) → not caused by cleanup. Buckets: outdated vs approved rules (~23), rotated test logins dar.test/exec.test/profile.qa (12), preview-data drift (~30). User chose NOT to repair suite yet.
- D1: chefs MAY edit purchase categories + reorder items (user decision). Tests updated: test_reorder_allowed_for_chef, test_chef_can_put.
- D2: Masters stock "₹47k gap" is the test formula, not the app: gap = issue premium (issues valued at max(WAC, latest rate)) ₹37,452 + stock-take adjustments ₹9,717. App identity op+purch−WAC issues−waste+adj = on_hand_value holds to ₹0.01. Test not yet updated.
- D3: scheduler.send_checkout_reminders logs Twilio rejections with logger.exception (traceback noise). Bigger: preview office config has LIVE Twilio creds (AC790b…, enabled) + real +91 numbers; tests (test_review_iter16 send-now) + preview reminder loop try to text real people. All 122 attempts today failed with Twilio 429 "50 daily messages limit"; preview sms_log has only 1 success ever → cap likely used by PRODUCTION on same account (unconfirmed). Pending user decision: disable Twilio in preview, change log level, check prod SMS failures.

## Update 06 Oct 2026 — Test suite repaired (A+B+C)
- Full pytest now green: see /app/test_reports/pytest/full_suite_after_repair.xml. Only test files changed, plus ONE small app fix: Muster check-in list no longer lists ex-members (routes/muster.py — checkin-bulk already refused them).
- conftest: make_member factory, throwaway `athlete`, `second_admin_client`. Tests no longer touch real members, the admin account’s own attendance, real kitchen days, or press "send checkout reminders".
- Skipped pending product decisions: (1) Office "Leave notice (days) per category" is shown in Office settings + MyLeaves warning but backend ignores it (fixed 3 days via short_notice_days); (2) chefs can create MEMBER categories (POST /masters/categories).

## Update 06 Oct 2026 — Backup/restore audit (no code changed)
- Backup lists collections at RUNTIME (only system.* skipped); restore reads the collection list from the archive; DB comes from MONGO_URL/DB_NAME env only. No data on disk; photos are base64 in Mongo so included. Only object-storage use = auto-backup files.
- Proof: memory/scripts/backup_roundtrip_check.py → full backup (6.9 MB gz, 53 collections, 15,298 docs) restored (replace) into scratch DB → 0 mismatches doc-by-doc. All stored values are JSON-native (dates are ISO strings), so nothing changes type.
- Caveats: (1) MERGE skips docs whose id OR unique natural key (per-day kitchen docs, DAR user+date, users email, devices…) already exists — skips only logged server-side, not reported to admin. (2) REPLACE is not all-or-nothing (no auto safety backup first). (3) Restore copies auto_backups records that point to the OTHER environment storage → 404 on download (seen in preview). (4) Restore copies config incl. live Twilio creds into preview.

## Update 06 Oct 2026 — Safety backup before every restore
- routes/admin_tools.py: run_pre_restore_backup() — after the archive is validated and BEFORE any write, a full snapshot goes to object storage (ych-attendance/backups/pre-restore/ych-pre-restore-{1..5}.tar.gz, oldest slot overwritten), metadata in `pre_restore_backups` (by, source_file, mode). Merge AND Replace (user choice). Safety copy fails → 503, nothing changed. Restore never overwrites `pre_restore_backups`. New GET /api/admin/backup/pre-restore/{slot}/download; backup-status returns pre_restore_backups; restore response returns safety_backup.
- Frontend: pages/admin/backup/SafetyBackupsCard.jsx on /admin/backup + note in restore report.
- Proof script memory/scripts/safety_backup_check.py (scratch DB): 8/8 incl. exact undo of a bad Replace.
- tests/conftest.py: session-end sweep deletes throwaway members other test modules create (email patterns) — suite 1073 pass / 10 skip. 53 leftovers from earlier runs today still in preview (awaiting OK to delete).

## Update 07 Oct 2026 — Hourly wagers: hours only, max 8 h/day, never late/absent + A–Z WhatsApp lists
- services/attendance_calc.py: compute_late → never late for hourly; session_ot_minutes = half-hour rounding then cap HOURLY_DAILY_CAP_MIN=480.
- services/attendance_helpers.py: no early-out for hourly; clear_hourly_timing_marks() wipes late/early-out from current month onward, skipping locked months (runs at startup + when PATCH /members sets hourly_wager true).
- grid.py: hourly never AB (blank); totals payable/absent/lop/late/early_out/dar_missed = 0, ot_minutes = capped hours. /api/leave-balances: hourly balances 0. muster absent-report + daily-roster exclude hourly. Checkout-reminder SMS skips hourly. SelfCheckIn: no early-out/OT prompt for hourly.
- WhatsApp: Dispatch prompt, Muster absent share, Daily roster share → A–Z one "• Name" per line (utils.sortByName); dispatch modal preview matches.
- Tests: tests/test_hourly_wager_rules.py (6). Full suite 1078 pass; only fail = iter83 log-clean test tripped by pre-existing "No response returned" middleware noise on client disconnects (44 in log history). iteration_92 frontend 100%.

### Jun 2026 — Absentee WhatsApp prompt: once per day across all admins
- New shared flag `absent_dispatch_log` (keyed by office-local date). GET/POST `/api/muster/absent-dispatch` (admin only); first sender wins via $setOnInsert.
- Popup hidden for every admin once anyone taps "Send to WhatsApp"; "Not now"/X hides only for that browser. Open popups on other admins close on focus/5-min recheck with toast "Already sent by X at HH:MM".
- Tests: backend/tests/test_absent_dispatch_once.py; iteration_93 all pass.

### Oct 2026 — Admin corrections: no look-back limit + exact-second late rule
- Admins can raise/file corrections for any past date (date picker has no min; candidates endpoint returns up to 400 rows for admins). Members keep the 31-day window. Payroll-locked months still refused.
- compute_late: compares whole seconds — 09:30:00 on time, 09:30:01 late; late minutes now rounded UP (1s late = 1 min). Existing stored late marks not recalculated.
- Test: tests/test_early_out_helper.py::test_late_exact_second_boundary.

### Oct 2026 — Super Admin attendance corrections need a second admin too
- create_correction: any admin's ATTENDANCE correction (missed check-in / time adjust) → pending + needs_second_admin; filer (incl. Super Admin) can't decide it; any other admin can. Leave/tour corrections still auto-apply.
- Grid toast now says "another admin must approve it". Tests updated: test_review_iter88::test_07, test_roles_and_admin_corrections (77 corrections tests pass).

### Oct 2026 — PAN/Aadhaar ID docs, custom categories, Tuition Teacher group, categories cache bug
- ID docs: `member_id_docs` collection + routes/id_docs.py (admin-only). Self for all; father/mother/guardian for athlete-like. PAN/Aadhaar validated; one scan per card (PDF/JPG/PNG/WEBP ≤10 MB) in Object Storage at ych-attendance/id-docs/. UI: members/IdDocsSection.jsx inside MemberForm (edit mode). Audited.
- Members can be saved in any Masters category: stored as category=<staff|athlete rule bucket> + custom_category=<key> (routes/members.py _resolve_category). Categories master counts/cascades custom_category.
- Tuition Teacher = custom category whose key/label contains "tuition" (services/dar.py TUITION_KEYS). /dar/status returns is_tuition_teacher + checkin_group_name; check-in share + DAR share target WhatsApp "YCH Tuitions" (editable in Office → WhatsApp Groups: tuitions_group_name). Paid like staff.
- Bug fix: masters GETs had Cache-Control max-age=120 → stale list after create; now "private, no-cache".
- Tests: tests/test_id_docs_and_tuition.py; iteration_94 all pass (Tuition check-in UI label verified by code only).

### Oct 2026 — Safe refactor pass
- services/http_middleware.py: one pure-ASGI AppHttpMiddleware replaces 5 BaseHTTPMiddleware wrappers (request-id/access log, svc_ read-only guard, client-id, cache headers, CSP frame-ancestors). Fixes "RuntimeError: No response returned." on client disconnect. Behaviour unchanged.
- server.py: removed unused imports (fastapi extras, io, re, openpyxl, EmailStr, AUTO_APPROVAL_LATE_CHECKINS, geo/geocode, UserPublic, dar helpers) + unused var days_accounted (each verified not imported via `server.X`).
- routes/meals/__init__.py & routes/reports/__init__.py: pruned 91 dead re-exports (kept names imported externally, e.g. _classify_timeline_day).
- Frontend: removed unused vars/imports (MyLeaves noticeDays dead state, MealCompareTab X, MealEntryTab formatDate, MealsReport BarChart3, charts colorFn, MemberRow rowIdx, useUiPrefs e, stale eslint-disable). Hook-dependency warnings intentionally left (behaviour risk).
- Full backend suite: 1086 passed, 10 skipped, 0 failed (needs env: API_BASE_URL, TEST_ADMIN_EMAIL/PASSWORD + backend .env sourced).
- Open: user asked to "switch off the tips" — unclear which (hover titles vs hint boxes); user said skip for now.

### Oct 2026 — Read-only code review (ponytail-style) + fixes
- Review verdict: READY WITH FIXES (no critical/high). Fixed: PAN/Aadhaar no longer written raw to audit_log (masked ••••last4); unique indexes absent_dispatch_log.date + member_id_docs.user_id (startup, tolerant); upload read bounded to 10 MB+1; scan filename sanitised (Content-Disposition); blob URL revoked; category member_count no longer double-counts custom members under staff/athlete; rename toast counts custom cascade; TUITION_KEYS refreshed on each /dar/status (multi-worker safe); svc_ 403s now access-logged.
- Preview-only: deleted 6 test audit rows that held raw IDs. Production never had the feature yet.
- Tests added: audit masking, unique indexes, filename sanitising (tests/test_id_docs_and_tuition.py, 7 pass).

### Oct 2026 — PAN/Aadhaar auto-read from scans
- User: PAN/Aadhaar are not private → change log shows full numbers again (routes/id_docs.py `_numbers`).
- services/id_ocr.py: Gemini gemini-3.5-flash (Emergent LLM key, emergentintegrations, FileContentWithMimeType) reads number + name from PDF/photo; best-effort (None on failure).
- Upload response returns `detected` {number, name, expected_name, name_matches}; NOT saved until admin confirms. UI DetectedBar: auto-fill + "Confirm & save"/"Edit"; if box differs → "Use scanned"/"Keep current"; name mismatch = warning only.
- Tests: 9 in test_id_docs_and_tuition.py (incl. real OCR); iteration_95 6/6 UI flows pass.

### Oct 2026 — ID Documents page (Missing report + Bulk upload) + app-wide tooltips
- /admin/id-documents (button on Members): IdReport (filters, CSV, row → MemberForm) + BulkIdUpload (≤30 files, 3 parallel Gemini reads via POST /api/id-docs/bulk/read with auto card type + name→person match ≥0.5; review dropdowns; Save all uses upload ?ocr=false + partial PUT).
- PUT /members/{id}/id-docs now writes only fields sent (no wiping the other card).
- Tooltips: components/AutoTooltips.jsx (MutationObserver: icon-only buttons/links get title from aria-label/data-testid) + 74 static titles on common text buttons (/tmp/addtitles.py dictionary).
- Tests: 11 in test_id_docs_and_tuition.py; iteration_96 all pass.
- OPEN: "Late not shown in WhatsApp check-in message for Preethi (PREETHI KONGARA, coach, work_start 06:00)". Code path verified correct (geo-toggle returns late; caption adds 🔴 LATE). Asked deployer (debug) for prod data: hourly_wager? camp start_time? method? Await result.

### Oct 2026 — Code review of recent changes + fixes
- Bulk ID upload: failed rows retry via Save all; scan not re-uploaded unless target changed (uploadedTo); seq row keys; visible read errors.
- Missing-ID CSV neutralises leading = + - @ (formula injection).
- Tooltip corrections: auto check-in cancel, escort selfie delete, meals import Done.
- id_ocr: one retry on transient Gemini errors. Middleware logs "client-gone" instead of 0.
- tests/test_http_middleware.py (3 unit tests). iteration_97: 6/6 pass.
- Preethi late investigation: prod DB late=true (202 min); her WhatsApp caption lacks " · 🔴 LATE … ·" incl. one separator → no app version ever produced that → most likely edited in WhatsApp before sending. Offered: LATE first in caption, "Late today" list in admin post, server-side record of shared caption. Awaiting user choice.

### Oct 2026 — Members table: more fields, movable/hideable columns, inline edit everywhere
- New member fields (everyone): blood_group, address, emergency_contact_name/phone, school_class, medical_notes (MemberCreate/MemberUpdate/UserPublic + MemberForm "Profile & emergency" section). Email now editable (form + inline; validated, lower-cased, 409 on duplicate).
- members/columns.jsx: MEMBER_COLUMNS column defs (15 existing + 14 new, new hidden by default); useMemberColumns.js saves order/hidden per admin in ui-prefs (members_col_order / members_col_hidden); ColumnsMenu.jsx (tick, arrows, drag, reset); header drag via HTML5 DnD (dataTransfer set for Firefox/Safari). PAN/Aadhaar columns inline-save via PUT /members/{id}/id-docs.
- Tests: tests/test_member_profile_fields.py (2); iteration_98 all pass; header drag verified with real DragEvents.
- New-field set chosen by agent (user didn't list) — confirm with user.

### Oct 2026 — Passports
- Passport = 3rd card (member + parents for athletes): number (6–9 alnum) + expiry + one scan; Gemini reads number, surname, given names, expiry. Name rule: EXACT words + order ("Given Surname"), case/spacing ignored (id_ocr.name_exact) — red warning shows both names. Report: Passport no./scan/Expiry with expired / ≤6-month "soon" flags + filters; bulk upload + Members "Passport" column supported.
- name_score now tolerates OCR-dropped spaces (bulk matching).
- Tests: 15 in test_id_docs_and_tuition.py; iteration_99 all pass.

### Oct 2026 — Passport name fix, weekly expiry list, travel check
- POST /api/members/{mid}/id-docs/{person}/passport/use-name → Title-Case name into full_name / {person}_name (audited); buttons in member form DetectedBar (updates form field via onNameChanged) and bulk rows.
- Weekly list: GET/POST /api/id-docs/passport-expiry-week (passport_reminder_log, unique week=Monday ISO; first admin wins). components/PassportExpiryPrompt.jsx in Layout: shows from Monday until posted that week; "Later" = session-only hide.
- Travel check: GET /api/id-docs/travel-check — upcoming regattas with country ≠ India; all active athlete-like + coach members; issue missing / no_expiry / expiring (expiry < regatta end + 6 months). Tab in ID Documents. "Who is selected" deferred by user.
- Tests: 18 in test_id_docs_and_tuition.py; iteration_100 all pass.
- Design note from tester: 3 login popups stack (absent-dispatch overlay blocks clicks) — possible future toast-stack.

### Oct 2026 — Regatta Team Picker
- regattas.team_ids (any active member). Picker (calendar/TeamPicker.jsx) in RegattaForm + "Edit team" modal on Travel Check tab.
- travel-check: team picked → only those members (any category); none → all athletes+coaches + "No team picked yet" banner; returns team_picked. Tested iter 101.

### Oct 2026 — PAN/Aadhaar name check (like passport)
- Strict name_exact for PAN + Aadhaar uploads (member form + bulk read). Generic POST /members/{mid}/id-docs/{person}/{card}/use-name (aadhaar as printed, pan/passport Title Case, audit name_from_{card}).
- Passport wins: people.{person}.name_from_passport set on passport use-name or exact-match passport upload → pan/aadhaar use-name 409, UI shows name_locked note. Masked Aadhaar unchanged. Tested iter 102.

### Oct 2026 — Name mismatch report, birth certificates, approvals name filter
- Card names saved per scan ({card}_name / {card}_name_tried); /id-docs/name-report + one-off /id-docs/reread-names (batched). New "Name mismatch" tab.
- App name follows passport ONLY: PAN/Aadhaar/birth mismatches = solid red alert, no fix button (generic use-name removed).
- Birth certificate card (self only): number, DOB, name; use-dob endpoint; in Bulk upload + Missing ID report. Bulk Save-all popup lists name mismatches.
- Approvals: type-ahead name filter (datalist) over pending + history. Tested iter 103.

### Oct 2026 — DOB mismatches like names + yellow inputs
- OCR reads DOB from PAN/Aadhaar/passport (+birth). Self-only stored {card}_dob (birth_dob for birth). Reference DOB priority birth → passport → aadhaar → pan.
- /members/{mid}/id-docs/self/{card}/use-dob: only when app DOB empty and card is reference (else 409). Name report → "Name & DOB mismatch" with DOB filters; bulk popup includes DOB. Re-read fills missing DOBs. Parents skipped.
- Global CSS (index.css bottom): every editable input/textarea/select bright yellow #fff176. Tested iter 104.

### Oct 2026 — Education (marksheets tree)
- Top-level sidebar "Education" (/admin/education, admins only). Tree: Athletes (athlete_like_keys) / Coaches (coach) → members A→Z → marksheets newest first (year, month desc).
- routes/education.py: GET /education/tree, POST /education/read (AI pre-fill, nothing saved), POST /education/members/{mid}/marksheets, PATCH/DELETE /education/marksheets/{id}, GET .../file. Collection `marksheets`; scans in object storage. Strict name check vs app name (sheet_name). Tested iter 105.

### Jun 2026 — ID scan client-side compression
- Added `frontend/src/utils/compressImage.js`: resizes longest edge to ~2000px, re-encodes JPEG ~82%, flattens transparency to white; falls back to original if undecodable or no size gain.
- Wired into `IdDocsSection.jsx` upload for all ID doc scans (member + family). PDFs left untouched (compressed=image only).
- Lowered hard cap 10 MB → 5 MB: client post-compression check + backend `MAX_BYTES` in `routes/id_docs.py`; updated tip + error copy. Self-tested (smoke).

### Jun 2026 — Surname/Given name split + reject-on-name-mismatch
- Member name is now stored as given_name + surname (self only); full_name kept in sync for the rest of the app. MemberForm shows Given name + Surname fields with a live full-name preview; legacy members derive the split from full_name (last word = surname) and can be corrected. Models: MemberCreate/MemberUpdate/UserPublic gained given_name/surname (members.py, models.py).
- Birth certificate is the SOURCE OF TRUTH: uploading it offers Given/Surname split suggestions (last-word & first-word surname) which the admin picks/edits; POST /members/{mid}/id-docs/self/birth/apply-name replaces the app name (audit name_from_birth). Passport-name authority retired from the UI.
- Reject-on-mismatch: upload_scan now OCRs BEFORE storing; if the scan name is a clear different-person "mismatch" the upload is rejected 422 and NOTHING is saved (member self + family father/mother/guardian cards). Birth cert also rejected if way off the existing app name.
- Matching = order-independent, tolerant of an extra/missing middle name or an initial (services/id_ocr.name_match_status: exact|close|mismatch). "close" matches upload but stay flagged red until resolved; mirror JS util frontend/src/utils/nameMatch.js drives persistent red card-name warnings.
- Verified: name_match_status unit cases; curl on throwaway member (given/surname persist, apply-birth-name title-cases + replaces, empty→400, id-docs app_given/app_surname); MemberForm UI screenshot. NOT auto-tested: live OCR upload reject/birth-split flow (needs real ID scans + Gemini).

### Jun 2026 — Doc-type cross-check + scan preview + 4-digit year
- OCR now returns doc_type (what the scan ACTUALLY is). upload_scan rejects (422, nothing saved) when a wrong document is dropped in a slot — e.g. a passport into the Birth certificate stage — fixing the bug where the birth number got overwritten by the passport's. (services/id_ocr.py prompts+read_id_card, routes/id_docs.py).
- Confirm panel now shows a PICTURE of the uploaded scan so the admin can eyeball the OCR'd number/names before confirming; "couldn't read number" also shows the preview with a type-it note (IdDocsSection.jsx DetectedPanel; preview blob URL passed from IdCardField.upload).
- Date format standardised to DD/MM/YYYY (4-digit year) app-wide: formatDate + fmtDDMMYY + fmtDateWkYY now full year; all `year:"2-digit"` → `"numeric"` across 16 files; manual slice(-2) spots fixed (utils.js, utils/dates.js, StockLedgersPrintButton, meals-analytics/helpers). Verified in UI banner.

### Jun 2026 — Member modal grouped into coloured sections
- MemberForm now renders as labelled Section cards, each with its own tint + bold uppercase header + bold divider: Identity (sky), Role & assignment (indigo), Timings/dates & pay (emerald), Parents & guardian (rose), Profile & emergency (slate), Identity documents (white). All field test-ids preserved; cosmetic regroup only. Verified via screenshot.

### Jun 2026 — Tolerant name matching (flipped / misspelt)
- name_match_status (services/id_ocr.py + utils/nameMatch.js mirror) now returns exact | flipped | misspelt | close | mismatch. Flipped word order and small typos (Levenshtein ≤1 for ≤4-char words, ≤2 otherwise, 3+ letter tokens) are ALLOWED and flagged, not rejected. Only a genuine different-person mismatch is rejected (422).
- IdDocsSection shows tailored red flags: "Name order looks flipped", "Name spelling differs slightly", "close match (extra name/initial)". Persistent card-name line + detected panel + tip text updated.
- NOTE: Split-names backfill button (POST /members/backfill-name-split) is built & idempotent but NOT yet run on prod — awaiting user go-ahead (ask pending).

### Jun 2026 — Dropped the Split-names backfill
- Removed the "Split names" button (Members.jsx) and POST /members/backfill-name-split (members.py). Rationale (user): birth certificate is the source of truth, so a bulk split just complicates things. Given name/Surname are now populated only by the Birth-certificate upload or a manual edit in the member form.

### Jun 2026 — DOB lock + extra field scraping
- DOB reference: upload_scan now compares a card's DOB to reference = app DOB else highest-priority card on file (birth first). Once a birth-certificate (or any reference) DOB is accepted, Aadhaar/PAN/Passport DOB differences are FLAGGED RED only — dob_can_apply requires no app_dob AND no ref_dob AND no higher card, so they can never change it. HINT.dob updated; use_card_dob already 409s on an existing app DOB.
- Extra scrape-and-store (no validation, user rule): OCR prompts + read_id_card now also return an `extra` dict — Aadhaar: gender, address; Passport: place_of_birth, place_of_issue, date_of_issue, nationality, sex, file_number; Birth: place_of_birth, sex, date_of_registration, registration_authority, address. Stored at people.{person}.{card}_extra via _store_read; shown read-only in the DetectedPanel and persistently under each card (ExtraDetails in IdDocsSection.jsx). Only names/parents/athlete-DOB remain validated. Verified extraction via mocked OCR; app compiles.

### Jun 2026 — Code-review fixes
- MEDIUM: clear people.{person}.{card}_extra on scan re-upload ($unset) so replaced docs don't leave stale scanned details.
- MEDIUM: dob_can_apply no longer suppressed by a lower card's DOB (removed `not ref_dob`); birth certificate can set the app DOB via UI when app DOB empty. Lock on lower cards still enforced by `higher`.
- LOW: revoke preview blob URL on clearDetected (leak); keep given_name/surname even when "" on edit so clearing a surname persists; removed unused splitSuggestions from nameMatch.js; fixed stale dd/mm/yy comments in dates.js.

### Jun 2026 — Birth-cert name mismatch asks instead of rejecting
- upload_scan no longer rejects the BIRTH certificate on a name mismatch (card != "birth" guard); Aadhaar/PAN/Passport still reject. Wrong-document (doc_type) reject still applies to birth.
- BirthSplit panel now shows an amber "differs from app name 'X'" notice with two choices: "Change app name" (apply split) or "Keep app name as-is" (keepBirthName dismisses the prompt, scan stays saved). Tip text updated.

### Jun 2026 — Name mismatch = ask, for ALL documents
- upload_scan no longer rejects ANY card on a name mismatch (removed the 422 for aadhaar/pan/passport too). Only a WRONG document (doc_type) is still rejected. All name mismatches stay flagged red.
- Any SELF card (birth/aadhaar/pan/passport) with a differing name now shows the NameChoice panel (generalised from BirthSplit): "Change app name" (split → set) or "Keep app name as-is" (upload anyway). Birth always shows it (source of truth).
- Generalised endpoint: POST /members/{mid}/id-docs/apply-self-name (replaces /self/birth/apply-name; path chosen to avoid shadowing the 2-segment upload route). Frontend applyName(card)/keepName(card). Tip text updated. Verified routes + compile.

### Jun 2026 — Faster scan uploads
- upload_scan now runs the object-storage PUT and the AI OCR read CONCURRENTLY (asyncio.create_task + await), instead of OCR→then→store sequentially. On a wrong-document (doc_type) reject the already-uploaded blob is left unreferenced (no DB row). Verified store path with ocr=false on a throwaway member. The remaining wait is the inherent AI read time.

### Jun 2026 — Members table second "Details" line
- Added MemberDetailsLine.jsx: an always-on second <tr> under each member exposing DOB, Blood group, Joining/Leaving dates, Class, Address, Emergency contact + phone, Medical notes — all inline-editable via the existing onPatchField (MemberUpdate already accepts them). Two leading cells mirror the frozen Actions/Member columns for alignment; rest is a colSpan strip that wraps. Wired in MemberRow (fragment with the main row). Verified render + alignment via screenshot.
- Details line also exposes the member PAN / Aadhaar / Passport numbers inline-editable (idNum + saveIdNum), alongside the profile fields.

### Jun 2026 — Camp-less athletes show attendance when they check in / are mustered
- Grid (reports/grid.py _classify): a camp-less athlete day is still blank, EXCEPT when there's actual attendance (check_in_at from a check-in or muster) — then it shows P/LT like any present day. Previously the camp-only rule blanked it before the attendance check. Verified: inserted a muster attendance for a camp-less athlete → grid cell = "P", all other days blank.
- Presence board already surfaces them: it reads sessions from db.attendance, so a check-in/muster puts them in sess_map/last_map (on_campus/exited); the camp-less hide only applies when there's no session at all. No change needed there.
