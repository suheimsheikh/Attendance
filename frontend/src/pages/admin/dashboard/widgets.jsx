/**
 * Dashboard widgets — small reusable presentational components used by
 * the admin dashboard shell. Extracted from Dashboard.jsx on 15 Feb
 * 2026 as part of the incremental split.
 *
 * Everything here is pure — no state, no fetching, no side effects.
 */
import React from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";

export const CATEGORY_COLOR = {
  athlete:   "bg-sky-100 text-sky-800",
  coach:     "bg-emerald-100 text-emerald-800",
  staff:     "bg-amber-100 text-amber-800",
  executive: "bg-violet-100 text-violet-800",
};

/** Big number tile — used in the "Now" strip and the "This month"
 *  strip. If `to` is set, the whole tile is a Link.
 */
export function StatTile({ label, value, sub, icon: Icon, tone = "slate", to, testid }) {
  const toneMap = {
    slate:   "bg-white border-slate-200",
    emerald: "bg-emerald-50 border-emerald-200",
    amber:   "bg-amber-50 border-amber-200",
    rose:    "bg-rose-50 border-rose-200",
    sky:     "bg-sky-50 border-sky-200",
    violet:  "bg-violet-50 border-violet-200",
  };
  const iconTone = {
    slate:   "text-slate-400",
    emerald: "text-emerald-500",
    amber:   "text-amber-500",
    rose:    "text-rose-500",
    sky:     "text-sky-500",
    violet:  "text-violet-500",
  };
  const inner = (
    <div
      className={`relative flex flex-col justify-between rounded-2xl border ${toneMap[tone]} p-4 h-full min-h-[112px] transition hover:shadow-md hover:-translate-y-0.5 duration-150`}
      data-testid={testid}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          {label}
        </span>
        {Icon && <Icon size={16} className={iconTone[tone]} />}
      </div>
      <div>
        <div className="text-3xl font-black tabular-nums text-slate-900 leading-none mt-2">
          {value}
        </div>
        {sub && (
          <div className="text-xs text-slate-500 mt-1.5 leading-tight">
            {sub}
          </div>
        )}
      </div>
      {to && (
        <ArrowRight
          size={14}
          className="absolute bottom-3 right-3 text-slate-300 group-hover:text-slate-500"
        />
      )}
    </div>
  );
  return to ? (
    <Link to={to} className="group block h-full">
      {inner}
    </Link>
  ) : (
    inner
  );
}

/** Compact A·C·S·E breakdown under an on-campus tile. */
export function CategoryChips({ counts }) {
  const items = [
    { key: "athlete", label: "A", tone: "text-sky-700" },
    { key: "coach", label: "C", tone: "text-emerald-700" },
    { key: "staff", label: "S", tone: "text-amber-700" },
    { key: "executive", label: "E", tone: "text-violet-700" },
  ];
  return (
    <div className="flex gap-1.5 flex-wrap" data-testid="dashboard-onsite-breakdown">
      {items.map((it) => {
        const n = counts?.[it.key] ?? 0;
        return (
          <span
            key={it.key}
            className={`inline-flex items-center gap-1 px-1.5 rounded font-mono text-[10px] font-bold ${it.tone} ${n === 0 ? "opacity-40" : ""}`}
          >
            {it.label}·{n}
          </span>
        );
      })}
    </div>
  );
}

/** 7-day dual-line sparkline (athletes solid + staff dashed). */
export function Sparkline({ points }) {
  if (!points || points.length === 0) {
    return <div className="text-xs text-slate-400">No data</div>;
  }
  const w = 280, h = 60, pad = 4;
  const maxVal = Math.max(
    1,
    ...points.map((p) => Math.max(p.athletes || 0, p.staff || 0)),
  );
  const step = (w - 2 * pad) / Math.max(1, points.length - 1);
  const toPath = (key) => points.map((p, i) => {
    const x = pad + i * step;
    const y = h - pad - ((p[key] || 0) / maxVal) * (h - 2 * pad);
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const lastAth = points[points.length - 1]?.athletes ?? 0;
  const lastStaff = points[points.length - 1]?.staff ?? 0;
  return (
    <div>
      <svg width={w} height={h} className="block" data-testid="dashboard-sparkline">
        <path d={toPath("athletes")} stroke="#0284c7" strokeWidth="2" fill="none" />
        <path d={toPath("staff")} stroke="#059669" strokeWidth="2" fill="none" strokeDasharray="3,3" />
      </svg>
      <div className="flex gap-3 mt-1 text-[11px] text-slate-500">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-sky-600 inline-block" /> Athletes today: <b className="text-slate-800">{lastAth}</b>
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-emerald-600 inline-block" /> Staff/coaches today: <b className="text-slate-800">{lastStaff}</b>
        </span>
      </div>
    </div>
  );
}

/** Locale-aware "27 Jun" → matches the pill format used on Dashboard. */
export function fmtShortDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: "2-digit", month: "short" });
  } catch {
    return iso;
  }
}

/** "27 Jun → 3 Jul" for a range; single date if a === b. */
export function fmtRange(a, b) {
  const sa = fmtShortDate(a);
  const sb = fmtShortDate(b);
  return sa === sb ? sa : `${sa} → ${sb}`;
}

/** Boxed card with a small uppercase title + optional right-side action. */
export function SectionCard({ title, testid, children, action }) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4" data-testid={testid}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold uppercase tracking-widest text-slate-700">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

/** One row in the Attention rail — label + numeric pill, linkified. */
export function AttentionRow({ label, value, to, testid, tone = "slate" }) {
  const toneMap = {
    slate:  "bg-slate-100 text-slate-700",
    amber:  "bg-amber-100 text-amber-800",
    rose:   "bg-rose-100 text-rose-800",
    sky:    "bg-sky-100 text-sky-800",
  };
  const active = value > 0;
  return (
    <li>
      <Link
        to={to}
        className={`flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-sm transition ${active ? "hover:bg-slate-50" : "opacity-50 hover:bg-slate-50"}`}
        data-testid={testid}
      >
        <span className="text-slate-700">{label}</span>
        <span className={`inline-flex px-2 py-0.5 rounded-full font-mono text-[11px] font-bold min-w-[28px] justify-center ${active ? toneMap[tone] : "bg-slate-100 text-slate-400"}`}>
          {value}
        </span>
      </Link>
    </li>
  );
}

/** One shortcut chip at the bottom of the Attention rail. */
export function ShortcutBtn({ to, icon: Icon, label, testid }) {
  return (
    <Link
      to={to}
      className="flex items-center gap-2 px-3 h-11 rounded-lg border border-slate-200 hover:bg-slate-50 text-sm font-semibold text-slate-700 transition"
      data-testid={testid}
    >
      <Icon size={16} className="text-slate-500" />
      {label}
    </Link>
  );
}
