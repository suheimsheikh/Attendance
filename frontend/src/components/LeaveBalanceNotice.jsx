import React from "react";
import { Info, AlertTriangle, ShieldCheck } from "lucide-react";

/**
 * LeaveBalanceNotice — drop-in block for the Leave application form.
 *
 * UNIFIED LEAVE (Jun 2026): "Comp Off" is no longer an application type.
 * When a member applies for `leave`, the backend automatically waterfalls
 * the deduction: Comp-Off balance first, then Paid Leave, anything left
 * over is recorded as LOP. This component surfaces that split BEFORE the
 * user submits so there are no surprises.
 *
 * Props:
 *  - requestedDays:    number  — calendar days from start..end inclusive.
 *  - leaveType:        string  — "leave" | "tour" | "late_coming" (legacy "comp_off" tolerated).
 *  - members:          array<{full_name, category, opening, remaining}>
 *                                Used in the admin multi-pick path to render
 *                                a per-member table (per-member balances differ).
 *  - balanceSummary:   object | null
 *                                Unified summary for the SINGLE-target case
 *                                (self apply OR admin single-pick). Shape:
 *                                  { comp_off: {accrued, used, available},
 *                                    paid_leave: {opening, used, available, tracked},
 *                                    total_available }
 *  - autoApprove:      bool    — admin auto-approve flag (default false).
 *  - asAdmin:          bool    — admin "Apply on behalf" mode flag.
 */
