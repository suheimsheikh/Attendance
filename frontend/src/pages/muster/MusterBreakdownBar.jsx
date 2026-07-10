/**
 * Sticky breakdown bar — mirrors the per-category chip row on Presence
 * columns. Shows B/G/other split + already-in count + ticked count.
 * Stays visible while the roster scrolls so the coach always sees the
 * live counts for the currently filtered set.
 *
 * Extracted from Muster.jsx on 15 Feb 2026 (pure presentational).
 */
import React from "react";

export default function MusterBreakdownBar({ breakdown, mode, pickedCount }) {
  return (
    <div
      className="sticky top-0 z-10 -mx-1 px-1 py-2 mb-2 bg-white/95 backdrop-blur border-y border-slate-200 flex items-center gap-1.5 flex-wrap"
      data-testid="muster-breakdown"
    >
      <span className="text-[11px] uppercase tracking-wider font-bold text-slate-500 mr-1">
        Breakdown
      </span>
      {breakdown.boys > 0 && (
        <span
          className="inline-flex items-center gap-1 px-1.5 h-5 rounded text-[11px] font-bold bg-sky-100 text-sky-700"
          data-testid="muster-breakdown-boys"
          title={`${breakdown.boys} boys`}
        >
          B {breakdown.boys}
        </span>
      )}
      {breakdown.girls > 0 && (
        <span
          className="inline-flex items-center gap-1 px-1.5 h-5 rounded text-[11px] font-bold bg-pink-100 text-pink-700"
          data-testid="muster-breakdown-girls"
          title={`${breakdown.girls} girls`}
        >
          G {breakdown.girls}
        </span>
      )}
      {breakdown.other > 0 && (
        <span
          className="inline-flex items-center gap-1 px-1.5 h-5 rounded text-[11px] font-bold bg-slate-100 text-slate-700"
          data-testid="muster-breakdown-other"
          title={`${breakdown.other} unspecified gender`}
        >
          ◇ {breakdown.other}
        </span>
      )}
      {mode === "checkin" && breakdown.lockedIn > 0 && (
        <span
          className="inline-flex items-center gap-1 px-1.5 h-5 rounded text-[11px] font-bold bg-emerald-100 text-emerald-700"
          data-testid="muster-breakdown-locked"
          title={`${breakdown.lockedIn} already checked in`}
        >
          ✓ {breakdown.lockedIn} in
        </span>
      )}
      {pickedCount > 0 && (
        <span
          className="inline-flex items-center gap-1 px-1.5 h-5 rounded text-[11px] font-bold bg-emerald-600 text-white ml-auto"
          data-testid="muster-breakdown-picked"
          title={`${pickedCount} ticked`}
        >
          ☑ {pickedCount}
        </span>
      )}
    </div>
  );
}
