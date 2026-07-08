import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom";
import { Loader2, FileDown, FileText, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { useSearchParams } from "react-router-dom";
import { api, downloadBlob } from "../../api";
import { todayIso, shortDate, categoryLabel } from "../../utils";
import MemberTimelineModal from "../../components/MemberTimelineModal";
import OTLedgerModal from "./OTLedgerModal";

function pad2(n) { return String(n).padStart(2, "0"); }
function isoDate(y, m0, d) { return `${y}-${pad2(m0 + 1)}-${pad2(d)}`; }

/** Return `{start, end, isCurrent, label}` for the calendar month
 * containing (year, monthIdx). If the month is the current one, `end`
 * clamps to today; otherwise it's the last of the month. */
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

const CATEGORY_FILTERS = [
  { key: "all",     label: "All" },
  { key: "athlete", label: "Athletes" },
  // "Rest" (renamed to "Staff & Coaches" 7 Jul 2026 on user request)
  // collapses staff/coach/executive into one bucket — matches the
  // way admins actually think about the two populations at YCH.
  { key: "rest",    label: "Staff & Coaches" },
  // "Escorts" surfaces members who accompanied a parent-escort in the
  // window (7 Jul 2026 user-requested). Filter is applied client-side
  // against the row's escort_days count.
  { key: "escorts", label: "Escorts" },
];

const SORT_OPTIONS = [
  { key: "alpha", label: "A → Z" },
  { key: "pct_desc", label: "Attendance %" },
];

const VALID_TABS = new Set(["attendance", "daily"]);

export default function Reports() {
  // Month-navigator state (30 Jun 2026): admins think in months, not
  // arbitrary date ranges. Two arrow buttons flip year/monthIdx; today
  // resets to the current month.
  const _now = new Date();
  const [year, setYear] = useState(_now.getFullYear());
  const [monthIdx, setMonthIdx] = useState(_now.getMonth());
  const win = useMemo(() => monthWindow(year, monthIdx), [year, monthIdx]);
  const { isCurrent, label: monthLabel } = win;
  const stepMonth = (delta) => {
    let m = monthIdx + delta, y = year;
    while (m < 0)  { m += 12; y -= 1; }
    while (m > 11) { m -= 12; y += 1; }
    setYear(y); setMonthIdx(m);
  };
  const jumpToday = () => { setYear(_now.getFullYear()); setMonthIdx(_now.getMonth()); };

  // Tab is URL-driven so /admin/reports?tab=daily works, and legacy
  // links (e.g. /admin/payroll → /admin/reports?tab=payroll) route to
  // the merged Attendance tab.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTab = searchParams.get("tab");
  // Legacy aliases: `payroll` and `hours` both fold into the merged
  // "attendance" tab (7 Jul 2026 — user-requested collapse of the two).
  const normaliseTab = (t) => (t === "payroll" || t === "hours") ? "attendance" : t;
  const initial = VALID_TABS.has(normaliseTab(urlTab)) ? normaliseTab(urlTab) : "attendance";
  const [tab, setTabState] = useState(initial);
  const setTab = (t) => {
    setTabState(t);
    const next = new URLSearchParams(searchParams);
    if (t === "attendance") next.delete("tab"); else next.set("tab", t);
    setSearchParams(next, { replace: true });
  };
  useEffect(() => {
    const n = normaliseTab(urlTab);
    if (VALID_TABS.has(n) && n !== tab) setTabState(n);
  }, [urlTab, tab]);

  const [loading, setLoading] = useState(false);
  const [day, setDay] = useState(todayIso());
  const [daily, setDaily] = useState(null);
  const [attendance, setAttendance] = useState(null);
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [fleetFilter, setFleetFilter] = useState("");
  const [institutionFilter, setInstitutionFilter] = useState("");
  const [compOffOnly, setCompOffOnly] = useState(false);
  const [sortBy, setSortBy] = useState("alpha");
  // Escort-only mode fetches a separate report (list of parent-escorts
  // and their present-days) instead of blending with the member table.
  const [escortReport, setEscortReport] = useState(null);
  // Double-click OT-ledger modal state.
  const [otLedger, setOtLedger] = useState(null); // { member_id, member_name } | null

  // Drill-down hover popover state (7 Jul 2026 — replaces native
  // `title` attrs which had 1-2s browser-delay and broke inside the
  // scroll container). One shared portal-rendered bubble that follows
  // the hovered cell; instant show/hide.
  const [tip, setTip] = useState(null); // { x, y, label, dates } | null
  const showTip = useCallback((e, label, dates) => {
    const arr = Array.isArray(dates) ? dates : [];
    if (arr.length === 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    setTip({
      x: r.left + r.width / 2,
      y: r.top,
      label,
      dates: arr,
    });
  }, []);
  const hideTip = useCallback(() => setTip(null), []);

  // Day-by-day timeline modal (7 Jul 2026 user-requested "why is X
  // absent again?"). Triggered by double-clicking the member name.
  // `timelineMember` holds the row that's currently drilled into;
  // `null` closes the modal.
  const [timelineMember, setTimelineMember] = useState(null);

  const monthIso = `${year}-${pad2(monthIdx + 1)}`;
  const loadAttendance = useCallback(async () => {
    setLoading(true);
    try { setAttendance(await api.get("/reports/payroll", { month: monthIso })); }
    catch (err) { toast.error(err?.message || "Failed"); }
    finally { setLoading(false); }
  }, [monthIso]);

  // Fetched lazily when the admin flips the Escorts filter chip.
  // Escort attendance lives in its own collection so we hit a separate
  // endpoint rather than trying to shoe-horn it into the member table.
  const loadEscortReport = useCallback(async () => {
    if (!win?.start || !win?.end) return;
    setLoading(true);
    try {
      const r = await api.get("/reports/escort-attendance", { start: win.start, end: win.end });
      setEscortReport(r);
    } catch (err) { toast.error(err?.message || "Failed"); }
    finally { setLoading(false); }
  }, [win]);
  useEffect(() => {
    if (tab === "attendance" && categoryFilter === "escorts") loadEscortReport();
  }, [tab, categoryFilter, loadEscortReport]);

  const loadDaily = useCallback(async () => {
    setLoading(true);
    try { setDaily(await api.get("/reports/daily", { on: day })); }
    catch (err) { toast.error(err?.message || "Failed"); }
    finally { setLoading(false); }
  }, [day]);

  useEffect(() => {
    if (tab === "attendance") loadAttendance();
    else if (tab === "daily") loadDaily();
  }, [tab, loadAttendance, loadDaily]);

  const exportAttendance = (fmt) => {
    if (!attendance) return;
    // Reuse the /hours/export endpoint (same underlying data) — pass
    // the month's start/end + the on-screen category/fleet filters so
    // the CSV/PDF matches what the admin sees.
    const params = { start: attendance.start, end: attendance.end, fmt };
    if (categoryFilter && categoryFilter !== "all") params.category = categoryFilter;
    if (fleetFilter) params.fleet = fleetFilter;
    return downloadBlob("/reports/hours/export", `attendance_${monthIso}.${fmt}`, params);
  };
  const exportDaily = (fmt) => downloadBlob("/reports/daily/export", `daily_${day}.${fmt}`, { on: day, fmt });

  const rows = useMemo(() => attendance?.rows || [], [attendance]);
  // Distinct institutions present in the current dataset — feeds the dropdown.
  const institutionOptions = useMemo(() => {
    const set = new Set();
    for (const r of rows) if (r.institution) set.add(r.institution);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [rows]);
  const displayedRows = useMemo(() => {
    let list = rows;
    if (categoryFilter === "athlete") {
      list = list.filter((r) => r.category === "athlete");
    } else if (categoryFilter === "rest") {
      list = list.filter((r) => r.category !== "athlete");
    } else if (categoryFilter === "escorts") {
      list = list.filter((r) => (r.escort_days || 0) > 0);
    }
    if (fleetFilter) {
      list = list.filter((r) =>
        fleetFilter === "__none__"
          ? !r.fleet
          : (r.fleet || "").toLowerCase() === fleetFilter.toLowerCase()
      );
    }
    if (institutionFilter) {
      list = list.filter((r) =>
        institutionFilter === "__none__"
          ? !r.institution
          : (r.institution || "") === institutionFilter
      );
    }
    if (compOffOnly) {
      // Any non-zero comp-off signal earns inclusion — earned, applied, or approved/used.
      list = list.filter((r) => (r.comp_off_earned || 0) > 0
                              || (r.comp_off_applied || 0) > 0
                              || (r.comp_off_used || 0) > 0);
    }
    const sorted = [...list];
    if (sortBy === "pct_desc") {
      sorted.sort((a, b) => (b.attendance_pct || 0) - (a.attendance_pct || 0)
        || (a.member_name || "").localeCompare(b.member_name || ""));
    } else {
      sorted.sort((a, b) => (a.member_name || "").localeCompare(b.member_name || ""));
    }
    return sorted;
  }, [rows, categoryFilter, fleetFilter, institutionFilter, compOffOnly, sortBy]);

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
        <p className="text-slate-500 text-sm mt-1">Monthly attendance, leave balances and daily leave/tour summaries.</p>
      </header>

      <div className="flex gap-2 mb-4">
        <button data-testid="tab-attendance" onClick={() => setTab("attendance")} className={`iu-chip ${tab === "attendance" ? "iu-chip-active" : ""}`}>Attendance</button>
        <button data-testid="tab-daily" onClick={() => setTab("daily")} className={`iu-chip ${tab === "daily" ? "iu-chip-active" : ""}`}>Daily Leave/Tour</button>
      </div>

      {tab === "attendance" && (
        <>
          <div className="iu-card p-4 mb-4 flex flex-wrap items-center gap-3" data-testid="attendance-controls">
            <MonthNav
              monthLabel={monthLabel}
              isCurrent={isCurrent}
              onPrev={() => stepMonth(-1)}
              onNext={() => stepMonth(1)}
              onToday={jumpToday}
            />
            {attendance && (
              <div className="text-[11px] text-slate-500 hidden md:block">
                {attendance.start.split("-").reverse().join("/")} → {attendance.end.split("-").reverse().join("/")}
                &nbsp;·&nbsp; {attendance.rows.length} member{attendance.rows.length === 1 ? "" : "s"}
              </div>
            )}
            <button data-testid="attendance-run" onClick={loadAttendance} disabled={loading} className="iu-btn-primary">
              {loading ? <Loader2 className="animate-spin" size={14}/> : <RefreshCw size={14}/>} Run
            </button>
            <div className="flex-1" />
            <button data-testid="export-attendance-csv" onClick={() => exportAttendance("csv")} className="iu-btn-secondary"><FileDown size={14}/> CSV</button>
            <button data-testid="export-attendance-pdf" onClick={() => exportAttendance("pdf")} className="iu-btn-secondary"><FileText size={14}/> PDF</button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div className="flex flex-wrap gap-2" data-testid="category-filters">
              {CATEGORY_FILTERS.map((f) => {
                const active = categoryFilter === f.key;
                const count = f.key === "all"
                  ? rows.length
                  : f.key === "athlete"
                    ? rows.filter((r) => r.category === "athlete").length
                    : f.key === "escorts"
                      ? rows.filter((r) => (r.escort_days || 0) > 0).length
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
              {/* Institution dropdown — mirrors the Fleet dropdown but stays
                  visible for every category, not just athletes. */}
              {institutionOptions.length > 0 && (
                <select
                  data-testid="institution-filter"
                  value={institutionFilter}
                  onChange={(e) => setInstitutionFilter(e.target.value)}
                  className="iu-input !w-44 !py-1 !h-8 text-xs"
                  title="Filter by institution"
                >
                  <option value="">All institutions</option>
                  <option value="__none__">(No institution)</option>
                  {institutionOptions.map((i) => (
                    <option key={i} value={i}>{i}</option>
                  ))}
                </select>
              )}
              {/* Comp-off-only toggle — surfaces staff who have any non-zero
                  comp-off signal (earned / applied / used) this month. */}
              <button
                data-testid="comp-off-only-toggle"
                onClick={() => setCompOffOnly((v) => !v)}
                className={`iu-chip ${compOffOnly ? "iu-chip-active" : ""}`}
                title="Show only rows where comp-off earned / applied / approved > 0"
              >
                Comp-off &gt; 0
              </button>
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
              {/* When the Escorts chip is active we render a completely
                  separate slim table sourced from /reports/escort-attendance
                  (parent-escorts, not the athletes they accompany). Keeps
                  the two data shapes cleanly separated. */}
              {categoryFilter === "escorts" ? (
                <table className="min-w-full text-xs iu-table-compact" data-testid="escort-report-table">
                  <thead className="sticky top-0 z-10 bg-slate-100 text-[10px] uppercase tracking-wider font-bold text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="py-1.5 px-2 text-left">Escort</th>
                      <th className="py-1.5 px-2 text-left">Institution</th>
                      <th className="py-1.5 px-2 text-left">Mobile</th>
                      <th className="py-1.5 px-2 text-right">Days present</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(escortReport?.rows || []).length === 0 && !loading ? (
                      <tr><td colSpan={4} className="py-6 text-center italic text-slate-500">No escort check-ins in this window.</td></tr>
                    ) : (escortReport?.rows || []).map((r) => (
                      <tr key={r.escort_id} data-testid={`escort-row-${r.escort_id}`}
                          className="border-t border-slate-100 hover:bg-slate-50/70">
                        <td className="py-1.5 px-2 font-semibold text-slate-800">{r.name}</td>
                        <td className="py-1.5 px-2 text-slate-600">{r.institution || "—"}</td>
                        <td className="py-1.5 px-2 font-mono text-slate-600">{r.mobile || "—"}</td>
                        <td className="py-1.5 px-2 text-right font-bold" title={(r.dates_present || []).join(", ")}>
                          {r.days_present}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
              <table className="min-w-full text-xs iu-table-compact" style={{ minWidth: 1300 }}>
                <thead>
                  {/* Grouped header row + sub-header row are BOTH sticky
                      (7 Jul 2026 user-requested). Row 1 pins to top-0,
                      row 2 to top-7 (~28 px = row-1 height with text-[10px]
                      + tight vertical padding). z-20 on both so they
                      overlay the first data row on the initial paint. */}
                  <tr className="sticky top-0 z-30 bg-slate-100 text-[10px] uppercase tracking-wider font-bold text-slate-500 border-b border-slate-200 shadow-sm">
                    <th className="py-1.5 px-2 text-left sticky left-0 z-40 bg-slate-100" colSpan={2}>&nbsp;</th>
                    <th className="py-1.5 px-2 text-center bg-emerald-50 border-l border-r border-emerald-200 text-emerald-800" colSpan={8}>Attendance</th>
                    <th className="py-1.5 px-2 text-center bg-amber-50 border-r border-amber-200 text-amber-800" colSpan={3}>Leave</th>
                    <th className="py-1.5 px-2 text-center bg-sky-50 border-r border-sky-200 text-sky-800" colSpan={3}>Comp-Off</th>
                    <th className="py-1.5 px-2 text-center bg-violet-50 border-r border-violet-200 text-violet-800" colSpan={3}>Overtime</th>
                    <th className="py-1.5 px-2 text-center bg-indigo-50 border-r border-indigo-200 text-indigo-800" colSpan={2}>Hours</th>
                    <th className="py-1.5 px-2 text-center bg-teal-50 border-r border-teal-200 text-teal-800" colSpan={2}>Escorts</th>
                  </tr>
                  <tr className="sticky top-7 z-30 bg-slate-50 shadow-sm text-[10px] uppercase tracking-wider font-bold text-slate-500">
                    <th className="py-1.5 px-2 text-left sticky left-0 z-40 bg-slate-50">Member</th>
                    <th className="py-1.5 px-2 text-left hidden md:table-cell sticky left-[140px] z-40 bg-slate-50">Cat</th>
                    <th className="py-1.5 px-1.5 text-center bg-emerald-50/70 border-l border-emerald-100">Pres</th>
                    <th className="py-1.5 px-1.5 text-center bg-emerald-50/70">Lv</th>
                    <th className="py-1.5 px-1.5 text-center bg-emerald-50/70">Tour</th>
                    <th className="py-1.5 px-1.5 text-center bg-emerald-50/70">Off</th>
                    <th className="py-1.5 px-1.5 text-center bg-emerald-50/70">Late</th>
                    <th className="py-1.5 px-1.5 text-center bg-emerald-50/70">Half</th>
                    <th className="py-1.5 px-1.5 text-center bg-emerald-50/70">Abs</th>
                    <th className="py-1.5 px-1.5 text-center bg-emerald-50/70 border-r border-emerald-100 font-extrabold">Tot</th>
                    <th className="py-1.5 px-1.5 text-center bg-amber-50/70">Open</th>
                    <th className="py-1.5 px-1.5 text-center bg-amber-50/70">Avld</th>
                    <th className="py-1.5 px-1.5 text-center bg-amber-50/70 border-r border-amber-100 font-extrabold">Close</th>
                    <th className="py-1.5 px-1.5 text-center bg-sky-50/70">Srvd</th>
                    <th className="py-1.5 px-1.5 text-center bg-sky-50/70">Appl</th>
                    <th className="py-1.5 px-1.5 text-center bg-sky-50/70 border-r border-sky-100 font-extrabold">Apprv</th>
                    <th className="py-1.5 px-1.5 text-center bg-violet-50/70">Srvd</th>
                    <th className="py-1.5 px-1.5 text-center bg-violet-50/70">Appl</th>
                    <th className="py-1.5 px-1.5 text-center bg-violet-50/70 border-r border-violet-100 font-extrabold">Apprv</th>
                    <th className="py-1.5 px-1.5 text-center bg-indigo-50/70">Tot h</th>
                    <th className="py-1.5 px-1.5 text-center bg-indigo-50/70 border-r border-indigo-100">Avg h</th>
                    <th className="py-1.5 px-1.5 text-center bg-teal-50/70">Dut</th>
                    <th className="py-1.5 px-1.5 text-center bg-teal-50/70 border-r border-teal-100">Ovr</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedRows.map((r, rowIdx) => {
                    // Zebra striping (7 Jul 2026 user request "make
                    // reports easy read"). Odd rows keep the white
                    // background, even rows carry a subtle slate tint;
                    // the group column tints (/30 alpha) layer on top
                    // so the visual grouping is preserved.
                    const isEven = rowIdx % 2 === 1;
                    // Higher-contrast zebra (7 Jul 2026 — user asked
                    // for stronger banding). slate-200/80 reads
                    // clearly against white without overpowering the
                    // per-group column tints.
                    const rowBg = isEven ? "bg-slate-200/80" : "bg-white";
                    // 7 Jul 2026 (evening): Total now includes Off so
                    // weekly-off + in-progress-today land in the sum.
                    const attnTotal = (r.days_present || 0) + (r.days_leave || 0) + (r.days_tour || 0) + (r.days_off || 0);
                    const otServed = r.overtime_hours_served || 0;
                    const otApplied = r.overtime_hours_pending || 0;
                    const otApproved = r.overtime_hours_approved || 0;
                    const n = (v) => (v ? v : "");
                    const h = (v) => (v ? `${(+v).toFixed(2).replace(/\.?0+$/, "")}h` : "");
                    // Drill-down hover props for a cell — attaches
                    // mouse-enter / mouse-leave handlers only when
                    // there's actually a date list to show. Empty
                    // categories stay plain (no cursor-help, no
                    // popover) so admins don't chase phantom hovers.
                    const hoverProps = (label, dates) => {
                      const arr = Array.isArray(dates) ? dates : [];
                      if (arr.length === 0) return {};
                      return {
                        onMouseEnter: (e) => showTip(e, label, arr),
                        onMouseLeave: hideTip,
                        className: "cursor-help",
                      };
                    };
                    // Merge the base cell className with the optional
                    // `cursor-help` from `hoverProps`.
                    const merge = (base, extra) => {
                      if (!extra || !extra.className) return { className: base, ...(extra || {}) };
                      const { className, ...rest } = extra;
                      return { className: `${base} ${className}`, ...rest };
                    };
                    return (
                      <tr key={r.member_id} className={`${rowBg} hover:bg-sky-50 group transition-colors`} data-testid={`attn-row-${r.member_id}`}>
                        {/* Member + Category are pinned to the left with
                            `position: sticky` so admins keep the row
                            anchor visible when horizontal-scrolling
                            across the 23 columns. Sticky cells inherit
                            the row's zebra tint so the pinned half
                            stays visually aligned with the scrolling
                            half. Double-clicking the name opens the
                            day-by-day timeline modal (7 Jul 2026). */}
                        <td
                          className={`py-1.5 px-2 font-semibold text-slate-800 border-t border-slate-100 sticky left-0 z-10 ${rowBg} group-hover:bg-sky-50 cursor-pointer`}
                          onDoubleClick={() => setTimelineMember(r)}
                          title="Double-click for day-by-day timeline"
                          data-testid={`attn-name-${r.member_id}`}
                        >
                          {r.member_name}
                          <div className="text-[10px] text-slate-400 leading-tight">
                            {r.rank || ""}
                            {r.attendance_pct !== undefined && (
                              <span className={`font-bold text-slate-800 ${r.rank ? "ml-1.5" : ""}`}>{r.attendance_pct}%</span>
                            )}
                          </div>
                        </td>
                        <td className={`py-1.5 px-2 hidden md:table-cell text-slate-600 border-t border-slate-100 sticky left-[140px] z-10 ${rowBg} group-hover:bg-sky-50`}>{categoryLabel(r.category)}</td>
                        {/* Attendance group */}
                        <td {...merge("py-1.5 px-1.5 text-center bg-emerald-50/30 border-l border-t border-emerald-100 font-semibold text-emerald-700", hoverProps("Present", r.dates_present))} data-testid={`days-present-${r.member_id}`}>{n(r.days_present)}</td>
                        <td {...merge("py-1.5 px-1.5 text-center bg-emerald-50/30 border-t border-emerald-100 text-amber-700", hoverProps("Leave", r.dates_leave))} data-testid={`days-leave-${r.member_id}`}>{n(r.days_leave)}</td>
                        <td {...merge("py-1.5 px-1.5 text-center bg-emerald-50/30 border-t border-emerald-100 text-orange-700", hoverProps("Tour", r.dates_tour))} data-testid={`days-tour-${r.member_id}`}>{n(r.days_tour)}</td>
                        <td {...merge("py-1.5 px-1.5 text-center bg-emerald-50/30 border-t border-emerald-100 text-slate-500", hoverProps("Off", r.dates_off))} data-testid={`days-off-${r.member_id}`}>{n(r.days_off)}</td>
                        <td {...merge("py-1.5 px-1.5 text-center bg-emerald-50/30 border-t border-emerald-100 text-amber-600", hoverProps("Late", r.dates_late))} data-testid={`late-days-${r.member_id}`}>{n(r.late_days)}</td>
                        <td {...merge("py-1.5 px-1.5 text-center bg-emerald-50/30 border-t border-emerald-100", hoverProps("Half-day", r.dates_half_day))} data-testid={`half-days-${r.member_id}`}>{n(r.half_days)}</td>
                        <td {...merge(`py-1.5 px-1.5 text-center bg-emerald-50/30 border-t border-emerald-100 font-semibold ${(r.days_absent || 0) > 0 ? "text-red-600" : "text-slate-400"}`, hoverProps("Absent", r.dates_absent))} data-testid={`days-absent-${r.member_id}`}>{n(r.days_absent)}</td>
                        <td className="py-1.5 px-1.5 text-center bg-emerald-50/30 border-r border-t border-emerald-100 font-extrabold text-slate-900" data-testid={`days-total-${r.member_id}`}>{n(attnTotal)}</td>
                        {/* Leave group */}
                        <td className="py-1.5 px-1.5 text-center bg-amber-50/30 border-t border-amber-100">{n(r.leave_balance_opening)}</td>
                        <td className="py-1.5 px-1.5 text-center bg-amber-50/30 border-t border-amber-100">{n(r.leave_balance_taken_ytd)}</td>
                        <td className={`py-1.5 px-1.5 text-center bg-amber-50/30 border-r border-t border-amber-100 font-extrabold ${(r.leave_balance_remaining || 0) < 0 ? "text-red-600" : "text-emerald-700"}`}>{n(r.leave_balance_remaining)}</td>
                        {/* Comp-Off group */}
                        <td {...merge("py-1.5 px-1.5 text-center bg-sky-50/30 border-t border-sky-100 cursor-pointer hover:bg-sky-100/50", hoverProps("Comp-off earned · double-click for OT ledger", r.dates_comp_off_earned))} data-testid={`comp-off-earned-${r.member_id}`} onDoubleClick={() => setOtLedger({ member_id: r.member_id, member_name: r.member_name })}>{n(r.comp_off_earned)}</td>
                        <td {...merge("py-1.5 px-1.5 text-center bg-sky-50/30 border-t border-sky-100 text-amber-700 cursor-pointer hover:bg-sky-100/50", hoverProps("Comp-off applied · double-click for OT ledger", r.dates_comp_off_applied))} data-testid={`comp-off-applied-${r.member_id}`} onDoubleClick={() => setOtLedger({ member_id: r.member_id, member_name: r.member_name })}>{n(r.comp_off_applied)}</td>
                        <td {...merge("py-1.5 px-1.5 text-center bg-sky-50/30 border-r border-t border-sky-100 font-extrabold text-emerald-700 cursor-pointer hover:bg-sky-100/50", hoverProps("Comp-off approved · double-click for OT ledger", r.dates_comp_off_used))} data-testid={`comp-off-approved-${r.member_id}`} onDoubleClick={() => setOtLedger({ member_id: r.member_id, member_name: r.member_name })}>{n(r.comp_off_used)}</td>
                        {/* Overtime group */}
                        <td {...merge("py-1.5 px-1.5 text-center bg-violet-50/30 border-t border-violet-100", hoverProps("OT served", r.dates_overtime_served))}>{h(otServed)}</td>
                        <td {...merge("py-1.5 px-1.5 text-center bg-violet-50/30 border-t border-violet-100 text-amber-700", hoverProps("OT applied", r.dates_overtime_applied))}>{h(otApplied)}</td>
                        <td {...merge("py-1.5 px-1.5 text-center bg-violet-50/30 border-r border-t border-violet-100 font-extrabold text-emerald-700", hoverProps("OT approved", r.dates_overtime_approved))}>{h(otApproved)}</td>
                        {/* Hours group */}
                        <td className="py-1.5 px-1.5 text-center bg-indigo-50/30 border-t border-indigo-100">{r.total_hours ? `${r.total_hours}h` : ""}</td>
                        <td className="py-1.5 px-1.5 text-center bg-indigo-50/30 border-r border-t border-indigo-100 text-slate-600">{r.avg_hours_per_day ? `${r.avg_hours_per_day}h` : ""}</td>
                        {/* Escorts group */}
                        <td {...merge("py-1.5 px-1.5 text-center bg-teal-50/30 border-t border-teal-100 text-teal-700 font-semibold", hoverProps("Escort days", r.dates_escort))} data-testid={`escort-days-${r.member_id}`}>{n(r.escort_days)}</td>
                        <td className={`py-1.5 px-1.5 text-center bg-teal-50/30 border-r border-t border-teal-100 ${(r.overstays || 0) > 0 ? "text-red-600 font-semibold" : ""}`} data-testid={`overstays-${r.member_id}`}>{n(r.overstays)}</td>
                      </tr>
                    );
                  })}
                  {!loading && displayedRows.length === 0 && (
                    <tr><td colSpan={23} className="text-center py-10 text-slate-500">No data.</td></tr>
                  )}
                </tbody>
              </table>
              )}
            </div>
          </div>
        </>
      )}

      {/* OT-ledger drill-down — opens on double-click of any comp-off cell. */}
      <OTLedgerModal
        open={!!otLedger}
        onClose={() => setOtLedger(null)}
        memberId={otLedger?.member_id}
        memberName={otLedger?.member_name}
        year={year}
      />

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

      {tip && ReactDOM.createPortal(
        <DrillDownBubble tip={tip} />,
        document.body
      )}

      {timelineMember && attendance && (
        <MemberTimelineModal
          memberId={timelineMember.member_id}
          start={attendance.start}
          end={attendance.end}
          onClose={() => setTimelineMember(null)}
        />
      )}
    </div>
  );
}

/** Portal-rendered hover bubble that lists the exact dates behind a
 * count cell. Positioned above the hovered cell (centred), auto-flips
 * below when the cell is near the top edge of the viewport. */
function DrillDownBubble({ tip }) {
  const { x, y, label, dates } = tip;
  const flipBelow = y < 140; // not enough room above
  const style = {
    position: "fixed",
    left: `${x}px`,
    top: `${y + (flipBelow ? 24 : -8)}px`,
    transform: flipBelow
      ? "translate(-50%, 0)"
      : "translate(-50%, -100%)",
    zIndex: 100,
    pointerEvents: "none",
    maxWidth: "240px",
  };
  const pretty = (dates || []).map((d) => {
    try {
      const dt = new Date(d + "T00:00:00");
      return dt.toLocaleDateString(undefined,
        { day: "2-digit", month: "short", weekday: "short" });
    } catch { return d; }
  });
  return (
    <div style={style} data-testid="drilldown-tooltip">
      <div className="rounded-lg bg-slate-900 text-white text-[11px] px-3 py-2 shadow-xl ring-1 ring-slate-700">
        <div className="font-bold uppercase tracking-wide text-[10px] text-slate-300 mb-1">
          {label} · {dates.length}
        </div>
        <ul className="leading-tight space-y-0.5">
          {pretty.map((p, i) => <li key={dates[i]} className="tabular-nums">{p}</li>)}
        </ul>
      </div>
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
