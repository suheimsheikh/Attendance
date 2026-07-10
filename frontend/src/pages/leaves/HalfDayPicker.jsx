/**
 * HalfDayPicker — the "Half-day only" checkbox + FN/PN pill selector
 * used on the leave apply form. Only relevant when leave type = leave
 * AND range is a single day.
 *
 * halfDay ∈ null | "FN" | "PN". null means full-day. When set,
 * `end_date` on the parent form is locked to `start_date`.
 *
 * Extracted from MyLeaves.jsx on 15 Feb 2026.
 */
import React from "react";

export default function HalfDayPicker({ halfDay, onChange, windows }) {
  return (
    <div
      className="mt-3 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2.5"
      data-testid="half-day-block"
    >
      <label className="inline-flex items-center gap-2 text-[12px] font-semibold text-slate-800 cursor-pointer">
        <input
          type="checkbox"
          checked={!!halfDay}
          onChange={(e) => onChange(e.target.checked ? "FN" : null)}
          data-testid="half-day-toggle"
        />
        Half-day only (single day, consumes 0.5 from balance)
      </label>
      {halfDay && (
        <div className="mt-2 flex flex-wrap gap-2 items-center">
          <button
            type="button"
            onClick={() => onChange("FN")}
            data-testid="half-day-fn"
            className={`px-2.5 py-1 rounded-md text-[11px] font-bold border transition ${halfDay === "FN" ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-300 hover:border-slate-500"}`}
          >
            Forenoon · {windows.fn}
          </button>
          <button
            type="button"
            onClick={() => onChange("PN")}
            data-testid="half-day-pn"
            className={`px-2.5 py-1 rounded-md text-[11px] font-bold border transition ${halfDay === "PN" ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-300 hover:border-slate-500"}`}
          >
            Postnoon · {windows.pn}
          </button>
          <span className="text-[11px] text-slate-500">
            End date will be locked to the start date.
          </span>
        </div>
      )}
    </div>
  );
}
