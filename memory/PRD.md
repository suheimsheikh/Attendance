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
