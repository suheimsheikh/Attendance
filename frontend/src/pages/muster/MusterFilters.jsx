/**
 * Muster scope + institution filter chip rows.
 *
 * Pure presentational — both components are stateless and controlled
 * from Muster.jsx. Extracted 15 Feb 2026 as part of the incremental
 * split of the 587-line parent.
 */
import React from "react";

// Admin-only scope chips — widens the muster roster beyond athletes.
// Coaches/escorts don't see these; the server always restricts them
// to athletes regardless of the client filter.
export const MUSTER_SCOPES = [
  { key: "all",          label: "All" },
  { key: "athletes",     label: "Athletes" },
  { key: "staff",        label: "Staff" },
  { key: "coach",        label: "Coaches" },
  { key: "executive",    label: "Executives" },
  { key: "non_athletes", label: "Non-athletes" },
];

export function MusterScopeChips({ scope, onChange }) {
  return (
    <div
      className="flex gap-2 overflow-x-auto pb-2 mb-3 -mx-1 px-1"
      data-testid="muster-scope-filter"
    >
      {MUSTER_SCOPES.map((s) => {
        const active = scope === s.key;
        return (
          <button
            key={s.key}
            data-testid={`muster-scope-${s.key}`}
            onClick={() => onChange(s.key)}
            className={`iu-chip whitespace-nowrap shrink-0 ${active ? "iu-chip-active" : ""}`}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Institution filter chips. Only renders when there are ≥ 2 institutions
 * represented in the current roster (single-institution academies
 * shouldn't see the extra chrome).
 */
export function MusterInstitutionChips({
  institutions, institutionFilter, onChange, totalCount,
}) {
  if (institutions.length <= 1) return null;
  return (
    <div
      className="flex gap-2 overflow-x-auto pb-2 mb-3 -mx-1 px-1"
      data-testid="muster-institution-filter"
    >
      <button
        data-testid="muster-institution-all"
        onClick={() => onChange("all")}
        className={`iu-chip whitespace-nowrap shrink-0 ${institutionFilter === "all" ? "iu-chip-active" : ""}`}
      >
        All
        <span className={`min-w-[22px] h-5 px-1.5 rounded-full text-[10px] flex items-center justify-center ${institutionFilter === "all" ? "bg-white/20 text-white" : "bg-white border border-slate-200 text-slate-600"}`}>
          {totalCount}
        </span>
      </button>
      {institutions.map((inst) => {
        const active = institutionFilter === inst.name;
        return (
          <button
            key={inst.name}
            data-testid={`muster-institution-${inst.name.replace(/\s+/g, "-").toLowerCase()}`}
            onClick={() => onChange(inst.name)}
            className={`iu-chip whitespace-nowrap shrink-0 ${active ? "iu-chip-active" : ""}`}
          >
            {inst.name}
            <span className={`min-w-[22px] h-5 px-1.5 rounded-full text-[10px] flex items-center justify-center ${active ? "bg-white/20 text-white" : "bg-white border border-slate-200 text-slate-600"}`}>
              {inst.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
