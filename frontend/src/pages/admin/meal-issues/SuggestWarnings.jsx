import React from "react";
import { AlertTriangle, Link2, Loader2 } from "lucide-react";

/** Recipe ingredients with no pantry match — admins can map each to a pantry item in one tap. */
export function UnmatchedList({ rows, canMap, mapping, onMap }) {
  if (!rows.length) return null;
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-3" data-testid="suggest-unmatched">
      <div className="flex items-center gap-1.5 text-xs font-bold text-amber-800 mb-2">
        <AlertTriangle size={13} /> {rows.length} recipe ingredient{rows.length === 1 ? "" : "s"} not in the pantry — skipped
      </div>
      <ul className="space-y-1.5">
        {rows.map((u) => (
          <li key={u.name} className="flex flex-wrap items-center gap-1.5 text-xs" data-testid={`suggest-unmatched-${u.name}`}>
            <span className="font-semibold text-slate-800">{u.name}</span>
            <span className="text-slate-500 truncate max-w-[16rem]" title={u.sources.join("\n")}>· {u.sources[0]}{u.sources.length > 1 ? ` +${u.sources.length - 1}` : ""}</span>
            {canMap && u.suggestions.length > 0 && (
              <span className="inline-flex items-center gap-1 ml-auto">
                <Link2 size={12} className="text-slate-400" />
                {u.suggestions.map((s) => (
                  <button
                    key={s} type="button" disabled={!!mapping}
                    onClick={() => onMap(u.name, s)}
                    title={`Rename "${u.name}" to "${s}" in every recipe`}
                    className="px-2 h-6 rounded-full bg-white border border-amber-300 text-amber-900 hover:bg-amber-100 transition-colors"
                    data-testid={`suggest-map-${u.name}-${s}`}
                  >
                    {mapping === `${u.name}→${s}` ? <Loader2 size={11} className="animate-spin inline" /> : null} {s}
                  </button>
                ))}
              </span>
            )}
          </li>
        ))}
      </ul>
      {!canMap && <p className="text-[11px] text-amber-700 mt-2">Ask an admin to map these in Recipes → Menu vs Actual.</p>}
    </div>
  );
}

/** Ingredients matched by name whose recipe unit can't convert to the pantry unit (e.g. g → dozen). */
export function UnitMismatchList({ rows }) {
  if (!rows.length) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs" data-testid="suggest-unit-mismatches">
      <div className="font-bold text-slate-700 mb-1">Unit can't convert — add these by hand</div>
      {rows.map((m) => (
        <div key={m.pantry_name} className="text-slate-600">
          <span className="font-semibold text-slate-800">{m.pantry_name}</span>: recipe in {m.recipe_unit}, pantry in {m.pantry_unit}
        </div>
      ))}
    </div>
  );
}
