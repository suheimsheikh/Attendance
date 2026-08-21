/**
 * MealsAnalyticsPanel — four charts derived entirely client-side from
 * the `days` array the Meals Calendar already fetches. Purposefully no
 * extra API call: at ~90 days per view the compute is trivial and the
 * charts stay in sync with any inline edit the admin makes.
 *
 *   • Daily meals + 7-day moving-average (line chart)
 *   • Meal-slot split — BF / L / D (donut)
 *   • Day-of-week average (bar)
 *   • Monthly totals grouped BF / L / D (grouped bar)
 */
import React, { useMemo } from "react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, PieChart, Pie, Cell, BarChart, Bar,
} from "recharts";
import { TrendingUp, PieChart as PieIcon, Calendar as CalIcon, BarChart3, Flame, Trophy } from "lucide-react";

const SLOT_COLORS = { Breakfast: "#F59E0B", Lunch: "#F97316", Dinner: "#6366F1" };
const inr = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN"));

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmt(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" });
}

function useMetrics(days) {
  return useMemo(() => {
    const populated = (days || []).filter((d) => d.has_data);
    if (populated.length === 0) return null;

    // ── Daily series with 7-day moving average ────────────────────
    const rows = populated.map((d) => ({
      date: d.date,
      label: fmt(d.date),
      Breakfast: d.breakfast,
      Lunch: d.lunch,
      Dinner: d.dinner,
      total: d.total,
      dow: new Date(d.date + "T00:00:00").getDay(),
    }));
    // Simple trailing 7-day moving average of `total`
    rows.forEach((r, i) => {
      const slice = rows.slice(Math.max(0, i - 6), i + 1);
      r.ma7 = Math.round(slice.reduce((s, x) => s + x.total, 0) / slice.length);
    });

    // ── Meal-slot totals ──────────────────────────────────────────
    const bf = rows.reduce((s, r) => s + r.Breakfast, 0);
    const l  = rows.reduce((s, r) => s + r.Lunch, 0);
    const dn = rows.reduce((s, r) => s + r.Dinner, 0);
    const grand = bf + l + dn;
    const slots = [
      { key: "Breakfast", value: bf, pct: grand ? Math.round(bf * 100 / grand) : 0 },
      { key: "Lunch",     value: l,  pct: grand ? Math.round(l  * 100 / grand) : 0 },
      { key: "Dinner",    value: dn, pct: grand ? Math.round(dn * 100 / grand) : 0 },
    ];

    // ── Day-of-week averages ──────────────────────────────────────
    const dowAgg = Array(7).fill(0).map(() => ({ total: 0, days: 0 }));
    rows.forEach((r) => { dowAgg[r.dow].total += r.total; dowAgg[r.dow].days += 1; });
    // Present as Mon-first order
    const dowRows = [1, 2, 3, 4, 5, 6, 0].map((i) => ({
      dow: DOW[i],
      avg: dowAgg[i].days ? Math.round(dowAgg[i].total / dowAgg[i].days) : 0,
      days: dowAgg[i].days,
    }));

    // ── Monthly totals ────────────────────────────────────────────
    const monthMap = new Map();
    rows.forEach((r) => {
      const [y, m] = r.date.split("-");
      const key = `${MONTH_LABELS[+m - 1]} ${y.slice(-2)}`;
      const rec = monthMap.get(key) || { month: key, Breakfast: 0, Lunch: 0, Dinner: 0, days: 0 };
      rec.Breakfast += r.Breakfast;
      rec.Lunch     += r.Lunch;
      rec.Dinner    += r.Dinner;
      rec.days += 1;
      monthMap.set(key, rec);
    });
    const months = [...monthMap.values()];

    // ── Peaks ─────────────────────────────────────────────────────
    const sorted = [...rows].sort((a, b) => b.total - a.total);
    const highest = sorted[0];
    const lowest = sorted[sorted.length - 1];

    return {
      rows, slots, dowRows, months, highest, lowest,
      totals: { Breakfast: bf, Lunch: l, Dinner: dn, grand, days: rows.length,
                avgPerDay: rows.length ? Math.round(grand / rows.length) : 0 },
    };
  }, [days]);
}

