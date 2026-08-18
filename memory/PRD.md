# I Showed Up — PRD (living document)

## Original problem statement
Browser-based PWA ("I-showed-up") ported from the "Attendance" mobile app for a youth
competitive sailing academy (Yacht Club of Hyderabad). Staff payroll tracking + sailor
attendance with audit logging, data-quality monitoring, geolocation check-ins, check-in
approvals, admin dashboard, Muster Roll bulk check-ins, self-check-ins, leaves,
detailed reports, camps/regattas, Escorts module, Meals (muster + chef view + reports).

## Architecture
- React (CRA) + Tailwind frontend, FastAPI backend, MongoDB (Motor)
- Roles: admin, chef, member (coach scoping via services/scope.py)
- Timezone: strictly IST (Asia/Kolkata). LIVE IN PRODUCTION — clarify Preview vs Prod on bug reports.
- Super-admin phone login: 9849002111. Admin: admin@attendance.app / Admin@12345.

## Implemented (highlights, most recent first)
### 18 Aug 2026 (alignment polish + active-tab highlight)
- **Masters**: Fixed lingering right-alignment drift — sticky header and
  grand-total row were using `px-3` while item/category rows sit inside
  a `p-3` wrapper AND have their own `pr-2`, adding 8px of hidden right
  offset. Sticky rows now use `pl-3 pr-5`. Grand Total and category
  totals now stack pixel-perfect over item cells.
- **Meals tab bar**: Active tab now renders on a `bg-blue-100` band with
  a `border-blue-600` under-bar and `text-blue-800` label (was green
  underline only) — the selected option is immediately obvious.

### 18 Aug 2026 (Daily Entry v2 — totals-top, filter, group headers)
- **Masters**: All category rows now render on a bright yellow band
  (`bg-amber-100` always, not just on hover). Grocery / Fruits / Meat
  etc. stand out at a glance.
- **Daily entry — totals at top**: Two summary chips pinned above the
  grid — "Purchases · Day total ₹X" (emerald) and "Issues · Day total
  ₹Y" (amber). Removed the old bottom tfoot totals row.
- **Non-zero filter**: "Only touched rows" checkbox in the header. When
  on, hides items with zero purchase-qty, zero rate AND zero issue-qty.
  A category is hidden entirely once all its rows are filtered out.
- **Group headers**: Above the column labels, a two-cell band splits the
  grid into PURCHASES (emerald) and ISSUES (amber) so chefs can't confuse
  the two halves. Column cells beneath keep matching tints for reinforcement.
- **Sticky thead**: Removed the `overflow-hidden` on the card wrapper so
  the sticky positioning actually latches. Both the group-header row and
  the column-label row stay glued to the viewport top while scrolling
  down a long pantry list.

### 18 Aug 2026 (Masters right-align + Issue valuation)
- **Masters**: Fixed right-alignment of grand-total & category-total ₹
  amounts with item cells. Item row's `ml-6` outer indent was shrinking
  the row width, so its ml-auto stat grid ended 24px short of the
  category grid. Moved the indent to inner `pl-8` padding — right edge
  now flush across all three row types.
- **Daily entry**: Issue column now displays TWO computed cells:
  Rate ₹ (weighted-average purchase cost) and Amount ₹ (issue qty × avg
  rate). Loaded from `/meals/stock?as_of=<selected date>` so any purchase
  entered earlier the same day feeds today's issue valuation.
- After every purchase auto-save the avg-rate map is refetched, so the
  issue rate/amount cells refresh live without a manual reload.
- Table footer now shows both Day purchase total AND Day issue total.

### 18 Aug 2026 (Masters v3 + unified Daily Entry tab)
- **Masters**: LOW-stock pill moved to the extreme-left of every item row
  (dedicated w-6 slot) — scan-and-spot restock candidates without reading
  the whole row. Category rows carry an empty matching slot so the grid
  stays aligned.
- **Masters**: Grand-total row pinned at the top of the tree (below the
  sticky column header) — sums Opening / Purch / Issue / Close ₹amounts
  across ALL visible categories. Warm amber band + category/item count.
- **Daily entry** (new): Merged the old Purchases + Daily-issues tabs into
  a single `MealEntryTab`. One row per item with columns for Purch qty ·
  Rate ₹ · Amount ₹ AND Issue qty on the same line.
- Auto-saves on blur (350ms debounce per half). Silent when idle, spinner
  during flush, green "Saved ✓" tick for 3s post-save.
- Prev/next-day arrows flanking the date picker. Next disabled when it
  would run past today.
