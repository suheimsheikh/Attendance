import React from "react";
import { LogIn, LogOut as ExitIcon, Coffee, AlertTriangle } from "lucide-react";

/**
 * Compact session timeline shown when a Presence row is expanded.
 * Lays out check-in → step-outs → returns → check-out as a vertical
 * stripe, mirroring the old Daily Sessions page so the merger is lossless.
 */
export function SessionTimeline({ m }) {
  const items = [];
  if (m.check_in_at) {
    items.push({
      key: `in-${m.check_in_at}`,
      icon: <LogIn size={11}/>,
      color: "#10B981",
      title: "Checked in",
      time: m.check_in_time,
      note: m.late ? `Late ${m.late_minutes || ""}m` : (m.geo_in?.out_of_geofence ? "Off-site" : ""),
    });
  }
  (m.excursions || []).forEach((e) => {
    items.push({
      key: `out-${e.id}`,
      icon: <Coffee size={11}/>,
      color: "#06B6D4",
      title: `Stepped out${e.reason ? " · " + e.reason : ""}`,
      time: e.out_time,
      note: e.expected_return_time ? `Expected back ${e.expected_return_time}` : "",
    });
    if (e.in_time) {
      items.push({
        key: `back-${e.id}`,
        icon: <LogIn size={11}/>,
        color: "#0EA5E9",
        title: "Returned",
        time: e.in_time,
        note: (e.duration_min != null ? `${e.duration_min}m away` : "")
              + (e.overdue_min ? ` · ${e.overdue_min}m overdue` : ""),
        overdue: !!e.overdue_min,
      });
    } else {
      items.push({
        key: `pending-${e.id}`,
        icon: <AlertTriangle size={11}/>,
        color: "#F59E0B",
        title: "Still away",
        time: "",
        note: e.expected_return_time ? `Expected back ${e.expected_return_time}` : "Awaiting return",
        overdue: !!e.overdue_min,
      });
    }
  });
  if (m.check_out_at) {
    items.push({
      key: `co-${m.check_out_at}`,
      icon: <ExitIcon size={11}/>,
      color: "#6B7280",
      title: m.auto_checkout ? "Auto-closed at midnight" : "Checked out",
      time: m.check_out_time,
      note: m.stored_hours != null ? `${m.stored_hours}h logged` : "",
    });
  }
  if (items.length === 0) return null;
  return (
    <div
      className="px-3 pb-3 pl-12 bg-slate-50/70 border-t border-slate-100"
      data-testid={`presence-timeline-${m.id}`}
    >
      <ol className="relative pl-4 pt-2">
        <span className="absolute left-[5px] top-3 bottom-1 w-px bg-slate-200" />
        {items.map((it) => (
          <li key={it.key} className="relative pb-2 last:pb-0">
            <span className="absolute -left-[11px] top-0.5 w-[14px] h-[14px] rounded-full flex items-center justify-center text-white" style={{ background: it.color }}>
              {it.icon}
            </span>
            <div className="flex items-baseline gap-1.5 flex-wrap pl-2">
              <span className="text-[11px] font-semibold text-slate-900">{it.title}</span>
              {it.time && <span className="text-[10px] font-mono text-slate-500">{it.time}</span>}
              {it.note && <span className={`text-[10px] ${it.overdue ? "text-amber-700 font-semibold" : "text-slate-500"}`}>· {it.note}</span>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
