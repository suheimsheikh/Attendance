import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom";
import { Loader2, FileDown, FileText, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { useSearchParams } from "react-router-dom";
import { api, downloadBlob } from "../../api";
import { useAuth } from "../../auth";
import { todayIso, shortDate, categoryLabel } from "../../utils";
import MemberTimelineModal from "../../components/MemberTimelineModal";
import OTLedgerModal from "./OTLedgerModal";
import AttendanceLedgerModal from "./AttendanceLedgerModal";
import CompOffLedgerModal from "./CompOffLedgerModal";
import LeaveLedgerModal from "./LeaveLedgerModal";
import CompositeLedgerTab from "./CompositeLedgerTab";

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
  // Elite is athlete-like but coaches asked for a dedicated pill to
  // drill into just the Elite cohort (~18-strong at YCH) without
  // exporting. Filter matches `r.category === "elite"` literally so it
  // stays deterministic even if new athlete-like categories get added.
  { key: "elite",   label: "Elite" },
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

const VALID_TABS = new Set(["attendance", "composite", "daily"]);

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
  // Super-admin gating — the Hours group (Total Hours + Avg Hours) is
  // privacy-sensitive and only the top-of-org account should see it.
  // Flag is stamped on /auth/me from an env whitelist of phone numbers
  // (SUPER_ADMIN_PHONES). 04 Feb 2026 user request.
  const { user: currentUser } = useAuth();
  const showHours = !!currentUser?.is_super_admin;
  const [daily, setDaily] = useState(null);
  const [attendance, setAttendance] = useState(null);
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [fleetFilter, setFleetFilter] = useState("");
  const [institutionFilter, setInstitutionFilter] = useState("");
  // OT-only filter — replaces the previous Comp-off filter (8 Jul 2026
  // user-requested). Surfaces rows with any non-zero OT signal
  // (served / applied / approved) this month.
  const [otOnly, setOtOnly] = useState(false);
  const [sortBy, setSortBy] = useState("alpha");
  // YTD comp-off available per member — fetched once from /leave-balances
  // and merged into the on-screen Leave columns (Open · COff · Total ·
  // Avld · Close). Athletes are absent from this endpoint by design
  // (Breaks workflow), so their COff falls through to 0.
  const [compOffMap, setCompOffMap] = useState({});
  useEffect(() => {
    api.get("/leave-balances").then((r) => {
      const map = {};
      for (const row of (r?.rows || [])) map[row.id] = row.comp_off_available || 0;
      setCompOffMap(map);
    }).catch(() => { /* non-fatal — COff column falls back to 0 */ });
  }, []);
  // Athlete-like category keys — driven by categories master so Elite
  // (and any future admin-added athlete-like category) is bucketed with
  // Athletes, not Staff & Coaches. Fixes 15 Jul 2026 user report
  // "In the staff and coaches filter a lot of athletes appear".
  const [athleteLikeKeys, setAthleteLikeKeys] = useState(() => new Set(["athlete", "elite"]));
  useEffect(() => {
    api.get("/masters/categories").then((cats) => {
      const rows = Array.isArray(cats) ? cats : (cats?.items || []);
      const keys = rows.filter((c) => c.is_athlete_like).map((c) => c.key);
      if (keys.length) setAthleteLikeKeys(new Set(keys));
    }).catch(() => { /* fall back to defaults */ });
  }, []);
  const isAthleteLike = useCallback((r) => athleteLikeKeys.has(r?.category), [athleteLikeKeys]);
  // Escort-only mode fetches a separate report (list of parent-escorts
  // and their present-days) instead of blending with the member table.
  const [escortReport, setEscortReport] = useState(null);
  // Double-click OT-ledger modal state.
  const [otLedger, setOtLedger] = useState(null); // { member_id, member_name } | null
  // Double-click Comp-off ledger modal state (8 Jul 2026 user request:
  // "A double click on the comp off col for anybody should create a
  // window with all the comp off dates and DOW").
  const [coLedger, setCoLedger] = useState(null); // { member_id, member_name } | null
  // Double-click Leave ledger modal state (8 Jul 2026 user request:
  // "Double click on the leave cols should show all the leave date like
  // diff rows chronologically of Leave applied, Leave availed Leave
  // rejected and totals thereof").
  const [lvLedger, setLvLedger] = useState(null); // { member_id, member_name } | null
  // Double-click Attendance ledger modal state (04 Feb 2026 user request:
  // "Double click on the attendance columns should show a table with
  // the months data of the said member date wise clearly indicating
  // tour and leave and absent etc").
  const [attnLedger, setAttnLedger] = useState(null); // { member_id, member_name } | null

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
    // Reuse the /hours/export endpoint — pass every on-screen filter so
    // the CSV/PDF matches exactly what the admin sees (including
    // Institution + Elite, which used to be client-only). The backend
    // applies the same filter logic before rendering the table.
    const params = { start: attendance.start, end: attendance.end, fmt };
    if (categoryFilter && categoryFilter !== "all") params.category = categoryFilter;
    if (fleetFilter) params.fleet = fleetFilter;
    if (institutionFilter) params.institution = institutionFilter;
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
      list = list.filter((r) => isAthleteLike(r));
    } else if (categoryFilter === "elite") {
      list = list.filter((r) => r.category === "elite");
    } else if (categoryFilter === "rest") {
      list = list.filter((r) => !isAthleteLike(r));
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
    if (otOnly) {
      // OT filter — any non-zero OT signal (served / applied / approved)
      // this month. Replaces the Comp-off toggle (8 Jul 2026).
      list = list.filter((r) => (r.overtime_hours_served || 0) > 0
                              || (r.overtime_hours_pending || 0) > 0
                              || (r.overtime_hours_approved || 0) > 0);
    }
    const sorted = [...list];
    if (sortBy === "pct_desc") {
      sorted.sort((a, b) => (b.attendance_pct || 0) - (a.attendance_pct || 0)
        || (a.member_name || "").localeCompare(b.member_name || ""));
    } else {
      sorted.sort((a, b) => (a.member_name || "").localeCompare(b.member_name || ""));
    }
    return sorted;
  }, [rows, categoryFilter, fleetFilter, institutionFilter, otOnly, sortBy, isAthleteLike]);

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
        <button data-testid="tab-composite" onClick={() => setTab("composite")} className={`iu-chip ${tab === "composite" ? "iu-chip-active" : ""}`}>Composite Ledger</button>
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
                    ? rows.filter((r) => isAthleteLike(r)).length
                    : f.key === "elite"
                      ? rows.filter((r) => r.category === "elite").length
                      : f.key === "escorts"
                        ? rows.filter((r) => (r.escort_days || 0) > 0).length
                        : rows.filter((r) => !isAthleteLike(r)).length;
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
              {/* OT-only toggle — surfaces rows with any non-zero OT
                  signal (served / applied / approved) this month.
                  Replaces the previous Comp-off toggle (8 Jul 2026 user
                  request "The filter comp off > 0 should be replaced
                  with OT > 0"). */}
              <button
                data-testid="ot-only-toggle"
                onClick={() => setOtOnly((v) => !v)}
                className={`iu-chip ${otOnly ? "iu-chip-active" : ""}`}
                title="Show only rows where OT served / applied / approved > 0"
              >
                OT &gt; 0
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
              <table className="min-w-full text-xs iu-table-compact" style={{ minWidth: 1100 }}>
                <thead>
                  {/* Grouped header row + sub-header row are BOTH sticky
                      (7 Jul 2026 user-requested). Row 1 pins to top-0,
                      row 2 to top-7 (~28 px = row-1 height with text-[10px]
                      + tight vertical padding). z-20 on both so they
                      overlay the first data row on the initial paint. */}
                  <tr className="sticky top-0 z-30 bg-slate-100 text-[10px] uppercase tracking-wider font-bold text-slate-500 border-b border-slate-200 shadow-sm">
                    <th className="py-1.5 px-2 text-left sticky left-0 z-40 bg-slate-100" colSpan={2}>&nbsp;</th>
                    <th className="py-1.5 px-2 text-center bg-emerald-50 border-l border-r border-emerald-200 text-emerald-800" colSpan={8}>Attendance</th>
                    <th className="py-1.5 px-2 text-center bg-amber-50 border-r border-amber-200 text-amber-800" colSpan={5}>Leave</th>
                    <th className="py-1.5 px-2 text-center bg-violet-50 border-r border-violet-200 text-violet-800" colSpan={1}>Overtime</th>
                    <th className="py-1.5 px-2 text-center bg-sky-50 border-r border-sky-200 text-sky-800" colSpan={1}>Comp-Off</th>
                    {showHours && (
                      <th className="py-1.5 px-2 text-center bg-indigo-50 border-r border-indigo-200 text-indigo-800" colSpan={2}>Hours</th>
                    )}
                  </tr>
                  <tr className="sticky top-7 z-30 bg-slate-50 shadow-sm text-[10px] uppercase tracking-wider font-bold text-slate-500">
                    <th className="py-1.5 px-2 text-left sticky left-0 z-40 bg-slate-50">Member</th>
                    <th className="py-1.5 px-2 text-left hidden md:table-cell sticky left-[140px] z-40 bg-slate-50">Cat</th>
                    <th className="py-1.5 px-1.5 text-center bg-emerald-200/50 border-l border-emerald-100">Pres</th>
                    <th className="py-1.5 px-1.5 text-center bg-emerald-200/50">Lv</th>
                    <th className="py-1.5 px-1.5 text-center bg-emerald-200/50">Tour</th>
                    <th className="py-1.5 px-1.5 text-center bg-emerald-200/50">Off</th>
                    <th className="py-1.5 px-1.5 text-center bg-emerald-200/50">Late</th>
                    <th className="py-1.5 px-1.5 text-center bg-emerald-200/50">Half</th>
                    <th className="py-1.5 px-1.5 text-center bg-emerald-200/50">Abs</th>
                    <th className="py-1.5 px-1.5 text-center bg-emerald-200/50 border-r border-emerald-100 font-extrabold">Tot</th>
                    <th className="py-1.5 px-1.5 text-center bg-amber-200/50" title="Opening annual leave balance for the year">Open</th>
                    <th className="py-1.5 px-1.5 text-center bg-amber-200/50" title="Comp-off available YTD (accrued − used). Adds to the leave pool.">COff</th>
                    <th className="py-1.5 px-1.5 text-center bg-amber-200/50" title="Total = Open + COff (all leave credit available this year)">Total</th>
                    <th className="py-1.5 px-1.5 text-center bg-amber-200/50" title="Availed = leave taken YTD">Avld</th>
                    <th className="py-1.5 px-1.5 text-center bg-amber-200/50 border-r border-amber-100 font-extrabold" title="Closing = Total − Avld">Close</th>
                    <th className="py-1.5 px-1.5 text-center bg-violet-200/50 border-r border-violet-100 font-extrabold">OT</th>
                    <th className="py-1.5 px-1.5 text-center bg-sky-200/50 border-r border-sky-100 font-extrabold">CO</th>
                    {showHours && (
                      <>
                        <th className="py-1.5 px-1.5 text-center bg-indigo-200/50">Tot h</th>
                        <th className="py-1.5 px-1.5 text-center bg-indigo-200/50 border-r border-indigo-100">Avg h</th>
                      </>
                    )}
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
                        {/* Attendance group — double-clicking ANY of these 8
                            cells opens the date-wise Attendance Ledger for
                            this member across the current reporting range
                            (04 Feb 2026 user request). */}
                        {(() => {
                          const openAttn = () => setAttnLedger({ member_id: r.member_id, member_name: r.member_name });
                          const attnCell = "cursor-pointer hover:bg-emerald-200/70";
                          return (
                            <>
                        <td {...merge(`py-1.5 px-1.5 text-center bg-emerald-200/50 border-l border-t border-emerald-100 font-semibold text-emerald-700 ${attnCell}`, hoverProps("Present · double-click for daily ledger", r.dates_present))} data-testid={`days-present-${r.member_id}`} onDoubleClick={openAttn}>{n(r.days_present)}</td>
                        <td {...merge(`py-1.5 px-1.5 text-center bg-emerald-200/50 border-t border-emerald-100 text-amber-700 ${attnCell}`, hoverProps("Leave · double-click for daily ledger", r.dates_leave))} data-testid={`days-leave-${r.member_id}`} onDoubleClick={openAttn}>{n(r.days_leave)}</td>
                        <td {...merge(`py-1.5 px-1.5 text-center bg-emerald-200/50 border-t border-emerald-100 text-orange-700 ${attnCell}`, hoverProps("Tour · double-click for daily ledger", r.dates_tour))} data-testid={`days-tour-${r.member_id}`} onDoubleClick={openAttn}>{n(r.days_tour)}</td>
                        <td {...merge(`py-1.5 px-1.5 text-center bg-emerald-200/50 border-t border-emerald-100 text-slate-500 ${attnCell}`, hoverProps("Off · double-click for daily ledger", r.dates_off))} data-testid={`days-off-${r.member_id}`} onDoubleClick={openAttn}>{n(r.days_off)}</td>
                        <td {...merge(`py-1.5 px-1.5 text-center bg-emerald-200/50 border-t border-emerald-100 text-amber-600 ${attnCell}`, hoverProps("Late · double-click for daily ledger", r.dates_late))} data-testid={`late-days-${r.member_id}`} onDoubleClick={openAttn}>{n(r.late_days)}</td>
                        <td {...merge(`py-1.5 px-1.5 text-center bg-emerald-200/50 border-t border-emerald-100 ${attnCell}`, hoverProps("Half-day · double-click for daily ledger", r.dates_half_day))} data-testid={`half-days-${r.member_id}`} onDoubleClick={openAttn}>{n(r.half_days)}</td>
                        <td {...merge(`py-1.5 px-1.5 text-center bg-emerald-200/50 border-t border-emerald-100 font-semibold ${(r.days_absent || 0) > 0 ? "text-red-600" : "text-slate-400"} ${attnCell}`, hoverProps("Absent · double-click for daily ledger", r.dates_absent))} data-testid={`days-absent-${r.member_id}`} onDoubleClick={openAttn}>{n(r.days_absent)}</td>
                        <td className={`py-1.5 px-1.5 text-center bg-emerald-200/50 border-r border-t border-emerald-100 font-extrabold text-slate-900 ${attnCell}`} data-testid={`days-total-${r.member_id}`} onDoubleClick={openAttn} title="Double-click for daily ledger">{n(attnTotal)}</td>
                            </>
                          );
                        })()}
                        {/* Leave group — 5 columns (8 Jul 2026 user
                            request: Open · COff · Total · Avld · Close).
                            COff is comp-off available YTD, pulled from
                            /leave-balances and merged client-side; it
                            adds to the leave pool. Athletes fall through
                            to 0 for all fields (Breaks workflow).
                            Double-clicking Open / Total / Avld / Close
                            opens the year-wide Leave ledger (applied /
                            availed / rejected). COff opens the comp-off
                            ledger instead — it's conceptually a
                            different pool. */}
                        {(() => {
                          const open = r.leave_balance_opening || 0;
                          const coff = compOffMap[r.member_id] || 0;
                          const total = open + coff;
                          const avld = r.leave_balance_taken_ytd || 0;
                          const close = Math.round((total - avld) * 10) / 10;
                          const hasBalance = open > 0 || coff > 0 || avld > 0;
                          const fmt = (v) => (hasBalance ? String(v) : "");
                          const openLv = () => setLvLedger({ member_id: r.member_id, member_name: r.member_name });
                          const openCo = () => setCoLedger({ member_id: r.member_id, member_name: r.member_name });
                          const lvCell = "py-1.5 px-1.5 text-center bg-amber-200/50 border-t border-amber-100 cursor-pointer hover:bg-amber-200/50";
                          return (
                            <>
                              <td className={lvCell} data-testid={`leave-open-${r.member_id}`} onDoubleClick={openLv} title="Double-click for leave ledger">{fmt(open)}</td>
                              <td className={`${lvCell} text-sky-700`} data-testid={`leave-coff-${r.member_id}`} onDoubleClick={openCo} title="Double-click for comp-off ledger">{coff > 0 ? String(coff) : ""}</td>
                              <td className={`${lvCell} font-semibold`} data-testid={`leave-total-${r.member_id}`} onDoubleClick={openLv} title="Double-click for leave ledger">{fmt(total)}</td>
                              <td className={lvCell} data-testid={`leave-avld-${r.member_id}`} onDoubleClick={openLv} title="Double-click for leave ledger">{fmt(avld)}</td>
                              <td className={`py-1.5 px-1.5 text-center bg-amber-200/50 border-r border-t border-amber-100 font-extrabold cursor-pointer hover:bg-amber-200/50 ${close < 0 ? "text-red-600" : "text-emerald-700"}`} data-testid={`leave-close-${r.member_id}`} onDoubleClick={openLv} title="Double-click for leave ledger">{fmt(close)}</td>
                            </>
                          );
                        })()}
                        {/* Comp-Off group */}
                        {/* Overtime group — comes BEFORE Comp-off (07 Jul
                            2026 user request "shift OT one left"). Double-
                            clicking any OT cell opens the year's OT ledger
                            for this member. */}
                        {/* Overtime — single column showing the system-calculated
                            OT (= served/earned). Applied + Approved columns
                            removed 04 Feb 2026 per user request; the OT
                            Ledger (double-click) still shows the full
                            applied/approved breakdown per session. */}
                        <td {...merge("py-1.5 px-1.5 text-center bg-violet-200/50 border-r border-t border-violet-100 font-extrabold cursor-pointer hover:bg-violet-200/50", hoverProps("OT earned by the system · double-click for OT ledger", r.dates_overtime_served))} data-testid={`ot-served-${r.member_id}`} onDoubleClick={() => setOtLedger({ member_id: r.member_id, member_name: r.member_name })}>{h(otServed)}</td>
                        {/* Comp-off group — double-clicking any cell
                            opens the year's comp-off ledger (Earned /
                            Applied / Approved with DOW). Hover tooltip
                            still shows the month's dates inline. */}
                        {/* Comp-off — single column showing earned (system-
                            calculated). Applied + Approved removed 04 Feb
                            2026; the ledger drill-down still carries the
                            full applied/approved detail. */}
                        <td {...merge("py-1.5 px-1.5 text-center bg-sky-200/50 border-r border-t border-sky-100 font-extrabold cursor-pointer hover:bg-sky-200/50", hoverProps("Comp-off earned · double-click for ledger", r.dates_comp_off_earned))} data-testid={`comp-off-earned-${r.member_id}`} onDoubleClick={() => setCoLedger({ member_id: r.member_id, member_name: r.member_name })}>{n(r.comp_off_earned)}</td>
                        {/* Hours group */}
                        {/* Hours group — super-admin only. Hidden from
                            regular admins per 04 Feb 2026 privacy request. */}
                        {showHours && (
                          <>
                            <td className="py-1.5 px-1.5 text-center bg-indigo-200/50 border-t border-indigo-100">{r.total_hours ? `${r.total_hours}h` : ""}</td>
                            <td className="py-1.5 px-1.5 text-center bg-indigo-200/50 border-r border-t border-indigo-100 text-slate-600">{r.avg_hours_per_day ? `${r.avg_hours_per_day}h` : ""}</td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                  {!loading && displayedRows.length === 0 && (
                    <tr><td colSpan={showHours ? 19 : 17} className="text-center py-10 text-slate-500">No data.</td></tr>
                  )}
                </tbody>
              </table>
              )}
            </div>
          </div>
        </>
      )}

      {/* OT-ledger drill-down — opens on double-click of any OT cell. */}
      <OTLedgerModal
        open={!!otLedger}
        onClose={() => setOtLedger(null)}
        memberId={otLedger?.member_id}
        memberName={otLedger?.member_name}
        year={year}
      />

      {/* Comp-off ledger drill-down — opens on double-click of any
          Comp-off cell (Earned / Applied / Approved). */}
      <CompOffLedgerModal
        open={!!coLedger}
        onClose={() => setCoLedger(null)}
        memberId={coLedger?.member_id}
        memberName={coLedger?.member_name}
        year={year}
      />

      {/* Leave ledger drill-down — opens on double-click of any Leave
          section cell (Open / Total / Avld / Close). */}
      <LeaveLedgerModal
        open={!!lvLedger}
        onClose={() => setLvLedger(null)}
        memberId={lvLedger?.member_id}
        memberName={lvLedger?.member_name}
        year={year}
      />

      {/* Attendance ledger drill-down — opens on double-click of any
          Attendance cell (Pres / Lv / Tour / Off / Late / Half / Abs /
          Tot). Scoped to the current report's start-end window. */}
      <AttendanceLedgerModal
        open={!!attnLedger}
        onClose={() => setAttnLedger(null)}
        memberId={attnLedger?.member_id}
        memberName={attnLedger?.member_name}
        start={attendance?.start}
        end={attendance?.end}
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

      {tab === "composite" && (
        <CompositeLedgerTab
          monthIso={monthIso}
          monthLabel={monthLabel}
          isCurrent={isCurrent}
          onPrevMonth={() => stepMonth(-1)}
          onNextMonth={() => stepMonth(1)}
          onJumpToday={jumpToday}
          MonthNav={MonthNav}
          athleteLikeKeys={athleteLikeKeys}
        />
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
