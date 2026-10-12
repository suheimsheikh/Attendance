import React from "react";

// Mon..Sun editor for per-day-of-week work-timing overrides. Value shape:
//   { sat: { start: "08:00", end: "12:00" }, sun: { ... } }
// A blank day inherits the normal schedule. Employees only — athletes are
// camp-driven, so this is never rendered for them.
const DOW = [
  ["mon", "Monday"], ["tue", "Tuesday"], ["wed", "Wednesday"],
  ["thu", "Thursday"], ["fri", "Friday"], ["sat", "Saturday"], ["sun", "Sunday"],
];

export function DowHoursEditor({ value, onChange, testIdPrefix = "dow" }) {
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

  return (
    <div className="space-y-1.5" data-testid={`${testIdPrefix}-editor`}>
      {DOW.map(([key, label]) => {
        const day = v[key] || {};
        const isSet = !!(day.start || day.end);
        return (
          <div
            key={key}
            className={`flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors ${isSet ? "bg-emerald-100/70" : ""}`}
            data-testid={`${testIdPrefix}-row-${key}`}
          >
            <span className="w-20 md:w-24 text-sm font-semibold text-slate-700 shrink-0">{label}</span>
            <input
              data-testid={`${testIdPrefix}-${key}-start`}
              type="time"
              value={day.start || ""}
              onChange={(e) => setDay(key, "start", e.target.value)}
              className="iu-input !h-9 flex-1 min-w-0"
            />
            <span className="text-slate-400 text-xs shrink-0">to</span>
            <input
              data-testid={`${testIdPrefix}-${key}-end`}
              type="time"
              value={day.end || ""}
              onChange={(e) => setDay(key, "end", e.target.value)}
              className="iu-input !h-9 flex-1 min-w-0"
            />
            <button
              type="button"
              data-testid={`${testIdPrefix}-${key}-clear`}
              onClick={() => clearDay(key)}
              disabled={!isSet}
              className={`text-xs px-1 shrink-0 ${isSet ? "text-slate-400 hover:text-rose-500" : "text-transparent cursor-default"}`}
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
