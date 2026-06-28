import React, { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, FileDown, FileText, Calendar } from "lucide-react";
import { toast } from "sonner";
import { api, downloadBlob } from "../../api";
import { categoryLabel } from "../../utils";

function isoMonth(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function thisMonthIso() { return isoMonth(new Date()); }
function lastMonthIso() {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
  return isoMonth(d);
}

export default function Payroll() {
  // Default to THIS month so admins opening the page during a live
  // payroll cycle see the running totals, not an empty "last month"
  // that hasn't seen any attendance yet. A "Last month" chip remains
  // for the formal 1st-of-month run.
  const [month, setMonth] = useState(thisMonthIso());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await api.get("/reports/payroll", { month })); }
    catch (err) { toast.error(err?.message || "Failed"); }
    finally { setLoading(false); }
  }, [month]);
  useEffect(() => { load(); }, [load]);

  const exportFmt = (fmt) => {
    if (!data) return;
    downloadBlob("/reports/hours/export", `payroll_${month}.${fmt}`,
                 { start: data.start, end: data.end, fmt });
  };

  const totalRows = data?.rows?.length || 0;
  const nonZero = (data?.rows || []).filter((r) =>
    r.days_present > 0 || r.days_leave > 0 || r.days_tour > 0 || r.total_hours > 0
  ).length;

  return (
    <div className="p-4 md:p-8 max-w-[1500px] mx-auto">
      <header className="mb-5">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Monthly Payroll Report</h1>
        <p className="text-slate-500 text-sm mt-1">Hours, OT, leaves &amp; balances for the chosen month. Shows running totals when &ldquo;This month&rdquo; is picked mid-cycle.</p>
      </header>

      <div className="iu-card p-4 mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="iu-label">Month</label>
          <input data-testid="pr-month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="iu-input !w-48" />
        </div>
        <div className="flex items-end gap-1.5">
          <button
            type="button"
            onClick={() => setMonth(thisMonthIso())}
            className={`iu-btn ${month === thisMonthIso() ? "iu-btn-primary" : "iu-btn-secondary"} !h-9 !px-2.5 !text-xs`}
            data-testid="pr-month-current"
            title="Use current month"
          ><Calendar size={12}/> This month</button>
          <button
            type="button"
            onClick={() => setMonth(lastMonthIso())}
            className={`iu-btn ${month === lastMonthIso() ? "iu-btn-primary" : "iu-btn-secondary"} !h-9 !px-2.5 !text-xs`}
            data-testid="pr-month-prev"
          >Last month</button>
        </div>
        <button data-testid="pr-run" onClick={load} disabled={loading} className="iu-btn-primary">
          {loading ? <Loader2 className="animate-spin" size={14}/> : <RefreshCw size={14}/>} Run
        </button>
        {/* Empty-data hint — common when "Last month" is selected before
            attendance has accumulated. Helps admins self-diagnose. */}
        {!loading && data && totalRows > 0 && nonZero === 0 && (
          <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 max-w-md" data-testid="pr-empty-hint">
            All {totalRows} rows are zero. Either no one was on campus this month, or the month hasn&apos;t accumulated data yet — pick a different month.
          </div>
        )}
        <div className="flex-1" />
        <button data-testid="pr-csv" onClick={() => exportFmt("csv")} className="iu-btn-secondary"><FileDown size={14}/> CSV</button>
        <button data-testid="pr-pdf" onClick={() => exportFmt("pdf")} className="iu-btn-secondary"><FileText size={14}/> PDF</button>
      </div>

      {data && (
        <p className="text-xs text-slate-500 mb-3">Period: <strong>{data.start} → {data.end}</strong> · {data.rows.length} members</p>
      )}

      {loading ? (
        <div className="text-center py-10"><Loader2 className="mx-auto animate-spin text-slate-400" /></div>
      ) : (
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
                {data?.rows?.map((r) => (
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
                )) || null}
                {(data?.rows || []).length === 0 && (
                  <tr><td colSpan={10} className="text-center py-10 text-slate-500">No data.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
