import React, { useEffect, useRef, useState } from "react";
import { Loader2, Check } from "lucide-react";

/**
 * InlineCell — a single inline-editable cell.
 *
 * Used in the Members admin table to let admins tweak common fields
 * (name, category, role, rank, mobile, gender, fleet, leave balance,
 * institution, weekly-off) in place, without opening the modal.
 *
 * Behaviour:
 *  - text/number: save on blur or Enter, cancel on Esc.
 *  - select:      save on change (no blur step needed for dropdowns).
 *  - Optimistic local update + revert on error.
 *  - Shows a green check for ~1.2s after a successful save.
 *
 * Required props:
 *  - value: current value (string|number|null)
 *  - onSave: async (newValue) => void   — throws on failure to trigger revert
 *  - kind: "text" | "number" | "select" | "tel"
 *  - testId: string                     — used as data-testid
 *
 * Optional:
 *  - options: [{value, label}]   when kind === "select"
 *  - placeholder, className, disabled, required
 *  - renderDisplay: (value) => JSX  — overrides the static display layer
 *      (e.g. render the Fleet pill, the category badge, etc.)
 *  - format: (v) => string          — display formatter for the static view
 *  - normalise: (raw) => any        — runs on the user-entered value before save
 */
export default function InlineCell({
  value,
  onSave,
  kind = "text",
  testId,
  options,
  placeholder = "—",
  className = "",
  disabled = false,
  required = false,
  renderDisplay,
  format,
  normalise,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [busy, setBusy] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const inputRef = useRef(null);

  // Re-sync if a parent refresh brings a fresh value while we're idle.
  useEffect(() => {
    if (!editing) setDraft(value ?? "");
  }, [value, editing]);

  // Auto-focus on edit-mode entry.
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      if (kind !== "select" && inputRef.current.select) inputRef.current.select();
    }
  }, [editing, kind]);

  const commit = async (raw) => {
    const next = normalise ? normalise(raw) : raw;
    const curr = value ?? (kind === "number" ? null : "");
    // No-op if unchanged (string-compare handles number↔null safely).
    if (String(next ?? "") === String(curr ?? "")) {
      setEditing(false);
      return;
    }
    if (required && (next === "" || next == null)) {
      // Silently revert — required fields can't be cleared inline.
      setDraft(value ?? "");
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await onSave(next);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1200);
      setEditing(false);
    } catch {
      setDraft(value ?? "");
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  // ── Display layer (idle state) ────────────────────────────────────────────
  if (!editing) {
    return (
      <button
        type="button"
        disabled={disabled}
        data-testid={testId}
        onClick={(e) => { e.stopPropagation(); if (!disabled) setEditing(true); }}
        className={`group inline-flex items-center gap-1 text-left px-1 -mx-1 rounded transition
          ${disabled ? "cursor-not-allowed opacity-60" : "hover:bg-sky-50/60 cursor-text"} ${className}`}
        title={disabled ? "Read-only" : "Click to edit"}
      >
        <span className="flex-1 min-w-0 truncate">
          {renderDisplay
            ? renderDisplay(value)
            : (value == null || value === "")
              ? <span className="text-slate-300">{placeholder}</span>
              : (format ? format(value) : String(value))}
        </span>
        {busy
          ? <Loader2 size={11} className="animate-spin text-slate-400 shrink-0" />
          : savedFlash
            ? <Check size={11} className="text-emerald-600 shrink-0" />
            : null}
      </button>
    );
  }

  // ── Edit layer ────────────────────────────────────────────────────────────
  const commonInputCls =
    "w-full min-w-0 px-2 h-7 text-xs rounded border border-sky-400 bg-white focus:ring-2 focus:ring-sky-200 outline-none";

  if (kind === "select") {
    return (
      <select
        ref={inputRef}
        data-testid={testId}
        value={draft ?? ""}
        disabled={busy}
        onChange={(e) => commit(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => { if (e.key === "Escape") { setDraft(value ?? ""); setEditing(false); } }}
        className={commonInputCls + " " + className}
      >
        {(options || []).map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    );
  }

  return (
    <input
      ref={inputRef}
      type={kind === "number" ? "number" : kind === "tel" ? "tel" : "text"}
      data-testid={testId}
      value={draft ?? ""}
      disabled={busy}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => commit(draft)}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") { setDraft(value ?? ""); setEditing(false); }
      }}
      step={kind === "number" ? "0.5" : undefined}
      className={commonInputCls + " " + className}
    />
  );
}
