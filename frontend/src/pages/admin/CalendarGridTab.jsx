import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, FileDown, FileText, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api, downloadBlob } from "../../api";
import { categoryLabel } from "../../utils";
import CorrectionRequestModal from "../../components/CorrectionRequestModal";

/**
 * Calendar Grid tab — one row per member, one column per day of the
 * month. Each cell shows a 2-letter code (LV, AB, TR, HD, LT, WO, HO,
 * CO, PS) or a green pill for a present day. Future days render blank.
 */

const CATEGORY_FILTERS = [
  { key: "all",     label: "All" },
  { key: "athlete", label: "Athletes" },
  { key: "elite",   label: "Elite" },
  { key: "rest",    label: "Staff & Coaches" },
];

// Cell colour + label registry. Each entry maps a status code to
// tailwind bg + text classes and the display label (2-letter code).
const CELL_STYLE = {
  P:  { bg: "bg-emerald-500",    text: "text-white",       label: "P",  title: "Present" },
  HD: { bg: "bg-amber-100",      text: "text-amber-700",   label: "HD", title: "Half day" },
  LT: { bg: "bg-emerald-500/70", text: "text-amber-100",   label: "LT", title: "Late" },
  LV: { bg: "bg-amber-200",      text: "text-amber-800",   label: "LV", title: "Leave" },
  TR: { bg: "bg-orange-200",     text: "text-orange-800",  label: "TR", title: "Tour" },
  PS: { bg: "bg-slate-200",      text: "text-slate-700",   label: "PS", title: "Posting" },
  CO: { bg: "bg-sky-200",        text: "text-sky-800",     label: "CO", title: "Comp-off" },
  WO: { bg: "bg-slate-100",      text: "text-slate-500",   label: "WO", title: "Weekly off" },
  HO: { bg: "bg-violet-100",     text: "text-violet-700",  label: "HO", title: "Holiday" },
  AB: { bg: "bg-red-500",        text: "text-white",       label: "AB", title: "Absent" },
};

function GridCell({ code, dow, onClick }) {
  if (!code) {
    // Future date — render an empty slot but keep it clickable-looking
    // in the same width so the grid stays aligned.
    return <td className="border border-slate-100 text-center text-slate-300 tabular-nums h-6 w-7">·</td>;
  }
  const s = CELL_STYLE[code] || CELL_STYLE.AB;
  const clickable = !!onClick;
  return (
    <td
      className={`border border-white text-center text-[10px] font-bold ${s.bg} ${s.text} h-6 w-7 leading-none ${clickable ? "cursor-pointer hover:ring-2 hover:ring-sky-500 hover:ring-offset-1 transition" : ""}`}
      title={`${s.title}${dow ? " · " + dow : ""}${clickable ? " · click to file correction" : ""}`}
      onClick={onClick}
    >
      {s.label}
    </td>
  );
}

// Given a cell code, pick the best default correction kind + entityType
// so the modal opens straight to the right form section. Cells that
// don't map to a useful correction (WO / HO) return null so we don't
// wire an onClick handler.
function correctionForCode(code) {
  switch (code) {
    case "AB":               return { entityType: "attendance", initialKind: "missed_checkin" };
    case "LT":
    case "P":
    case "HD":               return { entityType: "attendance", initialKind: "time_adjust" };
    case "LV":
    case "TR":
    case "CO":
    case "PS":               return { entityType: "leave", initialKind: "leave_cancel" };
    default:                 return null;   // WO, HO — nothing sensible to correct
  }
}

