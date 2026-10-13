import React from "react";
import { Ban } from "lucide-react";

// Mon..Sun editor for per-day-of-week work-timing overrides. Value shape:
//   { sat: { start: "08:00", end: "12:00" }, sun: { off: true } }
// A blank day inherits the normal schedule. `{ off: true }` marks the day
// as "not expected" (part-timers) — reflected in Presence and the Grid (NE).
// Employees only — athletes are camp-driven, so this is never rendered for them.
const DOW = [
  ["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"],
  ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"],
];

export function DowHoursEditor({ value, onChange, testIdPrefix = "dow", allowOff = false }) {
  const v = value || {};

  const setDay = (key, field, val) => {
    const day = { ...(v[key] || {}), [field]: val };
    const next = { ...v, [key]: day };
    if (!day.start && !day.end) delete next[key];
    onChange(next);
  };
  const clearDay = (key) => {
    const next = { ...v };
    delete next[key];
    onChange(next);
  };
  const toggleOff = (key, checked) => {
    const next = { ...v };
    if (checked) next[key] = { off: true }; // off clears any timings
    else delete next[key];
    onChange(next);
  };

  return (
    <div className="space-y-1.5" data-testid={`${testIdPrefix}-editor`}>
      {DOW.map(([key, label]) => {
        const day = v[key] || {};
        const isOff = day.off === true;
        const isSet = !!(day.start || day.end);
        return (
          <div
            key={key}
            className={`flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors ${isOff ? "bg-rose-100/70" : isSet ? "bg-emerald-100/70" : ""}`}
            data-testid={`${testIdPrefix}-row-${key}`}
          >
            <span className={`w-20 md:w-24 text-sm font-semibold shrink-0 ${isOff ? "text-rose-600 line-through" : "text-slate-700"}`}>{label}</span>
            <input
              data-testid={`${testIdPrefix}-${key}-start`}
              type="time"
              value={day.start || ""}
              disabled={isOff}
              onChange={(e) => setDay(key, "start", e.target.value)}
              className="iu-input !h-9 flex-1 min-w-0 disabled:opacity-40 disabled:bg-slate-50"
            />
            <span className="text-slate-400 text-xs shrink-0">to</span>
            <input
              data-testid={`${testIdPrefix}-${key}-end`}
              type="time"
              value={day.end || ""}
              disabled={isOff}
              onChange={(e) => setDay(key, "end", e.target.value)}
              className="iu-input !h-9 flex-1 min-w-0 disabled:opacity-40 disabled:bg-slate-50"
            />
            {allowOff && (
              <label
                className={`flex items-center gap-1 text-xs shrink-0 cursor-pointer select-none ${isOff ? "text-rose-600 font-semibold" : "text-slate-400 hover:text-rose-500"}`}
                title="Not expected on this day (part-timer) — shown as 'NE' on the Grid and 'Not scheduled' in Presence"
              >
                <input
                  type="checkbox"
                  data-testid={`${testIdPrefix}-${key}-off`}
                  checked={isOff}
                  onChange={(e) => toggleOff(key, e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-slate-300 text-rose-600 focus:ring-rose-500"
                />
                <Ban size={12} className={isOff ? "" : "opacity-50"} />
                <span className="hidden sm:inline">Not expected</span>
              </label>
            )}
            <button
              type="button"
              data-testid={`${testIdPrefix}-${key}-clear`}
              onClick={() => clearDay(key)}
              disabled={!isSet && !isOff}
              className={`text-xs px-1 shrink-0 ${isSet || isOff ? "text-slate-400 hover:text-rose-500" : "text-transparent cursor-default"}`}
              title="Clear this day — inherit the normal schedule"
            >
              clear
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default DowHoursEditor;
