/**
 * StockVarianceReport — ranks the biggest stock-take losses/extras
 * across items over a range, plus a chronological audit trail of every
 * count (who, when, physical vs system). Rendered inside the Stock Take
 * tab under the "Variance & audit" view.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Loader2, TrendingDown, TrendingUp, History, AlertTriangle } from "lucide-react";
import { api, showApiError } from "../../api";
import { formatDate, fmtQty } from "../../utils";

const isoDaysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString("sv-SE"); };
const todayISO = () => new Date().toLocaleDateString("sv-SE");
const rupee = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const stamp = (iso) => iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "";

function Stat({ label, value, tone }) {
  const tones = {
    rose: "bg-rose-50 ring-rose-100 text-rose-700",
    emerald: "bg-emerald-50 ring-emerald-100 text-emerald-700",
    slate: "bg-slate-50 ring-slate-200 text-slate-700",
  };
  return (
    <div className={`rounded-xl ring-1 px-3 py-2 ${tones[tone] || tones.slate}`}>
      <p className="text-[10px] uppercase font-bold opacity-80">{label}</p>
      <p className="text-sm font-extrabold tabular-nums">{value}</p>
    </div>
  );
}

export default function StockVarianceReport({ liveSig }) {
  const [start, setStart] = useState(isoDaysAgo(29));
  const [end, setEnd] = useState(todayISO());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api.get(`/meals/stock-take/report?start=${start}&end=${end}`)
      .then(setData)
      .catch((e) => showApiError(e, "Couldn't load variance report"))
      .finally(() => setLoading(false));
  }, [start, end]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (liveSig) load(); }, [liveSig, load]);

  const rows = data?.rows || [];
  const history = data?.history || [];
  const t = data?.totals || {};

  return (
    <div data-testid="stock-variance-report">
      <div className="flex items-center gap-2 flex-wrap mb-4">
        <input type="date" value={start} max={end} onChange={(e) => setStart(e.target.value)} className="iu-input !h-8 !w-auto text-xs" data-testid="variance-start" title="Report start date" />
        <span className="text-xs text-slate-400">to</span>
        <input type="date" value={end} min={start} max={todayISO()} onChange={(e) => setEnd(e.target.value)} className="iu-input !h-8 !w-auto text-xs" data-testid="variance-end" title="Report end date" />
        {[["30d", 29], ["90d", 89], ["1y", 364]].map(([lbl, days]) => (
          <button key={lbl} onClick={() => { setStart(isoDaysAgo(days)); setEnd(todayISO()); }}
                  title={`Show the last ${lbl.replace("d", " days").replace("1y", "year")}`}
                  className="text-[11px] font-bold text-slate-500 hover:text-emerald-700 bg-slate-100 hover:bg-emerald-50 rounded-full px-2.5 py-1">{lbl}</button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-12"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-5" data-testid="variance-stats">
            <Stat label="Loss value" value={rupee(t.loss_value)} tone="rose" />
            <Stat label="Extra value" value={rupee(t.extra_value)} tone="emerald" />
            <Stat label="Net" value={`${(t.net_value || 0) >= 0 ? "+" : "−"}${rupee(Math.abs(t.net_value || 0))}`} tone={(t.net_value || 0) >= 0 ? "emerald" : "rose"} />
            <Stat label="Counts" value={t.count || 0} tone="slate" />
            <Stat label="Items" value={t.items || 0} tone="slate" />
          </div>

          <h3 className="text-xs font-black uppercase tracking-wider text-slate-500 mb-2 flex items-center gap-1.5">
            <AlertTriangle size={13} className="text-amber-500" /> Biggest variances
          </h3>
          {rows.length === 0 ? (
            <div className="iu-card p-8 text-center text-slate-500 mb-6" data-testid="variance-empty">No stock-take adjustments in this range.</div>
          ) : (
            <div className="iu-card overflow-x-auto mb-6">
              <table className="w-full text-sm" data-testid="variance-table">
                <thead className="text-[11px] uppercase text-slate-500 bg-slate-50">
                  <tr>
                    <th className="text-left p-2.5">Item</th>
                    <th className="text-left p-2.5">Category</th>
                    <th className="text-right p-2.5">Loss</th>
                    <th className="text-right p-2.5">Extra</th>
                    <th className="text-right p-2.5">Net</th>
                    <th className="text-right p-2.5 bg-slate-100">Value impact</th>
                    <th className="text-right p-2.5">Counts</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.item_id} className="border-t border-slate-100 hover:bg-slate-50/60" data-testid={`variance-row-${r.item_id}`}>
                      <td className="p-2.5 font-semibold text-slate-900">{r.name} <span className="text-[10px] text-slate-400 uppercase">{r.unit}</span></td>
                      <td className="p-2.5 text-slate-500 text-xs">{r.category_label}</td>
                      <td className="p-2.5 text-right tabular-nums text-rose-700 font-semibold">{r.loss_qty ? `−${fmtQty(r.loss_qty, r.unit)}` : "—"}</td>
                      <td className="p-2.5 text-right tabular-nums text-emerald-700 font-semibold">{r.extra_qty ? `+${fmtQty(r.extra_qty, r.unit)}` : "—"}</td>
                      <td className={`p-2.5 text-right tabular-nums font-bold ${r.net_qty < 0 ? "text-rose-700" : r.net_qty > 0 ? "text-emerald-700" : "text-slate-400"}`}>
                        {r.net_qty ? `${r.net_qty > 0 ? "+" : "−"}${fmtQty(Math.abs(r.net_qty), r.unit)}` : "0"}
                      </td>
                      <td className="p-2.5 text-right tabular-nums font-bold bg-slate-50/70 text-slate-900">{rupee(r.loss_value + r.extra_value)}</td>
                      <td className="p-2.5 text-right tabular-nums text-slate-500">{r.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3 className="text-xs font-black uppercase tracking-wider text-slate-500 mb-2 flex items-center gap-1.5">
            <History size={13} className="text-indigo-500" /> Audit trail
          </h3>
          {history.length === 0 ? (
            <div className="iu-card p-6 text-center text-slate-400 text-sm italic" data-testid="audit-empty">No stock-take activity yet.</div>
          ) : (
            <div className="iu-card divide-y divide-slate-100" data-testid="audit-list">
              {history.map((h, i) => {
                const loss = h.qty < 0;
                return (
                  <div key={i} className="flex items-center gap-3 px-4 py-2.5 text-sm" data-testid={`audit-row-${i}`}>
                    <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full shrink-0 ${loss ? "bg-rose-100 text-rose-600" : "bg-emerald-100 text-emerald-600"}`}>
                      {loss ? <TrendingDown size={14} /> : <TrendingUp size={14} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-slate-900 truncate">{h.name}
                        <span className={`ml-2 tabular-nums font-bold ${loss ? "text-rose-700" : "text-emerald-700"}`}>
                          {h.qty > 0 ? "+" : "−"}{fmtQty(Math.abs(h.qty), h.unit)} {h.unit}
                        </span>
                      </div>
                      <div className="text-xs text-slate-500">
                        Counted <b>{fmtQty(h.physical, h.unit)}</b> vs system <b>{fmtQty(h.system, h.unit)}</b>
                        {h.notes ? ` · ${h.notes}` : ""}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs font-semibold text-slate-700">{formatDate(h.date)}</div>
                      <div className="text-[11px] text-slate-400">{h.by_name || "—"}{h.at ? ` · ${stamp(h.at)}` : ""}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
