import React from "react";
import { fmtQty } from "../../../utils";

/** Editable per-meal headcounts (pre-filled from the meals muster). */
export function HeadcountRow({ headcounts, draft, setDraft, onRecalc, busy }) {
  return (
    <div className="flex flex-wrap items-end gap-2" data-testid="suggest-headcounts">
      {Object.entries(headcounts).map(([k, h]) => (
        <label key={k} className="flex flex-col text-[11px] text-slate-500 w-[6.5rem]">
          <span className="font-semibold truncate" title={h.label}>{h.label}</span>
          <input
            type="number" min="0" value={draft[k] ?? h.used}
            onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
            className="iu-input !h-8 text-sm text-right tabular-nums"
            data-testid={`suggest-headcount-${k}`}
          />
          <span className="mt-0.5" data-testid={`suggest-headcount-src-${k}`}>
            {h.source === "muster" ? `muster: ${h.muster}` : h.source === "prev_day" ? `yesterday: ${h.prev_day}` : `muster ${h.muster} · yday ${h.prev_day}`}
          </span>
        </label>
      ))}
      <button type="button" onClick={onRecalc} disabled={busy} className="iu-btn-secondary !h-8 text-xs mb-[18px]" data-testid="suggest-recalc">
        Recalculate
      </button>
    </div>
  );
}

/** Suggested lines with a pick checkbox each. */
export function SuggestLines({ lines, picked, setPicked }) {
  if (!lines.length) {
    return <div className="p-6 text-center text-sm text-slate-500" data-testid="suggest-no-lines">No lines — set a headcount above or check the menu.</div>;
  }
  const toggle = (id) => setPicked({ ...picked, [id]: !picked[id] });
  return (
    <table className="w-full text-sm" data-testid="suggest-lines">
      <thead className="bg-slate-50 text-[11px] uppercase text-slate-500 sticky top-0">
        <tr>
          <th className="p-2 w-8" />
          <th className="text-left p-2">Item</th>
          <th className="text-right p-2">Suggested</th>
          <th className="text-right p-2">On-hand</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.item_id} className={`border-t border-slate-100 ${l.short ? "bg-rose-50/60" : ""}`} data-testid={`suggest-line-${l.item_id}`}>
            <td className="p-2">
              <input type="checkbox" checked={!!picked[l.item_id]} onChange={() => toggle(l.item_id)} data-testid={`suggest-pick-${l.item_id}`} />
            </td>
            <td className="p-2">
              <div className="font-semibold text-slate-900">{l.item_name}</div>
              <div className="text-[11px] text-slate-500 truncate max-w-[18rem]" title={l.sources.join("\n")}>{l.sources.join(" · ")}</div>
              {l.conversion && (
                <div className="text-[10px] text-sky-700" data-testid={`suggest-conv-note-${l.item_id}`}>
                  ≈ 1 {l.unit} = {l.conversion.grams_per_unit} g{l.conversion.source === "item" ? "" : " (assumed)"}
                </div>
              )}
            </td>
            <td className="p-2 text-right tabular-nums font-semibold" data-testid={`suggest-qty-${l.item_id}`}>{fmtQty(l.qty, l.unit)} <span className="text-slate-400 text-xs font-normal">{l.unit}</span></td>
            <td className="p-2 text-right tabular-nums text-slate-600">
              {l.on_hand != null ? fmtQty(l.on_hand, l.unit) : "—"}
              {l.short && <span className="ml-1 text-[10px] font-bold text-rose-600" data-testid={`suggest-short-${l.item_id}`}>SHORT</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
