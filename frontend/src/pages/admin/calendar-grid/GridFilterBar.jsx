/**
 * GridFilterBar — the row of category chips + fleet + institution +
 * name-search + rows-mode toggle that sits above the calendar-grid
 * table. Purely presentational; parent (`CalendarGridTab`) owns all
 * filter state and passes down setters. Extracted 14 Feb 2026 as part
 * of the low-risk maintainability refactor (item I from the priority
 * grid) — CalendarGridTab.jsx was creeping past 600 LOC.
 */
import React from "react";
import { Search, Rows2, Rows } from "lucide-react";

const CATEGORY_FILTERS = [
  { key: "all",     label: "All" },
  { key: "athlete", label: "Athletes" },
  { key: "elite",   label: "Elite" },
  { key: "rest",    label: "Staff & Coaches" },
];

export default function GridFilterBar({
  rows,
  isAthleteLike,
  categoryFilter,
  onCategoryFilter,
  fleetFilter,
  onFleetFilter,
  fleetOptions,
  institutionFilter,
  onInstitutionFilter,
  institutionOptions,
  nameSearch,
  onNameSearch,
  rowsMode,
  onToggleRowsMode,
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
      <div className="flex flex-wrap gap-2" data-testid="calendar-category-filters">
        {CATEGORY_FILTERS.map((f) => {
          const active = categoryFilter === f.key;
          const count =
            f.key === "all"     ? rows.length
          : f.key === "athlete" ? rows.filter(isAthleteLike).length
          : f.key === "elite"   ? rows.filter((r) => r.category === "elite").length
          :                       rows.filter((r) => !isAthleteLike(r)).length;
          return (
            <button
              key={f.key}
              data-testid={`calendar-cat-filter-${f.key}`}
              onClick={() => {
                onCategoryFilter(f.key);
                // Athlete is the only category that surfaces a fleet
                // dropdown — reset the fleet filter when leaving it so
                // stale state doesn't leak into the next view.
                if (f.key !== "athlete") onFleetFilter("");
              }}
              className={`iu-chip ${active ? "iu-chip-active" : ""}`}
            >
              {f.label}
              <span className={`min-w-[22px] h-5 px-1.5 rounded-full text-[10px] flex items-center justify-center ${active ? "bg-white/20 text-white" : "bg-white border border-slate-200 text-slate-600"}`}>
                {count}
              </span>
            </button>
          );
        })}
        {categoryFilter === "athlete" && fleetOptions.length > 0 && (
          <select
            data-testid="calendar-fleet-filter"
            value={fleetFilter}
            onChange={(e) => onFleetFilter(e.target.value)}
            className="iu-input !w-40 !py-1 !h-8 text-xs"
          >
            <option value="">All fleets</option>
            {fleetOptions.map((f) => (
              <option key={f} value={f}>{f === "__none__" ? "(No fleet)" : f}</option>
            ))}
          </select>
        )}
        {institutionOptions.length > 0 && (
          <select
            data-testid="calendar-institution-filter"
            value={institutionFilter}
            onChange={(e) => onInstitutionFilter(e.target.value)}
            className="iu-input !w-44 !py-1 !h-8 text-xs"
            title="Filter by institution"
          >
            <option value="">All institutions</option>
            <option value="__none__">(No institution)</option>
            {institutionOptions.map((i) => (
              <option key={i} value={i}>{i}</option>
            ))}
          </select>
        )}
        {/* Name / rank search — fed straight into displayedRows in
            CalendarGridTab. Case-insensitive substring across
            member_name + rank. */}
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            type="search"
            data-testid="calendar-name-search"
            value={nameSearch}
            onChange={(e) => onNameSearch(e.target.value)}
            placeholder="Search name / rank…"
            className="iu-input !w-52 !py-1 !h-8 text-xs !pl-7"
            autoComplete="off"
          />
        </div>
        {/* 1-row / 2-row toggle. Icon reflects the state you'd flip
            INTO on click so the affordance is unambiguous. */}
        <button
          type="button"
          data-testid="calendar-rows-mode-toggle"
          onClick={onToggleRowsMode}
          title={rowsMode === "single" ? "Switch to 2-row view (In/Out times)" : "Switch to 1-row view"}
          className={`inline-flex items-center gap-1 px-2 h-8 rounded-md text-xs font-semibold border transition ${
            rowsMode === "double"
              ? "border-sky-500 bg-sky-500 text-white"
              : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
          }`}
        >
          {rowsMode === "single" ? <Rows2 size={12}/> : <Rows size={12}/>}
          {rowsMode === "single" ? "In / Out" : "Compact"}
        </button>
      </div>
    </div>
  );
}
