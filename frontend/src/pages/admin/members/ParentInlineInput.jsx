import React, { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";

/**
 * Per-row parent editor — one horizontal strip for a single parent role
 * (father / mother / guardian). Two inputs in a single strip:
 *
 *   [role badge]  [editable NAME]  [editable MOBILE]
 *
 * Both fields persist on blur or Enter and show a green check for ~1 s
 * after a successful save. Extracted from Members.jsx — pure presentation,
 * no shared state.
 *
 * Props:
 *   memberId      — the member id these fields belong to
 *   field         — the mobile field key ("father_mobile" / "mother_mobile" /
 *                    "guardian_mobile") — drives the PATCH call
 *   nameField     — the name  field key ("father_name" / …)
 *   nameValue     — current parent name (string)
 *   initial       — current parent mobile (string)
 *   onSave        — (memberId, field, value) => Promise, resolves on success
 *   colorClass    — tailwind classes for the role badge tint
 *   defaultBadge  — 1-letter fallback shown before the name is filled in
 */
export default function ParentInlineInput({
  memberId, field, nameField, nameValue, initial, onSave, colorClass, defaultBadge,
}) {
  // Local drafts, re-synced when the parent reloads with fresh data.
  const [name, setName] = useState(nameValue || "");
  const [mobile, setMobile] = useState(initial || "");
  const [nameBusy, setNameBusy] = useState(false);
  const [mobileBusy, setMobileBusy] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);
  const [mobileSaved, setMobileSaved] = useState(false);

  useEffect(() => { setName(nameValue || ""); }, [nameValue]);
  useEffect(() => { setMobile(initial || ""); }, [initial]);

  // Generic persist helper — trims, no-ops on unchanged, reverts on error.
  const persistName = async () => {
    const trimmed = name.trim();
    if (trimmed === (nameValue || "").trim()) return;
    setNameBusy(true);
    try {
      await onSave(memberId, nameField, trimmed || null);
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 1200);
    } catch { setName(nameValue || ""); }
    finally { setNameBusy(false); }
  };
  const persistMobile = async () => {
    const trimmed = mobile.trim();
    if (trimmed === (initial || "").trim()) return;
    setMobileBusy(true);
    try {
      await onSave(memberId, field, trimmed || null);
      setMobileSaved(true);
      setTimeout(() => setMobileSaved(false), 1200);
    } catch { setMobile(initial || ""); }
    finally { setMobileBusy(false); }
  };

  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`w-5 h-5 rounded text-[10px] font-bold flex items-center justify-center ${colorClass}`}
        title={nameField.replace("_name", "")}
      >
        {defaultBadge}
      </span>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={persistName}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        placeholder="Name"
        data-testid={`inline-${nameField}-${memberId}`}
        disabled={nameBusy}
        className="w-[110px] shrink-0 px-2 h-7 text-xs rounded border border-slate-200 bg-white focus:bg-white focus:border-sky-400 focus:ring-1 focus:ring-sky-200 outline-none"
      />
      {nameBusy
        ? <Loader2 size={11} className="animate-spin text-slate-400" />
        : (nameSaved ? <Check size={11} className="text-emerald-600" /> : <span className="w-3" />)}
      <input
        type="tel"
        value={mobile}
        onChange={(e) => setMobile(e.target.value)}
        onBlur={persistMobile}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        placeholder="+91…"
        data-testid={`inline-${field}-${memberId}`}
        disabled={mobileBusy}
        className="flex-1 min-w-0 px-2 h-7 text-xs font-mono rounded border border-slate-200 bg-white focus:bg-white focus:border-sky-400 focus:ring-1 focus:ring-sky-200 outline-none"
      />
      {mobileBusy
        ? <Loader2 size={11} className="animate-spin text-slate-400" />
        : (mobileSaved ? <Check size={11} className="text-emerald-600" /> : <span className="w-3" />)}
    </div>
  );
}
