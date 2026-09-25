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