- Category headers rendered in bold uppercase on a warm yellow band
  (`bg-amber-100`) to anchor scans down a long grocery list.
- Legacy `MealPurchasesTab` and `MealIssuesTab` kept reachable via URL
  deep-links only so any old browser bookmarks still work.

### 18 Aug 2026 (Pantry Master v2 — sticky header + one-line rows)
- Added a **sticky column header** at the top of the Masters tree:
  `Item/Category | Unit | Opening | Min | Purch(qty·₹) | Issue(qty·₹) | Close(qty·₹)`.
  Labels no longer repeat on every row.
- Item rows compressed to **one line**: qty and ₹amount inline in each of
  the Purch/Issue/Close cells (was stacked qty-over-₹).
- **Unit / Opening / Min are now inline-editable** on the item row itself
  via `InlineUnit` and `InlineNum` helper components — removed the `⋯`
  edit panel entirely. Click any value to edit, Enter/blur saves, Esc
  cancels.
- Category-total row aligned to the same 6-column grid (Unit + Min cells
  intentionally blank because units are mixed at the category level).
- Hover contrast bumped from `slate-100` to `slate-200/70` for a more
  visible band while scrolling.

### 18 Aug 2026 (Pantry Master row redesign)
- Moved row actions to the LEFT of the item/category name (previously
  hover-revealed on the right). Always visible now — no layout shift.
- Darker row hover: `hover:bg-slate-50` → `hover:bg-slate-100` on both
  categories and items.
- Per-item stats: 4-column grid showing OPEN / PURCH / ISSUE / CLOSE with
  qty + ₹amount stacked. Amounts use weighted-avg cost (WAC) — avg_rate =
  Σ purchase amounts ÷ Σ purchase qty, applied to opening / issued /
  closing which have no per-line rate. Closing value = opening_value +
  purchased_amount − issued_value − wasted_value.
- Per-category stats: only ₹amount totals (qty roll-ups impossible across
  units like kg + L + pcs). Computed on the frontend from item rows.
- Backend `_stock_snapshot` now returns `avg_rate`, `opening_value`,
  `purchased_amount`, `issued_value`, `wasted_value`, `on_hand_value` per
  item alongside existing qty fields (backwards compatible).
- Removed number-input spinner arrows app-wide via `.iu-input[type=number]`
  CSS rule in index.css (WebKit + Firefox). Keyboard entry unaffected.

### 18 Aug 2026 (restore lockout fix)
- Fixed "This device is no longer authorised" after `POST /api/admin/restore?mode=replace`.
  The restore was wiping `devices` (and possibly `users`) before reload — the caller's
  JWT still referenced the old device_id, so the very next request 401'd.
- admin_tools.admin_restore now snapshots the caller's user row + all their device
  rows BEFORE the wipe, and upserts them back AFTER the restore (device status
  forced to "approved" so the current browser tab stays signed in). Idempotent for
  merge mode. Verified end-to-end: preflight + /auth/me both return 200 after a
  full replace restore.

### 18 Aug 2026 (preview login fix + auth hardening)
- Preview phone login 403 root cause: 3 revoked device rows (super phone
  9849002111) were linked to a DELETED old admin user id, so the admin
  self-recovery bypass refused (`device.user_id != matched.id`) → perma-403.
  Deleted the stale rows (preview DB).
- Hardened auth.py self-recovery: an admin may also recover a revoked device
  whose linked user no longer exists (ghost link). Non-admin revoked devices
  remain blocked (verified 403).
- "Item not found" on move/delete: NOT reproducible in preview (UI+API verified);
  likely stale item list on production. Added 404 auto-refresh safety net in
  MealMastersTab (patchItem/deleteItem). AWAITING user answer: preview or prod?

### 18 Aug 2026 (code review #2 + fixes)
- Fixed drag-reorder while a filter is on: dropOn now reorders against the FULL
  category list (items state) so hidden (inactive / not-low) items keep slots.
- Removed 3 duplicate title props from hint sweep (MyLeaves, Meals copy-yesterday,
  Institutions escorts) — kept the more specific hint on each.
- _stock_snapshot to_list caps raised 2000 → 5000; MealNodeDetail Chip uses static
  slate classes (JIT-safe). All 37 pantry pytest cases pass; UI drag verified.
- Reviewer note (deferred, product call): consumption-check "servings" = count of
  ALL meal_records that day (every member × meal tick). Norm is per meal-tick.

