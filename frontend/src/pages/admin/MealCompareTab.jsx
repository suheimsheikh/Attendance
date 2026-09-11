import React, { useEffect, useMemo, useState } from "react";
import { Loader2, LineChart as LineIcon, Search, X, ShoppingCart, Utensils } from "lucide-react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";
import { api, showApiError } from "../../api";
import { fmtQty } from "../../utils";

const todayIso = () => new Date().toLocaleDateString("en-CA");
const isoDaysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - (n - 1)); return d.toLocaleDateString("en-CA"); };
const inr = (n) => Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortDate = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short" });

function eachDay(start, end) {
  const out = []; const d = new Date(start + "T00:00:00"); const e = new Date(end + "T00:00:00");
  while (d <= e) { out.push(d.toLocaleDateString("en-CA")); d.setDate(d.getDate() + 1); }
  return out;
}

export default function MealCompareTab() {
  const [items, setItems] = useState([]);
  const [cats, setCats] = useState([]);
  const [picked, setPicked] = useState(() => new Set());
  const [q, setQ] = useState("");
  const [preset, setPreset] = useState("90");
  const [from, setFrom] = useState(isoDaysAgo(90));
  const [to, setTo] = useState(todayIso());
  const [metric, setMetric] = useState("qty");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    Promise.all([api.get("/meals/items"), api.get("/meals/purchase-categories").catch(() => ({ categories: [] }))])
      .then(([it, c]) => { setItems(it.items || []); setCats(c.categories || []); })
      .catch((e) => showApiError(e, "Couldn't load items"));
  }, []);

  useEffect(() => {
    if (preset === "custom") return;
    setFrom(isoDaysAgo(parseInt(preset, 10))); setTo(todayIso());
  }, [preset]);

  useEffect(() => {
    if (picked.size === 0 || !from || !to || from > to) { setData(null); return; }
    let ignore = false; setLoading(true);
    const ids = [...picked].join(",");
    api.get(`/meals/kitchen-analytics/item-compare?start=${from}&end=${to}&item_ids=${ids}`)
      .then((r) => { if (!ignore) setData(r); })
      .catch((e) => { if (!ignore) { showApiError(e, "Couldn't load comparison"); setData(null); } })
      .finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [picked, from, to]);

  const catLabel = useMemo(() => Object.fromEntries((cats || []).map((c) => [c.key, c.label])), [cats]);
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle ? items.filter((i) => i.name.toLowerCase().includes(needle)) : items;
    const groups = new Map();
    list.forEach((i) => { const k = i.category_key || "other"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
    return [...groups.entries()];
  }, [items, q]);

  const chartRows = useMemo(() => {
    if (!data) return [];
    const map = Object.fromEntries((data.days || []).map((d) => [d.date, d]));
    return eachDay(from, to).map((dd) => {
      const r = map[dd] || {};
      return { date: shortDate(dd),
        Purchases: metric === "qty" ? (r.purch_qty || 0) : (r.purch_amt || 0),
        Issues: metric === "qty" ? (r.issue_qty || 0) : (r.issue_amt || 0) };
    });
  }, [data, from, to, metric]);

  const toggle = (id) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const totals = data?.totals;
  const fmtVal = (v) => metric === "qty" ? fmtQty(v) : `₹${inr(v)}`;

  return (
    <div data-testid="meal-compare-tab" className="grid lg:grid-cols-[280px_1fr] gap-4">
      {/* Item picker */}
      <div className="iu-card p-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-xs font-black uppercase tracking-wider text-slate-500">Pick items ({picked.size})</h3>
          {picked.size > 0 && <button onClick={() => setPicked(new Set())} className="text-[11px] text-rose-600 font-semibold hover:underline" data-testid="compare-clear">Clear</button>}
        </div>
        <div className="relative mb-2">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search items…" className="iu-input !h-8 text-sm !pl-7" data-testid="compare-search" />
        </div>
        <div className="max-h-[420px] overflow-y-auto pr-1 space-y-2">
          {filtered.length === 0 ? <p className="text-xs text-slate-400 italic">No items.</p>
            : filtered.map(([ck, list]) => (
              <div key={ck}>
                <div className="text-[10px] font-bold uppercase text-indigo-600 mb-0.5">{catLabel[ck] || ck}</div>
                {list.map((i) => (
                  <label key={i.id} className="flex items-center gap-2 py-0.5 text-sm cursor-pointer hover:bg-slate-50 rounded px-1" data-testid={`compare-item-${i.id}`}>
                    <input type="checkbox" checked={picked.has(i.id)} onChange={() => toggle(i.id)} className="accent-indigo-600" />
                    <span className="flex-1 min-w-0 truncate text-slate-700">{i.name}</span>
                    <span className="text-[10px] text-slate-400">{i.unit}</span>
                  </label>
                ))}
              </div>
            ))}
        </div>
      </div>

      {/* Chart + controls */}
      <div className="iu-card p-3 md:p-4">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <h2 className="text-lg font-extrabold flex items-center gap-2 mr-auto"><LineIcon size={18} className="text-indigo-600" /> Purchases vs Issues</h2>
          <div className="flex rounded-lg overflow-hidden ring-1 ring-slate-200">
            {[["qty", "Quantity"], ["amount", "Amount ₹"]].map(([v, l]) => (
              <button key={v} onClick={() => setMetric(v)} data-testid={`compare-metric-${v}`} className={`px-3 h-9 text-xs font-bold ${metric === v ? "bg-slate-800 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>{l}</button>
            ))}
          </div>
          <div className="flex rounded-lg overflow-hidden ring-1 ring-slate-200">
            {[["30", "30d"], ["90", "90d"], ["365", "1yr"], ["custom", "Custom"]].map(([v, l]) => (
              <button key={v} onClick={() => setPreset(v)} data-testid={`compare-preset-${v}`} className={`px-3 h-9 text-xs font-bold ${preset === v ? "bg-indigo-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>{l}</button>
            ))}
          </div>
          {preset === "custom" && (
            <div className="flex items-center gap-1">
              <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="iu-input !h-9 !w-auto text-xs" data-testid="compare-from" />
              <span className="text-slate-400">→</span>
              <input type="date" value={to} min={from} max={todayIso()} onChange={(e) => setTo(e.target.value)} className="iu-input !h-9 !w-auto text-xs" data-testid="compare-to" />
            </div>
          )}
        </div>

        {totals && (
          <div className="grid grid-cols-2 gap-2 mb-3">
            <div className="rounded-xl bg-blue-50 ring-1 ring-blue-100 px-3 py-2" data-testid="compare-total-purchases">
              <p className="text-[10px] uppercase font-bold text-blue-700 flex items-center gap-1"><ShoppingCart size={11} /> Purchased</p>
              <p className="text-sm font-extrabold text-blue-900 tabular-nums">{metric === "qty" ? `${fmtQty(totals.purch_qty)} units` : `₹${inr(totals.purch_amt)}`}</p>
            </div>
            <div className="rounded-xl bg-orange-50 ring-1 ring-orange-100 px-3 py-2" data-testid="compare-total-consumption">
              <p className="text-[10px] uppercase font-bold text-orange-700 flex items-center gap-1"><Utensils size={11} /> Issued</p>
              <p className="text-sm font-extrabold text-orange-900 tabular-nums">{metric === "qty" ? `${fmtQty(totals.issue_qty)} units` : `₹${inr(totals.issue_amt)}`}</p>
            </div>
          </div>
        )}

        {picked.size === 0 ? (
          <div className="h-[320px] grid place-items-center text-sm text-slate-400 italic" data-testid="compare-empty">Pick one or more items to compare their purchases and issues over time.</div>
        ) : loading ? (
          <div className="h-[320px] grid place-items-center"><Loader2 className="animate-spin text-slate-400" /></div>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={chartRows} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={24} />
              <YAxis tick={{ fontSize: 10 }} width={48} />
              <Tooltip formatter={(v, n) => [fmtVal(v), n]} />
              <Legend />
              <Line type="monotone" dataKey="Purchases" stroke="#2563EB" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="Issues" stroke="#F97316" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
