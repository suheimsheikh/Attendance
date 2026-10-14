import React from "react";

/** Subtle "Press Esc to close" hint for modal footers. */
export default function EscHint({ className = "" }) {
  return (
    <span className={`text-[11px] text-slate-400 inline-flex items-center gap-1 select-none ${className}`} data-testid="esc-hint">
      Press
      <kbd className="px-1 py-0.5 rounded border border-slate-300 bg-slate-50 font-mono text-[10px] leading-none text-slate-500">Esc</kbd>
      to close
    </span>
  );
}
