import React from "react";

/**
 * FleetFilterRow — pill row for fleet filters on the Presence Board.
 * Renders nothing when no fleet labels exist among loaded members.
 * Pure presentation; controlled by the parent's `fleetFilter` state.
 */
export function FleetFilterRow({ fleetOptions, fleetFilter, onFleetChange }) {
  if (!fleetOptions || fleetOptions.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5 mb-3 flex-wrap" data-testid="fleet-filter-row">
      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mr-1">Fleet</span>
      <button
        type="button"
        data-testid="fleet-filter-all"
        onClick={() => onFleetChange("")}
        className={`px-2.5 h-7 rounded-full text-[11px] font-bold transition border ${
          fleetFilter === "" ? "bg-sky-600 text-white border-transparent" : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
        }`}
      >
        All
      </button>
      {fleetOptions.map((f) => (
        <button
          key={f}
          type="button"
          data-testid={`fleet-filter-${f}`}
          onClick={() => onFleetChange(f)}
          className={`px-2.5 h-7 rounded-full text-[11px] font-bold transition border ${
            fleetFilter === f ? "bg-sky-600 text-white border-transparent" : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
          }`}
        >
          {f}
        </button>
      ))}
    </div>
  );
}
