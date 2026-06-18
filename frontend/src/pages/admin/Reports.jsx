import React, { useEffect, useMemo, useState } from "react";
import { Loader2, FileDown, FileText, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api, downloadBlob } from "../../api";
import ParentContact from "../../components/ParentContact";
import { todayIso, shortDate, categoryLabel } from "../../utils";

function nDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

const CATEGORY_FILTERS = [
  { key: "all", label: "All" },
  { key: "athlete", label: "Athletes" },
  { key: "staff", label: "Staff" },
  { key: "coach", label: "Coaches" },
];

const SORT_OPTIONS = [
  { key: "alpha", label: "A → Z" },
  { key: "pct_desc", label: "Attendance %" },
];

export default function Reports() {
  const [start, setStart] = useState(nDaysAgo(7));
  const [end, setEnd] = useState(todayIso());
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState("hours"); // hours | daily
  const [day, setDay] = useState(todayIso());
  const [daily, setDaily] = useState(null);
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [sortBy, setSortBy] = useState("alpha");

  const loadHours = async () => {
    setLoading(true);
    try {
      const res = await api.get("/reports/hours", { start, end });
      setRows(res.rows || []);
    } catch (err) { toast.error(err?.message || "Failed"); }
    finally { setLoading(false); }
  };

  const loadDaily = async () => {
    setLoading(true);
    try { setDaily(await api.get("/reports/daily", { on: day })); }
    catch (err) { toast.error(err?.message || "Failed"); }
    finally { setLoading(false); }
  };

  useEffect(() => { if (tab === "hours") loadHours(); else loadDaily();   }, [tab]);

  const exportHours = (fmt) => downloadBlob("/reports/hours/export", `hours_${start}_${end}.${fmt}`, { start, end, fmt });
  const exportDaily = (fmt) => downloadBlob("/reports/daily/export", `daily_${day}.${fmt}`, { on: day, fmt });

  const displayedRows = useMemo(() => {
    let list = rows;
    if (categoryFilter !== "all") {
      list = list.filter((r) => r.category === categoryFilter);
    }
    const sorted = [...list];
    if (sortBy === "pct_desc") {
      sorted.sort((a, b) => (b.attendance_pct || 0) - (a.attendance_pct || 0)
        || (a.member_name || "").localeCompare(b.member_name || ""));
    } else {
      sorted.sort((a, b) => (a.member_name || "").localeCompare(b.member_name || ""));
    }
    return sorted;
  }, [rows, categoryFilter, sortBy]);

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Reports</h1>
        <p className="text-slate-500 text-sm mt-1">Attendance hours and daily leave/tour summaries.</p>
      </header>

      <div className="flex gap-2 mb-4">
        <button data-testid="tab-hours" onClick={() => setTab("hours")} className={`iu-chip ${tab === "hours" ? "iu-chip-active" : ""}`}>Hours & Attendance</button>
        <button data-testid="tab-daily" onClick={() => setTab("daily")} className={`iu-chip ${tab === "daily" ? "iu-chip-active" : ""}`}>Daily Leave/Tour</button>
      </div>

      {tab === "hours" ? (
        <>
          <div className="iu-card p-4 mb-4 flex flex-wrap items-end gap-3" data-testid="hours-controls">
            <div>
              <label className="iu-label">From</label>
              <input data-testid="rep-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} className="iu-input !w-44" />
            </div>
            <div>
              <label className="iu-label">To</label>
              <input data-testid="rep-end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="iu-input !w-44" />
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
                const count = f.key === "all" ? rows.length : rows.filter((r) => r.category === f.key).length;
                return (
                  <button
                    key={f.key}
                    data-testid={`cat-filter-${f.key}`}
                    onClick={() => setCategoryFilter(f.key)}
                    className={`iu-chip ${active ? "iu-chip-active" : ""}`}
                  >
                    {f.label}
                    <span className={`min-w-[22px] h-5 px-1.5 rounded-full text-[10px] flex items-center justify-center ${active ? "bg-white/20 text-white" : "bg-white border border-slate-200 text-slate-600"}`}>{count}</span>
                  </button>
                );
              })}
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
                    <th className="iu-table-th hidden md:table-cell">Weekly off</th>
                    <th className="iu-table-th">Total hrs</th>
                    <th className="iu-table-th">OT hrs</th>
                    <th className="iu-table-th">Days</th>
                    <th className="iu-table-th hidden md:table-cell">Late days</th>
                    <th className="iu-table-th">Leave days</th>
                    <th className="iu-table-th">Comp-Off (E/U/P)</th>
                    <th className="iu-table-th hidden lg:table-cell">Overstays</th>
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
                      <td className="iu-table-td hidden md:table-cell capitalize text-xs text-slate-600">{r.weekly_off || "monday"}</td>
                      <td className="iu-table-td">{r.total_hours}h</td>
                      <td className="iu-table-td">
                        <span className="font-semibold text-emerald-700">{r.overtime_hours_approved || 0}h</span>
                        {r.overtime_hours_pending > 0 && (
                          <span className="ml-1 text-amber-600 text-xs">(+{r.overtime_hours_pending}h pending)</span>
                        )}
                      </td>
                      <td className="iu-table-td">{r.days_present}/{r.span_days}</td>
                      <td className="iu-table-td hidden md:table-cell">{r.late_days}</td>
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
                      <td className={`iu-table-td hidden lg:table-cell font-semibold ${(r.overstays || 0) > 0 ? "text-red-600" : "text-slate-400"}`}>{r.overstays || 0}</td>
                    </tr>
                  ))}
                  {displayedRows.length === 0 && !loading && <tr><td colSpan={11} className="text-center py-10 text-slate-500">No data for this range.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : (
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
