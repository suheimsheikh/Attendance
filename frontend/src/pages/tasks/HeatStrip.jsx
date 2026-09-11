import React from "react";
import { Flame } from "lucide-react";

const fmtLong = (iso) => iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }) : "";
const fmtWeekday = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short" });
const fmtDayNum = (iso) => new Date(iso + "T00:00:00").getDate();
const heatIntensity = (total) => total === 0 ? "bg-slate-50 text-slate-400 hover:bg-slate-100"
  : total <= 2 ? "bg-indigo-100 text-indigo-800 hover:bg-indigo-200"
  : total <= 5 ? "bg-indigo-300 text-indigo-900 hover:bg-indigo-400"
  : "bg-indigo-600 text-white hover:bg-indigo-700";

/** Compact 7-day due/overdue strip. Clicking a day calls onPick(date). */
export default function HeatStrip({ heat, viewDate, scope, onPick }) {
  if (!heat) return null;
  return (
    <div className="mb-3" data-testid="task-heatstrip">
      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Your week at a glance {scope === "mine" ? "(mine)" : "(everyone)"}</div>
      <div className="grid grid-cols-7 gap-1">
        {heat.days.map((d) => {
          const total = d.due + d.overdue;
          const active = d.date === viewDate;
          return (
            <button key={d.date} onClick={() => onPick(d.date)} data-testid={`heat-day-${d.date}`}
                    aria-label={`${fmtLong(d.date)}: ${d.due} due${d.overdue ? `, ${d.overdue} overdue` : ""}${d.urgent ? `, ${d.urgent} urgent` : ""}`}
                    title={`${d.due} due${d.overdue ? ` · ${d.overdue} overdue` : ""}${d.urgent ? ` · ${d.urgent} urgent` : ""}`}
                    className={`relative rounded-lg py-1.5 text-center transition-colors ${heatIntensity(total)} ${active ? "ring-2 ring-indigo-500" : ""}`}>
              {d.urgent > 0 && <Flame size={9} className="absolute top-1 right-1 text-rose-500" />}
              <div className="text-[9px] font-bold uppercase opacity-70">{fmtWeekday(d.date)}</div>
              <div className="text-sm font-extrabold leading-tight">{fmtDayNum(d.date)}</div>
              <div className="text-[10px] font-semibold h-3 leading-3">{total > 0 ? total : ""}</div>
              {d.overdue > 0 && <div className="text-[8px] font-bold text-rose-600 leading-none">{d.overdue} od</div>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
