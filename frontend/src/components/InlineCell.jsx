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
 *  - kind: "text" | "number" | "select" | "tel" | "date" | "time" | "checkbox"
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

  // ── Checkbox fast path — no edit/display split. Toggles on click and
  // persists immediately; no Enter/Escape flow needed. Renders whatever
  // `renderDisplay` returns (typically a badge). Falls back to a native
  // checkbox if no renderDisplay is provided.
  if (kind === "checkbox") {
    const checked = !!value;
    const toggle = async (e) => {
      e.stopPropagation();
      if (disabled || busy) return;
      setBusy(true);
      try {
        await onSave(!checked);
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 1200);
      } catch { /* parent shows the toast; keep our state as-is */ }
      finally { setBusy(false); }
    };
    return (
      <button
        type="button"
        disabled={disabled || busy}
        data-testid={testId}
        onClick={toggle}
        className={`group inline-flex items-center gap-1 text-left px-1 -mx-1 rounded transition hover:bg-sky-50/60 cursor-pointer ${className}`}
        title={disabled ? "Read-only" : `Click to toggle (currently ${checked ? "on" : "off"})`}
      >
        <span className="flex-1 min-w-0 truncate">
          {renderDisplay ? renderDisplay(checked) : (
            <input type="checkbox" checked={checked} readOnly className="pointer-events-none w-3.5 h-3.5 accent-sky-600" />
          )}
        </span>
        {busy && <Loader2 size={11} className="animate-spin text-slate-400 shrink-0" />}
        {!busy && savedFlash && <Check size={11} className="text-emerald-600 shrink-0" />}
      </button>
    );
  }

  // ── Display layer (idle state) ────────────────────────────────────────────
  if (!editing) {
    return (
      <DisplayCell
        value={value}
        testId={testId}
        disabled={disabled}
        className={className}
        placeholder={placeholder}
        busy={busy}
        savedFlash={savedFlash}
        renderDisplay={renderDisplay}
        format={format}
        onEdit={() => setEditing(true)}
      />
    );
  }

  // ── Edit layer ────────────────────────────────────────────────────────────
  const cancel = () => { setDraft(value ?? ""); setEditing(false); };

  if (kind === "select") {
    return (
      <EditSelect
        inputRef={inputRef}
        testId={testId}
        draft={draft}
        busy={busy}
        options={options}
        className={className}
        onCommit={commit}
        onCancel={cancel}
        onBlur={() => setEditing(false)}
      />
    );
  }
  return (
    <EditInput
      inputRef={inputRef}
      kind={kind}
      testId={testId}
      draft={draft}
      busy={busy}
      placeholder={placeholder}
      className={className}
      onChange={setDraft}
      onCommit={() => commit(draft)}
      onCancel={cancel}
    />
  );
}

// ── Helper sub-components ──────────────────────────────────────────────────
// Kept inside this module because they're not useful anywhere else and
// keep the file self-contained. Each is small enough to be obvious.

function DisplayCell({ value, testId, disabled, className, placeholder, busy, savedFlash, renderDisplay, format, onEdit }) {
  const empty = value == null || value === "";
  return (
    <button
      type="button"
      disabled={disabled}
      data-testid={testId}
      onClick={(e) => { e.stopPropagation(); if (!disabled) onEdit(); }}
      className={`group inline-flex items-center gap-1 text-left px-1 -mx-1 rounded transition
        ${disabled ? "cursor-not-allowed opacity-60" : "hover:bg-sky-50/60 cursor-text"} ${className}`}
      title={disabled ? "Read-only" : "Click to edit"}
    >
      <span className="flex-1 min-w-0 truncate">
        {renderDisplay
          ? renderDisplay(value)
          : empty
            ? <span className="text-slate-300">{placeholder}</span>
            : (format ? format(value) : String(value))}
      </span>
      {busy && <Loader2 size={11} className="animate-spin text-slate-400 shrink-0" />}
      {!busy && savedFlash && <Check size={11} className="text-emerald-600 shrink-0" />}
    </button>
  );
}

const editInputCls =
  "w-full min-w-0 px-2 h-7 text-xs rounded border border-sky-400 bg-white focus:ring-2 focus:ring-sky-200 outline-none";

function EditSelect({ inputRef, testId, draft, busy, options, className, onCommit, onCancel, onBlur }) {
  return (
    <select
      ref={inputRef}
      data-testid={testId}
      value={draft ?? ""}
      disabled={busy}
      onChange={(e) => onCommit(e.target.value)}
      onBlur={onBlur}
      onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
      className={editInputCls + " " + className}
    >
      {(options || []).map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

function EditInput({ inputRef, kind, testId, draft, busy, placeholder, className, onChange, onCommit, onCancel }) {
  const inputType = kind === "number" ? "number"
    : kind === "tel" ? "tel"
    : kind === "date" ? "date"
    : kind === "time" ? "time"
    : "text";
  return (
    <input
      ref={inputRef}
      type={inputType}
      data-testid={testId}
      value={draft ?? ""}
      disabled={busy}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") onCancel();
      }}
      step={kind === "number" ? "0.5" : undefined}
      className={editInputCls + " " + className}
    />
  );
}
