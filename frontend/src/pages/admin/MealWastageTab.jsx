/**
 * MealWastageTab — 30-day wastage history, now VALUED at the last purchase
 * rate (Jun 2026). Shows a trend graph + totals up top, then the audit list.
 * Entry still lives in Daily Entry; this tab stays read-only.
 */
import React, { useEffect, useState } from "react";
import { Boxes, TrendingDown, IndianRupee } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../../api";
import { formatDate, fmtQty as uQty, todayIso, isoDaysAgo } from "../../utils";

const REASONS = [
  { key: "wasted",   label: "Wasted" },
  { key: "spoilt",   label: "Spoilt" },
  { key: "rotten",   label: "Rotten" },
  { key: "lost",     label: "Lost" },
  { key: "damaged",  label: "Damaged" },
  { key: "other",    label: "Other" },
];
const REASON_LABEL = Object.fromEntries(REASONS.map((r) => [r.key, r.label]));
const rupee = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const rupee2 = (n) => `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function TrendTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow p-2 text-xs">
      <div className="font-bold mb-0.5">{formatDate(label)}</div>
      <div className="tabular-nums text-rose-700 font-semibold">{rupee2(payload[0].value)} wasted</div>
    </div>
  );
}

export default function MealWastageTab({ liveSig }) {
  const [recent, setRecent] = useState([]);
  const [totals, setTotals] = useState({ total_value: 0, total_qty: 0, by_reason: {} });
  const [series, setSeries] = useState([]);

  const loadRecent = () => {
    const end = todayIso();
    const start = isoDaysAgo(30);
    api.get(`/meals/wastage?start=${start}&end=${end}`)
      .then((r) => {
        setRecent((r.wastage || []).slice().reverse());
        setTotals({ total_value: r.total_value || 0, total_qty: r.total_qty || 0, by_reason: r.by_reason || {} });
        setSeries((r.series || []).map((p) => ({ ...p, label: (p.date || "").slice(5) })));
      })
      .catch(() => {});
  };
  useEffect(loadRecent, []);
  useEffect(() => { if (liveSig) loadRecent(); }, [liveSig]);

  const hasValue = (totals.total_value || 0) > 0;
  const reasonRows = REASONS
    .map((r) => ({ ...r, value: totals.by_reason?.[r.key] || 0 }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);

  return (
    <div data-testid="meal-wastage-tab">
      {/* Trend graph + valued totals */}
      <div className="iu-card p-4 mb-4" data-testid="wastage-summary">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2">
            <TrendingDown size={18} className="text-rose-500" />
            <h3 className="font-extrabold text-base">Wastage — last 30 days</h3>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right" data-testid="wastage-total-value">
              <div className="text-[11px] uppercase font-bold text-slate-400 tracking-wide">Total value</div>
              <div className="text-xl font-extrabold text-rose-700 tabular-nums flex items-center gap-0.5">
                <IndianRupee size={16} className="text-rose-500" />{Number(totals.total_value || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
              </div>
            </div>
          </div>
        </div>

        {series.some((p) => p.value > 0) ? (
          <div style={{ width: "100%", height: 200 }} data-testid="wastage-trend-chart">
            <ResponsiveContainer>
              <BarChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1e5e5" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={16} />
                <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => (v >= 1000 ? `₹${(v / 1000).toFixed(0)}k` : `₹${v}`)} width={46} />
                <Tooltip content={<TrendTooltip />} cursor={{ fill: "rgba(244,63,94,0.06)" }} />
                <Bar dataKey="value" fill="#f43f5e" radius={[3, 3, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="py-8 text-center text-sm text-slate-400" data-testid="wastage-trend-empty">No wastage valued in this window — good going.</div>
        )}

        {reasonRows.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-slate-100" data-testid="wastage-by-reason">
            {reasonRows.map((r) => (
              <span key={r.key} className="inline-flex items-center gap-1.5 px-2 h-6 rounded-full bg-rose-50 border border-rose-200 text-xs" data-testid={`wastage-reason-${r.key}`}>
                <span className="font-bold text-rose-700 uppercase text-[10px]">{r.label}</span>
                <span className="tabular-nums font-semibold text-slate-700">{rupee(r.value)}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="iu-card p-4 mb-4 bg-rose-50/40 border-rose-200" data-testid="wastage-moved-notice">
        <div className="flex items-start gap-3">
          <Boxes size={20} className="text-rose-500 mt-0.5"/>
          <div className="text-sm text-slate-700">
            <div className="font-bold text-rose-800">Wastage entry has moved.</div>
            <div className="mt-1">
              Log wastage directly on the <span className="font-semibold">Daily entry</span> tab — every item row now has a <span className="font-semibold text-rose-700">Wastage</span> column with quantity and reason, right next to Consumption.
            </div>
            <div className="mt-1 text-xs text-slate-500">This history values each wasted item at its last purchase rate.</div>
          </div>
        </div>
      </div>

      <div className="iu-card overflow-auto" data-testid="wastage-recent">
        <div className="px-4 py-3 border-b border-slate-100 font-bold text-sm">Last 30 days of wastage</div>
        {recent.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500" data-testid="wastage-recent-empty">Nothing logged yet — good going.</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Items</th>
                <th className="px-3 py-2 text-left">Reasons</th>
                <th className="px-3 py-2 text-right">Value</th>
                <th className="px-3 py-2 text-left">By</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => {
                const lineList = r.lines || [];
                const reasonTags = Array.from(new Set(lineList.map((l) => l.reason))).map((k) => REASON_LABEL[k] || k);
                const preview = lineList.slice(0, 3)
                  .map((l) => `${l.item_name} (${uQty(l.qty, l.unit)} ${l.unit}${l.value ? ` · ${rupee(l.value)}` : ""})`)
                  .join(", ");
                return (
                  <tr key={r.date} className="border-t border-slate-100 hover:bg-slate-50/70" data-testid={`wastage-recent-row-${r.date}`}>
                    <td className="px-3 py-1.5 font-semibold whitespace-nowrap">{formatDate(r.date)}</td>
                    <td className="px-3 py-1.5 text-slate-700">
                      {preview}{lineList.length > 3 ? ` +${lineList.length - 3}` : ""}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex flex-wrap gap-1">
                        {reasonTags.map((rt) => (
                          <span key={rt} className="inline-flex items-center px-1.5 h-4 rounded bg-rose-100 text-rose-700 text-[10px] font-bold uppercase">{rt}</span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-semibold text-rose-700" data-testid={`wastage-row-value-${r.date}`}>{r.day_value ? rupee(r.day_value) : "—"}</td>
                    <td className="px-3 py-1.5 text-slate-500">{r.updated_by_name || ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
