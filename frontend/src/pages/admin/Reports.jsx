import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, FileDown, FileText, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { useSearchParams } from "react-router-dom";
import { api, downloadBlob } from "../../api";
import ParentContact from "../../components/ParentContact";
import { todayIso, shortDate, categoryLabel } from "../../utils";

function pad2(n) { return String(n).padStart(2, "0"); }
function isoDate(y, m0, d) { return `${y}-${pad2(m0 + 1)}-${pad2(d)}`; }

/** Return `{start, end, isCurrent, label}` for the calendar month
 * containing (year, monthIdx). If the month is the current one, `end`
 * clamps to today; otherwise it's the last of the month. `label` reads
 * "July 2026" (browser-locale month name). */
function monthWindow(year, monthIdx) {
  const today = new Date();
  const isCurrent = today.getFullYear() === year && today.getMonth() === monthIdx;
  const start = isoDate(year, monthIdx, 1);
  const lastDay = new Date(year, monthIdx + 1, 0).getDate();
  const end = isCurrent ? todayIso() : isoDate(year, monthIdx, lastDay);
  const label = new Date(year, monthIdx, 1).toLocaleDateString(undefined,
    { month: "long", year: "numeric" });
  return { start, end, isCurrent, label, lastDay };
}

/** Days elapsed in a month up to `end` (inclusive). If `end` is the
 * last day, it's the month's full length. */
function daysElapsed(start, end) {
  try {
    const s = new Date(start + "T00:00:00");
    const e = new Date(end + "T00:00:00");
    return Math.floor((e - s) / 86400000) + 1;
  } catch { return 0; }
}

const CATEGORY_FILTERS = [
  { key: "all",     label: "All" },
  { key: "athlete", label: "Athletes" },
  // "Rest" collapses staff/coach/executive into one bucket — matches the
  // way admins actually think about the two populations at YCH.
  { key: "rest",    label: "Rest" },
];

const SORT_OPTIONS = [
  { key: "alpha", label: "A → Z" },
  { key: "pct_desc", label: "Attendance %" },
];

const VALID_TABS = new Set(["hours", "daily", "payroll"]);

