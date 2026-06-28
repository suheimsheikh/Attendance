import React, { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";

/**
 * Tiny per-cell editor for one parent_mobile field. Persists on blur or
 * Enter; shows a green check for ~1s after a successful save so the admin
 * can confirm without a toast spam.
 *
 * Extracted from Members.jsx — pure presentation, no shared state.
 */
export default function ParentInlineInput({ memberId, field, label, initial, onSave }) {
  const [val, setVal] = useState(initial || "");
  const [busy, setBusy] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  // Re-sync local state if a fresh reload from the server brings new data.
  useEffect(() => { setVal(initial || ""); }, [initial]);

  const persist = async () => {
    const trimmed = val.trim();
    if (trimmed === (initial || "").trim()) return;
    setBusy(true);
    try {
      await onSave(memberId, field, trimmed);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1200);
    } catch {
      setVal(initial || "");
    } finally {
      setBusy(false);
    }
  };

  // Background tint stays consistent per role. The `label` text itself now
  // shows the parent's NAME (truncated) when available — falling back to a
  // single-letter role badge for older records.
  const isFather = field === "father_mobile";
  const isMother = field === "mother_mobile";
  const labelColor = isFather ? "bg-sky-100 text-sky-700"
    : isMother ? "bg-pink-100 text-pink-700"
    : "bg-violet-100 text-violet-700";
  const isShortBadge = label && label.length <= 1;

  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`${isShortBadge ? "w-5 h-5" : "px-1.5 h-5 max-w-[200px] truncate"} rounded text-[10px] font-bold flex items-center justify-center ${labelColor}`}
        title={label}
      >
        {label}
      </span>
      <input
        type="tel"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={persist}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        placeholder="—"
        data-testid={`inline-${field}-${memberId}`}
        className="flex-1 min-w-0 px-2 h-7 text-xs font-mono rounded border border-slate-200 bg-white focus:bg-white focus:border-sky-400 focus:ring-1 focus:ring-sky-200 outline-none"
        disabled={busy}
      />
      {busy
        ? <Loader2 size={11} className="animate-spin text-slate-400" />
        : (savedFlash ? <Check size={11} className="text-emerald-600" /> : <span className="w-3" />)}
    </div>
  );
}
