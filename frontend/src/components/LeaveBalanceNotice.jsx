import React from "react";
import { Info, AlertTriangle, ShieldCheck } from "lucide-react";

/**
 * LeaveBalanceNotice — drop-in block for the Leave application form.
 *
 * Responsibilities (kept inside this component so the form stays flat):
 *  - Shows the available balance vs the requested days.
 *  - Flags LOP (Loss of Pay) when requested > remaining.
 *  - Always reminds the user that "All leave is subject to approval"
 *    UNLESS the admin has ticked Auto-approve (in which case the text
 *    becomes "Will be auto-approved on submit").
 *  - For non-athletes who have no opening balance set, shows a gentle
 *    note rather than computing nonsense numbers.
 *  - For athletes, surfaces the Breaks-workflow hint and skips LOP math.
 *
 * Props:
 *  - requestedDays:    number  — calendar days from start..end inclusive.
 *  - leaveType:        string  — "leave" | "tour" | "comp_off" | "late_coming".
 *                                Only "leave" consumes the balance.
 *  - members:          array<{full_name, category, opening, remaining}>
 *                                For self: a single-item array. For admin
 *                                multi-pick: one entry per picked member.
 *  - autoApprove:      bool    — admin auto-approve flag (default false).
 *  - asAdmin:          bool    — admin "Apply on behalf" mode flag.
 */
