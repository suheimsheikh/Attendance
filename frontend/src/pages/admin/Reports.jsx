import React, { useEffect, useState } from "react";
import { Loader2, FileDown, FileText, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api, downloadBlob } from "../../api";
import { todayIso, shortDate, categoryLabel } from "../../utils";

function nDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export default function Reports() {
  const [start, setStart] = useState(nDaysAgo(7));
  const [end, setEnd] = useState(todayIso());
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState("hours"); // hours | daily
  const [day, setDay] = useState(todayIso());
  const [daily, setDaily] = useState(null);

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

  useEffect(() => { if (tab === "hours") loadHours(); else loadDaily(); /* eslint-disable-next-line */ }, [tab]);

  const exportHours = (fmt) => downloadBlob("/reports/hours/export", `hours_${start}_${end}.${fmt}`, { start, end, fmt });
  const exportDaily = (fmt) => downloadBlob("/reports/daily/export", `daily_${day}.${fmt}`, { on: day, fmt });

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

          <div className="iu-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="iu-table-th">Member</th>
                    <th className="iu-table-th hidden md:table-cell">Category</th>
                    <th className="iu-table-th">Hours</th>
                    <th className="iu-table-th">Days</th>
                    <th className="iu-table-th hidden md:table-cell">Late days</th>
                    <th className="iu-table-th">Attendance</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.member_id} className="hover:bg-slate-50" data-testid={`hours-row-${r.member_id}`}>
                      <td className="iu-table-td font-semibold">{r.member_name}<div className="text-xs text-slate-400">{r.rank || ""}</div></td>
                      <td className="iu-table-td hidden md:table-cell">{categoryLabel(r.category)}</td>
                      <td className="iu-table-td font-bold">{r.total_hours}h</td>
                      <td className="iu-table-td">{r.days_present}/{r.span_days}</td>
                      <td className="iu-table-td hidden md:table-cell">{r.late_days}</td>
                      <td className="iu-table-td">{r.attendance_pct}%</td>
                    </tr>
                  ))}
                  {rows.length === 0 && !loading && <tr><td colSpan={6} className="text-center py-10 text-slate-500">No data for this range.</td></tr>}
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
