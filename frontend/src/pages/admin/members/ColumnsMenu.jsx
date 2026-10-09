import React, { useEffect, useRef, useState } from "react";
import { Columns3, ArrowUp, ArrowDown, GripVertical, RotateCcw } from "lucide-react";
import { COLUMN_BY_KEY } from "./columns";

// "Columns" button: tick columns on/off, drag (or arrow) to reorder.
export default function ColumnsMenu({ cols }) {
  const [drag, setDrag] = useState(null);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <button type="button" className="iu-btn-secondary" data-testid="members-columns-btn" onClick={() => setOpen((o) => !o)}
        title="Choose which columns to show and drag them into any order — saved for you">
        <Columns3 size={16} /> Columns
      </button>
      {open && (
      <div className="absolute right-0 top-full mt-1 z-50 w-72 p-2 max-h-[70vh] overflow-y-auto bg-white border border-slate-200 rounded-xl shadow-xl" data-testid="members-columns-menu">
        <div className="flex items-center justify-between px-1 pb-2 border-b border-slate-100 mb-1">
          <span className="text-xs font-bold text-slate-600">Show &amp; order columns</span>
          <button type="button" onClick={cols.reset} className="text-[11px] text-slate-500 hover:text-slate-900 inline-flex items-center gap-1"
            data-testid="members-columns-reset" title="Back to the standard columns and order">
            <RotateCcw size={11} /> Reset
          </button>
        </div>
        {cols.order.map((k, i) => {
          const c = COLUMN_BY_KEY[k];
          return (
            <div key={k} draggable onDragStart={() => setDrag(k)} onDragOver={(e) => e.preventDefault()}
              onDrop={() => { cols.move(drag, k); setDrag(null); }} data-testid={`col-item-${k}`}
              className={`flex items-center gap-1.5 px-1 py-1 rounded hover:bg-slate-50 ${drag === k ? "opacity-40" : ""}`}>
              <GripVertical size={13} className="text-slate-300 cursor-grab" aria-label="Drag to reorder" />
              <label className="flex items-center gap-2 flex-1 text-xs cursor-pointer" title={c.help && c.help.includes(" ") ? c.help : undefined}>
                <input type="checkbox" checked={!cols.hidden.has(k)} onChange={() => cols.toggle(k)} data-testid={`col-toggle-${k}`} />
                {c.label}{c.isNew && <span className="text-[9px] font-bold text-emerald-600 uppercase">new</span>}
              </label>
              <button type="button" disabled={i === 0} onClick={() => cols.step(k, -1)} className="p-0.5 text-slate-400 hover:text-slate-800 disabled:opacity-20"
                title="Move left" data-testid={`col-up-${k}`}><ArrowUp size={12} /></button>
              <button type="button" disabled={i === cols.order.length - 1} onClick={() => cols.step(k, 1)} className="p-0.5 text-slate-400 hover:text-slate-800 disabled:opacity-20"
                title="Move right" data-testid={`col-down-${k}`}><ArrowDown size={12} /></button>
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}
