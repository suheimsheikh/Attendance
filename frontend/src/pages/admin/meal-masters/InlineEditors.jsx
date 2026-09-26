/**
 * MealMastersTab inline editors — small self-contained click-to-edit
 * cells used across the Masters tree. Extracted 25 Jun 2026 (pure move).
 */
import React, { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { fmt, fmtRs } from "./helpers";

export function InlineEdit({ value, onSave, onCancel, testid }) {
  const [v, setV] = useState(value);
  return (
    <span className="inline-flex items-center gap-1">
      <input
        autoFocus
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSave(v.trim());
          if (e.key === "Escape") onCancel();
        }}
        className="iu-input !h-7 !w-44 text-sm"
        data-testid={testid}
      />
      <button onClick={() => onSave(v.trim())} className="p-1 rounded hover:bg-emerald-100 text-emerald-700" data-testid={`${testid}-save`} title="Save"><Check size={14}/></button>
      <button onClick={onCancel} className="p-1 rounded hover:bg-slate-100 text-slate-500" title="Cancel"><X size={14}/></button>
    </span>
  );
}

// Inline number cell — displays a value, click to turn into an input. Used
// for editable Opening Stock and Min Level columns in the Masters tree so
// admins don't need a separate `⋯` panel. Enter/blur saves, Escape cancels.
export function InlineNum({ value, onSave, testid, hint, unit }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value ?? 0);
  useEffect(() => { setV(value ?? 0); }, [value]);
  if (!editing) {
    return (
      <button
        className="w-full text-right px-1 py-0.5 rounded hover:bg-white hover:ring-1 hover:ring-emerald-300 text-slate-800 font-semibold tabular-nums transition"
        onClick={() => setEditing(true)}
        data-testid={testid}
        title={hint || "Click to edit"}
      >
        {value == null || value === "" ? "—" : fmt(value, unit)}
      </button>
    );
  }
  const commit = () => {
    const n = parseFloat(v);
    setEditing(false);
    if (!isNaN(n) && n !== Number(value)) onSave(n);
  };
  return (
    <input
      autoFocus
      type="number"
      min="0"
      step="any"
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { setV(value ?? 0); setEditing(false); }
      }}
      className="iu-input !h-6 !w-full !py-0 !px-1.5 text-[11px] text-right tabular-nums"
      data-testid={`${testid}-input`}
    />
  );
}

// Tiny inline editor for the opening RATE (₹/unit) shown under the opening
// qty. Values opening stock before an item's first recorded purchase so
// closing / issue valuations aren't ₹0 for opening-only items.
export function InlineRate({ value, unit, onSave, testid }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value ?? 0);
  useEffect(() => { setV(value ?? 0); }, [value]);
  if (!editing) {
    return (
      <button
        className="w-full text-right text-[9px] leading-tight tabular-nums text-emerald-700 hover:underline underline-offset-2"
        onClick={() => setEditing(true)}
        data-testid={testid}
        title="Opening rate (₹ per unit) — click to edit. Used to value opening stock before the first purchase."
      >
        {Number(value) > 0 ? `@${fmtRs(value)}/${unit}` : "@₹—"}
      </button>
    );
  }
  const commit = () => {
    const n = parseFloat(v);
    setEditing(false);
    if (!isNaN(n) && n !== Number(value)) onSave(n);
  };
  return (
    <input
      autoFocus type="number" min="0" step="any" value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { setV(value ?? 0); setEditing(false); }
      }}
      className="iu-input !h-5 !w-full !py-0 !px-1 text-[10px] text-right tabular-nums"
      data-testid={`${testid}-input`}
    />
  );
}

// Inline as-of date pill for opening stock. Shown right under the
// opening qty / rate on Master rows so admins can see + edit when the
// opening balance was struck (Aug 2026 user ask).
export function InlineDate({ value, onSave, testid }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value || "");
  useEffect(() => { setV(value || ""); }, [value]);
  const display = value
    ? new Date(value + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" })
    : "set date";
  if (!editing) {
    return (
      <button
        className="w-full text-right text-[9px] leading-tight tabular-nums text-slate-500 hover:text-slate-700 hover:underline underline-offset-2"
        onClick={() => setEditing(true)}
        data-testid={testid}
        title="Opening stock as-of date — click to edit"
      >
        as of {display}
      </button>
    );
  }
  const commit = () => {
    setEditing(false);
    if (v && v !== (value || "")) onSave(v);
  };
  return (
    <input
      autoFocus type="date" value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { setV(value || ""); setEditing(false); }
      }}
      className="iu-input !h-5 !w-full !py-0 !px-1 text-[10px] text-right tabular-nums"
      data-testid={`${testid}-input`}
    />
  );
}

// Inline unit picker — small transparent-looking select that saves on
// change. Used in the Masters tree Unit column.
export function InlineUnit({ value, options, onSave, testid }) {
  return (
    <select
      value={value}
      onChange={(e) => e.target.value !== value && onSave(e.target.value)}
      className="w-full h-6 text-[10px] font-bold uppercase text-slate-600 bg-transparent border border-transparent hover:bg-white hover:ring-1 hover:ring-emerald-300 rounded px-1 text-center transition cursor-pointer"
      data-testid={testid}
      title="Change unit"
    >
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}
