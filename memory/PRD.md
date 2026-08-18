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

## Notes for agents
- Print PDFs: portal print region to document.body, body class + print CSS in index.css.
- Test users: emails ending .local are rejected by email-validator; use @meals.example.com.
- Env "today" in preview ≈ 2026-08-17.
- Backend test suite: /app/backend/tests/ (incl. test_meal_purchases_and_expense.py).