export default function CalendarGridTab({ monthIso, monthLabel, isCurrent, onPrevMonth, onNextMonth, onJumpToday, MonthNav, athleteLikeKeys }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [fleetFilter, setFleetFilter] = useState("");
  const [institutionFilter, setInstitutionFilter] = useState("");
  // Correction modal state — clicking any cell with a useful code
  // (AB/LT/P/HD/LV/TR/CO/PS) opens the shared CorrectionRequestModal
  // pre-filled with the member and date the admin clicked.
  const [correction, setCorrection] = useState(null); // { member, date, entityType, initialKind } | null

  const isAthleteLike = useCallback(
    (r) => athleteLikeKeys.has(r?.category),
    [athleteLikeKeys]
  );

  const loadReport = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get("/reports/calendar-grid", { month: monthIso });
      setData(r);
    } catch (err) {
      toast.error(err?.message || "Failed to load calendar grid");
    } finally {
      setLoading(false);
    }
  }, [monthIso]);

  useEffect(() => { loadReport(); }, [loadReport]);

  const rows = useMemo(() => data?.rows || [], [data]);
  const days = useMemo(() => data?.days || [], [data]);
  const todayIso = data?.today;

  // Per-day weekday label ("Mo", "Tu"…) for the sub-header row.
  const dayHeaders = useMemo(() => days.map((iso) => {
    const dt = new Date(iso + "T00:00:00");
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dt.getDay()];
    return { day: iso.slice(8, 10), dow, iso, isWeekend: dt.getDay() === 0 || dt.getDay() === 6, isToday: iso === todayIso };
  }), [days, todayIso]);

  const displayedRows = useMemo(() => {
    let list = rows;
    if (categoryFilter === "athlete") list = list.filter(isAthleteLike);
    else if (categoryFilter === "elite") list = list.filter((r) => r.category === "elite");
    else if (categoryFilter === "rest") list = list.filter((r) => !isAthleteLike(r));
    if (fleetFilter) {
      list = list.filter((r) =>
        fleetFilter === "__none__" ? !r.fleet : (r.fleet || "").toLowerCase() === fleetFilter.toLowerCase()
      );
    }
    if (institutionFilter) {
      list = list.filter((r) =>
        institutionFilter === "__none__" ? !r.institution : (r.institution || "") === institutionFilter
      );
    }
    return [...list].sort((a, b) => (a.member_name || "").localeCompare(b.member_name || ""));
  }, [rows, categoryFilter, fleetFilter, institutionFilter, isAthleteLike]);

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

  const institutionOptions = useMemo(() => {
    const set = new Set();
    for (const r of rows) if (r.institution) set.add(r.institution);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const exportGrid = (fmt) => {
    const params = { month: monthIso, fmt };
    if (categoryFilter && categoryFilter !== "all") params.category = categoryFilter;
    if (fleetFilter) params.fleet = fleetFilter;
    if (institutionFilter) params.institution = institutionFilter;
    return downloadBlob(
      "/reports/calendar-grid/export",
      `calendar_grid_${monthIso}.${fmt}`,
      params
    );
  };

  return (
    <>
      <div className="iu-card p-4 mb-4 flex flex-wrap items-center gap-3" data-testid="calendar-grid-controls">
        <MonthNav
          monthLabel={monthLabel}
          isCurrent={isCurrent}
          onPrev={onPrevMonth}
          onNext={onNextMonth}
          onToday={onJumpToday}
        />
        {data && (
          <div className="text-[11px] text-slate-500 hidden md:block">
            {data.start.split("-").reverse().join("/")} → {data.end.split("-").reverse().join("/")}
            &nbsp;·&nbsp; {displayedRows.length} of {rows.length} member{rows.length === 1 ? "" : "s"}
          </div>
        )}
        <button data-testid="calendar-grid-run" onClick={loadReport} disabled={loading} className="iu-btn-primary">
          {loading ? <Loader2 className="animate-spin" size={14}/> : <RefreshCw size={14}/>} Run
        </button>
        <div className="flex-1" />
        <button data-testid="export-calendar-csv" onClick={() => exportGrid("csv")} className="iu-btn-secondary"><FileDown size={14}/> CSV</button>
        <button data-testid="export-calendar-pdf" onClick={() => exportGrid("pdf")} className="iu-btn-secondary"><FileText size={14}/> PDF</button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex flex-wrap gap-2" data-testid="calendar-category-filters">
          {CATEGORY_FILTERS.map((f) => {
            const active = categoryFilter === f.key;
            const count = f.key === "all"
              ? rows.length
              : f.key === "athlete"
                ? rows.filter(isAthleteLike).length
                : f.key === "elite"
                  ? rows.filter((r) => r.category === "elite").length
                  : rows.filter((r) => !isAthleteLike(r)).length;
            return (
              <button
                key={f.key}
                data-testid={`calendar-cat-filter-${f.key}`}
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
              data-testid="calendar-fleet-filter"
              value={fleetFilter}
              onChange={(e) => setFleetFilter(e.target.value)}
              className="iu-input !w-40 !py-1 !h-8 text-xs"
            >
              <option value="">All fleets</option>
              {fleetOptions.map((f) => (
                <option key={f} value={f}>{f === "__none__" ? "(No fleet)" : f}</option>
              ))}
            </select>
          )}
          {institutionOptions.length > 0 && (
            <select
              data-testid="calendar-institution-filter"
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
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-2 mb-3 text-[11px]" data-testid="calendar-legend">
        {Object.entries(CELL_STYLE).map(([code, s]) => (
          <span key={code} className="inline-flex items-center gap-1.5">
            <span className={`inline-flex items-center justify-center w-6 h-5 rounded ${s.bg} ${s.text} font-bold text-[10px]`}>{s.label}</span>
            <span className="text-slate-600">{s.title}</span>
          </span>
        ))}
      </div>

      <div className="iu-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="text-xs border-collapse" data-testid="calendar-grid-table">
            <thead className="sticky top-0 z-20 bg-slate-50">
              <tr>
                <th className="py-1.5 px-2 text-left sticky left-0 z-30 bg-slate-50 min-w-[180px] border-b border-slate-200 font-semibold text-slate-700">Member</th>
                <th className="py-1.5 px-2 text-left bg-slate-50 min-w-[100px] hidden md:table-cell border-b border-slate-200 font-semibold text-slate-700">Category</th>
                {dayHeaders.map((h) => (
                  <th
                    key={h.iso}
                    className={`text-center h-6 w-7 border-b border-r border-slate-200 tabular-nums font-bold ${h.isWeekend ? "bg-slate-100 text-slate-400" : "bg-slate-50 text-slate-700"} ${h.isToday ? "!bg-sky-100 !text-sky-800" : ""}`}
                    title={`${h.dow} · ${h.iso}`}
                    data-testid={`cal-header-${h.iso}`}
                  >
                    {h.day}
                  </th>
                ))}
              </tr>
              <tr>
                <th className="py-0.5 px-2 sticky left-0 z-30 bg-slate-50 text-[9px] uppercase tracking-wider text-slate-400 border-b border-slate-200">Name / Rank</th>
                <th className="py-0.5 px-2 bg-slate-50 hidden md:table-cell border-b border-slate-200"></th>
                {dayHeaders.map((h) => (
                  <th
                    key={h.iso + "-dow"}
                    className={`text-center h-4 border-b border-r border-slate-200 text-[9px] uppercase font-semibold ${h.isWeekend ? "bg-slate-100 text-slate-400" : "bg-slate-50 text-slate-500"}`}
                  >
                    {h.dow.slice(0, 2)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={2 + days.length} className="py-8 text-center text-slate-400">Loading…</td></tr>
              )}
              {!loading && displayedRows.length === 0 && (
                <tr><td colSpan={2 + days.length} className="py-8 text-center text-slate-400" data-testid="calendar-empty">No members match the current filters.</td></tr>
              )}
              {!loading && displayedRows.map((r, i) => {
                const rowBg = i % 2 === 1 ? "bg-slate-100/40" : "bg-white";
                return (
                  <tr key={r.member_id} className={`${rowBg} hover:bg-sky-50 group transition-colors`} data-testid={`calendar-row-${r.member_id}`}>
                    <td className={`py-1 px-2 font-semibold text-slate-800 sticky left-0 z-10 ${rowBg} group-hover:bg-sky-50 border-b border-slate-100`}>
                      {r.member_name}
                      {r.rank && <div className="text-[10px] text-slate-400 leading-tight">{r.rank}</div>}
                    </td>
                    <td className="py-1 px-2 text-slate-600 hidden md:table-cell border-b border-slate-100">{categoryLabel(r.category)}</td>
                    {r.cells.map((code, idx) => {
                      const cfg = correctionForCode(code);
                      const iso = days[idx];
                      // Only wire onClick for past-or-today cells that
                      // map to a useful correction. Future dates
                      // (empty code) already skip in GridCell; WO/HO
                      // return null cfg.
                      const onClick = cfg
                        ? () => setCorrection({
                            member: { id: r.member_id, full_name: r.member_name },
                            date: iso,
                            entityType: cfg.entityType,
                            initialKind: cfg.initialKind,
                          })
                        : undefined;
                      return (
                        <GridCell
                          key={iso}
                          code={code}
                          dow={dayHeaders[idx]?.dow}
                          onClick={onClick}
                        />
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {correction && (
        <CorrectionRequestModal
          open
          onClose={() => setCorrection(null)}
          onSaved={() => {
            toast.success("Correction filed — pending admin approval");
            setCorrection(null);
            loadReport();
          }}
          entityType={correction.entityType}
          initialKind={correction.initialKind}
          targetDate={correction.date}
          onBehalfOfMember={correction.member}
          entityLabel={`${correction.member.full_name} · ${correction.date}`}
        />
      )}
    </>
  );
}