export default function LeaveBalanceNotice({
  requestedDays,
  leaveType,
  members,
  autoApprove = false,
  asAdmin = false,
  compOffBalance = null,
}) {
  // Tours / comp-off / late-coming don't draw from the leave balance.
  // Show a slim informational note (still mention approval policy) so the
  // applicant understands their balance won't change.
  if (leaveType === "comp_off") {
    // Comp-off has its OWN balance pool (accrued from holiday/weekly-off
    // attendance). Render a dedicated panel mirroring the leave layout —
    // green when affordable, red when the request exceeds available.
    const bal = compOffBalance || { accrued: 0, used: 0, available: 0 };
    const short = Math.max(0, requestedDays - bal.available);
    const overdraft = short > 0;
    return (
      <div
        data-testid="comp-off-balance-notice"
        className={`rounded-lg border px-3 py-2.5 ${overdraft ? "border-red-300 bg-red-50/70" : "border-emerald-200 bg-emerald-50/60"}`}
      >
        <div className="flex items-start gap-2">
          {overdraft
            ? <AlertTriangle size={14} className="text-red-600 mt-0.5 shrink-0" />
            : <ShieldCheck size={14} className="text-emerald-700 mt-0.5 shrink-0" />}
          <div className={`text-xs leading-snug flex-1 min-w-0 ${overdraft ? "text-red-800" : "text-emerald-900"}`}>
            <div>
              Comp-off balance: <strong>{bal.available}</strong> day{bal.available === 1 ? "" : "s"} available
              <span className="opacity-75"> (accrued {bal.accrued} − used {bal.used})</span>.
              {" "}
              Applying for <strong>{requestedDays}</strong> day{requestedDays === 1 ? "" : "s"}.
            </div>
            {overdraft && (
              <div className="mt-1 font-extrabold uppercase tracking-wide text-red-700" data-testid="comp-off-overdraft">
                Cannot exceed your comp-off balance — short by {short} day{short === 1 ? "" : "s"}. Submit will be blocked.
              </div>
            )}
            <div className="pt-1.5 mt-1.5 border-t border-current/15 text-[11px] font-medium">
              <ApprovalLine autoApprove={autoApprove} asAdmin={asAdmin} />
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (leaveType !== "leave") {
    return (
      <div className="rounded-lg border border-sky-200 bg-sky-50/60 px-3 py-2.5 flex items-start gap-2" data-testid="leave-balance-info-nonleave">
        <Info size={14} className="text-sky-600 mt-0.5 shrink-0" />
        <div className="text-xs text-sky-900 leading-snug">
          {leaveType === "tour" && "Tours don't count against the leave balance."}
          {leaveType === "late_coming" && "Late-coming is for the same day only and doesn't consume any leave."}
          {" "}
          <ApprovalLine autoApprove={autoApprove} asAdmin={asAdmin} />
        </div>
      </div>
    );
  }

  // For "leave" type — render per-member balance rows.
  const rows = (members || []).map((m) => {
    const opening = m.opening;
    const remaining = m.remaining;
    const category = m.category || "athlete";
    const tracked = category !== "athlete" && opening != null;
    const lop = tracked && requestedDays > remaining ? Math.max(0, requestedDays - Math.max(0, remaining || 0)) : 0;
    return { ...m, tracked, opening, remaining, lop };
  });

  const anyLop = rows.some((r) => r.lop > 0);

  return (
    <div
      data-testid="leave-balance-notice"
      className={`rounded-lg border px-3 py-2.5 ${anyLop ? "border-red-300 bg-red-50/70" : "border-emerald-200 bg-emerald-50/60"}`}
    >
      <div className="flex items-start gap-2">
        {anyLop
          ? <AlertTriangle size={14} className="text-red-600 mt-0.5 shrink-0" />
          : <ShieldCheck size={14} className="text-emerald-700 mt-0.5 shrink-0" />}
        <div className={`text-xs leading-snug flex-1 min-w-0 ${anyLop ? "text-red-800" : "text-emerald-900"}`}>
          {/* Single-member layout — no need for a table */}
          {rows.length === 1 ? (
            <SingleRow row={rows[0]} requestedDays={requestedDays} />
          ) : (
            <MultiRowTable rows={rows} requestedDays={requestedDays} />
          )}
          <div className="pt-1.5 mt-1.5 border-t border-current/15 text-[11px] font-medium">
            <ApprovalLine autoApprove={autoApprove} asAdmin={asAdmin} />
          </div>
        </div>
      </div>
    </div>
  );
}

function SingleRow({ row, requestedDays }) {
  if (!row.tracked) {
    return (
      <span data-testid="leave-balance-untracked">
        {(row.category || "athlete") === "athlete"
          ? "Athletes use the Breaks workflow — no numeric balance is consumed."
          : "No opening leave balance has been set yet. Days approved will be on record but balance maths needs an opening figure first."}
      </span>
    );
  }
  return (
    <div data-testid="leave-balance-single">
      <div>
        <strong>{row.remaining}</strong> day{row.remaining === 1 ? "" : "s"} of leave remaining
        {row.opening != null && <span className="opacity-75"> (out of {row.opening} opening)</span>}.
        {" "}
        Applying for <strong>{requestedDays}</strong> day{requestedDays === 1 ? "" : "s"}.
      </div>
      {row.lop > 0 && (
        <div className="mt-1 font-extrabold uppercase tracking-wide text-red-700" data-testid="leave-balance-lop">
          {row.lop} day{row.lop === 1 ? "" : "s"} will be Loss of Pay (LOP).
        </div>
      )}
    </div>
  );
}

function MultiRowTable({ rows, requestedDays }) {
  return (
    <div data-testid="leave-balance-multi">
      <div className="font-semibold mb-1">
        Applying for <strong>{requestedDays}</strong> day{requestedDays === 1 ? "" : "s"} across {rows.length} member{rows.length === 1 ? "" : "s"}:
      </div>
      <div className="rounded-md bg-white/60 border border-current/20 overflow-hidden">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="bg-current/10">
              <th className="px-2 py-1 text-left font-bold">Member</th>
              <th className="px-2 py-1 text-right font-bold">Remaining</th>
              <th className="px-2 py-1 text-right font-bold">LOP</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id || r.full_name} className="border-t border-current/15">
                <td className="px-2 py-1 truncate">{r.full_name}</td>
                <td className="px-2 py-1 text-right font-mono">
                  {r.tracked ? r.remaining : <span className="opacity-60">—</span>}
                </td>
                <td className={`px-2 py-1 text-right font-mono font-bold ${r.lop > 0 ? "text-red-700" : "opacity-60"}`}>
                  {r.tracked ? (r.lop > 0 ? r.lop : "0") : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ApprovalLine({ autoApprove, asAdmin }) {
  if (asAdmin && autoApprove) {
    return <span data-testid="approval-line-auto"><ShieldCheck size={10} className="inline -mt-0.5 mr-1" />Will be auto-approved on submit (admin override).</span>;
  }
  return <span data-testid="approval-line-default">All leave is subject to admin approval.</span>;
}