export default function Reports() {
  // Month-navigator state (30 Jun 2026): admins think in months, not
  // arbitrary date ranges. Two arrow buttons flip year/monthIdx; today
  // resets to the current month. `start`/`end` are derived and passed
  // to the backend unchanged (so range endpoints stay clean).
  const _now = new Date();
  const [year, setYear] = useState(_now.getFullYear());
  const [monthIdx, setMonthIdx] = useState(_now.getMonth());
  const win = useMemo(() => monthWindow(year, monthIdx), [year, monthIdx]);
  const { start, end, isCurrent, label: monthLabel } = win;
  // Navigation helpers.
  const stepMonth = (delta) => {
    let m = monthIdx + delta, y = year;
    while (m < 0)  { m += 12; y -= 1; }
    while (m > 11) { m -= 12; y += 1; }
    setYear(y); setMonthIdx(m);
  };
  const jumpToday = () => { setYear(_now.getFullYear()); setMonthIdx(_now.getMonth()); };

  // Tab is URL-driven so /admin/reports?tab=payroll works (and legacy
  // /admin/payroll redirects here) — 1 Feb 2026 Payroll+Reports merge.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTab = searchParams.get("tab");
  const [tab, setTabState] = useState(VALID_TABS.has(urlTab) ? urlTab : "hours");
  const setTab = (t) => {
    setTabState(t);
    const next = new URLSearchParams(searchParams);
    if (t === "hours") next.delete("tab"); else next.set("tab", t);
    setSearchParams(next, { replace: true });
  };
  useEffect(() => {
    if (VALID_TABS.has(urlTab) && urlTab !== tab) setTabState(urlTab);
  }, [urlTab, tab]);

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [day, setDay] = useState(todayIso());
  const [daily, setDaily] = useState(null);
  const [payroll, setPayroll] = useState(null);
  const [categoryFilter, setCategoryFilter] = useState("all");
  // Fleet (class-wise) filter — only meaningful when the category
  // filter is set to Athletes. Populated from the rows on load; empty
  // string means "any fleet".
  const [fleetFilter, setFleetFilter] = useState("");
  const [sortBy, setSortBy] = useState("alpha");

  const loadHours = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/reports/hours", { start, end });
      setRows(res.rows || []);
    } catch (err) { toast.error(err?.message || "Failed"); }
    finally { setLoading(false); }
  }, [start, end]);

  const loadDaily = useCallback(async () => {
    setLoading(true);
    try { setDaily(await api.get("/reports/daily", { on: day })); }
    catch (err) { toast.error(err?.message || "Failed"); }
    finally { setLoading(false); }
  }, [day]);

  const monthIso = `${year}-${pad2(monthIdx + 1)}`;
  const loadPayroll = useCallback(async () => {
    setLoading(true);
    try { setPayroll(await api.get("/reports/payroll", { month: monthIso })); }
    catch (err) { toast.error(err?.message || "Failed"); }
    finally { setLoading(false); }
  }, [monthIso]);

  useEffect(() => {
    if (tab === "hours") loadHours();
    else if (tab === "daily") loadDaily();
    else if (tab === "payroll") loadPayroll();
  }, [tab, loadHours, loadDaily, loadPayroll]);

  const exportHours = (fmt) => {
    // Push the same category + fleet filters up to the backend so the
    // downloaded PDF/CSV matches what the admin currently sees on
    // screen (30 Jun 2026 late-evening — user-requested consistency).
    const params = { start, end, fmt };
    if (categoryFilter && categoryFilter !== "all") params.category = categoryFilter;
    if (fleetFilter) params.fleet = fleetFilter;
    return downloadBlob("/reports/hours/export", `hours_${start}_${end}.${fmt}`, params);
  };
  const exportDaily = (fmt) => downloadBlob("/reports/daily/export", `daily_${day}.${fmt}`, { on: day, fmt });
  const exportPayroll = (fmt) => {
    if (!payroll) return;
    return downloadBlob("/reports/hours/export", `payroll_${monthIso}.${fmt}`,
                        { start: payroll.start, end: payroll.end, fmt });
  };

  const displayedRows = useMemo(() => {
    let list = rows;
    if (categoryFilter === "athlete") {
      list = list.filter((r) => r.category === "athlete");
    } else if (categoryFilter === "rest") {
      list = list.filter((r) => r.category !== "athlete");
    }
    // Class-wise (fleet) filter — only applied when set. Empty string
    // means "any fleet". Members with no fleet stamped are matched only
    // by the explicit "(No fleet)" option.
    if (fleetFilter) {
      list = list.filter((r) =>
        fleetFilter === "__none__"
          ? !r.fleet
          : (r.fleet || "").toLowerCase() === fleetFilter.toLowerCase()
      );
    }
    const sorted = [...list];
    if (sortBy === "pct_desc") {
      sorted.sort((a, b) => (b.attendance_pct || 0) - (a.attendance_pct || 0)
        || (a.member_name || "").localeCompare(b.member_name || ""));
    } else {
      sorted.sort((a, b) => (a.member_name || "").localeCompare(b.member_name || ""));
    }
    return sorted;
  }, [rows, categoryFilter, fleetFilter, sortBy]);

  // Distinct fleet list (sorted). Recomputed whenever rows change.
  const fleetOptions = useMemo(() => {
    const s = new Set();
    let hasBlank = false;
    for (const r of rows) {
      if (r.fleet) s.add(r.fleet);
      else hasBlank = true;
    }
    const out = [...s].sort((a, b) => a.localeCompare(b));
    if (hasBlank) out.push("__none__");
    return out;
  }, [rows]);

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Reports</h1>
        <p className="text-slate-500 text-sm mt-1">Attendance hours, daily leave/tour summaries and monthly payroll.</p>
      </header>

      <div className="flex gap-2 mb-4">
        <button data-testid="tab-hours" onClick={() => setTab("hours")} className={`iu-chip ${tab === "hours" ? "iu-chip-active" : ""}`}>Hours & Attendance</button>
        <button data-testid="tab-daily" onClick={() => setTab("daily")} className={`iu-chip ${tab === "daily" ? "iu-chip-active" : ""}`}>Daily Leave/Tour</button>
        <button data-testid="tab-payroll" onClick={() => setTab("payroll")} className={`iu-chip ${tab === "payroll" ? "iu-chip-active" : ""}`}>Payroll</button>
      </div>

      {tab === "hours" && (
        <>
          <div className="iu-card p-4 mb-4 flex flex-wrap items-center gap-3" data-testid="hours-controls">
            {/* Month navigator (30 Jun 2026): arrows + label replace the
                old From/To/Quick-Pick tri-input. `end` clamps to today
                for the current month so mid-month runs read "01 → today". */}
            <MonthNav
              monthLabel={monthLabel}
              isCurrent={isCurrent}
              onPrev={() => stepMonth(-1)}
              onNext={() => stepMonth(1)}
              onToday={jumpToday}
            />
            <div className="text-[11px] text-slate-500 hidden md:block" data-testid="month-range-hint">
              {start.split("-").reverse().join("/")} → {end.split("-").reverse().join("/")}
              &nbsp;·&nbsp; {daysElapsed(start, end)} day{daysElapsed(start, end) === 1 ? "" : "s"} elapsed
            </div>
            <button data-testid="rep-run" onClick={loadHours} disabled={loading} className="iu-btn-primary">
              {loading ? <Loader2 className="animate-spin" size={14}/> : <RefreshCw size={14}/>} Run report
            </button>
            <div className="flex-1" />
            <button data-testid="export-hours-csv" onClick={() => exportHours("csv")} className="iu-btn-secondary"><FileDown size={14}/> CSV</button>
            <button data-testid="export-hours-pdf" onClick={() => exportHours("pdf")} className="iu-btn-secondary"><FileText size={14}/> PDF</button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div className="flex flex-wrap gap-2" data-testid="category-filters">
              {CATEGORY_FILTERS.map((f) => {
                const active = categoryFilter === f.key;
                const count = f.key === "all"
                  ? rows.length
                  : f.key === "athlete"
                    ? rows.filter((r) => r.category === "athlete").length
                    : rows.filter((r) => r.category !== "athlete").length;
                return (
                  <button
                    key={f.key}
                    data-testid={`cat-filter-${f.key}`}
                    onClick={() => { setCategoryFilter(f.key); if (f.key !== "athlete") setFleetFilter(""); }}
                    className={`iu-chip ${active ? "iu-chip-active" : ""}`}
                  >
                    {f.label}
                    <span className={`min-w-[22px] h-5 px-1.5 rounded-full text-[10px] flex items-center justify-center ${active ? "bg-white/20 text-white" : "bg-white border border-slate-200 text-slate-600"}`}>{count}</span>
                  </button>
                );
              })}
              {/* Fleet (class-wise) filter — only relevant for athletes;
                  shown as a compact dropdown adjacent to the pills. */}
              {categoryFilter === "athlete" && fleetOptions.length > 0 && (
                <select
                  data-testid="fleet-filter"
                  value={fleetFilter}
                  onChange={(e) => setFleetFilter(e.target.value)}
                  className="iu-input !w-40 !py-1 !h-8 text-xs"
                >
                  <option value="">All fleets</option>
                  {fleetOptions.map((f) => (
                    <option key={f} value={f}>
                      {f === "__none__" ? "(No fleet)" : f}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="flex items-center gap-2" data-testid="sort-options">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Sort</span>
              {SORT_OPTIONS.map((s) => (
                <button
                  key={s.key}
                  data-testid={`sort-${s.key}`}
                  onClick={() => setSortBy(s.key)}
                  className={`iu-chip ${sortBy === s.key ? "iu-chip-active" : ""}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className="iu-card overflow-hidden">
            <div className="overflow-auto max-h-[70vh]">
              <table className="w-full">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="iu-table-th">Attendance</th>
                    <th className="iu-table-th">Member</th>
                    <th className="iu-table-th hidden md:table-cell">Category</th>
                    <th className="iu-table-th">Present</th>
                    <th className="iu-table-th">Leave</th>
                    <th className="iu-table-th">Tour</th>
                    <th className="iu-table-th">Comp-Off</th>
                    <th className="iu-table-th">Absent</th>
                    <th className="iu-table-th font-extrabold">Total</th>
                    <th className="iu-table-th hidden md:table-cell">Total hrs</th>
                    <th className="iu-table-th hidden lg:table-cell">OT hrs</th>
                    <th className="iu-table-th hidden lg:table-cell">Late days</th>
                    <th className="iu-table-th hidden xl:table-cell">Overstays</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedRows.map((r) => (
                    <tr key={r.member_id} className="hover:bg-slate-50" data-testid={`hours-row-${r.member_id}`}>
                      <td className="iu-table-td font-bold">{r.attendance_pct}%</td>
                      <td className="iu-table-td font-semibold">
                        <div className="flex items-center gap-2">
                          <span className="truncate">{r.member_name}</span>
                          <ParentContact father={r.father_mobile} mother={r.mother_mobile} guardian={r.guardian_mobile} />
                        </div>
                        <div className="text-xs text-slate-400">{r.rank || ""}</div>
                      </td>
                      <td className="iu-table-td hidden md:table-cell">{categoryLabel(r.category)}</td>
                      <td className="iu-table-td font-semibold text-emerald-700" data-testid={`days-present-${r.member_id}`}>{r.days_present}</td>
                      <td className="iu-table-td text-amber-700" data-testid={`days-leave-${r.member_id}`}>{(r.days_leave || 0) + (r.days_break || 0)}</td>
                      <td className="iu-table-td text-orange-700" data-testid={`days-tour-${r.member_id}`}>{r.days_tour || 0}</td>
                      <td className="iu-table-td text-violet-700" data-testid={`days-comp-off-${r.member_id}`}>{r.comp_off_used || 0}</td>
                      <td className={`iu-table-td ${(r.days_absent || 0) > 0 ? "text-red-600 font-semibold" : "text-slate-400"}`} data-testid={`days-absent-${r.member_id}`}>{r.days_absent || 0}</td>
                      <td className="iu-table-td font-extrabold text-slate-900" data-testid={`days-total-${r.member_id}`}>
                        {r.days_accounted || 0}<span className="text-xs text-slate-400 font-normal"> / {r.span_days}</span>
                      </td>
                      <td className="iu-table-td hidden md:table-cell">{r.total_hours}h</td>
                      <td className="iu-table-td hidden lg:table-cell">
                        <span className="font-semibold text-emerald-700">{r.overtime_hours_approved || 0}h</span>
                        {r.overtime_hours_pending > 0 && (
                          <span className="ml-1 text-amber-600 text-xs">(+{r.overtime_hours_pending}h pending)</span>
                        )}
                      </td>
                      <td className="iu-table-td hidden lg:table-cell">{r.late_days}</td>
                      <td className={`iu-table-td hidden xl:table-cell font-semibold ${(r.overstays || 0) > 0 ? "text-red-600" : "text-slate-400"}`}>{r.overstays || 0}</td>
                    </tr>
                  ))}
                  {displayedRows.length === 0 && !loading && <tr><td colSpan={13} className="text-center py-10 text-slate-500">No data for this range.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {tab === "daily" && (
        <>
          <div className="iu-card p-4 mb-4 flex flex-wrap items-end gap-3">
            <div>
              <label className="iu-label">Date</label>
              <input data-testid="rep-day" type="date" value={day} onChange={(e) => setDay(e.target.value)} className="iu-input !w-44" />
            </div>
            <button data-testid="rep-day-run" onClick={loadDaily} disabled={loading} className="iu-btn-primary">
              {loading ? <Loader2 className="animate-spin" size={14}/> : <RefreshCw size={14}/>} Run report
            </button>
            <div className="flex-1" />
            <button data-testid="export-daily-csv" onClick={() => exportDaily("csv")} className="iu-btn-secondary"><FileDown size={14}/> CSV</button>
            <button data-testid="export-daily-pdf" onClick={() => exportDaily("pdf")} className="iu-btn-secondary"><FileText size={14}/> PDF</button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <SectionList title="On leave" items={daily?.on_leave || []} />
            <SectionList title="On tour" items={daily?.on_tour || []} />
          </div>
        </>
      )}

      {tab === "payroll" && (
        <>
          <div className="iu-card p-4 mb-4 flex flex-wrap items-center gap-3" data-testid="payroll-controls">
            <MonthNav
              monthLabel={monthLabel}
              isCurrent={isCurrent}
              onPrev={() => stepMonth(-1)}
              onNext={() => stepMonth(1)}
              onToday={jumpToday}
            />
            <div className="text-[11px] text-slate-500 hidden md:block">
              Staff &amp; coaches only · running totals when the current month is picked
            </div>
            <button data-testid="pr-run" onClick={loadPayroll} disabled={loading} className="iu-btn-primary">
              {loading ? <Loader2 className="animate-spin" size={14}/> : <RefreshCw size={14}/>} Run
            </button>
            <div className="flex-1" />
            <button data-testid="pr-csv" onClick={() => exportPayroll("csv")} className="iu-btn-secondary"><FileDown size={14}/> CSV</button>
            <button data-testid="pr-pdf" onClick={() => exportPayroll("pdf")} className="iu-btn-secondary"><FileText size={14}/> PDF</button>
          </div>

          {payroll && (
            <p className="text-xs text-slate-500 mb-3">
              Period: <strong>{payroll.start.split("-").reverse().join("/")} → {payroll.end.split("-").reverse().join("/")}</strong>
              &nbsp;· {payroll.rows.length} members
            </p>
          )}

          <div className="iu-card overflow-hidden">
            <div className="overflow-auto max-h-[70vh]">
              <table className="w-full text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="iu-table-th">Member</th>
                    <th className="iu-table-th hidden md:table-cell">Category</th>
                    <th className="iu-table-th">Days Present</th>
                    <th className="iu-table-th">Total hrs</th>
                    <th className="iu-table-th">OT hrs (approved)</th>
                    <th className="iu-table-th">Leave days (month)</th>
                    <th className="iu-table-th">Comp-Off (E/U/P)</th>
                    <th className="iu-table-th">Leave bal · open</th>
                    <th className="iu-table-th">Leave bal · taken YTD</th>
                    <th className="iu-table-th">Leave bal · remaining</th>
                  </tr>
                </thead>
                <tbody>
                  {(payroll?.rows || []).map((r) => (
                    <tr key={r.member_id} className="hover:bg-slate-50" data-testid={`pr-row-${r.member_id}`}>
                      <td className="iu-table-td font-semibold">{r.member_name}<div className="text-xs text-slate-400">{r.rank || ""}</div></td>
                      <td className="iu-table-td hidden md:table-cell">{categoryLabel(r.category)}</td>
                      <td className="iu-table-td">{r.days_present}</td>
                      <td className="iu-table-td">{r.total_hours}h</td>
                      <td className="iu-table-td font-semibold text-emerald-700">{r.overtime_hours_approved || 0}h</td>
                      <td className="iu-table-td">{r.days_on_leave || 0}</td>
                      <td className="iu-table-td">
                        <span className="text-xs">
                          <span className="text-slate-700 font-semibold">{r.comp_off_earned || 0}</span>
                          <span className="text-slate-400"> · </span>
                          <span className="text-emerald-700">{r.comp_off_used || 0}</span>
                          <span className="text-slate-400"> · </span>
                          <span className={(r.comp_off_pending || 0) > 0 ? "text-violet-700 font-semibold" : "text-slate-400"}>{r.comp_off_pending || 0}</span>
                        </span>
                      </td>
                      <td className="iu-table-td">{r.leave_balance_opening || 0}</td>
                      <td className="iu-table-td">{r.leave_balance_taken_ytd || 0}</td>
                      <td className={`iu-table-td font-bold ${(r.leave_balance_remaining || 0) < 0 ? "text-red-600" : "text-emerald-700"}`}>{r.leave_balance_remaining || 0}</td>
                    </tr>
                  ))}
                  {!loading && (payroll?.rows || []).length === 0 && (
                    <tr><td colSpan={10} className="text-center py-10 text-slate-500">No data.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MonthNav({ monthLabel, isCurrent, onPrev, onNext, onToday }) {
  return (
    <div className="flex items-center gap-1" data-testid="month-nav">
      <button
        type="button"
        data-testid="month-prev"
        onClick={onPrev}
        className="iu-btn-secondary !h-9 !w-9 !p-0 justify-center"
        aria-label="Previous month"
      ><ChevronLeft size={16}/></button>
      <div className="px-3 min-w-[160px] text-center font-semibold text-slate-800 tabular-nums" data-testid="month-label">
        {monthLabel}
        {isCurrent && <span className="ml-1.5 text-[10px] font-bold uppercase tracking-wide text-emerald-600">· current</span>}
      </div>
      <button
        type="button"
        data-testid="month-next"
        onClick={onNext}
        className="iu-btn-secondary !h-9 !w-9 !p-0 justify-center"
        aria-label="Next month"
      ><ChevronRight size={16}/></button>
      {!isCurrent && (
        <button
          type="button"
          data-testid="month-today"
          onClick={onToday}
          className="iu-chip ml-1"
        >Today</button>
      )}
    </div>
  );
}

function SectionList({ title, items }) {
  return (
    <div className="iu-card">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
        <h3 className="font-extrabold tracking-tight">{title}</h3>
        <span className="text-xs text-slate-400">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="p-6 text-center text-sm text-slate-500">Nobody.</div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {items.map((l) => (
            <li key={l.id} className="px-5 py-3">
              <div className="font-semibold text-sm">{l.member_name}</div>
              <div className="text-xs text-slate-500">{shortDate(l.start_date)} – {shortDate(l.end_date)}{l.location ? ` · ${l.location}` : ""}</div>
              <div className="text-xs text-slate-600 mt-1 line-clamp-2">{l.reason}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