function StatPill({ icon: Icon, label, value, tint }) {
  return (
    <div className={`iu-card p-3 flex items-center gap-3 ${tint || ""}`}>
      <div className="w-9 h-9 rounded-lg bg-white/70 flex items-center justify-center shrink-0">
        <Icon size={16} />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wide font-semibold text-slate-500">{label}</div>
        <div className="text-lg font-extrabold tabular-nums truncate">{value}</div>
      </div>
    </div>
  );
}

export default function MealsAnalyticsPanel({ days }) {
  const m = useMetrics(days);
  if (!m) {
    return (
      <div className="iu-card p-6 text-center text-slate-400 text-sm" data-testid="meals-analytics-empty">
        No populated days in this window to analyse.
      </div>
    );
  }
  return (
    <div className="space-y-3" data-testid="meals-analytics-panel">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatPill icon={Flame}  label="Avg meals / day" value={inr(m.totals.avgPerDay)} tint="bg-emerald-50" />
        <StatPill icon={Trophy} label="Highest day"
                  value={`${inr(m.highest.total)} · ${fmt(m.highest.date)}`}
                  tint="bg-amber-50" />
        <StatPill icon={CalIcon} label="Days populated" value={m.totals.days} tint="bg-sky-50" />
        <StatPill icon={PieIcon} label="BF : L : D"
                  value={`${m.slots[0].pct}·${m.slots[1].pct}·${m.slots[2].pct}%`}
                  tint="bg-violet-50" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp size={14} className="text-slate-500"/>
            <div className="font-bold text-sm">Daily total & 7-day trend</div>
          </div>
          <div style={{ width: "100%", height: 260 }} data-testid="ma-daily-trend">
            <ResponsiveContainer>
              <LineChart data={m.rows} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={20} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v) => `${inr(v)} meals`} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="total" name="Meals"       stroke="#10B981" strokeWidth={2} dot={{ r: 2 }} />
                <Line type="monotone" dataKey="ma7"   name="7-day avg"  stroke="#0F172A" strokeWidth={1.5} strokeDasharray="4 2" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1">
            <PieIcon size={14} className="text-slate-500"/>
            <div className="font-bold text-sm">Meal-slot share (all days)</div>
          </div>
          <div style={{ width: "100%", height: 260 }} data-testid="ma-slot-pie">
            <ResponsiveContainer>
              <PieChart>
                <Pie data={m.slots} dataKey="value" nameKey="key" outerRadius={95} innerRadius={45}
                     label={(e) => `${e.pct}%`} labelLine={false}>
                  {m.slots.map((s) => <Cell key={s.key} fill={SLOT_COLORS[s.key]} />)}
                </Pie>
                <Tooltip formatter={(v, n) => [`${inr(v)} meals`, n]} contentStyle={{ fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1">
            <BarChart3 size={14} className="text-slate-500"/>
            <div className="font-bold text-sm">Average meals by day of week</div>
            <span className="text-[10px] text-slate-400">(spotting Sunday-off etc.)</span>
          </div>
          <div style={{ width: "100%", height: 240 }} data-testid="ma-dow-bar">
            <ResponsiveContainer>
              <BarChart data={m.dowRows} margin={{ top: 4, right: 12, left: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="dow" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v) => `${inr(v)} meals`} />
                <Bar dataKey="avg" name="Avg meals" radius={[4, 4, 0, 0]}>
                  {m.dowRows.map((r) => (
                    <Cell key={r.dow} fill={r.dow === "Sun" ? "#DC2626" : "#10B981"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1">
            <BarChart3 size={14} className="text-slate-500"/>
            <div className="font-bold text-sm">Monthly totals · BF · L · D</div>
          </div>
          <div style={{ width: "100%", height: 260 }} data-testid="ma-monthly">
            <ResponsiveContainer>
              <BarChart data={m.months} margin={{ top: 4, right: 12, left: 4, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip contentStyle={{ fontSize: 12 }} formatter={(v, n) => [`${inr(v)} meals`, n]} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="Breakfast" stackId="a" fill={SLOT_COLORS.Breakfast} />
                <Bar dataKey="Lunch"     stackId="a" fill={SLOT_COLORS.Lunch} />
                <Bar dataKey="Dinner"    stackId="a" fill={SLOT_COLORS.Dinner} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
