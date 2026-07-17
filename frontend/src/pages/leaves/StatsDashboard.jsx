/**
 * StatsDashboard — eight-tile grid summarising every relevant leave
 * number for the logged-in member. Drives directly from the unified
 * /me/leave-summary endpoint so the values stay consistent with what
 * the apply form's waterfall preview shows.
 *
 * Extracted from MyLeaves.jsx on 14 Feb 2026.
 */
import React from "react";
import { Bed, Plane, RefreshCw, Clock, Check, AlertTriangle } from "lucide-react";
import { TONE, round1 } from "./utils";

export default function StatsDashboard({ summary }) {
  const co = summary.comp_off || { accrued: 0, used: 0, available: 0 };
  const pl = summary.paid_leave || { opening: null, used: 0, available: 0, tracked: false };
  const stats = [
    {
      key: "leave-availed",
      label: "Leave availed",
      value: pl.tracked ? round1(pl.used) : "—",
      // Half-day breakdown when any halves exist, else the plain hint.
      hint: pl.tracked
        ? ((pl.half_count || 0) > 0
            ? `${pl.full_count || 0} full + ${pl.half_count} half day${pl.half_count === 1 ? "" : "s"}`
            : "Paid leave taken this year")
        : "Not tracked",
      tone: "amber",
      Icon: Bed,
    },
    {
      key: "leave-balance",
      label: "Paid Leave balance",
      value: pl.tracked ? round1(pl.available) : "—",
      hint: pl.tracked ? `Opening ${round1(pl.opening) || 0}` : "No opening balance",
      tone: pl.tracked && pl.available <= 0 ? "red" : "amber",
      Icon: Bed,
    },
    {
      key: "compoff-eligibility",
      label: "Comp-Off eligibility",
      value: co.available,
      hint: `Accrued ${co.accrued} − used ${co.used}`,
      // Footnotes split the accrual source between approved tours and
      // admin-seeded opening balance — surfaces so members can trace
      // where each credit came from.
      footnotes: [
        (co.from_tours || 0) > 0 && { icon: Plane, text: `${co.from_tours} from tours`, tone: "orange" },
        (co.from_opening || 0) > 0 && { icon: RefreshCw, text: `${co.from_opening} opening`, tone: "violet" },
      ].filter(Boolean),
      tone: "violet",
      Icon: RefreshCw,
    },
    {
      key: "total-available",
      label: "Total leave available",
      value: pl.tracked ? round1(summary.total_available) : co.available,
      hint: "Comp-Off + Paid Leave",
      tone: "emerald",
      Icon: Check,
      emphasis: true,
    },
    {
      key: "applied-pending",
      label: "Applied, not yet taken",
      value: round1((summary.pending_leave_days || 0) + (summary.future_approved_leave_days || 0)),
      hint: `${round1(summary.pending_leave_days || 0)} pending · ${round1(summary.future_approved_leave_days || 0)} future approved`,
      tone: "sky",
      Icon: Clock,
    },
    {
      key: "tour-total",
      label: "Tour days (YTD)",
      value: summary.tour_ytd_days || 0,
      hint: summary.pending_tour_days ? `${summary.pending_tour_days} pending` : "Doesn't consume balance",
      tone: "orange",
      Icon: Plane,
    },
    {
      key: "absent",
      label: "Absent days",
      value: summary.absent_ytd_days || 0,
      hint: "Working days with no record",
      tone: summary.absent_ytd_days > 5 ? "red" : "slate",
      Icon: AlertTriangle,
    },
    {
      key: "lop",
      label: "LOP this year",
      value: round1(summary.lop_ytd_days || 0),
      hint: "Loss of Pay days",
      tone: summary.lop_ytd_days > 0 ? "red" : "slate",
      Icon: AlertTriangle,
    },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-5" data-testid="myleaves-stats">
      {stats.map(({ key, ...rest }) => <StatCard key={key} {...rest} />)}
    </div>
  );
}

function StatCard({ label, value, hint, tone = "slate", Icon, emphasis, footnotes }) {
  const t = TONE[tone] || TONE.slate;
  const safeId = label.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-+|-+$/g, "");
  return (
    <div
      className={`iu-card !p-3 border ${t.border} ${t.bg} ${emphasis ? "ring-2 ring-emerald-200/60" : ""}`}
      data-testid={`stat-${safeId}`}
    >
      <div className={`flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold ${t.text}`}>
        {Icon && <Icon size={12} className={t.icon} />}
        <span className="truncate">{label}</span>
      </div>
      <div className={`font-extrabold text-2xl leading-tight mt-1 ${t.value}`}>{value}</div>
      <div className={`text-[10px] mt-0.5 ${t.text} opacity-80 line-clamp-1`} title={hint}>{hint}</div>
      {(footnotes || []).map((fn, idx) => {
        const ft = TONE[fn.tone] || TONE.slate;
        const FIcon = fn.icon;
        // Stable key = tone::text so footnotes survive re-renders + reorderings
        // (was array index, flagged by code review).
        const key = `${fn.tone || "slate"}::${fn.text}`;
        return (
          <div
            key={key}
            className={`text-[10px] mt-0.5 flex items-center gap-1 font-semibold ${ft.text}`}
            data-testid={idx === 0 ? `stat-footnote-${safeId}` : `stat-footnote-${safeId}-${idx}`}
          >
            {FIcon && <FIcon size={10} className={ft.icon} />}
            <span>{fn.text}</span>
          </div>
        );
      })}
    </div>
  );
}
