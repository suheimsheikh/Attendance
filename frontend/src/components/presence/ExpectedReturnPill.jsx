import React from "react";
import { Clock, AlertTriangle } from "lucide-react";

/**
 * ExpectedReturnPill — small colour-coded badge for stepped-out rows
 * (members in the temp_out column AND escorts in the column sub-section
 * and the EscortsStrip).
 *
 * Props:
 *   expectedReturnTime  — local HH:MM string ("13:30") or "" / null
 *   overdueMinutes      — integer 0+ if returned past ETA, else null/undefined
 *
 * Colour logic:
 *   • green  → not yet due, more than 15 min away
 *   • amber  → due within 15 min, OR just-overdue (≤ 5 min late)
 *   • red    → > 5 min overdue
 *
 * Renders nothing if no ETA is set (escort/member stepped out without
 * specifying an expected return time).
 */
export function ExpectedReturnPill({ expectedReturnTime, overdueMinutes, testId }) {
  if (!expectedReturnTime) return null;

  const overdue = typeof overdueMinutes === "number" && overdueMinutes > 0;
  // Approximate "minutes until due" from overdue: if not overdue, we
  // don't get a precise countdown from the backend — fall back to a
  // single green pill ("Due HH:MM"). Amber-when-approaching needs a
  // client-side clock; we keep this lightweight and recompute below
  // from the HH:MM string against the local clock.
  let tone;
  if (overdue) {
    tone = overdueMinutes > 5 ? "red" : "amber";
  } else {
    const minsUntil = minutesUntilLocalHm(expectedReturnTime);
    tone = minsUntil !== null && minsUntil <= 15 ? "amber" : "green";
  }

  const palette = {
    green: { bg: "bg-emerald-100", fg: "text-emerald-800", border: "border-emerald-200", Icon: Clock },
    amber: { bg: "bg-amber-100",   fg: "text-amber-800",   border: "border-amber-200",   Icon: Clock },
    red:   { bg: "bg-red-100",     fg: "text-red-800",     border: "border-red-200",     Icon: AlertTriangle },
  }[tone];

  const lateLabel = overdue
    ? ` · ${overdueMinutes}m late`
    : "";

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold border ${palette.bg} ${palette.fg} ${palette.border} shrink-0`}
      data-testid={testId}
      title={overdue
        ? `Was due back at ${expectedReturnTime} — ${overdueMinutes} minute${overdueMinutes === 1 ? "" : "s"} overdue`
        : `Expected back at ${expectedReturnTime}`}
    >
      <palette.Icon size={9}/>
      Due {expectedReturnTime}{lateLabel}
    </span>
  );
}

/** Returns minutes from now until the next local-time HH:MM. Positive = future,
 * negative = already past (treated as overdue but the server-side
 * overdueMinutes takes precedence when present). null on parse failure. */
function minutesUntilLocalHm(hm) {
  if (!hm || typeof hm !== "string") return null;
  const [h, m] = hm.split(":").map((x) => parseInt(x, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  const now = new Date();
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  return Math.round((target.getTime() - now.getTime()) / 60000);
}
