import React from "react";
import { MapPin } from "lucide-react";

/**
 * LocationFilterRow — pill row for filtering the Presence Board by the
 * training location a member is currently checked into. Shown only when
 * there is more than one distinct location on today's board (so the
 * bar doesn't add noise on a single-site day).
 *
 * `locations` is the `by_location` array from GET /api/presence.
 * `locationFilter` holds the currently-selected site_name (or "" for all).
 */
export function LocationFilterRow({ locations, locationFilter, onLocationChange }) {
  if (!locations || locations.length < 2) return null;
  return (
    <div className="flex items-center gap-1.5 mb-3 flex-wrap" data-testid="location-filter-row">
      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mr-1 flex items-center gap-1">
        <MapPin size={11} /> Location
      </span>
      <button
        type="button"
        data-testid="location-filter-all"
        onClick={() => onLocationChange("")}
        className={`px-2.5 h-7 rounded-full text-[11px] font-bold transition border ${
          locationFilter === ""
            ? "bg-sky-600 text-white border-transparent"
            : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
        }`}
      >
        All
      </button>
      {locations.map((loc) => {
        const active = locationFilter === loc.site_name;
        return (
          <button
            key={loc.site_id || "__main__"}
            type="button"
            data-testid={`location-filter-${loc.site_id || "main"}`}
            onClick={() => onLocationChange(loc.site_name)}
            className={`inline-flex items-center gap-1.5 pl-2.5 pr-2 h-7 rounded-full text-[11px] font-bold transition border ${
              active
                ? "bg-sky-600 text-white border-transparent"
                : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
            }`}
          >
            <span>{loc.site_name}</span>
            <span
              className={`inline-flex items-center justify-center min-w-[20px] h-4 rounded-full text-[10px] font-mono tabular-nums px-1 ${
                active ? "bg-white/25 text-white" : "bg-slate-100 text-slate-700"
              }`}
            >
              {loc.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
