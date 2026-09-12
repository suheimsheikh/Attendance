/**
 * ItemLedgerDrawer — passbook-style stock ledger for a single item.
 * Opened by double-clicking a row on the Daily Entry grid. Shows
 * Purchases / Issues / Wastage in their own columns per date, with a
 * running stock-in-hand balance carried forward, column totals and the
 * final on-hand at the bottom.
 */
import React, { useEffect, useState } from "react";
import { Loader2, X, BookOpen, AlertTriangle } from "lucide-react";
import { api, showApiError } from "../../api";
import { formatDate, fmtQty as uQty } from "../../utils";
import { useEscape } from "../../hooks/useEscape";

const fmt = (n, unit) => (n == null ? "—" : uQty(n, unit));
const rupee = (n) => (!n ? "—" : `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const isoDaysAgo = (days) => { const d = new Date(); d.setDate(d.getDate() - days); return d.toLocaleDateString("sv-SE"); };
const todayISO = () => new Date().toLocaleDateString("sv-SE");

export default function ItemLedgerDrawer({ itemId, itemName, unit, onClose }) {
  const [start, setStart] = useState(isoDaysAgo(89));
  const [end, setEnd] = useState(todayISO());
  const [gran, setGran] = useState("week");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEscape(onClose);

  useEffect(() => {
    let ignore = false;
    setLoading(true);
    api.get(`/meals/items/${itemId}/ledger?start=${start}&end=${end}&granularity=${gran}`)
      .then((d) => { if (!ignore) setData(d); })
      .catch((err) => { if (!ignore) showApiError(err, "Couldn't load ledger"); })
      .finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [itemId, start, end, gran]);

  const item = data?.item;
  const u = item?.unit || unit;
  const tot = data?.totals || {};
  const rows = data?.rows || [];
  const low = data && item && data.on_hand <= ((item.min_stock || 0) > 0 ? item.min_stock : 0.001);

  const dmy = (iso) => { if (!iso) return ""; const [y, m, d] = iso.split("-"); return `${d}/${m}/${y.slice(2)}`; };
  const periodLabel = (r) => {
    if (gran === "day" || !r.period_start) return formatDate(r.date);
    if (gran === "month") return new Date(r.period_start + "T00:00:00").toLocaleDateString("en-GB", { month: "short", year: "numeric" });
    return `${dmy(r.period_start)} – ${dmy(r.period_end)}`;
  };
  const adjTitle = (r) => {
    if (!r.adj_qty) return "";
    if (r.adj_count > 1) return `${r.adj_count} stock-take adjustments this ${gran}`;
    const bits = [];
    if (r.adj_physical != null && r.adj_system != null) bits.push(`Counted ${fmt(r.adj_physical, u)} vs system ${fmt(r.adj_system, u)}`);
    if (r.adj_by) bits.push(`by ${r.adj_by}`);
    if (r.adj_at) bits.push(`on ${formatDate(r.adj_at)}`);
    return bits.join(" · ") || "Stock-take adjustment";
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={onClose} data-testid="item-ledger-backdrop">
      <div
        className="bg-white w-full max-w-3xl h-full shadow-2xl flex flex-col animate-in slide-in-from-right duration-200"
        onClick={(e) => e.stopPropagation()}
        data-testid="item-ledger-drawer"
      >
        <header className="px-5 py-4 border-b border-slate-200 flex items-center justify-between shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg font-extrabold text-slate-900 flex items-center gap-2 truncate">
              <BookOpen size={18} className="text-emerald-600 shrink-0" /> {itemName || item?.name} <span className="text-slate-400 text-sm font-semibold uppercase">{u}</span>
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">Stock ledger — purchases, issues &amp; wastage with running balance</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-100 text-slate-500" data-testid="item-ledger-close"><X size={18} /></button>
        </header>

        <div className="flex-1 overflow-auto p-5">
          <div className="flex items-center gap-2 flex-wrap mb-4">
            <div className="flex rounded-lg overflow-hidden ring-1 ring-slate-200" data-testid="ledger-granularity">
              {[["week", "Weekly"], ["month", "Monthly"], ["day", "Daily"]].map(([v, l]) => (
                <button key={v} onClick={() => setGran(v)} data-testid={`ledger-gran-${v}`}
                        className={`px-3 h-8 text-xs font-bold ${gran === v ? "bg-emerald-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>{l}</button>
              ))}
            </div>
            <span className="w-px h-6 bg-slate-200 mx-1" />
            <input type="date" value={start} max={end} onChange={(e) => setStart(e.target.value)} className="iu-input !h-8 !w-auto text-xs" data-testid="ledger-range-start" />
            <span className="text-xs text-slate-400">to</span>
            <input type="date" value={end} min={start} max={todayISO()} onChange={(e) => setEnd(e.target.value)} className="iu-input !h-8 !w-auto text-xs" data-testid="ledger-range-end" />
            {[["30d", 29], ["90d", 89], ["1y", 364]].map(([lbl, days]) => (
              <button key={lbl} onClick={() => { setStart(isoDaysAgo(days)); setEnd(todayISO()); }}
                      className="text-[11px] font-bold text-slate-500 hover:text-emerald-700 bg-slate-100 hover:bg-emerald-50 rounded-full px-2.5 py-1">
                {lbl}
              </button>
            ))}
            {data && (
              <span className={`ml-auto inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-extrabold tabular-nums ${low ? "bg-rose-50 text-rose-700 ring-1 ring-rose-200" : "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200"}`} data-testid="ledger-onhand-now">
                {low && <AlertTriangle size={13} />} On hand now: {fmt(data.on_hand, u)} {u}
              </span>
            )}
          </div>

          {loading ? (
            <div className="text-center py-12"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
          ) : !data ? null : (
            <div className="overflow-x-auto rounded-xl ring-1 ring-slate-200">
              <table className="w-full text-sm" data-testid="item-ledger-table">
                <thead className="text-[11px] uppercase text-slate-500 bg-slate-50">
                  <tr>
                    <th className="text-left p-2.5">{gran === "day" ? "Date" : "Period"}</th>
                    <th className="text-right p-2.5 border-l border-emerald-100">Purchased</th>
                    <th className="text-right p-2.5">Amount</th>
                    <th className="text-right p-2.5 border-l border-sky-100">Issued</th>
                    <th className="text-right p-2.5 border-l border-amber-100">Wasted</th>
                    <th className="text-right p-2.5 border-l border-violet-100">Stock-take</th>
                    <th className="text-right p-2.5 border-l border-slate-200 bg-slate-100">Stock on hand</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t border-slate-100 bg-slate-50/60" data-testid="ledger-opening-row">
                    <td className="p-2.5 font-semibold text-slate-500 italic">Opening balance</td>
                    <td className="p-2.5" colSpan={5} />
                    <td className="p-2.5 text-right tabular-nums font-bold bg-slate-50 text-slate-700" data-testid="ledger-opening-balance">
                      {fmt(data.opening_balance, u)} {u}
                    </td>
                  </tr>
                  {rows.length === 0 ? (
                    <tr><td colSpan={7} className="p-8 text-center text-sm text-slate-400 italic" data-testid="item-ledger-empty">No purchases, issues or wastage in this range.</td></tr>
                  ) : rows.map((r) => (
                    <tr key={r.date} className="border-t border-slate-100 hover:bg-slate-50/70" data-testid={`ledger-row-${r.date}`}>
                      <td className="p-2.5 whitespace-nowrap text-slate-700">{periodLabel(r)}</td>
                      <td className="p-2.5 text-right tabular-nums font-semibold text-emerald-700">{r.purch_qty ? `+${fmt(r.purch_qty, u)}` : ""}</td>
                      <td className="p-2.5 text-right tabular-nums text-slate-600">{r.purch_amt ? rupee(r.purch_amt) : ""}</td>
                      <td className="p-2.5 text-right tabular-nums font-semibold text-sky-700 border-l border-slate-50">{r.issue_qty ? `−${fmt(r.issue_qty, u)}` : ""}</td>
                      <td className="p-2.5 text-right tabular-nums font-semibold text-amber-700 border-l border-slate-50">{r.waste_qty ? `−${fmt(r.waste_qty, u)}` : ""}</td>
                      <td className={`p-2.5 text-right tabular-nums font-semibold border-l border-slate-50 ${r.adj_qty > 0 ? "text-emerald-700" : r.adj_qty < 0 ? "text-rose-700" : "text-slate-400"}`} title={adjTitle(r)}>
                        {r.adj_qty ? `${r.adj_qty > 0 ? "+" : "−"}${fmt(Math.abs(r.adj_qty), u)}` : ""}
                      </td>
                      <td className="p-2.5 text-right tabular-nums font-bold bg-slate-50/70 text-slate-900" title={r.pre_opening ? "Before the opening-stock baseline — not counted in on-hand" : ""}>{r.pre_opening ? <span className="text-slate-300 font-normal">—</span> : fmt(r.balance, u)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-slate-300 bg-slate-100 font-bold text-slate-900" data-testid="item-ledger-totals">
                    <td className="p-2.5 uppercase text-[11px] tracking-wider text-slate-600">Totals</td>
                    <td className="p-2.5 text-right tabular-nums text-emerald-800" data-testid="ledger-total-purchased">{fmt(tot.purchased_qty, u)}</td>
                    <td className="p-2.5 text-right tabular-nums text-slate-700" data-testid="ledger-total-amount">{rupee(tot.purchased_amount)}</td>
                    <td className="p-2.5 text-right tabular-nums text-sky-800" data-testid="ledger-total-issued">{fmt(tot.issued_qty, u)}</td>
                    <td className="p-2.5 text-right tabular-nums text-amber-800" data-testid="ledger-total-wasted">{fmt(tot.wasted_qty, u)}</td>
                    <td className={`p-2.5 text-right tabular-nums ${(tot.adjusted_qty || 0) > 0 ? "text-emerald-800" : (tot.adjusted_qty || 0) < 0 ? "text-rose-700" : "text-slate-500"}`} data-testid="ledger-total-adjusted">
                      {tot.adjusted_qty ? `${tot.adjusted_qty > 0 ? "+" : "−"}${fmt(Math.abs(tot.adjusted_qty), u)}` : "0"}
                    </td>
                    <td className="p-2.5 text-right tabular-nums text-slate-900 bg-slate-200" data-testid="ledger-final-onhand">{fmt(data.on_hand, u)} {u}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
