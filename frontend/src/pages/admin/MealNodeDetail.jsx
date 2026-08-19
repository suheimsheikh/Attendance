/**
 * MealNodeDetail — slide-over panels for the Masters tree.
 * ItemDetailPanel: merged purchase/issue/wastage ledger for one item.
 * CategoryDetailPanel: per-item totals + spend for one category.
 */
import React, { useEffect, useState } from "react";
import { Loader2, X, ShoppingCart, ClipboardList, Flame, AlertTriangle } from "lucide-react";
import { api, showApiError } from "../../api";
import { formatDate } from "../../utils";
import { useEscape } from "../../hooks/useEscape";

const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 3 }));
const rupee = (n) => (n == null ? "—" : `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toLocaleDateString("sv-SE");
}
const todayISO = () => new Date().toLocaleDateString("sv-SE");

const TYPE_META = {
  purchase: { label: "Purchase", cls: "bg-emerald-100 text-emerald-700", Icon: ShoppingCart, sign: "+" },
  issue:    { label: "Issued",   cls: "bg-sky-100 text-sky-700",         Icon: ClipboardList, sign: "−" },
  wastage:  { label: "Wastage",  cls: "bg-amber-100 text-amber-700",     Icon: Flame, sign: "−" },
};

function Sheet({ title, subtitle, onClose, children, testid }) {
  useEscape(onClose);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={onClose} data-testid={`${testid}-backdrop`}>
      <div
        className="bg-white w-full max-w-2xl h-full shadow-2xl flex flex-col animate-in slide-in-from-right duration-200"
        onClick={(e) => e.stopPropagation()}
        data-testid={testid}
      >
        <header className="px-5 py-4 border-b border-slate-200 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-lg font-extrabold text-slate-900">{title}</h2>
            {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-100 text-slate-500" data-testid={`${testid}-close`}><X size={18}/></button>
        </header>
        <div className="flex-1 overflow-auto p-5">{children}</div>
      </div>
    </div>
  );
}

function RangePicker({ start, end, setStart, setEnd }) {
  return (
    <div className="flex items-center gap-2 flex-wrap mb-4">
      <input type="date" value={start} max={end} onChange={(e) => setStart(e.target.value)} className="iu-input !h-8 !w-auto text-xs" data-testid="detail-range-start"/>
      <span className="text-xs text-slate-400">to</span>
      <input type="date" value={end} min={start} max={todayISO()} onChange={(e) => setEnd(e.target.value)} className="iu-input !h-8 !w-auto text-xs" data-testid="detail-range-end"/>
      {[["30d", 29], ["90d", 89], ["1y", 364]].map(([lbl, days]) => (
        <button key={lbl} onClick={() => { setStart(isoDaysAgo(days)); setEnd(todayISO()); }}
                className="text-[11px] font-bold text-slate-500 hover:text-emerald-700 bg-slate-100 hover:bg-emerald-50 rounded-full px-2.5 py-1">
          {lbl}
        </button>
      ))}
    </div>
  );
}

function Chip({ label, value }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-3 py-2">
      <p className="text-[10px] uppercase font-bold text-slate-500">{label}</p>
      <p className="text-sm font-extrabold text-slate-900 tabular-nums">{value}</p>
    </div>
  );
}

export function ItemDetailPanel({ itemId, onClose }) {
  const [start, setStart] = useState(isoDaysAgo(29));
  const [end, setEnd] = useState(todayISO());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.get(`/meals/items/${itemId}/ledger?start=${start}&end=${end}`)
      .then(setData)
      .catch((err) => showApiError(err, "Couldn't load item history"))
      .finally(() => setLoading(false));
  }, [itemId, start, end]);

  const item = data?.item;
  const tot = data?.totals || {};
  const low = data && item && data.on_hand <= ((item.min_stock || 0) > 0 ? item.min_stock : 0.001);
  return (
    <Sheet
      title={item ? item.name : "Item"}
      subtitle={item ? `${item.unit} · opening ${fmt(item.opening_stock)} as of ${formatDate(item.opening_stock_as_of)}${item.min_stock > 0 ? ` · min level ${fmt(item.min_stock)} ${item.unit}` : ""}` : ""}
      onClose={onClose}
      testid="item-detail-panel"
    >
      <RangePicker start={start} end={end} setStart={setStart} setEnd={setEnd}/>
      {loading ? (
        <div className="text-center py-10"><Loader2 className="animate-spin mx-auto text-slate-400"/></div>
      ) : !data ? null : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-5">
            <div className={`rounded-xl border px-3 py-2 ${low ? "border-rose-300 bg-rose-50" : "border-emerald-200 bg-emerald-50/60"}`}>
              <p className="text-[10px] uppercase font-bold text-slate-500 flex items-center gap-1">
                On hand now {low && <AlertTriangle size={11} className="text-rose-500"/>}
              </p>
              <p className={`text-sm font-extrabold tabular-nums ${low ? "text-rose-700" : "text-slate-900"}`} data-testid="item-detail-onhand">
                {fmt(data.on_hand)} {item.unit}
              </p>
            </div>
            <Chip label="Purchased" value={`${fmt(tot.purchased_qty)} ${item.unit}`}/>
            <Chip label="Spend" value={rupee(tot.purchased_amount)}/>
            <Chip label="Issued" value={`${fmt(tot.issued_qty)} ${item.unit}`}/>
            <Chip label="Wasted" value={`${fmt(tot.wasted_qty)} ${item.unit}`}/>
          </div>

          {data.events.length === 0 ? (
            <p className="text-sm text-slate-400 italic text-center py-8" data-testid="item-detail-empty">
              No purchases, issues or wastage in this range.
            </p>
          ) : (
            <table className="w-full text-sm" data-testid="item-detail-ledger">
              <thead className="text-[11px] uppercase text-slate-500 bg-slate-50">
                <tr>
                  <th className="text-left p-2">Date</th>
                  <th className="text-left p-2">Type</th>
                  <th className="text-right p-2">Qty</th>
                  <th className="text-right p-2">Rate / Amount</th>
                  <th className="text-left p-2">Reason / By</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((ev, i) => {
                  const m = TYPE_META[ev.type];
                  return (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="p-2 whitespace-nowrap text-slate-700">{formatDate(ev.date)}</td>
                      <td className="p-2">
                        <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${m.cls}`}>
                          <m.Icon size={10}/> {m.label}
                        </span>
                      </td>
                      <td className={`p-2 text-right tabular-nums font-semibold ${ev.type === "purchase" ? "text-emerald-700" : ev.type === "issue" ? "text-sky-700" : "text-amber-700"}`}>
                        {m.sign}{fmt(ev.qty)} {item.unit}
                      </td>
                      <td className="p-2 text-right tabular-nums text-slate-600">
                        {ev.type === "purchase" ? `${rupee(ev.rate)} → ${rupee(ev.amount)}` : "—"}
                      </td>
                      <td className="p-2 text-xs text-slate-500">
                        {ev.reason ? <span className="font-semibold text-amber-700">{ev.reason}</span> : null}
                        {ev.notes ? <span> · {ev.notes}</span> : null}
                        {!ev.reason && !ev.notes ? (ev.by || "—") : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </Sheet>
  );
}

