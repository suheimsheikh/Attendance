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
  { key: "rest",    label: "Staff & Coaches" },
  { key: "athlete", label: "Athletes" },
];

// Compact live-snapshot pills shown to the right of the filter row.
const STAT_PILLS = [
  { key: "present", label: "Present", dot: "bg-emerald-500", text: "text-emerald-700", bg: "bg-emerald-50 border-emerald-200" },
  { key: "late",    label: "Late",    dot: "bg-yellow-500",  text: "text-yellow-700",  bg: "bg-yellow-50 border-yellow-200" },
  { key: "absent",  label: "Absent",  dot: "bg-red-500",     text: "text-red-700",     bg: "bg-red-50 border-red-200" },
  { key: "leave",   label: "Leave",   dot: "bg-amber-400",   text: "text-amber-700",   bg: "bg-amber-50 border-amber-200" },
  { key: "tour",    label: "Tour",    dot: "bg-orange-400",  text: "text-orange-700",  bg: "bg-orange-50 border-orange-200" },
  { key: "off",     label: "Off",     dot: "bg-slate-400",   text: "text-slate-600",   bg: "bg-slate-100 border-slate-200" },
];

function StatGroup({ title, stats, testid }) {
  if (!stats) return null;
  return (
    <div className="inline-flex items-center gap-1.5" data-testid={testid}>
      <span className="text-[11px] font-extrabold uppercase tracking-wide text-slate-900 mr-0.5">{title}</span>
      {STAT_PILLS.map((p) => (
        <span
          key={p.key}
          className={`inline-flex items-center gap-1.5 h-8 pl-2 pr-2.5 rounded-full border text-xs font-bold ${p.bg} ${p.text}`}
          title={`${title} — ${p.label}`}
          data-testid={`${testid}-${p.key}`}
        >
          <span className={`w-2 h-2 rounded-full ${p.dot}`} />
          <span className="tabular-nums">{stats[p.key] ?? 0}</span>
          <span className="hidden 2xl:inline text-slate-500 font-semibold">{p.label}</span>
        </span>
      ))}
    </div>
  );
}

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
  staffStats,
  athleteStats,
  statsDateLabel,
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mb-2">
      <div className="flex flex-wrap items-center gap-2" data-testid="calendar-category-filters">
        {CATEGORY_FILTERS.map((f) => {
          const active = categoryFilter === f.key;
          const count =
            f.key === "all"     ? rows.length
          : f.key === "athlete" ? rows.filter(isAthleteLike).length
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

      {/* Live status snapshot — Staff & Athletes, as of the reference day. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-testid="calendar-stat-pills">
        <StatGroup title="Staff" stats={staffStats} testid="grid-stats-staff" />
        <StatGroup title="Athletes" stats={athleteStats} testid="grid-stats-athletes" />
        {statsDateLabel && (
          <span className="text-[10px] text-slate-400 hidden xl:inline">as of {statsDateLabel}</span>
        )}
      </div>
    </div>
  );
}
