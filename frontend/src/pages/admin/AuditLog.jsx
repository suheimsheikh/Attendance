/**
 * AuditLog — admin-only "who changed what, when" viewer.
 *
 * Displays the tail of the `audit_log` collection, most-recent first,
 * with filters for actor, entity, action, and date range. Each row
 * shows the diff (`changes`) inline so an admin can answer parent /
 * staff questions like "who bumped ARUNA's opening leave balance from
 * 12 to 24 on July 3?" without going anywhere near the database.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, ScanLine } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";

const ACTION_LABELS = {
  "member.update":            { label: "Member edit",           color: "bg-slate-100 text-slate-700" },
  "member.password_reset":    { label: "Password reset",        color: "bg-rose-100 text-rose-700" },
  "leave_balance.set":        { label: "Leave balance set",     color: "bg-amber-100 text-amber-800" },
  "attendance.check_in":      { label: "Attendance override — check-in",  color: "bg-emerald-100 text-emerald-800" },
  "attendance.check_out":     { label: "Attendance override — check-out", color: "bg-emerald-100 text-emerald-800" },
  "attendance.toggle":        { label: "Attendance override",   color: "bg-emerald-100 text-emerald-800" },
};

function ActionBadge({ action }) {
  const cfg = ACTION_LABELS[action] || { label: action, color: "bg-slate-100 text-slate-600" };
  return (
    <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

/** Render a compact diff snippet: "leave_balance_opening: 12 → 24". */
function ChangeList({ changes }) {
  if (!changes) return <span className="text-slate-300">—</span>;
  const entries = Object.entries(changes);
  if (entries.length === 0) return <span className="text-slate-300">—</span>;
  return (
    <ul className="space-y-0.5">
      {entries.map(([k, v]) => (
        <li key={k} className="font-mono text-[11px]">
          <span className="text-slate-500">{k}: </span>
          <span className="text-slate-400 line-through">
            {v.before === null || v.before === undefined ? "∅" : String(v.before)}
          </span>
          <span className="mx-1 text-slate-400">→</span>
          <span className="text-slate-800 font-semibold">
            {v.after === null || v.after === undefined ? "∅" : String(v.after)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function fmtWhen(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

export default function AuditLog() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [actor, setActor] = useState("");
  const [entity, setEntity] = useState("");
  const [action, setAction] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (actor) params.actor_id = actor;
      if (entity) params.entity_id = entity;
      if (action) params.action = action;
      if (since) params.since = since;
      if (until) params.until = until;
      const r = await api.get("/admin/audit-log", params);
      setRows(r.rows || []);
    } catch (err) {
      toast.error(err?.message || "Load failed");
    } finally {
      setLoading(false);
    }
  }, [actor, entity, action, since, until]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="p-4 md:p-8">
      <div className="mb-6 flex items-center gap-2">
        <ScanLine size={20} className="text-slate-500" />
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Audit Log</h1>
      </div>

      <div className="iu-card p-4 mb-4 grid grid-cols-2 md:grid-cols-6 gap-3">
        <div className="col-span-2">
          <label className="iu-label">Action</label>
          <select
            data-testid="audit-filter-action"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="iu-input"
          >
            <option value="">Any action</option>
            {Object.entries(ACTION_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="iu-label">Actor ID</label>
          <input
            data-testid="audit-filter-actor"
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            placeholder="paste admin id"
            className="iu-input"
          />
        </div>
        <div>
          <label className="iu-label">Entity ID</label>
          <input
            data-testid="audit-filter-entity"
            value={entity}
            onChange={(e) => setEntity(e.target.value)}
            placeholder="paste member id"
            className="iu-input"
          />
        </div>
        <div>
          <label className="iu-label">Since</label>
          <input
            data-testid="audit-filter-since"
            type="date"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            className="iu-input"
          />
        </div>
        <div>
          <label className="iu-label">Until</label>
          <input
            data-testid="audit-filter-until"
            type="date"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
            className="iu-input"
          />
        </div>
        <div className="col-span-2 md:col-span-6 flex gap-2">
          <button
            data-testid="audit-refresh"
            onClick={load}
            disabled={loading}
            className="iu-btn-primary"
          >
            {loading ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}
            Refresh
          </button>
          <span className="text-xs text-slate-500 self-center">
            {rows.length} row{rows.length === 1 ? "" : "s"} • max 200 per query
          </span>
        </div>
      </div>

      <div className="iu-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs" data-testid="audit-table">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr className="text-[10px] uppercase tracking-wider font-bold text-slate-500">
                <th className="py-2 px-3 text-left">When</th>
                <th className="py-2 px-3 text-left">Actor</th>
                <th className="py-2 px-3 text-left">Action</th>
                <th className="py-2 px-3 text-left">Entity</th>
                <th className="py-2 px-3 text-left">Changes</th>
                <th className="py-2 px-3 text-left">Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50 align-top">
                  <td className="py-2 px-3 whitespace-nowrap font-mono text-[11px] text-slate-600">
                    {fmtWhen(r.at)}
                  </td>
                  <td className="py-2 px-3 font-semibold text-slate-800">
                    {r.actor_name || "—"}
                  </td>
                  <td className="py-2 px-3">
                    <ActionBadge action={r.action} />
                  </td>
                  <td className="py-2 px-3 text-slate-700">
                    {r.entity_name || <span className="text-slate-400 font-mono text-[10px]">{r.entity_id}</span>}
                    <div className="text-[10px] text-slate-400">{r.entity_type}</div>
                  </td>
                  <td className="py-2 px-3">
                    <ChangeList changes={r.changes} />
                  </td>
                  <td className="py-2 px-3 text-slate-600 max-w-xs">
                    {r.reason || <span className="text-slate-300">—</span>}
                  </td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-16 text-center text-slate-400">
                    No entries match the current filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
