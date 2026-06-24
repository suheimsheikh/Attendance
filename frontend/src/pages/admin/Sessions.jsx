import React, { useEffect, useState, useCallback } from "react";
import { Loader2, RefreshCw, Coffee, LogIn, LogOut as LogOutIcon, Clock, AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { api } from "../../api";
import Avatar from "../../components/Avatar";
import { categoryLabel, todayIso } from "../../utils";

function fmt(t) { return t || "—"; }

export default function Sessions() {
  const [day, setDay] = useState(todayIso());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await api.get("/admin/sessions", { on: day })); }
    finally { setLoading(false); }
  }, [day]);

  useEffect(() => { load(); }, [load]);

  const rows = data?.rows || [];
  const counts = data?.counts || {};

  const toggleRow = (id) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpanded(next);
  };

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      <header className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Daily Sessions</h1>
          <p className="text-slate-500 text-sm mt-1">
            One row per person. Click any row to see check-in → temp exits/returns → final check-out.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div>
            <label className="iu-label">Date</label>
            <input data-testid="sessions-date" type="date" value={day} onChange={(e) => setDay(e.target.value)} className="iu-input !w-44" />
          </div>
          <button data-testid="sessions-refresh" onClick={load} className="iu-btn-secondary">
            {loading ? <Loader2 className="animate-spin" size={14}/> : <RefreshCw size={14}/>}
          </button>
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
        <StatCard label="Members today" value={counts.members || 0} color="#111827" />
        <StatCard label="Still open" value={counts.open || 0} color="#10B981" />
        <StatCard label="Stepped out now" value={counts.on_temp_exit || 0} color="#06B6D4" />
        <StatCard label="Auto-closed" value={counts.auto_closed || 0} color="#F59E0B" />
        <StatCard label="Temp excursions" value={counts.total_excursions || 0} color="#F97316" />
      </div>

      <div className="iu-card overflow-hidden">
        <div className="overflow-auto max-h-[70vh]">
          <table className="w-full">
            <thead className="bg-slate-50">
              <tr>
                <th className="iu-table-th w-10"></th>
                <th className="iu-table-th">Member</th>
                <th className="iu-table-th">Check-in</th>
                <th className="iu-table-th">Excursions</th>
                <th className="iu-table-th hidden md:table-cell">Away</th>
                <th className="iu-table-th">Check-out</th>
                <th className="iu-table-th">Hours</th>
              </tr>
            </thead>
            <tbody data-testid="sessions-table">
              {loading && rows.length === 0 && (
                <tr><td colSpan={7} className="text-center py-10"><Loader2 className="animate-spin mx-auto text-slate-400" /></td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={7} className="text-center py-10 text-slate-500 text-sm">No sessions on this date.</td></tr>
              )}
              {rows.map((r) => (
                <React.Fragment key={r.session_id}>
                  <tr
                    onClick={() => toggleRow(r.session_id)}
                    className="hover:bg-slate-50 cursor-pointer"
                    data-testid={`session-row-${r.session_id}`}
                  >
                    <td className="iu-table-td text-slate-400">
                      {expanded.has(r.session_id) ? <ChevronDown size={16}/> : <ChevronRight size={16}/>}
                    </td>
                    <td className="iu-table-td">
                      <div className="flex items-center gap-3">
                        <Avatar name={r.member_name} photo={r.photo} size={36} ring={r.on_temp_exit ? "#06B6D4" : r.open ? "#10B981" : null} />
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-900 truncate flex items-center gap-2">
                            {r.member_name}
                            {r.on_temp_exit && (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-cyan-100 text-cyan-700">
                                <Coffee size={10}/> Stepped out
                              </span>
                            )}
                            {r.open && !r.on_temp_exit && (
                              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-700">
                                Open
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-slate-500 truncate">
                            {r.member_rank ? `${r.member_rank} · ` : ""}{categoryLabel(r.member_category)}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="iu-table-td">
                      <div className="flex items-center gap-1.5 text-sm">
                        <LogIn size={13} className="text-emerald-600"/>
                        <span className="font-semibold">{fmt(r.check_in_time)}</span>
                      </div>
                      {r.late && <div className="text-[10px] font-bold text-amber-700 mt-0.5">Late {r.late_minutes}m</div>}
                    </td>
                    <td className="iu-table-td">
                      {r.excursion_count > 0 ? (
                        <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-cyan-100 text-cyan-700">
                          <Coffee size={11}/> {r.excursion_count}
                        </div>
                      ) : <span className="text-slate-400">—</span>}
                    </td>
                    <td className="iu-table-td hidden md:table-cell text-sm text-slate-700">
                      {r.away_minutes > 0 ? `${r.away_minutes}m` : <span className="text-slate-400">0</span>}
                    </td>
                    <td className="iu-table-td">
                      {r.check_out_time ? (
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-1.5 text-sm">
                            <LogOutIcon size={13} className="text-slate-500"/>
                            <span className="font-semibold">{r.check_out_time}</span>
                          </div>
                          {r.auto_checkout && (
                            <span
                              data-testid={`auto-checkout-badge-${r.session_id}`}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 w-fit"
                              title={`Auto-closed by system${r.auto_checkout_reason ? ` (${r.auto_checkout_reason})` : ""} — member forgot to check out. Hours are an estimate.`}
                            >
                              <AlertTriangle size={9}/> Auto-closed
                            </span>
                          )}
                        </div>
                      ) : <span className="text-slate-400 text-sm">—</span>}
                    </td>
                    <td className="iu-table-td font-bold">{r.hours}h</td>
                  </tr>
                  {expanded.has(r.session_id) && (
                    <tr className="bg-slate-50/60">
                      <td></td>
                      <td colSpan={6} className="px-4 py-4">
                        <Timeline row={r} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div className="iu-card p-4">
      <div className="w-9 h-9 rounded-lg flex items-center justify-center mb-3" style={{ background: color + "22", color }}>
        <Clock size={16}/>
      </div>
      <div className="text-2xl font-extrabold">{value}</div>
      <div className="text-xs text-slate-500 font-semibold uppercase tracking-wide mt-0.5">{label}</div>
    </div>
  );
}

function Timeline({ row }) {
  const items = [];
  items.push({
    key: `in-${row.check_in_at}`,
    icon: <LogIn size={14}/>,
    color: "#10B981",
    title: "Checked in",
    time: row.check_in_time,
    note: row.late ? `Late ${row.late_minutes}m` : (row.out_of_geofence ? "Off-site" : (row.method ? row.method.replace("_", " ") : "")),
  });
  (row.excursions || []).forEach((e) => {
    items.push({
      key: `out-${e.id}`,
      icon: <Coffee size={14}/>,
      color: "#06B6D4",
      title: `Stepped out · ${e.reason || ""}`,
      time: e.out_time,
      note: e.expected_return_time ? `Expected back by ${e.expected_return_time}` : "",
    });
    if (e.in_time) {
      items.push({
        key: `back-${e.id}`,
        icon: <LogIn size={14}/>,
        color: "#0EA5E9",
        title: "Returned",
        time: e.in_time,
        note: (e.duration_min != null ? `${e.duration_min}m away` : "")
              + (e.overdue_min ? ` · ${e.overdue_min}m overdue` : ""),
        overdue: !!e.overdue_min,
      });
    } else {
      items.push({
        key: `pending-${e.id}`,
        icon: <AlertTriangle size={14}/>,
        color: "#F59E0B",
        title: "Still away",
        time: "",
        note: e.expected_return_time ? `Expected back by ${e.expected_return_time}` : "Awaiting return",
      });
    }
  });
  if (row.check_out_time) {
    items.push({
      key: `out-${row.check_out_at}`,
      icon: <LogOutIcon size={14}/>,
      color: "#6B7280",
      title: "Checked out",
      time: row.check_out_time,
      note: row.stored_hours != null ? `${row.stored_hours}h logged` : "",
    });
  }

  return (
    <ol className="relative pl-6">
      <span className="absolute left-2 top-1 bottom-1 w-px bg-slate-200" />
      {items.map((it) => (
        <li key={it.key} className="relative pb-3 last:pb-0" data-testid={`timeline-${it.key}`}>
          <span
            className="absolute -left-[18px] top-0.5 w-5 h-5 rounded-full flex items-center justify-center text-white"
            style={{ background: it.color }}
          >
            {it.icon}
          </span>
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm font-semibold text-slate-900">{it.title}</span>
            {it.time && <span className="text-xs font-mono text-slate-500">{it.time}</span>}
            {it.note && <span className={`text-xs ${it.overdue ? "text-amber-700 font-semibold" : "text-slate-500"}`}>· {it.note}</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}
