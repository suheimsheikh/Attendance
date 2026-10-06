import { History } from "lucide-react";
import { formatDate, formatTime, shortDate } from "../../../utils";
import { round1 } from "../../leaves/utils";
import { daysBetween } from "./rowHelpers";


// decided leave we surface every field from the pending grid PLUS the
// four new audit fields snapshotted on PATCH:
//   • turnaround (applied → decided) — computed client-side from the two ISO stamps
//   • denial_reason                 — set only for rejects
//   • balance_at_decision           — { paid_leave_available, comp_off_available }
//   • ytd_applied_days / ytd_denied_days
// ---------------------------------------------------------------------------
function fmtTurnaround(fromIso, toIso) {
  if (!fromIso || !toIso) return "—";
  try {
    const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return "—";
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ${mins % 60}m`;
    const days = Math.floor(hrs / 24);
    return `${days}d ${hrs % 24}h`;
  } catch { return "—"; }
}

const STATUS_TONE = {
  approved: "bg-emerald-100 text-emerald-800",
  rejected: "bg-slate-200 text-slate-700",
};

function computeHistoryStats(rows) {
  let approved = 0, rejected = 0, lop = 0, tSum = 0, tN = 0;
  for (const l of rows) {
    if (l.status === "approved") approved++;
    else if (l.status === "rejected") rejected++;
    if (typeof l.lop_days === "number") lop += l.lop_days;
    if (l.created_at && l.decided_at) {
      const ms = new Date(l.decided_at).getTime() - new Date(l.created_at).getTime();
      if (Number.isFinite(ms) && ms >= 0) { tSum += ms; tN++; }
    }
  }
  const avgMs = tN ? tSum / tN : 0;
  const avgH = avgMs / 3600000;
  return {
    total: rows.length,
    approved, rejected, lop: round1(lop),
    avgTurnaround: avgH >= 24 ? `${(avgH / 24).toFixed(1)}d` : (avgH >= 1 ? `${avgH.toFixed(1)}h` : `${Math.round(avgMs / 60000)}m`),
  };
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadDecisionHistoryCsv(rows) {
  const header = ["Member","Category","Type","Half day","Start","End","Days","Applied on",
    "Reason for applying","Status","Decided by","Decided on","Turnaround",
    "Denial reason","LOP override","Balance @ decision","Applied YTD","Denied YTD","LOP days"];
  const lines = [header.map(csvEscape).join(",")];
  for (const l of rows) {
    const days = l.half_day ? 0.5 : (daysBetween(l.start_date, l.end_date) ?? "");
    const bal = l.balance_at_decision;
    const balTotal = bal ? round1((bal.paid_leave_available || 0) + (bal.comp_off_available || 0)) : "";
    lines.push([
      l.member_name || "", l.member_category || "",
      (l.type || "").toUpperCase(), l.half_day || "",
      l.start_date || "", l.end_date || "", days,
      l.created_at ? l.created_at.slice(0, 10) : "",
      l.reason || "", l.status || "",
      l.decided_by || "",
      l.decided_at ? l.decided_at.slice(0, 10) : "",
      fmtTurnaround(l.created_at, l.decided_at),
      l.denial_reason || "", l.approval_override_reason || "",
      balTotal,
      typeof l.ytd_applied_days === "number" ? l.ytd_applied_days : "",
      typeof l.ytd_denied_days === "number" ? l.ytd_denied_days : "",
      typeof l.lop_days === "number" ? l.lop_days : "",
    ].map(csvEscape).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `leave-decisions-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function StatPill({ label, value, tone = "slate", testid }) {
  const toneMap = {
    slate: "bg-white text-slate-900 border-slate-200",
    emerald: "bg-emerald-50 text-emerald-900 border-emerald-200",
    rose: "bg-rose-50 text-rose-900 border-rose-200",
    amber: "bg-amber-50 text-amber-900 border-amber-200",
    violet: "bg-violet-50 text-violet-900 border-violet-200",
  };
  return (
    <div className={`px-3 py-1.5 rounded-md border ${toneMap[tone]}`} data-testid={testid}>
      <div className="text-[10px] uppercase tracking-wider font-bold opacity-70">{label}</div>
      <div className="text-lg font-extrabold tabular-nums leading-none mt-0.5">{value}</div>
    </div>
  );
}

export function DecisionHistoryLeaves({ rows, onReopen }) {
  const stats = computeHistoryStats(rows);
  if (!rows || rows.length === 0) {
    return (
      <div className="mt-6" data-testid="decision-history-empty">
        <div className="flex items-center gap-2 mb-2 text-slate-500">
          <History size={14} />
          <h2 className="text-sm font-extrabold uppercase tracking-wider">Decision history — Leaves</h2>
        </div>
        <div className="iu-card p-6 text-center text-slate-400 text-sm">
          No approved or rejected leave requests yet.
        </div>
      </div>
    );
  }
  return (
    <div className="mt-6" data-testid="decision-history">
      <div className="flex items-center gap-2 mb-2 text-slate-500 flex-wrap">
        <History size={14} />
        <h2 className="text-sm font-extrabold uppercase tracking-wider">Decision history — Leaves</h2>
        <span className="text-[11px] normal-case tracking-normal text-slate-400">
          (latest on top)
        </span>
        <div className="ml-auto">
          <button
            type="button"
            data-testid="history-export-csv"
            onClick={() => downloadDecisionHistoryCsv(rows)}
            className="iu-btn-secondary !h-8 !px-3 !text-xs"
            title="Download all decisions in this view as CSV"
          >
            Download CSV
          </button>
        </div>
      </div>

      {/* Violet-tinted "history box" so admins can tell at a glance
          they're looking at decided rows, not the pending queue above. */}
      <div className="rounded-lg border border-violet-200 bg-violet-50/40 p-3" data-testid="history-box">
        {/* Stats strip at the top of the history box. */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3" data-testid="history-stats">
          <StatPill testid="stat-total"     label="Total"       value={stats.total}         tone="violet" />
          <StatPill testid="stat-approved"  label="Approved"    value={stats.approved}      tone="emerald" />
          <StatPill testid="stat-rejected"  label="Rejected"    value={stats.rejected}      tone="rose" />
          <StatPill testid="stat-lop"       label="LOP days"    value={stats.lop || 0}      tone="amber" />
          <StatPill testid="stat-avg"       label="Avg turnaround" value={stats.avgTurnaround} tone="slate" />
        </div>

        <div className="rounded-md bg-white border border-violet-100 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[12px] table-fixed" data-testid="decision-history-table">
              <colgroup>
                <col style={{ width: "13%" }} />{/* Member */}
                <col style={{ width: "6%"  }} />{/* Type */}
                <col style={{ width: "12%" }} />{/* Dates */}
                <col style={{ width: "4%"  }} />{/* Days */}
                <col style={{ width: "14%" }} />{/* Reason applied */}
                <col style={{ width: "6%"  }} />{/* Status */}
                <col style={{ width: "12%" }} />{/* Decided (by/on) */}
                <col style={{ width: "6%"  }} />{/* Turnaround */}
                <col style={{ width: "15%" }} />{/* Denial / Override */}
                <col style={{ width: "4%"  }} />{/* Bal */}
                <col style={{ width: "4%"  }} />{/* YTD app */}
                <col style={{ width: "4%"  }} />{/* YTD den */}
              </colgroup>
              <thead className="bg-violet-100/60 border-b border-violet-200 text-violet-900 text-[10px] uppercase tracking-wider">
                <tr>
                  <th className="py-1.5 px-2 text-left">Member</th>
                  <th className="py-1.5 px-2 text-left">Type</th>
                  <th className="py-1.5 px-2 text-left">Dates</th>
                  <th className="py-1.5 px-2 text-right">Days</th>
                  <th className="py-1.5 px-2 text-left">Reason</th>
                  <th className="py-1.5 px-2 text-left">Status</th>
                  <th className="py-1.5 px-2 text-left" title="Decided by · Decided on">Decided</th>
                  <th className="py-1.5 px-2 text-left" title="Applied → Decided">T/A</th>
                  <th className="py-1.5 px-2 text-left" title="Denial reason or LOP override note">Note</th>
                  <th className="py-1.5 px-2 text-right" title="Balance at decision (paid + comp)">Bal</th>
                  <th className="py-1.5 px-2 text-right" title="YTD days applied">A</th>
                  <th className="py-1.5 px-2 text-right" title="YTD days denied">D</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => {
                  const days = daysBetween(l.start_date, l.end_date);
                  const bal = l.balance_at_decision;
                  const balTotal = bal
                    ? round1((bal.paid_leave_available || 0) + (bal.comp_off_available || 0))
                    : null;
                  const statusTone = STATUS_TONE[l.status] || "bg-slate-100 text-slate-700";
                  const note = l.status === "rejected"
                    ? l.denial_reason
                    : l.approval_override_reason;
                  const noteTone = l.status === "rejected" ? "text-rose-700" : "text-amber-700";
                  return (
                    <tr
                      key={l.id}
                      data-testid={`history-row-${l.id}`}
                      className="border-b border-violet-100/60 hover:bg-violet-50/50"
                      onDoubleClick={() => onReopen(l.id)}
                      title="Double-click to re-open"
                    >
                      <td className="py-1.5 px-2 truncate">
                        <div className="font-semibold text-slate-800 truncate">{l.member_name}</div>
                        <div className="text-[10px] text-slate-500 truncate">{l.member_category || ""}</div>
                      </td>
                      <td className="py-1.5 px-2">
                        <span className="inline-block px-1.5 h-4 leading-4 rounded text-[9px] font-bold uppercase bg-amber-100 text-amber-800">
                          {(l.type || "leave").slice(0, 4).toUpperCase()}
                        </span>
                        {l.half_day && (
                          <div className="mt-0.5 text-[9px] font-bold text-sky-700">½ · {l.half_day}</div>
                        )}
                      </td>
                      <td className="py-1.5 px-2 whitespace-nowrap font-mono text-[10px] text-slate-700">
                        {shortDate(l.start_date)}
                        {l.end_date && l.end_date !== l.start_date && <> → {shortDate(l.end_date)}</>}
                        <div className="text-[9px] text-slate-400">app {shortDate(l.created_at)}</div>
                      </td>
                      <td className="py-1.5 px-2 text-right font-mono font-semibold tabular-nums">
                        {l.half_day ? "0.5" : (days ?? "—")}
                      </td>
                      <td className="py-1.5 px-2 text-[11px] text-slate-700">
                        <div className="line-clamp-2" title={l.reason}>
                          {l.reason || <span className="text-slate-300">—</span>}
                        </div>
                      </td>
                      <td className="py-1.5 px-2">
                        <span className={`inline-block px-1.5 h-4 leading-4 rounded-full text-[10px] font-bold ${statusTone}`}>
                          {l.status === "approved" ? "OK" : "REJ"}
                        </span>
                      </td>
                      <td className="py-1.5 px-2 text-[11px] text-slate-700">
                        <div className="truncate" title={l.decided_by || ""}>{l.decided_by || <span className="text-slate-300">—</span>}</div>
                        <div className="text-[10px] text-slate-500 whitespace-nowrap">{l.decided_at ? shortDate(l.decided_at) : ""}</div>
                      </td>
                      <td className="py-1.5 px-2 text-[10px] font-mono text-slate-600 whitespace-nowrap">
                        {fmtTurnaround(l.created_at, l.decided_at)}
                      </td>
                      <td className="py-1.5 px-2 text-[11px]">
                        {note
                          ? <div className={`line-clamp-2 ${noteTone}`} title={note}>{note}</div>
                          : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="py-1.5 px-2 text-right text-[11px] font-mono tabular-nums">
                        {balTotal != null
                          ? <span title={`${bal.comp_off_available ?? 0} comp + ${bal.paid_leave_available ?? 0} paid`}>{balTotal}</span>
                          : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="py-1.5 px-2 text-right text-[11px] font-mono tabular-nums">
                        {typeof l.ytd_applied_days === "number" ? l.ytd_applied_days : <span className="text-slate-300">—</span>}
                      </td>
                      <td className="py-1.5 px-2 text-right text-[11px] font-mono tabular-nums">
                        {typeof l.ytd_denied_days === "number" ? l.ytd_denied_days : <span className="text-slate-300">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <p className="mt-2 text-[10px] text-violet-800/70">
          Double-click any row to re-open it. Hover cells for full text — long values are truncated to fit.
        </p>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Decision history — Check-ins. Simpler than leaves: no balance / YTD
// fields, no re-open (check-ins aren't reversible), but the columns
// still mirror the pending grid + audit fields.
// ---------------------------------------------------------------------------
export function DecisionHistoryCheckins({ rows }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="mt-6" data-testid="decision-history-checkins-empty">
        <div className="flex items-center gap-2 mb-2 text-slate-500">
          <History size={14} />
          <h2 className="text-sm font-extrabold uppercase tracking-wider">Decision history — Check-ins</h2>
        </div>
        <div className="iu-card p-6 text-center text-slate-400 text-sm">No decided check-in requests yet.</div>
      </div>
    );
  }
  return (
    <div className="mt-6" data-testid="decision-history-checkins">
      <div className="flex items-center gap-2 mb-2 text-slate-500">
        <History size={14} />
        <h2 className="text-sm font-extrabold uppercase tracking-wider">Decision history — Check-ins</h2>
        <span className="text-[11px] normal-case tracking-normal text-slate-400">
          (latest on top — {rows.length} decision{rows.length === 1 ? "" : "s"})
        </span>
      </div>
      <div className="iu-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[1100px]" data-testid="decision-history-checkins-table">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 text-[11px] uppercase tracking-wider">
              <tr>
                <th className="py-2 px-3 text-left">Member</th>
                <th className="py-2 px-3 text-left">Date · Time</th>
                <th className="py-2 px-3 text-left">Method · Geofence</th>
                <th className="py-2 px-3 text-left">Reason for applying</th>
                <th className="py-2 px-3 text-left w-24">Status</th>
                <th className="py-2 px-3 text-left">Decided by</th>
                <th className="py-2 px-3 text-left w-24">Decided on</th>
                <th className="py-2 px-3 text-left w-20">Turnaround</th>
                <th className="py-2 px-3 text-left">Denial note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const decidedAt = r.approval_decided_at || r.decided_at || r.approval_at;
                const submittedAt = r.requested_at || r.check_in_at;
                const status = r.approval_status || r.status;
                const tone = status === "approved" ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-700";
                return (
                  <tr key={r.id} data-testid={`history-checkin-row-${r.id}`} className="border-b border-slate-100 hover:bg-sky-50/40">
                    <td className="py-2 px-3 font-semibold text-slate-800">{r.user_name || r.member_name || "—"}</td>
                    <td className="py-2 px-3 whitespace-nowrap text-slate-700 text-xs">
                      {r.date && formatDate(r.date)} · {r.check_in_at && formatTime(r.check_in_at)}
                    </td>
                    <td className="py-2 px-3 text-slate-600 text-xs">
                      {[r.method?.toUpperCase(), r.geofence_status || (r.distance_m ? `${Math.round(r.distance_m)}m from site` : null)]
                        .filter(Boolean).join(" · ") || "—"}
                    </td>
                    <td className="py-2 px-3 text-slate-700 text-xs max-w-[240px]">
                      <div className="line-clamp-2" title={r.reason}>{r.reason || <span className="text-slate-300">—</span>}</div>
                    </td>
                    <td className="py-2 px-3">
                      <span className={`inline-flex items-center px-2 h-5 rounded-full text-[11px] font-bold ${tone}`}>
                        {status === "approved" ? "Approved" : "Rejected"}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-xs font-semibold text-slate-700">
                      {r.approval_by_name || r.decided_by || <span className="text-slate-300">—</span>}
                    </td>
                    <td className="py-2 px-3 text-xs text-slate-600 whitespace-nowrap">
                      {decidedAt ? shortDate(decidedAt) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="py-2 px-3 text-[11px] font-mono text-slate-600">
                      {fmtTurnaround(submittedAt, decidedAt)}
                    </td>
                    <td className="py-2 px-3 text-xs text-slate-700 max-w-[240px]">
                      {status === "rejected" && r.approval_note
                        ? <div className="line-clamp-2 text-rose-700" title={r.approval_note}>{r.approval_note}</div>
                        : <span className="text-slate-300">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Decision history — Corrections. Column set mirrors leaves minus the
// balance / YTD snapshot (corrections don't touch the leave pool).
// ---------------------------------------------------------------------------
export function DecisionHistoryCorrections({ rows }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="mt-6" data-testid="decision-history-corrections-empty">
        <div className="flex items-center gap-2 mb-2 text-slate-500">
          <History size={14} />
          <h2 className="text-sm font-extrabold uppercase tracking-wider">Decision history — Corrections</h2>
        </div>
        <div className="iu-card p-6 text-center text-slate-400 text-sm">No decided correction requests yet.</div>
      </div>
    );
  }
  return (
    <div className="mt-6" data-testid="decision-history-corrections">
      <div className="flex items-center gap-2 mb-2 text-slate-500">
        <History size={14} />
        <h2 className="text-sm font-extrabold uppercase tracking-wider">Decision history — Corrections</h2>
        <span className="text-[11px] normal-case tracking-normal text-slate-400">
          (latest on top — {rows.length} decision{rows.length === 1 ? "" : "s"})
        </span>
      </div>
      <div className="iu-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[1100px]" data-testid="decision-history-corrections-table">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 text-[11px] uppercase tracking-wider">
              <tr>
                <th className="py-2 px-3 text-left">Requester</th>
                <th className="py-2 px-3 text-left">Kind</th>
                <th className="py-2 px-3 text-left">Target date</th>
                <th className="py-2 px-3 text-left">Reason for applying</th>
                <th className="py-2 px-3 text-left w-24">Status</th>
                <th className="py-2 px-3 text-left">Decided by</th>
                <th className="py-2 px-3 text-left w-24">Decided on</th>
                <th className="py-2 px-3 text-left w-20">Turnaround</th>
                <th className="py-2 px-3 text-left">Denial note</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const tone = r.status === "approved" ? "bg-emerald-100 text-emerald-800" : "bg-slate-200 text-slate-700";
                return (
                  <tr key={r.id} data-testid={`history-correction-row-${r.id}`} className="border-b border-slate-100 hover:bg-sky-50/40">
                    <td className="py-2 px-3 font-semibold text-slate-800">{r.requester_name || "—"}</td>
                    <td className="py-2 px-3 text-xs text-slate-600 capitalize">
                      {(r.kind || "").replace(/_/g, " ")}
                    </td>
                    <td className="py-2 px-3 whitespace-nowrap text-slate-700 text-xs">
                      {r.target_date && formatDate(r.target_date)}
                    </td>
                    <td className="py-2 px-3 text-slate-700 text-xs max-w-[240px]">
                      <div className="line-clamp-2" title={r.reason}>{r.reason || <span className="text-slate-300">—</span>}</div>
                    </td>
                    <td className="py-2 px-3">
                      <span className={`inline-flex items-center px-2 h-5 rounded-full text-[11px] font-bold ${tone}`}>
                        {r.status === "approved" ? "Approved" : "Rejected"}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-xs font-semibold text-slate-700">
                      {r.decided_by_name || <span className="text-slate-300">—</span>}
                    </td>
                    <td className="py-2 px-3 text-xs text-slate-600 whitespace-nowrap">
                      {r.decided_at ? shortDate(r.decided_at) : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="py-2 px-3 text-[11px] font-mono text-slate-600">
                      {fmtTurnaround(r.requested_at, r.decided_at)}
                    </td>
                    <td className="py-2 px-3 text-xs text-slate-700 max-w-[240px]">
                      {r.status === "rejected" && r.admin_note
                        ? <div className="line-clamp-2 text-rose-700" title={r.admin_note}>{r.admin_note}</div>
                        : <span className="text-slate-300">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
