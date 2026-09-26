# Component Map — where things live

> Purpose: land each change in the right small file first-try. Updated 25 Jun 2026.
> Frontend root: `/app/frontend/src`. Backend root: `/app/backend`.

## Routing
- `App.js` — all routes. Admin pages gated by `RequireAdmin` / `RequireChefOrAdmin`.
- Sidebar links live in `components/Layout.jsx` (edit BOTH nav arrays when adding a link).

## Meals / Kitchen module
Entry point: **`pages/admin/MealsReport.jsx`** (route `/admin/meals-report`). It renders a tab bar; each tab → one component:

| Tab (`?tab=`) | Component | Notes |
|---|---|---|
| `entry` (default) | `MealEntryTab.jsx` | Unified daily Purchases/Issues/Wastage grid, auto-save |
| `masters` | `MealMastersTab.jsx` | Categories→Items tree (Stock Master) |
| `daily` | `reports/DailyTab.jsx` | (shared with Grid) |
| `expenses` | `MealExpensesTab.jsx` | |
| `stocktake` | `MealStockTakeTab.jsx` | physical count → `meal_adjustments` |
| `crosscheck` | `MealCrossCheckTab.jsx` | expected vs actual (uses `norm_per_serving`) |
| analytics/price-movers/compare | `KitchenAnalyticsTab.jsx`, `MealPriceMoversTab.jsx`, `MealCompareTab.jsx` | nested tabs, not sidebar |

### `MealEntryTab.jsx` (orchestrator, ~1140 lines) + `pages/admin/meal-entry/`
- `helpers.js` — `todayISO`, `addDays`, `num`, `inr`
- `RowVendorPicker.jsx` — per-row supplier `<select>` + scorecard button (used inside EntryItemRow)
- `AddVendorInlineModal.jsx` — "＋ Add new vendor…" dialog
- `DailyTotalsHistoryModal.jsx` — date-wise drill-down (dbl-click a totals card), print/PDF
- `EntryItemRow.jsx` — one item row, split into four internal cell-groups: `LeadCells` (name/unit/on-hand), `PurchaseCells` (supplier/qty/rate/amt), `IssueCells` (qty/rate/amt), `WastageCells` (qty/reason+note/amt). All share one `ctx` bundle passed from the parent (setters, refs, data, focus helpers).

### `MealMastersTab.jsx` (orchestrator, ~650 lines) + `pages/admin/meal-masters/`
- `helpers.js` — `fmt`, `fmtRs`, `UNIT_OPTIONS`, `COL_GRID` (shared column-width grid)
- `InlineEditors.jsx` — `InlineEdit` (text), `InlineNum`, `InlineRate`, `InlineDate`, `InlineUnit` (click-to-edit cells)
- `AddItemForm.jsx` — inline add-item row within a category
- `ItemRow.jsx` — one item line (ops, inline editors, stock stats)
- `NutritionEditorModal.jsx` — per-100g nutrition editor
- Node detail panels: `MealNodeDetail.jsx` (`ItemDetailPanel`, `CategoryDetailPanel`), drawer `ItemLedgerDrawer.jsx`

### Kitchen extras (sidebar under "Kitchen")
- `KitchenAuditLog.jsx` (`/admin/kitchen-audit`) — `GET /api/meals/audit-log`
- `MealsDataHealth.jsx` (`/admin/kitchen-health`) — `GET /api/meals/data-health`

## The Grid (attendance calendar)
Entry point: **`pages/admin/Reports.jsx`** (route `/admin/reports`), tab bar → Calendar Grid / Attendance / Daily.
### `CalendarGridTab.jsx` + `pages/admin/calendar-grid/`
- `gridHelpers.jsx` — `CELL_STYLE` (code→colour registry), `GridCell`, `GridTimeCell`, `buildCellTooltip`, `correctionForCode`, `fmtOt`, `TODAY_COL` (today-column outline)
- `GridFilterBar.jsx` — category/fleet/institution/name filters + rows-mode toggle
- `GridRowTotals.jsx` — right-sticky totals strip (DAR/P/AB/LP/LV/TR/OT/EO/LT)
- Data: `GET /api/reports/calendar-grid?month=` (backend `routes/reports.py`)

## Backend
- `server.py` — app assembly, auth, attendance core, `compute_hours_report` (payroll). Passes `write_audit` into routers.
- `routes/meals.py` — ALL pantry endpoints (items, categories, purchases, issues, wastage, stock-take, daily-totals, last-rates, audit-log, data-health). ~5.5k lines; `_grid_impl`/stock math here. NOTE: not yet split.
- `routes/reports.py` — calendar-grid, attendance summaries, exports.
- `routes/admin_audit.py` — shared `audit_log` read API.
- `services/` — `attendance_calc.py`, `time_utils.py`, `nutrition_seed.py`.

## Conventions
- Every interactive/critical element needs a unique kebab-case `data-testid`.
- New shared component → `components/`; page-specific sub-component → a `pages/admin/<feature>/` subfolder (see meal-entry, meal-masters, calendar-grid).
- Backend routes ALWAYS `/api`-prefixed. Frontend calls via `api` from `src/api.js` (uses `REACT_APP_BACKEND_URL`).
