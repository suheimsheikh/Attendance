/**
 * MealsReport — chef daily counts + admin monthly grid.
 *
 * Two tabs:
 *   • Daily counts — chef-facing headcount per meal + category
 *     breakdown for a chosen date. Fast-glance portion planning.
 *   • Monthly grid — rows = members, cols = days, cells = which meals
 *     they took (BF / L / S / D). Admin-focused audit view.
 *
 * Access: admin / chef / coach (require_chef_or_admin on the server).
 */
import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Utensils, CalendarDays, BarChart3 } from "lucide-react";
import { api, showApiError } from "../../api";
import { formatDate } from "../../utils";

const MEAL_ORDER = ["breakfast", "lunch", "snacks", "dinner"];
const MEAL_LABELS = {
  breakfast: "Breakfast",
  lunch:     "Lunch",
  snacks:    "Snacks / Tea",
  dinner:    "Dinner",
};
const MEAL_SHORT = { breakfast: "BF", lunch: "L", snacks: "S", dinner: "D" };
const MEAL_COLOR = {
  breakfast: "#F59E0B",
  lunch:     "#10B981",
  snacks:    "#8B5CF6",
  dinner:    "#2563EB",
};

function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function currentMonth() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
}

function DailyTab() {
  const [dateStr, setDateStr] = useState(todayISO());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.get(`/meals/daily-counts?date=${dateStr}`)
      .then(setData)
      .catch((err) => showApiError(err, "Load failed"))
      .finally(() => setLoading(false));
  }, [dateStr]);

  const total = useMemo(
    () => (data?.meals || []).reduce((s, m) => s + (m.total || 0), 0),
    [data],
  );

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <label className="text-xs font-semibold text-slate-600" htmlFor="meals-report-date">
          Date
        </label>
        <input
          id="meals-report-date"
          data-testid="meals-report-date"
          type="date"
          value={dateStr}
          onChange={(e) => setDateStr(e.target.value)}
          max={todayISO()}
          className="iu-input !h-9 !w-auto text-sm"
        />
        <span className="text-xs text-slate-500">{formatDate(dateStr)}</span>
        <span className="ml-auto text-xs text-slate-500">
          <b>{total}</b> meal marks total
        </span>
      </div>

      {loading ? (
        <div className="text-center py-10"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="meals-report-daily">
          {(data?.meals || []).map((m) => (
            <div key={m.key} className="iu-card p-4" data-testid={`meals-report-daily-${m.key}`}>
              <div className="flex items-center gap-3 mb-2">
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center text-white font-bold shrink-0"
                  style={{ background: MEAL_COLOR[m.key] }}
                >
                  {MEAL_SHORT[m.key]}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-slate-900">{m.label}</div>
                  <div className="text-xs text-slate-500">Portions to plan</div>
                </div>
                <div className="text-3xl font-extrabold tabular-nums" data-testid={`meals-report-daily-${m.key}-total`}>
                  {m.total || 0}
                </div>
              </div>
              {Object.keys(m.by_category || {}).length > 0 && (
                <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-100">
                  {Object.entries(m.by_category).map(([cat, n]) => (
                    <span
                      key={cat}
                      className="inline-flex items-center gap-1 px-2 h-6 rounded-full bg-slate-100 text-slate-700 text-xs font-semibold capitalize"
                    >
                      {cat}
                      <span className="font-bold">{n}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MonthlyGridTab() {
  const [month, setMonth] = useState(currentMonth());
  const [scope, setScope] = useState("all");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.get(`/meals/monthly-grid?month=${month}&scope=${scope}`)
      .then(setData)
      .catch((err) => showApiError(err, "Load failed"))
      .finally(() => setLoading(false));
  }, [month, scope]);

  const days = data?.days || [];
  const rows = data?.rows || [];

  return (
    <div>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <label className="text-xs font-semibold text-slate-600" htmlFor="meals-report-month">Month</label>
        <input
          id="meals-report-month"
          data-testid="meals-report-month"
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          max={currentMonth()}
          className="iu-input !h-9 !w-auto text-sm"
        />
        <select
          data-testid="meals-report-scope"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className="iu-input !h-9 !w-auto text-sm"
        >
          <option value="all">All</option>
          <option value="athletes">Athletes</option>
          <option value="staff">Staff</option>
          <option value="coach">Coaches</option>
          <option value="executive">Executives</option>
          <option value="non_athletes">Non-athletes</option>
        </select>
        <span className="ml-auto text-xs text-slate-500">
          <b>{rows.length}</b> {rows.length === 1 ? "member" : "members"} with meals
        </span>
      </div>

      {loading ? (
        <div className="text-center py-10"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
      ) : rows.length === 0 ? (
        <div className="iu-card p-10 text-center" data-testid="meals-report-monthly-empty">
          <BarChart3 className="mx-auto text-slate-300 mb-2" size={36} />
          <p className="font-semibold text-slate-700">No meal marks yet for this month.</p>
          <p className="text-sm text-slate-500 mt-1">Start ticking members on the Meals page.</p>
        </div>
      ) : (
        <div className="iu-card overflow-auto" data-testid="meals-report-monthly">
          <table className="text-xs w-full">
            <thead className="bg-slate-50 sticky top-0 z-10">
              <tr>
                <th className="p-2 text-left sticky left-0 bg-slate-50 z-20 min-w-[180px]">Member</th>
                {days.map((d) => {
                  const dayNum = d.slice(-2);
                  return (
                    <th key={d} className="p-1 text-center font-semibold text-slate-600 min-w-[54px]"
                        title={d}>
                      {dayNum}
                    </th>
                  );
                })}
                <th className="p-2 text-center bg-slate-100 min-w-[60px]">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const totalMeals = MEAL_ORDER.reduce((s, k) => s + (row.totals?.[k] || 0), 0);
                return (
                  <tr key={row.id} className="border-t border-slate-100 hover:bg-slate-50/60"
                      data-testid={`meals-report-monthly-row-${row.id}`}>
                    <td className="p-2 sticky left-0 bg-white z-10 border-r border-slate-100">
                      <div className="font-semibold text-slate-900 truncate">{row.full_name}</div>
                      <div className="text-[10px] text-slate-500 capitalize">{row.category || ""}</div>
                    </td>
                    {days.map((d) => {
                      const cellMeals = row.days?.[d] || [];
                      return (
                        <td key={d} className="p-1 text-center align-middle" title={cellMeals.map((k) => MEAL_LABELS[k] || k).join(", ") || "—"}>
                          <div className="inline-flex gap-0.5">
                            {MEAL_ORDER.map((k) => (
                              <span
                                key={k}
                                className="inline-block w-2 h-3 rounded-sm"
                                style={{
                                  background: cellMeals.includes(k) ? MEAL_COLOR[k] : "#e5e7eb",
                                }}
                                data-testid={`meals-report-cell-${row.id}-${d}-${k}`}
                              />
                            ))}
                          </div>
                        </td>
                      );
                    })}
                    <td className="p-2 text-center font-bold bg-slate-50/60">{totalMeals}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {rows.length > 0 && (
        <div className="mt-3 flex items-center gap-3 text-xs text-slate-500 flex-wrap" data-testid="meals-report-legend">
          <span className="font-semibold">Legend:</span>
          {MEAL_ORDER.map((k) => (
            <span key={k} className="inline-flex items-center gap-1">
              <span className="inline-block w-2 h-3 rounded-sm" style={{ background: MEAL_COLOR[k] }} />
              {MEAL_LABELS[k]}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function MealsReport() {
  const [tab, setTab] = useState("daily");
  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto" data-testid="meals-report-page">
      <header className="mb-6">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Meals Report</h1>
        <p className="text-slate-500 text-sm mt-1">
          Portion planning (daily) and month-long audit (monthly grid) of who ate what.
        </p>
      </header>

      <div className="flex gap-2 mb-5 border-b border-slate-200" data-testid="meals-report-tabs">
        <button
          data-testid="meals-report-tab-daily"
          onClick={() => setTab("daily")}
          className={`px-4 py-2 text-sm font-semibold -mb-px border-b-2 ${
            tab === "daily" ? "border-emerald-600 text-emerald-700" : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
        >
          <span className="inline-flex items-center gap-2"><Utensils size={14}/> Daily counts</span>
        </button>
        <button
          data-testid="meals-report-tab-monthly"
          onClick={() => setTab("monthly")}
          className={`px-4 py-2 text-sm font-semibold -mb-px border-b-2 ${
            tab === "monthly" ? "border-emerald-600 text-emerald-700" : "border-transparent text-slate-500 hover:text-slate-700"
          }`}
        >
          <span className="inline-flex items-center gap-2"><CalendarDays size={14}/> Monthly grid</span>
        </button>
      </div>

      {tab === "daily" ? <DailyTab /> : <MonthlyGridTab />}
    </div>
  );
}
