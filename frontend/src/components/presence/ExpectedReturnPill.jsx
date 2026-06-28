import React from "react";
import { Clock, AlertTriangle } from "lucide-react";

/**
 * ExpectedReturnPill — small colour-coded badge for stepped-out rows
 * (members in the temp_out column AND escorts in the column sub-section
 * and the EscortsStrip).
 *
 * Props:
 *   expectedReturnTime  — local HH:MM string ("13:30") for display
 *   expectedReturnIso   — server-side absolute ISO datetime, used for
 *                         tz-safe "amber when approaching" calculation.
 *                         Falls back to HH:MM-against-browser-clock
 *                         when absent (legacy callers).
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
export function ExpectedReturnPill({ expectedReturnTime, expectedReturnIso, overdueMinutes, testId }) {
  if (!expectedReturnTime) return null;

  const overdue = typeof overdueMinutes === "number" && overdueMinutes > 0;
  let tone;
  if (overdue) {
    tone = overdueMinutes > 5 ? "red" : "amber";
  } else {
    // Prefer the server's ISO timestamp — it carries a real tz offset
    // so `new Date(iso) - Date.now()` is tz-safe regardless of where
    // the admin is viewing from. Falls back to the HH:MM-against-
    // browser-clock approximation for legacy callers without ISO.
    const minsUntil = expectedReturnIso
      ? minutesUntilIso(expectedReturnIso)
      : minutesUntilLocalHm(expectedReturnTime);
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

/** Returns minutes from now until the server-provided absolute ISO
 * datetime. Positive = future, negative = already past. Tz-safe (both
 * sides reduce to absolute time). null on parse failure. */
function minutesUntilIso(iso) {
  if (!iso || typeof iso !== "string") return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.round((t - Date.now()) / 60000);
}

/** Returns minutes from now until the next local-time HH:MM. Positive = future,
 * negative = already past (treated as overdue but the server-side
 * overdueMinutes takes precedence when present). null on parse failure.
 * Browser-clock based — only used as a fallback when no ISO is supplied. */
function minutesUntilLocalHm(hm) {
  if (!hm || typeof hm !== "string") return null;
  const [h, m] = hm.split(":").map((x) => parseInt(x, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  const now = new Date();
  const target = new Date(now);
  target.setHours(h, m, 0, 0);
  return Math.round((target.getTime() - now.getTime()) / 60000);
}
