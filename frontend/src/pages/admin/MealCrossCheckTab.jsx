/**
 * MealCrossCheckTab — day-by-day comparison of quantities the kitchen
 * issued vs meal counts × per-item norms. Flags OVER / UNDER days.
 * Norms are set per item in the Masters tree ("Norm/serving").
 */
import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Scale, AlertTriangle, ArrowUp, ArrowDown, Check } from "lucide-react";
import { api, showApiError } from "../../api";
import { formatDate } from "../../utils";

const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 3 }));

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toLocaleDateString("sv-SE");
}
const todayISO = () => new Date().toLocaleDateString("sv-SE");

const FLAG = {
  over:  { label: "Over",  cls: "bg-rose-100 text-rose-700",     Icon: ArrowUp },
  under: { label: "Under", cls: "bg-amber-100 text-amber-800",   Icon: ArrowDown },
  ok:    { label: "OK",    cls: "bg-emerald-100 text-emerald-700", Icon: Check },
};

export default function MealCrossCheckTab({ onGoMasters, liveSig }) {
  const [start, setStart] = useState(isoDaysAgo(13));
  const [end, setEnd] = useState(todayISO());
  const [tolPct, setTolPct] = useState(20);
  const [flaggedOnly, setFlaggedOnly] = useState(true);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const tol = Math.min(Math.max(Number(tolPct) || 20, 1), 100) / 100;
    api.get(`/meals/consumption-check?start=${start}&end=${end}&tolerance=${tol}`)
      .then(setData)
      .catch((err) => showApiError(err, "Couldn't run the cross-check"))
      .finally(() => setLoading(false));
  }, [start, end, tolPct, liveSig]);

  const byDate = useMemo(() => {
    const m = new Map();
    (data?.rows || []).forEach((r) => {
      if (flaggedOnly && r.flag === "ok") return;
      if (!m.has(r.date)) m.set(r.date, { servings: r.servings, rows: [] });
      m.get(r.date).rows.push(r);
    });
    return Array.from(m.entries());
  }, [data, flaggedOnly]);

  return (
    <div data-testid="meal-crosscheck-tab">
      <div className="flex items-center gap-3 flex-wrap mb-4">
        <input type="date" value={start} max={end} onChange={(e) => setStart(e.target.value)} className="iu-input !h-9 !w-auto text-sm" data-testid="crosscheck-start" title="Start of the range to check"/>
        <span className="text-xs text-slate-400">to</span>
        <input type="date" value={end} min={start} max={todayISO()} onChange={(e) => setEnd(e.target.value)} className="iu-input !h-9 !w-auto text-sm" data-testid="crosscheck-end" title="End of the range to check"/>
        <label className="inline-flex items-center gap-1.5 text-xs text-slate-600" title="How far issued can drift from expected before a day is flagged">
          Tolerance ±
          <input type="number" min="1" max="100" value={tolPct} onChange={(e) => setTolPct(e.target.value)} className="iu-input !h-9 !w-16 text-sm" data-testid="crosscheck-tolerance"/>%
        </label>
        <label className="ml-auto inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer" title="Hide days where usage was within tolerance">
          <input type="checkbox" checked={flaggedOnly} onChange={(e) => setFlaggedOnly(e.target.checked)} data-testid="crosscheck-flagged-only"/>
          <AlertTriangle size={12}/> Only flagged
        </label>
      </div>

      {loading ? (
        <div className="text-center py-10"><Loader2 className="animate-spin mx-auto text-slate-400"/></div>
      ) : !data ? null : data.items_with_norm === 0 ? (
        <div className="iu-card p-8 text-center" data-testid="crosscheck-no-norms">
          <Scale size={32} className="mx-auto text-slate-300 mb-3"/>
          <p className="font-bold text-slate-700 mb-1">No items have a norm yet</p>
          <p className="text-sm text-slate-500 mb-4 max-w-md mx-auto">
            Set a <span className="font-semibold">Norm/serving</span> (expected quantity per meal served, e.g. 0.15 kg of rice)
            on each item you want checked — via the item's edit form in the Masters tree.
          </p>
          {onGoMasters && (
            <button onClick={onGoMasters} className="iu-btn-primary" title="Open the Masters tree to set norms" data-testid="crosscheck-go-masters">
              Open Masters
            </button>
          )}
        </div>
      ) : (
        <>
          <p className="text-xs text-slate-500 mb-3" data-testid="crosscheck-summary">
            {data.items_with_norm} item{data.items_with_norm === 1 ? "" : "s"} with norms ·{" "}
            <span className={data.flagged > 0 ? "text-rose-600 font-bold" : "text-emerald-700 font-bold"}>
              {data.flagged} flagged
            </span>{" "}
            day-item{data.flagged === 1 ? "" : "s"} in this range
          </p>
          {byDate.length === 0 ? (
            <div className="iu-card p-8 text-center text-sm text-slate-400 italic" data-testid="crosscheck-empty">
              {flaggedOnly ? "Nothing flagged — kitchen usage matched the norms." : "No meal counts or issues found in this range."}
            </div>
          ) : (
            <div className="iu-card overflow-hidden">
              <table className="w-full text-sm" data-testid="crosscheck-table">
                <thead className="text-[11px] uppercase text-slate-500 bg-slate-50">
                  <tr>
                    <th className="text-left p-2">Item</th>
                    <th className="text-right p-2" title="Meal servings marked that day">Servings</th>
                    <th className="text-right p-2" title="Servings × norm per serving">Expected</th>
                    <th className="text-right p-2" title="Quantity logged in Daily issues">Issued</th>
                    <th className="text-right p-2" title="Issued − expected">Diff</th>
                    <th className="text-left p-2">Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {byDate.map(([d, g]) => (
                    <React.Fragment key={d}>
                      <tr className="bg-slate-50/80 border-t border-slate-200">
                        <td colSpan={6} className="px-2 py-1 text-[11px] font-bold text-slate-600 uppercase tracking-wider">
                          {formatDate(d)} · {g.servings} serving{g.servings === 1 ? "" : "s"}
                        </td>
                      </tr>
                      {g.rows.map((r) => {
                        const f = FLAG[r.flag];
                        return (
                          <tr key={`${d}-${r.item_id}`} className="border-t border-slate-100" data-testid={`crosscheck-row-${d}-${r.item_id}`}>
                            <td className="p-2 font-semibold text-slate-900">{r.name} <span className="text-[10px] text-slate-400 uppercase">{r.unit}</span></td>
                            <td className="p-2 text-right tabular-nums text-slate-600">{r.servings}</td>
                            <td className="p-2 text-right tabular-nums text-slate-600" title={`${r.servings} × ${fmt(r.norm)} ${r.unit}`}>{fmt(r.expected)}</td>
                            <td className="p-2 text-right tabular-nums font-semibold">{fmt(r.issued)}</td>
                            <td className={`p-2 text-right tabular-nums font-semibold ${r.diff > 0 ? "text-rose-600" : r.diff < 0 ? "text-amber-700" : "text-slate-500"}`}>
                              {r.diff > 0 ? "+" : ""}{fmt(r.diff)}{r.pct != null && <span className="text-[10px] text-slate-400"> ({r.pct > 0 ? "+" : ""}{r.pct}%)</span>}
                            </td>
                            <td className="p-2">
                              <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${f.cls}`}
                                    title={r.flag === "over" ? "Kitchen used more than expected for the meals served" : r.flag === "under" ? "Kitchen used less than expected for the meals served" : "Within tolerance"}>
                                <f.Icon size={10}/> {f.label}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
