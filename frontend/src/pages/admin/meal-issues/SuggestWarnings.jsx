import React, { useState } from "react";
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

/** Cross-unit conversions: items that can't convert (need a value) + items using an assumed weight. */
export function ConversionsBox({ mismatches, assumed, onSave, saving }) {
  const [vals, setVals] = useState({});
  const rows = [
    ...mismatches.map((m) => ({ id: m.item_id, name: m.pantry_name, unit: m.pantry_unit, need: true, note: `recipe in ${m.recipe_unit}` })),
    ...assumed.map((l) => ({ id: l.item_id, name: l.item_name, unit: l.unit, need: false, gpu: l.conversion.grams_per_unit,
      note: l.conversion.source === "density" ? "assumed 1 g ≈ 1 ml" : "assumed typical piece weight" })),
  ];
  if (!rows.length) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs" data-testid="suggest-conversions">
      <div className="font-bold text-slate-700 mb-2">Unit conversions — grams in one pantry unit</div>
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-1.5" data-testid={`suggest-conv-${r.id}`}>
            <span className={`font-semibold ${r.need ? "text-rose-700" : "text-slate-800"}`}>{r.name}</span>
            <span className="text-slate-500">· {r.need ? `can't convert (${r.note}) — skipped` : r.note}</span>
            <span className="ml-auto inline-flex items-center gap-1">
              1 {r.unit} =
              <input
                type="number" min="0" step="any" placeholder={r.gpu ? String(r.gpu) : "grams"}
                value={vals[r.id] ?? ""} onChange={(e) => setVals({ ...vals, [r.id]: e.target.value })}
                className="iu-input !h-7 w-20 text-right tabular-nums" data-testid={`suggest-conv-input-${r.id}`}
              />
              g
              <button
                type="button" disabled={!(Number(vals[r.id]) > 0) || saving === r.id}
                onClick={() => onSave(r.id, Number(vals[r.id]))}
                className="px-2 h-7 rounded-md bg-white border border-slate-300 hover:bg-slate-100 font-semibold disabled:opacity-50"
                data-testid={`suggest-conv-save-${r.id}`}
              >
                {saving === r.id ? <Loader2 size={11} className="animate-spin inline" /> : "Save"}
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