export function CategoryDetailPanel({ categoryKey, stockMap, onClose }) {
  const [start, setStart] = useState(isoDaysAgo(29));
  const [end, setEnd] = useState(todayISO());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.get(`/meals/categories/${categoryKey}/summary?start=${start}&end=${end}`)
      .then(setData)
      .catch((err) => showApiError(err, "Couldn't load category summary"))
      .finally(() => setLoading(false));
  }, [categoryKey, start, end]);

  const rows = (data?.items || []).filter((i) => i.active !== false);
  return (
    <Sheet
      title={data?.category?.label || "Category"}
      subtitle="Per-item totals for the selected range"
      onClose={onClose}
      testid="cat-detail-panel"
    >
      <RangePicker start={start} end={end} setStart={setStart} setEnd={setEnd}/>
      {loading ? (
        <div className="text-center py-10"><Loader2 className="animate-spin mx-auto text-slate-400"/></div>
      ) : !data ? null : (
        <>
          <div className="grid grid-cols-2 gap-2 mb-5 max-w-xs">
            <Chip label="Spend in range" value={rupee(data.spend)}/>
            <Chip label="Items" value={rows.length}/>
          </div>
          {rows.length === 0 ? (
            <p className="text-sm text-slate-400 italic text-center py-8">No active items in this category.</p>
          ) : (
            <table className="w-full text-sm" data-testid="cat-detail-table">
              <thead className="text-[11px] uppercase text-slate-500 bg-slate-50">
                <tr>
                  <th className="text-left p-2">Item</th>
                  <th className="text-right p-2">Purchased</th>
                  <th className="text-right p-2">Amount</th>
                  <th className="text-right p-2">Issued</th>
                  <th className="text-right p-2">Wasted</th>
                  <th className="text-right p-2 bg-slate-100">On hand</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const st = stockMap?.[r.item_id];
                  return (
                    <tr key={r.item_id} className="border-t border-slate-100">
                      <td className="p-2 font-semibold text-slate-900">{r.name} <span className="text-[10px] text-slate-400 uppercase">{r.unit}</span></td>
                      <td className="p-2 text-right tabular-nums text-emerald-700">{r.purchased_qty ? `+${fmt(r.purchased_qty)}` : "0"}</td>
                      <td className="p-2 text-right tabular-nums text-slate-600">{r.purchased_amount ? rupee(r.purchased_amount) : "—"}</td>
                      <td className="p-2 text-right tabular-nums text-sky-700">{r.issued_qty ? `−${fmt(r.issued_qty)}` : "0"}</td>
                      <td className="p-2 text-right tabular-nums text-amber-700">{r.wasted_qty ? `−${fmt(r.wasted_qty)}` : "0"}</td>
                      <td className={`p-2 text-right tabular-nums font-bold bg-slate-50/70 ${st?.low ? "text-rose-700" : "text-slate-900"}`}>
                        {st ? fmt(st.on_hand) : "—"}
                        {st?.low && <AlertTriangle size={11} className="inline ml-1 text-rose-500 -mt-0.5"/>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </Sheet>
  );
}