export default function LeaveBalanceNotice({
  requestedDays,
  leaveType,
  members,
  autoApprove = false,
  asAdmin = false,
  balanceSummary = null,
}) {
  // Tours / postings / late-coming don't draw from any balance — slim info note.
  if (leaveType === "tour" || leaveType === "late_coming" || leaveType === "posting") {
    return (
      <div className="rounded-lg border border-sky-200 bg-sky-50/60 px-3 py-2.5 flex items-start gap-2" data-testid="leave-balance-info-nonleave">
        <Info size={14} className="text-sky-600 mt-0.5 shrink-0" />
        <div className="text-xs text-sky-900 leading-snug">
          {leaveType === "tour" && "Tours don't count against your leave or comp-off balance."}
          {leaveType === "posting" && "Postings don't consume any leave or comp-off, and won't accrue weekly-off comp-off either."}
          {leaveType === "late_coming" && "Late-coming is for the same day only and doesn't consume any leave."}
          {" "}
          <ApprovalLine autoApprove={autoApprove} asAdmin={asAdmin} />
        </div>
      </div>
    );
  }

  // Legacy guard — UI no longer offers "Comp Off" as a type, but if a
  // caller still passes it, fall through to the unified leave view.
  // (Renders the same waterfall preview against the unified summary.)

  // Admin multi-pick: per-member balances differ → render the per-member
  // table (legacy layout). Single-target path uses the waterfall preview.
  const isMultiPick = asAdmin && (members || []).length > 1;
  if (isMultiPick) {
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
            <MultiRowTable rows={rows} requestedDays={requestedDays} />
            <div className="pt-1.5 mt-1.5 border-t border-current/15 text-[11px] font-medium opacity-90">
              Each member&apos;s comp-off + paid leave is drawn separately. Anything beyond their combined balance is LOP.
            </div>
            <div className="pt-1.5 mt-1.5 border-t border-current/15 text-[11px] font-medium">
              <ApprovalLine autoApprove={autoApprove} asAdmin={asAdmin} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Single-target waterfall preview (self apply OR admin single-pick).
  if (!balanceSummary) {
    // Summary still loading or not available — render a quiet placeholder
    // so the form layout doesn't jump when the data arrives.
    return (
      <div className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2.5 flex items-start gap-2" data-testid="leave-balance-loading">
        <Info size={14} className="text-slate-400 mt-0.5 shrink-0" />
        <div className="text-xs text-slate-600 leading-snug">
          Calculating your available balance…
          <div className="pt-1.5 mt-1.5 border-t border-slate-200 text-[11px] font-medium">
            <ApprovalLine autoApprove={autoApprove} asAdmin={asAdmin} />
          </div>
        </div>
      </div>
    );
  }

  const co = balanceSummary.comp_off || { accrued: 0, used: 0, available: 0 };
  const pl = balanceSummary.paid_leave || { opening: null, used: 0, available: 0, tracked: false };

  // Waterfall split — mirrors backend `split_leave_days`.
  const coUsed = Math.min(requestedDays, Math.max(0, co.available));
  const plUsed = Math.min(requestedDays - coUsed, Math.max(0, pl.available));
  const lop = Math.max(0, requestedDays - coUsed - plUsed);

  // Athletes use the Breaks workflow — they have no numeric paid-leave
  // pool and the form should make that clear rather than show a "LOP".
  // Sourced from the members prop (carries the live category for the
  // single target — self path puts the current user there, admin path
  // puts the picked member there).
  const target = (members || [])[0] || {};
  const isAthlete = (target.category || "athlete") === "athlete" && !pl.tracked;
  if (isAthlete) {
    return (
      <div className="rounded-lg border border-sky-200 bg-sky-50/60 px-3 py-2.5 flex items-start gap-2" data-testid="leave-balance-athlete">
        <Info size={14} className="text-sky-600 mt-0.5 shrink-0" />
        <div className="text-xs text-sky-900 leading-snug">
          Athletes use the Breaks workflow — no numeric balance is consumed.
          <div className="pt-1.5 mt-1.5 border-t border-sky-200 text-[11px] font-medium">
            <ApprovalLine autoApprove={autoApprove} asAdmin={asAdmin} />
          </div>
        </div>
      </div>
    );
  }

  const tone = lop > 0 ? "red" : "emerald";
  const palette = tone === "red"
    ? { border: "border-red-300", bg: "bg-red-50/70", text: "text-red-800", Icon: AlertTriangle, iconCls: "text-red-600" }
    : { border: "border-emerald-200", bg: "bg-emerald-50/60", text: "text-emerald-900", Icon: ShieldCheck, iconCls: "text-emerald-700" };

  return (
    <div
      data-testid="leave-balance-notice"
      className={`rounded-lg border px-3 py-2.5 ${palette.border} ${palette.bg}`}
    >
      <div className="flex items-start gap-2">
        <palette.Icon size={14} className={`${palette.iconCls} mt-0.5 shrink-0`} />
        <div className={`text-xs leading-snug flex-1 min-w-0 ${palette.text}`}>
          <div data-testid="leave-balance-header">
            Applying for <strong>{requestedDays}</strong> day{requestedDays === 1 ? "" : "s"} of leave.
          </div>

          {/* Available pools (live) */}
          <div className="mt-1.5 grid grid-cols-2 gap-2" data-testid="leave-balance-pools">
            <PoolPill
              label="Comp-Off available"
              value={co.available}
              hint={`accrued ${co.accrued} − used ${co.used}`}
              testId="pool-comp-off"
            />
            <PoolPill
              label="Paid Leave available"
              value={pl.tracked ? round1(pl.available) : "—"}
              hint={pl.tracked
                ? `opening ${round1(pl.opening) ?? 0} − used ${round1(pl.used) ?? 0}${(pl.half_count || 0) > 0 ? ` (${pl.full_count || 0}F + ${pl.half_count}H)` : ""}`
                : "no opening balance set"}
              testId="pool-paid-leave"
            />
          </div>

          {/* Waterfall preview */}
          <div className="mt-2 font-semibold" data-testid="waterfall-preview">
            This request will deduct{" "}
            <strong data-testid="waterfall-comp-off">{coUsed}</strong> from Comp-Off
            {" + "}
            <strong data-testid="waterfall-paid-leave">{round1(plUsed)}</strong> from Paid Leave
            {lop > 0 && (
              <>
                {" + "}
                <strong data-testid="waterfall-lop" className="uppercase tracking-wide">{lop} LOP</strong>
              </>
            )}
            .
          </div>

          {lop > 0 && (
            <div className="mt-1 font-extrabold uppercase tracking-wide text-red-700 text-[11px]" data-testid="leave-balance-lop">
              {lop} day{lop === 1 ? "" : "s"} will be Loss of Pay — you&apos;re short on both balances.
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

function round1(v) {
  if (v == null || v === "—") return v;
  const n = Number(v);
  if (Number.isNaN(n)) return v;
  return Math.round(n * 10) / 10;
}

function PoolPill({ label, value, hint, testId }) {
  return (
    <div className="rounded-md bg-white/70 border border-current/15 px-2 py-1.5" data-testid={testId}>
      <div className="text-[10px] uppercase tracking-wide opacity-70 font-bold">{label}</div>
      <div className="font-extrabold text-base leading-tight" data-testid={`${testId}-value`}>{value}</div>
      <div className="text-[10px] opacity-70">{hint}</div>
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
              <th className="px-2 py-1 text-right font-bold">Paid Leave remaining</th>
              <th className="px-2 py-1 text-right font-bold">Possible LOP</th>
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
