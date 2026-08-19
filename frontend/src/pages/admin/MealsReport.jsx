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
import { createPortal } from "react-dom";
import { Loader2, Utensils, CalendarDays, BarChart3, Printer, X, ChevronRight, IndianRupee, ShoppingCart, ClipboardList, Flame, FolderTree, Scale, Store } from "lucide-react";
import { api, showApiError } from "../../api";
import { formatDate } from "../../utils";
import { useMealsEvents } from "../../hooks/useMealsEvents";
import MealExpensesTab from "./MealExpensesTab";
import MealPurchasesTab from "./MealPurchasesTab";
import MealIssuesTab from "./MealIssuesTab";
import MealEntryTab from "./MealEntryTab";
import MealWastageTab from "./MealWastageTab";
import MealMastersTab from "./MealMastersTab";
import MealCrossCheckTab from "./MealCrossCheckTab";
import MealVendorsTab from "./MealVendorsTab";
import { useEscape } from "../../hooks/useEscape";

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

function DailyDetailsModal({ dateStr, meal, mealLabel, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEscape(onClose);

  useEffect(() => {
    setLoading(true);
    api.get(`/meals/daily-details?date=${dateStr}&meal=${meal}`)
      .then(setData)
      .catch((err) => showApiError(err, "Couldn't load details"))
      .finally(() => setLoading(false));
  }, [dateStr, meal]);

  // Printing: give body a marker class so the print CSS knows to
  // isolate the printable region, kick off the browser dialog, then
  // clean up on afterprint. Handles the ESC-abort path too via the
  // one-shot listener.
  const handlePrint = () => {
    document.body.classList.add("meals-print-active");
    const cleanup = () => {
      document.body.classList.remove("meals-print-active");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.print();
  };

  // Group members by category for the printable sheet — matches the
  // backend's sort order but surfaces group headings + running totals
  // so the kitchen can tick physical copies without recounting.
  const grouped = useMemo(() => {
    const g = new Map();
    (data?.members || []).forEach((m) => {
      const cat = m.category || "other";
      if (!g.has(cat)) g.set(cat, []);
      g.get(cat).push(m);
    });
    return Array.from(g.entries());
  }, [data]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={onClose}
      data-testid="meals-details-backdrop"
    >
      <div
        className="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        data-testid="meals-details-modal"
      >
        <header className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-extrabold text-slate-900" data-testid="meals-details-title">
              {mealLabel} — {formatDate(dateStr)}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {loading ? "Loading…" : `${data?.count || 0} members marked`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handlePrint}
              disabled={loading || !data?.count}
              className="iu-btn-secondary !h-9 !px-3 text-sm"
              data-testid="meals-details-print"
              title="Print or save as PDF"
            >
              <Printer size={14}/> Print / PDF
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
              aria-label="Close"
              data-testid="meals-details-close"
            >
              <X size={18}/>
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto" data-testid="meals-details-body">
          {loading ? (
            <div className="text-center py-12"><Loader2 className="animate-spin mx-auto text-slate-400"/></div>
          ) : !data?.count ? (
            <div className="text-center py-12 text-slate-500" data-testid="meals-details-empty">
              No one marked for this meal.
            </div>
          ) : (
            grouped.map(([cat, members]) => (
              <section key={cat} className="border-b border-slate-100 last:border-0" data-testid={`meals-details-group-${cat}`}>
                <div className="sticky top-0 bg-slate-50 px-5 py-2 border-b border-slate-100">
                  <div className="text-[11px] font-bold text-slate-600 uppercase tracking-wider flex items-center gap-2">
                    <span className="capitalize">{cat}</span>
                    <span className="text-slate-400">·</span>
                    <span className="text-slate-500">{members.length}</span>
                  </div>
                </div>
                <ul className="divide-y divide-slate-100">
                  {members.map((mem, idx) => (
                    <li key={mem.user_id || idx} className="px-5 py-2 flex items-center gap-3 text-sm" data-testid={`meals-details-row-${mem.user_id}`}>
                      <span className="w-8 text-right text-slate-400 tabular-nums text-xs shrink-0">{idx + 1}.</span>
                      <span className="font-semibold text-slate-900 flex-1 truncate">{mem.user_name || "—"}</span>
                      {mem.institution && (
                        <span className="text-xs text-slate-500 hidden sm:inline">{mem.institution}</span>
                      )}
                      {mem.copied_from && (
                        <span className="text-[10px] font-bold text-amber-700 bg-amber-100 px-1.5 h-4 rounded inline-flex items-center" title={`Copied from ${mem.copied_from}`}>
                          COPIED
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>

      {/* Print region is PORTALED to document.body so it's a direct
          body child. Two wins: (1) `body > *:not(print-region)` in the
          print CSS cleanly hides everything else without collapsing
          ancestors, (2) the print region uses normal flow (not
          position:fixed), so long rosters paginate across pages
          naturally instead of clipping to page 1. */}
      {typeof document !== "undefined" && createPortal(
        <div className="hidden print:block bg-white" data-testid="meals-details-print-region">
          <div className="border-b-2 border-slate-800 pb-3 mb-4">
            <h1 className="text-2xl font-extrabold text-slate-900">
              {mealLabel} — {formatDate(dateStr)}
            </h1>
            <p className="text-sm text-slate-600 mt-1">
              {data?.count || 0} members marked ·
              Printed {new Date().toLocaleString()}
            </p>
          </div>
          {grouped.map(([cat, members]) => (
            <section key={cat} className="mb-4 break-inside-avoid">
              <h2 className="text-sm font-extrabold uppercase tracking-wider bg-slate-100 px-2 py-1 mb-2">
                {cat} <span className="text-slate-500">({members.length})</span>
              </h2>
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-slate-300 text-xs text-slate-600 uppercase">
                    <th className="text-left p-1 w-10">#</th>
                    <th className="text-left p-1">Name</th>
                    <th className="text-left p-1 w-40">Institution</th>
                    <th className="text-left p-1 w-16"> </th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((mem, idx) => (
                    <tr key={mem.user_id || idx} className="border-b border-slate-200">
                      <td className="p-1 text-slate-500 tabular-nums">{idx + 1}</td>
                      <td className="p-1 font-semibold">{mem.user_name || "—"}</td>
                      <td className="p-1 text-slate-700">{mem.institution || ""}</td>
                      <td className="p-1 text-slate-500 text-xs">
                        {mem.copied_from ? `copied ${mem.copied_from}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

function DailyTab() {
  const [dateStr, setDateStr] = useState(todayISO());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [detailsMeal, setDetailsMeal] = useState(null);   // e.g. "breakfast"

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
          {(data?.meals || []).map((m) => {
            const disabled = !m.total;
            return (
              <button
                type="button"
                key={m.key}
                onClick={() => !disabled && setDetailsMeal(m.key)}
                disabled={disabled}
                className={`iu-card p-4 text-left transition ${
                  disabled
                    ? "opacity-70 cursor-not-allowed"
                    : "hover:shadow-md hover:border-slate-300 cursor-pointer"
                }`}
                data-testid={`meals-report-daily-${m.key}`}
                title={disabled ? "No one marked yet" : `Show ${m.label} details`}
              >
                <div className="flex items-center gap-3 mb-2">
                  <div
                    className="w-9 h-9 rounded-lg flex items-center justify-center text-white font-bold shrink-0"
                    style={{ background: MEAL_COLOR[m.key] }}
                  >
                    {MEAL_SHORT[m.key]}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-slate-900">{m.label}</div>
                    <div className="text-xs text-slate-500">
                      {disabled ? "No marks yet" : "Tap for details · printable"}
                    </div>
                  </div>
                  <div className="text-3xl font-extrabold tabular-nums" data-testid={`meals-report-daily-${m.key}-total`}>
                    {m.total || 0}
                  </div>
                  {!disabled && <ChevronRight size={16} className="text-slate-400 shrink-0" />}
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
              </button>
            );
          })}
        </div>
      )}

      {detailsMeal && (
        <DailyDetailsModal
          dateStr={dateStr}
          meal={detailsMeal}
          mealLabel={MEAL_LABELS[detailsMeal]}
          onClose={() => setDetailsMeal(null)}
        />
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
  const [tab, setTab] = useState("masters");
  const [lowCount, setLowCount] = useState(0);
  // Live update signal — pushed from the server whenever ANY machine
  // changes pantry data. Passed down so the active tab can refetch.
  const [liveSig, setLiveSig] = useState(null);
  useMealsEvents(setLiveSig);
  // Safety net: whenever the window regains focus, synthesize a signal so
  // the active tab refetches even if an SSE frame was missed while the
  // machine slept / the stream was reconnecting.
  useEffect(() => {
    const onFocus = () => setLiveSig({ seq: -1, scope: "purchases", date: null, client: "", synthetic: true });
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  useEffect(() => {
    api.get("/meals/stock").then((r) => setLowCount(r.low_count || 0)).catch(() => {});
  }, [tab, liveSig]);
  const TABS = [
    { key: "masters",   label: "Stock Master",       Icon: FolderTree, hint: "Central tree of categories and items — stock on hand, opening balance as-of date, low-stock alerts and item management" },
    { key: "entry",     label: "Daily entry",   Icon: ShoppingCart, hint: "One screen to enter both supplier purchases (qty · rate) and kitchen issues (qty) for a day — auto-saves as you type" },
    { key: "wastage",   label: "Wastage & losses", Icon: Flame, hint: "Record rotten, spilled or lost stock with a reason" },
    { key: "crosscheck", label: "Cross-check", Icon: Scale, hint: "Compare what the kitchen issued vs meals served × per-item norms — flags over/under days" },
    { key: "daily",     label: "Daily counts",  Icon: Utensils, hint: "Headcount of meals served per day" },
    { key: "monthly",   label: "Monthly grid",  Icon: CalendarDays, hint: "Month-long meal count audit grid" },
    { key: "expenses",  label: "Expense report", Icon: IndianRupee, hint: "Category-wise purchase spend for the accountant" },
    { key: "vendors",   label: "Vendors",       Icon: Store, hint: "Suppliers you can attribute purchase lines to — name and phone" },
  ];
  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto" data-testid="meals-report-page">
      {/* Page title + tab bar stay latched to the very top of the viewport
          so the chef always sees where they are and can jump tabs while
          scrolling a long pantry list. Height ≈ 132px on desktop; child
          sticky regions inside each tab must offset by this amount. */}
      <div className="sticky top-0 z-40 bg-slate-50 -mx-4 md:-mx-8 px-4 md:px-8 pt-1 pb-0" data-testid="meals-report-sticky-top">
        <header className="pb-3">
          <h1 className="text-xl md:text-2xl font-extrabold tracking-tight">Pantry Stock</h1>
          <p className="text-slate-500 text-xs mt-0.5">
            Portion planning, month-long audit, purchase entry and the expense report.
          </p>
        </header>

        <div className="flex gap-2 border-b border-slate-200 overflow-x-auto" data-testid="meals-report-tabs">
          {TABS.map(({ key, label, Icon, hint }) => (
            <button
              key={key}
              data-testid={`meals-report-tab-${key}`}
              onClick={() => setTab(key)}
              title={hint}
              className={`px-4 py-2 text-sm font-semibold -mb-px border-b-2 whitespace-nowrap rounded-t-md ${
                tab === key ? "border-blue-600 bg-blue-100 text-blue-800" : "border-transparent text-slate-500 hover:text-slate-700 hover:bg-slate-50"
              }`}
            >
              <span className="inline-flex items-center gap-2">
                <Icon size={14}/> {label}
                {key === "masters" && lowCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-rose-600 text-white text-[10px] font-bold" title={`${lowCount} item${lowCount === 1 ? "" : "s"} at or below the minimum stock level`} data-testid="stock-low-badge">
                    {lowCount}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="pt-4">
      {tab === "daily" && <DailyTab />}
      {tab === "monthly" && <MonthlyGridTab />}
      {tab === "expenses" && <MealExpensesTab liveSig={liveSig} />}
      {tab === "entry" && <MealEntryTab liveSig={liveSig} />}
      {/* Legacy: keep old tabs reachable via deep-link only, in case a
          user has a purchases/issues URL bookmarked from before the
          Feb-2026 merge. */}
      {tab === "purchases" && <MealPurchasesTab onGoMasters={() => setTab("masters")} />}
      {tab === "issues" && <MealIssuesTab />}
      {tab === "wastage" && <MealWastageTab liveSig={liveSig} />}
      {tab === "crosscheck" && <MealCrossCheckTab onGoMasters={() => setTab("masters")} liveSig={liveSig} />}
      {tab === "masters" && <MealMastersTab liveSig={liveSig} />}
      {tab === "vendors" && <MealVendorsTab liveSig={liveSig} />}
      </div>
    </div>
  );
}
