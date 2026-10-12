import { useEffect, useState } from "react";
import { useEscape } from "../../../hooks/useEscape";
import { BarChart3, Beef, Boxes, X as CloseIcon, Droplet, Flame, ListOrdered, Loader2, PieChart as PieIcon, TrendingUp, Wheat } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, showApiError } from "../../../api";
import { formatDate } from "../../../utils";
import { CHART_COLORS, StatPill, fmtQty, inr, inr2 } from "./helpers";

const MACRO_COLORS = {
  protein: "#DC2626",
  carbs:   "#F59E0B",
  fat:     "#8B5CF6",
  fibre:   "#10B981",
};
const KG_G = (g) => (g == null ? "—" : g >= 1000 ? `${(g / 1000).toFixed(1)} kg` : `${Math.round(g)} g`);

// Small muted caption shown under a chart title to explain what the
// graph depicts and what data it is based on.
export function Caption({ children }) {
  return <p className="text-[11px] leading-snug text-slate-500 mb-2">{children}</p>;
}

export function NutritionBlock({ nutrition, testKind, accent }) {
  const cov = nutrition.coverage || {};
  const macros = nutrition.macro_grams || [];
  const kcalPie = nutrition.kcal_pie || [];
  const dailyKcal = (nutrition.daily_kcal || []).map((d) => ({
    ...d,
    label: formatDate(d.date),
  }));
  const kcalColor = accent === "purchases" ? "#DC2626" : "#EA580C";
  const missing = cov.qty_pct != null ? Math.max(0, 100 - cov.qty_pct) : 0;
  return (
    <div className="mt-5" data-testid={`kitchen-${testKind}-nutrition`}>
      <div className="flex items-center gap-2 mb-1">
        <Flame size={16} className="text-rose-600" />
        <div className="font-extrabold text-sm">Nutrition of food consumed</div>
        {missing > 0 && (
          <span
            className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200"
            title={`${cov.items_covered} of ${cov.items_total} items have nutrition data. Items with no data — or sold by count with no gram weight set — are left out of every chart below.`}
            data-testid={`kitchen-${testKind}-nutrition-coverage`}
          >
            {missing.toFixed(0)}% of qty has no nutrition data — charts based on {cov.qty_pct}%
          </span>
        )}
      </div>
      <Caption>
        Based on what was <b>issued to the kitchen</b> (consumed) in this window — <b>not</b> ₹ spend.
        Each item&apos;s quantity is converted to grams and multiplied by its per-100g nutrition
        (an item-level override if set, otherwise a built-in reference table of common pantry items).
        Approximate — good for portion planning, not medical advice.
      </Caption>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3">
        <StatPill icon={Flame}   label="Total kcal"  value={inr(nutrition.kcal_total || 0)} tint="bg-rose-50" hint="Total calories in all food consumed in this window, from issued quantities × per-100g nutrition data." />
        <StatPill icon={Beef}    label="Protein"     value={KG_G(nutrition.totals?.protein_g)} tint="bg-red-50" hint="Total protein consumed in this window." />
        <StatPill icon={Wheat}   label="Carbs"       value={KG_G(nutrition.totals?.carbs_g)} tint="bg-amber-50" hint="Total carbohydrates consumed in this window." />
        <StatPill icon={Droplet} label="Fat"         value={KG_G(nutrition.totals?.fat_g)} tint="bg-violet-50" hint="Total fat consumed in this window." />
        <StatPill icon={Boxes}   label="Fibre"       value={KG_G(nutrition.totals?.fibre_g)} tint="bg-emerald-50" hint="Total dietary fibre consumed in this window." />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">
        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1"><TrendingUp size={14} className="text-slate-500" /><div className="font-bold text-sm">Daily calories</div></div>
          <Caption>Total calories of the food consumed each day across the window.</Caption>
          {(dailyKcal.length === 0)
            ? <div className="text-center text-slate-400 text-sm py-8">No data</div>
            : (
              <div style={{ width: "100%", height: 220 }} data-testid={`kitchen-${testKind}-nutrition-daily`}>
                <ResponsiveContainer>
                  <LineChart data={dailyKcal} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={20} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v)} />
                    <Tooltip formatter={(v) => `${inr(v)} kcal`} contentStyle={{ fontSize: 12 }} />
                    <Line type="monotone" dataKey="kcal" name="kcal" stroke={kcalColor} strokeWidth={2} dot={{ r: 2 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
        </div>
        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1"><PieIcon size={14} className="text-slate-500" /><div className="font-bold text-sm">Macros (grams)</div></div>
          <Caption>Total weight of protein, carbs, fat &amp; fibre consumed in the window.</Caption>
          {(macros.every((m) => (m.grams || 0) === 0))
            ? <div className="text-center text-slate-400 text-sm py-8">No data</div>
            : (
              <div style={{ width: "100%", height: 220 }} data-testid={`kitchen-${testKind}-nutrition-macros`}>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={macros} dataKey="grams" nameKey="label" outerRadius={80} innerRadius={40}
                         label={(e) => (e.pct >= 6 ? `${e.pct}%` : "")} labelLine={false}>
                      {macros.map((m) => <Cell key={m.key} fill={MACRO_COLORS[m.key]} />)}
                    </Pie>
                    <Tooltip formatter={(v, n) => [KG_G(v), n]} contentStyle={{ fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
        </div>
        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1"><PieIcon size={14} className="text-slate-500" /><div className="font-bold text-sm">Calorie source</div><span className="text-[10px] text-slate-400">(kcal from macro)</span></div>
          <Caption>Where the calories come from — protein &amp; carbs 4, fat 9, fibre 2 kcal per gram.</Caption>
          {(kcalPie.every((m) => (m.kcal || 0) === 0))
            ? <div className="text-center text-slate-400 text-sm py-8">No data</div>
            : (
              <div style={{ width: "100%", height: 220 }} data-testid={`kitchen-${testKind}-nutrition-kcalpie`}>
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={kcalPie} dataKey="kcal" nameKey="label" outerRadius={80} innerRadius={40}
                         label={(e) => (e.pct >= 6 ? `${e.pct}%` : "")} labelLine={false}>
                      {kcalPie.map((m) => <Cell key={m.key} fill={MACRO_COLORS[m.key]} />)}
                    </Pie>
                    <Tooltip formatter={(v, n) => [`${inr(v)} kcal`, n]} contentStyle={{ fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
        </div>
        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1"><BarChart3 size={14} className="text-slate-500" /><div className="font-bold text-sm">Top items by calories</div></div>
          <Caption>The 10 items contributing the most calories in this window.</Caption>
          {((nutrition.top_by_kcal || []).length === 0)
            ? <div className="text-center text-slate-400 text-sm py-8">No data</div>
            : (
              <div style={{ width: "100%", height: Math.max(220, (nutrition.top_by_kcal.slice(0, 10).length * 26)) }} data-testid={`kitchen-${testKind}-nutrition-top-kcal`}>
                <ResponsiveContainer>
                  <BarChart data={(nutrition.top_by_kcal || []).slice(0, 10)} layout="vertical" margin={{ top: 4, right: 20, left: 4, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v)} />
                    <YAxis dataKey="name" type="category" width={110} tick={{ fontSize: 10 }} />
                    <Tooltip formatter={(v) => `${inr(v)} kcal`} contentStyle={{ fontSize: 12 }} />
                    <Bar dataKey="kcal" name="kcal" radius={[0, 3, 3, 0]}>
                      {(nutrition.top_by_kcal || []).slice(0, 10).map((r, i) => <Cell key={r.item_id} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
        </div>
      </div>
    </div>
  );
}

export function PantryDayModal({ date, kind, accent, onClose }) {
  useEscape(onClose);
  // Fetches /meals/pantry-day-detail once for the clicked day and
  // renders a compact table: item + qty + rate + amount (+ vendor
  // for purchases). Bulk-uploaded category totals surface as
  // separate "unitemised" rows so the ₹ math ties out to the chart.
  const [state, setState] = useState({ loading: true, data: null });
  useEffect(() => {
    setState({ loading: true, data: null });
    api.get(`/meals/pantry-day-detail?date=${date}&kind=${kind}`)
      .then((r) => setState({ loading: false, data: r }))
      .catch((err) => {
        showApiError(err, "Couldn't load day detail");
        setState({ loading: false, data: null });
      });
  }, [date, kind]);
  const headerBg = accent === "purchases" ? "bg-blue-700" : "bg-orange-600";
  const dateLabel = formatDate(date);
  const { loading, data } = state;
  const isPurchase = kind === "purchases";
  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4"
      role="dialog"
      onClick={onClose}
      data-testid={`kitchen-${kind}-day-modal`}
    >
      <div
        className="bg-white rounded-xl max-w-3xl w-full max-h-[85vh] shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`px-5 py-3 flex items-center gap-2 shrink-0 text-white ${headerBg}`}>
          <ListOrdered size={18} />
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-widest opacity-80">{isPurchase ? "Purchases" : "Issues"}</div>
            <div className="font-black text-lg truncate">{dateLabel}</div>
          </div>
          <div className="ml-auto" />
          <button
            type="button" onClick={onClose}
            className="p-1.5 rounded-md hover:bg-white/10"
            title="Close (Esc)"
            data-testid={`kitchen-${kind}-day-modal-close`}
          >
            <CloseIcon size={18} />
          </button>
        </div>
        {loading ? (
          <div className="p-10 text-center text-slate-400"><Loader2 className="animate-spin inline mr-2" /> Loading…</div>
        ) : !data ? (
          <div className="p-10 text-center text-slate-400 text-sm">Couldn&apos;t load this day.</div>
        ) : (data.lines.length === 0 && data.unitemised.length === 0) ? (
          <div className="p-10 text-center text-slate-400 text-sm">No {isPurchase ? "purchases" : "issues"} recorded on this day.</div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 px-5 py-3 bg-slate-50 border-b border-slate-200 shrink-0 text-sm">
              <div><span className="text-[10px] uppercase tracking-wider font-bold text-slate-500 mr-2">Amount</span><b className="tabular-nums">₹{inr(data.totals.amount)}</b></div>
              <div><span className="text-[10px] uppercase tracking-wider font-bold text-slate-500 mr-2">Qty</span><b className="tabular-nums">{fmtQty(data.totals.qty)}</b></div>
              <div><span className="text-[10px] uppercase tracking-wider font-bold text-slate-500 mr-2">Lines</span><b className="tabular-nums">{data.totals.lines}</b></div>
            </div>
            <div className="overflow-auto flex-1">
              <table className="w-full text-sm">
                <thead className="bg-white sticky top-0 shadow-[0_1px_0_0_#e2e8f0] z-10">
                  <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                    <th className="text-left px-4 py-2">Item</th>
                    <th className="text-left px-2 py-2">Category</th>
                    {isPurchase && <th className="text-left px-2 py-2">Vendor</th>}
                    <th className="text-right px-2 py-2">Qty</th>
                    <th className="text-right px-2 py-2">Rate ₹</th>
                    <th className="text-right px-2 py-2">Amount ₹</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((r, i) => (
                    <tr key={`${r.item_id}-${i}`} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-1.5 font-semibold text-slate-800">{r.name}{r.unit && <span className="text-slate-400 text-xs ml-1">({r.unit})</span>}</td>
                      <td className="px-2 py-1.5 text-slate-500 text-xs">{r.category_label || "—"}</td>
                      {isPurchase && <td className="px-2 py-1.5 text-slate-500 text-xs">{r.vendor || "—"}</td>}
                      <td className="px-2 py-1.5 text-right tabular-nums">{fmtQty(r.qty)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{r.rate ? inr2(r.rate) : "—"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{inr2(r.amount)}</td>
                    </tr>
                  ))}
                  {data.unitemised.map((u, i) => (
                    <tr key={`u-${i}`} className="border-t border-slate-100 bg-amber-50/60">
                      <td className="px-4 py-1.5 italic text-amber-900" colSpan={isPurchase ? 5 : 4}>
                        Bulk-uploaded (no per-item detail) · <b>{u.category_label}</b>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums font-semibold text-amber-900">{inr2(u.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