### 18 Aug 2026 (Cross-check + Reorder Suggestions)
- Consumption Cross-Check: new "Cross-check" tab (MealCrossCheckTab.jsx) — compares
  issued qty vs meal servings × per-item norms, flags OVER/UNDER per day-item.
  `norm_per_serving` field on meal_items (Masters add/edit forms). Endpoint:
  GET /meals/consumption-check?start&end&tolerance (0.01–1.0, default 0.2).
  UI: range picker, tolerance % input, "Only flagged" toggle, grouped-by-date table.
- Reorder Suggestions: amber "Suggested shopping list" panel atop Masters
  (ShoppingListPanel.jsx) — low items + items running out at 30-day pace;
  suggested buy = ceil(rate×14 + min − on_hand); Copy-list to clipboard.
  Endpoint: GET /meals/reorder-suggestions. /meals/stock refactored into shared
  _stock_snapshot helper.
- Tested: iteration_43.json — 8/8 new pytest + 12/12 iter41 regression, all UI
  flows verified, zero issues. (Rice norm=0.15, min=10 seeded as demo.)

### 18 Aug 2026 (Masters as central hub + hover hints)
- Tree Data View: item click → ledger slide-over (merged purchase/issue/wastage
  events, range picker w/ 30d/90d/1y presets, totals, on-hand); category click →
  per-item summary panel + spend. NEW endpoints: GET /meals/items/{id}/ledger,
  GET /meals/categories/{key}/summary (MealNodeDetail.jsx).
- Low Stock Alerts: `min_stock` on meal_items (add/edit forms in Masters),
  /meals/stock rows carry min_stock+low, low_count; LOW chips in tree, red count
  badge on the Masters tab (MealsReport refetches per tab switch).
- RESTRUCTURE (user approved): "Stock on hand" tab REMOVED (MealStockTab.jsx
  deleted) — folded into Masters via "Only low stock" filter + "Stock as of" date
  picker. Masters is now FIRST tab + default landing. Purchases tab's duplicate
  Items/Categories manager modals removed → single "Manage in Masters" button.
- App-wide hover hints: title tooltips on all sidebar nav items (Layout.jsx hint
  field) and buttons/toggles across ~30 pages (Muster, Presence, Dashboard, Grid
  tabs, Approvals, Leaves, MyLeaves, CheckIn/SelfCheckIn/Escort, Login, Profile,
  Members, Meals, ChefsView, LeaveBalances, all Meal tabs, Calendar, Camps,
  Institutions, Categories, Fleets, Roles, Devices, CheckinApprovals,
  AdminCorrections, DataQuality, ImportMembers, Office, Sites, EscortPhotoCleanup).
- Fixed React table-whitespace warning in Members.jsx.
- Tested: iteration_41.json (Tree Data View + Low Stock, 100%), iteration_42.json
  (restructure + hints sweep + full regression, 100%).

### 18 Aug 2026 (Pantry Masters tree)
- New "Masters" tab in Pantry Stock (MealMastersTab.jsx): tree of Categories → Items.
  - Add/rename/deactivate categories (categories config now carries `active` flag;
    inactive cats hidden from Purchases/Issues/Wastage entry dropdowns).
  - Add/rename/edit (unit, opening stock + as-of)/deactivate/delete items;
    move item to another category via "Move to…" select.
  - Drag-and-drop reorder within a category → NEW `PUT /api/meals/items/reorder`
    (sets sort_order (idx+1)*10; validates ids belong to category; admin-only).
  - Read-only hints: unit badge + stock-on-hand per item (from /meals/stock),
    item count per category; "Show inactive" toggle; chefs get read-only tree.
- Tested: iteration_40.json — 8/8 backend (tests/test_meal_masters_iter40.py),
  all UI flows + chef read-only verified; UI drag-and-drop self-tested & persisted.
