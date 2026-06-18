import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Check, X, AlertTriangle } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../../api";
import Avatar from "../../components/Avatar";

const STATUS_FILTERS = [
  { key: "pending",  label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "all",      label: "All" },
];

function fmtHrs(min) {
  if (!min) return "0:00";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}
function fmtDay(iso) {
  if (!iso) return "—";
  try { return new Date(iso + "T00:00:00").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }); }
  catch { return iso; }
}
function fmtTime(iso) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  catch { return iso; }
}

export default function Overtime() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState(params.get("status") || "pending");
  const [from, setFrom] = useState(params.get("from") || "");
  const [to, setTo] = useState(params.get("to") || "");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState({});
  const [busyId, setBusyId] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const q = { status };
      if (from) q.date_from = from;
      if (to) q.date_to = to;
      const r = await api.get("/admin/overtime", q);
      setRows(r.rows || []);
      if (!from && !to && r.date_from) {
        setFrom(r.date_from);
        setTo(r.date_to);
      }
    } finally { setLoading(false); }
  };
  useEffect(() => { load();   }, [status, from, to]);

  useEffect(() => {
    const next = {};
    if (status) next.status = status;
    if (from) next.from = from;
    if (to) next.to = to;
    setParams(next, { replace: true });
  }, [status, from, to, setParams]);

  const decide = async (row, decision) => {
    setBusyId(row.session_id);
    try {
      await api.post(`/admin/overtime/${row.session_id}/decide`, { status: decision, admin_note: notes[row.session_id] || "" });
      toast.success(`${decision === "approved" ? "Approved" : "Rejected"} ${row.member_name}`);
      load();
    } catch (err) { toast.error(err?.message || "Failed"); }
    finally { setBusyId(null); }
  };

  const totals = useMemo(() => {
    const t = { count: rows.length, minutes: 0 };
    for (const r of rows) t.minutes += r.total_min || 0;
    return t;
  }, [rows]);

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto">
      <header className="mb-5">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Overtime Approvals</h1>
        <p className="text-slate-500 text-sm mt-1">Review staff sessions with 30+ min of overtime. Approved hours flow into Reports.</p>
      </header>

      <div className="iu-card p-4 mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="iu-label">From</label>
          <input data-testid="ot-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="iu-input !w-44" />
        </div>
        <div>
          <label className="iu-label">To</label>
          <input data-testid="ot-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="iu-input !w-44" />
        </div>
        <div className="flex-1 flex flex-wrap gap-2 justify-end">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              data-testid={`ot-filter-${f.key}`}
              onClick={() => setStatus(f.key)}
              className={`iu-chip ${status === f.key ? "iu-chip-active" : ""}`}
            >{f.label}</button>
          ))}
        </div>
      </div>

      {!loading && (
        <div className="text-xs text-slate-500 mb-3" data-testid="ot-summary">
          {totals.count} session{totals.count === 1 ? "" : "s"} · {fmtHrs(totals.minutes)} total
        </div>
      )}

      {loading ? (
        <div className="text-center py-10"><Loader2 className="mx-auto animate-spin text-slate-400" /></div>
      ) : rows.length === 0 ? (
        <div className="iu-card p-10 text-center" data-testid="ot-empty">
          <p className="font-semibold text-slate-700">No overtime in this range</p>
          <p className="text-sm text-slate-500 mt-1">Try expanding the date range or change the filter.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.session_id} className="iu-card p-4 flex flex-wrap items-start gap-4" data-testid={`ot-row-${r.session_id}`}>
              <Avatar name={r.member_name} photo={r.photo} size={44} />
              <div className="flex-1 min-w-[220px]">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="font-semibold">{r.member_name}</div>
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-bold uppercase tracking-wide">
                    <AlertTriangle size={9} /> {fmtHrs(r.total_min)} OT
                  </span>
                  {r.status !== "pending" && (
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${r.status === "approved" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                      {r.status}
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-500 mt-0.5">{r.rank ? `${r.rank} · ` : ""}{r.category}</div>
                <div className="text-xs text-slate-700 mt-1">
                  {fmtDay(r.date)} · in {fmtTime(r.check_in_at)} (work_start {r.work_start || "—"}) · out {fmtTime(r.check_out_at)} (work_end {r.work_end || "—"})
                </div>
                {(r.early_min > 0 || r.late_min > 0) && (
                  <div className="text-xs text-slate-600 mt-1">
                    {r.early_min > 0 && <>Early: <strong>{fmtHrs(r.early_min)}</strong></>}
                    {r.early_min > 0 && r.late_min > 0 && " · "}
                    {r.late_min > 0 && <>Late: <strong>{fmtHrs(r.late_min)}</strong></>}
                  </div>
                )}
                {r.reason && (
                  <div className="text-sm text-slate-800 bg-slate-50 rounded-md px-2 py-1.5 mt-2 border border-slate-200">
                    <span className="text-[10px] font-bold text-slate-500 uppercase">Member&apos;s reason</span><br />
                    {r.reason}
                  </div>
                )}
                {r.status === "pending" ? (
                  <div className="mt-3">
                    <label className="iu-label">Admin note (optional)</label>
                    <input
                      data-testid={`ot-note-${r.session_id}`}
                      value={notes[r.session_id] || ""}
                      onChange={(e) => setNotes((n) => ({ ...n, [r.session_id]: e.target.value }))}
                      placeholder="e.g. Approved per duty roster…"
                      className="iu-input"
                    />
                  </div>
                ) : r.admin_note && (
                  <div className="text-[11px] text-slate-500 mt-2">
                    Note: <span className="text-slate-700">{r.admin_note}</span>
                    {r.decided_by && <> · by <strong>{r.decided_by}</strong></>}
                  </div>
                )}
              </div>
              {r.status === "pending" && (
                <div className="flex gap-2">
                  <button
                    data-testid={`ot-approve-${r.session_id}`}
                    disabled={busyId === r.session_id}
                    onClick={() => decide(r, "approved")}
                    className="iu-btn-primary !h-9 !px-3"
                  >
                    {busyId === r.session_id ? <Loader2 className="animate-spin" size={14} /> : <><Check size={14} /> Approve</>}
                  </button>
                  <button
                    data-testid={`ot-reject-${r.session_id}`}
                    disabled={busyId === r.session_id}
                    onClick={() => decide(r, "rejected")}
                    className="iu-btn-secondary !h-9 !px-3 text-red-600"
                  >
                    <X size={14} /> Reject
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
