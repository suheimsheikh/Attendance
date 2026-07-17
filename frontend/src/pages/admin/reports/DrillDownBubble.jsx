import React from "react";

/**
 * Portal-rendered hover bubble that lists the exact dates behind a
 * count cell. Positioned above the hovered cell (centred), auto-flips
 * below when the cell is near the top edge of the viewport.
 * Rendered by Reports.jsx via `ReactDOM.createPortal(...)`.
 */
export default function DrillDownBubble({ tip }) {
  const { x, y, label, dates } = tip;
  const flipBelow = y < 140; // not enough room above
  const style = {
    position: "fixed",
    left: `${x}px`,
    top: `${y + (flipBelow ? 24 : -8)}px`,
    transform: flipBelow
      ? "translate(-50%, 0)"
      : "translate(-50%, -100%)",
    zIndex: 100,
    pointerEvents: "none",
    maxWidth: "240px",
  };
  const pretty = (dates || []).map((d) => {
    try {
      const dt = new Date(d + "T00:00:00");
      return dt.toLocaleDateString(undefined,
        { day: "2-digit", month: "short", weekday: "short" });
    } catch { return d; }
  });
  return (
    <div style={style} data-testid="drilldown-tooltip">
      <div className="rounded-lg bg-slate-900 text-white text-[11px] px-3 py-2 shadow-xl ring-1 ring-slate-700">
        <div className="font-bold uppercase tracking-wide text-[10px] text-slate-300 mb-1">
          {label} · {dates.length}
        </div>
        <ul className="leading-tight space-y-0.5">
          {pretty.map((p, i) => <li key={dates[i]} className="tabular-nums">{p}</li>)}
        </ul>
      </div>
    </div>
  );
}