- Future (user's words): "then to decide what data we need to manage directly
  from the tree" — next iteration may hang purchases/issues data off tree nodes.

### 17 Aug 2026 (perf + code review sweep)
- **Code review (read-only agent) + fixes, full suite now 665 passed / 0 failed:**
  - IST off-by-one: all backend `date.today()` "today" gates now use office-local
    (Asia/Kolkata) date via `local_date_str` — meals.py (_not_future, item as_of,
    stock as_of), corrections.py (window + future gates), holidays.py (year, buckets,
    absent-YTD, comp-off accrual), data_quality.py (dob/stale/horizon/ex-device).
    Previously blocked meal saves + shifted gates between 00:00–05:30 IST.
  - Members list leave_balance_remaining now mirrors /leave-balances (prefers
    paid_leave_used stamp → half-days/comp-off-funded leaves counted right; overlap
    query). Verified 42/42 members agree with Leave Balances page.
  - days_off double-count fix (server.py hours report): running the report on a
    member's weekly-off day counted today twice (unworked WO + in-progress). Now
    days_off = len(dates_off) set.
  - Naive-vs-aware datetime crashes fixed (legacy rows without tz offset): muster
    bulk checkout (500), data-quality stale-session scan (500), excursion_seconds,
    stale-photo check — naive stamps now assumed UTC.
  - Perf: /api/members last-seen aggregation rewritten to $sort+$group-$first riding
    the {user_id:1,date:-1} index (DISTINCT_SCAN, O(#users) vs full collection scan).
  - Frontend "today" standardized to local `toLocaleDateString("sv-SE")` in Camps,
    Institutions, ChurnRisk (were UTC toISOString — off-by-one before 05:30 IST).
  - Stale tests updated: LF cell code allowed (iter24), super-admin expectations
    derived dynamically (admin account now carries mobile 9849002111 → is super),
    reason-bank cleanup includes early-out smoke reason.
- NOTE (known, unfixed by design): purchases entered via legacy bulk-upload
  `amounts` map (no lines) are invisible to Stock-on-hand math.

### 17 Aug 2026 (Pantry Stock session)
- **Renamed "Meals Report" → "Pantry Stock"** everywhere (sidebar Layout.jsx, App.js, page header).
  Deduped: admins now see it only under ADMIN section (filtered out of Coaches nav).
- **Items master**: db.meal_items {id, category_key, name, unit, opening_stock,
  opening_stock_as_of, active, sort_order}; GET/POST/PUT /api/meals/items.
- **Line-item Purchases**: meal_purchases now carry lines:[{item_id, qty, unit, rate, amount}]
  (amount computed server-side); legacy amounts map kept in sync for expense report.
- **Daily Issues tab** (kitchen consumption): db.meal_issues, PUT/GET /api/meals/issues/{date}.
- **Wastage & Losses tab**: db.meal_wastage with per-line {reason, notes};
  PUT/GET /api/meals/wastage/{date}. Frontend MealWastageTab.jsx.
- **Stock on hand**: GET /api/meals/stock — Opening + Purchases − Issues − Wastage;
  entries before item's opening_stock_as_of excluded. Frontend MealStockTab.jsx.
- **Server-side future-date guard** on PUT purchases/issues/wastage (400 on date > today).
- Tested: iteration_39.json — 9/9 backend pytest (tests/test_pantry_stock_iter39.py),
  all 7 frontend tabs verified, stock math confirmed, zero console errors.

### 17 Jun 2026
- **Calendar Grid left-member fix**: /api/reports/calendar-grid now drops members whose
  `leaving_date` < month start; they still appear in their leaving month with LF cells. (Tested)
- **Meals Expense Report + Purchases module** (extends /admin/meals-report page, 4 tabs now):
  - GET /api/meals/expense-report?start&end — per-day Athletes vs Staff (BF/L/S/D) counts
    from meal_records (grouped by categories.is_athlete_like), daily meal count, purchase
    spend per category, day expense; totals + avg cost per meal. Month or custom range.
  - Purchases: db.meal_purchases (one doc per date, amounts map). GET/PUT
    /api/meals/purchases; configurable categories (db.config id=meal_purchase_categories,
    seeded Fruits/Grocery/Vegetables/Chicken-Mutton/Paneer, admin-managed via
    PUT /api/meals/purchase-categories).
  - Bulk upload: POST /api/meals/purchases/bulk-upload (CSV/XLSX multipart), fuzzy header
    matching, day-first dates, comma amounts, TOTAL footer rows skipped, merge-upsert.
  - Frontend: MealExpensesTab.jsx (summary cards, spreadsheet-style table, CSV export,
    print portal expense-print-active), MealPurchasesTab.jsx (daily entry, last-30-days,
    bulk upload + template, category manager modal admin-only). Admin + Chef access.
  - Tested: iteration_38.json — 20/20 backend, all frontend flows pass.

### Earlier sessions (summary)
- Meal Muster (/meals): roster, mark/unmark-bulk (eligibility + ex-member guards),
  copy-previous, daily counts/details, monthly grid; eligibility unified with Chef's View
  via categories.meal_eligible + leaving_date.
- Perf pass: photo URL endpoints w/ cache headers, GZip, React Query caching (10x faster).
- Leave approvals: context panel (overlapping regattas/tours) + 2-step confirm modal.
- Meals Report daily details modal + paginated PDF print (body-portal pattern).
- Data Quality false-positive fixes; LeaveLedgerModal key fix; Muster, Presence, Escorts,
  Camps/Regattas, Payroll/Overtime, SMS OTP (Twilio), Help chat (Emergent LLM key).

## Key DB collections
- users {id, role, category, mobile, joining_date, leaving_date, ...}
- meal_records {id, user_id, user_name, category, date, meal, marked_by...} (unique user+date+meal)
- meal_purchases {id, date, amounts:{key:amt}, updated_by_name, source}
- config: id=office, id=meal_purchase_categories
- categories {key, label, is_athlete_like, meal_eligible, active}

## Backlog
### P1
- Phase 2 Profile Data Additions — NEEDS USER CLARIFICATION on which fields
- Phase 3 Consumption cross-check (qty issued vs meal counts × per-item norms; flag over/under)
- Meals/Pantry CSV export alongside Print/PDF
- Group-Photo Muster check-in (single wide shot → face match → bulk check-in)
- Payslip PDF generator & Payroll worksheet CSV (staff)
### P2
- Monthly attendance certificate PDF for athletes
- Production data wipe/reset script/button (pre-launch test data)
### P3
- Migrate @sailors.local emails → @athletes.local
- SMS OTP hardening; Regatta locked/manually-edited flag; DMS coordinates input toggle
### Intentionally skipped
- JWT → HttpOnly cookies (would log out all prod users; needs explicit user approval)

## Code review fixes (18 Jun 2026 fork)
- useEscape.js rewritten: shared modal stack (only top-most modal closes per Esc) + Esc while typing in input/textarea only blurs the field (2nd Esc closes). Verified in browser.
- admin restore (replace mode) now atomic: all archive JSON parsed/validated BEFORE any delete_many; corrupt archive → 400 with zero data loss. Verified via curl.
- Roles.jsx duplicate title props removed; shareWhatsApp caption time now Asia/Kolkata; MealMastersTab dropOn reorder 404 → toast + refetch.
- A full DB backup exists at /tmp/backup.tar.gz (18 Aug snapshot, 142 users) — used once for recovery during testing.

## Absent-list WhatsApp share (18 Jun 2026 fork)
- `GET /api/muster/absent-report` — "Absent without information" for today: active athletes + coaches with no attendance row and no approved leave/tour; ex-members excluded. Returns ready flag (office default_work_start + parent_notify_grace_minutes, currently 09:30+5m).
- Muster page banner (`pages/muster/AbsentShareBanner.jsx`) appears once past ready time when absentees exist; one-tap "Share to WhatsApp" composes the bulleted list (athletes + coaches sections, counts, office name) via existing Web Share util.
- User explicitly wants FULL automation later (option b: unofficial gateway like Green API, or c: Twilio per-parent SMS) — semi-automatic chosen for now.

## Code review fixes (June 2026 fork — round 2, all tested via testing agent iteration_44, 100% pass)
- FIX HIGH — Daily entry auto-save day-nav race (`MealEntryTab.jsx`): blur + immediate day-arrow click could write the NEW day's lines onto the OLD date (data corruption) and drop the edit. Now: queuePurch/queueIssues capture the target date; flushPurchases/flushIssues(targetDate) use it in the PUT URL; the dateStr effect's cleanup flushes pending timers with the OLD date before the new day loads; loadToken stale-response guard on all 4 GETs prevents wrong-day paints on rapid day flipping.
- FIX MEDIUM — Opening Stock Rate (was P1 backlog item): new optional `opening_rate` (₹/unit) on meal_items. Backend: ItemIn/ItemPatch + create/update endpoints + `_stock_snapshot` WAC now blends opening value → items with opening stock but no purchases show real valuations instead of ₹0. Frontend: 'Opening ₹/unit' input in Masters add-item form; inline-editable `@₹x/unit` (InlineRate) under the Opening qty in the tree (shown when opening_stock > 0). Curl-verified: opening-only avg_rate=45→value ₹450; blend (10@50 + 10@60) → avg 55.
- FIX MEDIUM — DB restore self-preservation (`admin_tools.py`): user re-attach changed `$setOnInsert` → `$set` so a backup containing an older copy of the acting admin can no longer revert their role/state after a replace restore.
- Known cosmetic (NOT fixed, verified fine in testing): hardcoded sticky offsets top-[104px]/top-[216px] in Meals tabs vs page header ~111-132px; MealCrossCheckTab sticky treatment still pending.

## Notes for agents
- Print PDFs: portal print region to document.body, body class + print CSS in index.css.
- Test users: emails ending .local are rejected by email-validator; use @meals.example.com.
- Env "today" in preview ≈ 2026-08-17.
- Backend test suite: /app/backend/tests/ (incl. test_meal_purchases_and_expense.py).
