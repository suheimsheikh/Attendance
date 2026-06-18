import React, { useState, useRef, useEffect } from "react";
import { Phone, MessageSquare, X } from "lucide-react";

/**
 * Tiny popover that lists parent / guardian mobiles with one-tap
 * Call (tel:) and SMS (sms:) actions. Renders nothing if the member has no
 * parent / guardian numbers on file.
 *
 * Props:
 *   father, mother, guardian  — optional phone-string fields from the member
 *   size                      — icon size in px (default 14)
 *   compact                   — when true, renders a single icon button
 *                               (used inside dense lists like Presence cards)
 */
export default function ParentContact({ father, mother, guardian, size = 14, compact = true }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const contacts = [
    { label: "Father", number: (father || "").trim() },
    { label: "Mother", number: (mother || "").trim() },
    { label: "Guardian", number: (guardian || "").trim() },
  ].filter((c) => c.number);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (contacts.length === 0) return null;

  return (
    <div className="relative inline-block" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        data-testid="parent-contact-button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title="Contact parents / guardian"
        className="inline-flex items-center gap-1 px-1.5 h-6 rounded-full bg-sky-100 text-sky-700 hover:bg-sky-200 transition border border-sky-200 text-[10px] font-bold"
      >
        <Phone size={size - 2} />
        {!compact && <span>Parents</span>}
        <span className="bg-white/70 rounded-full w-4 h-4 flex items-center justify-center text-[9px]">
          {contacts.length}
        </span>
      </button>

      {open && (
        <div
          data-testid="parent-contact-popover"
          className="absolute z-50 right-0 mt-1 w-60 bg-white rounded-xl shadow-xl border border-slate-200 p-2"
          style={{ top: "100%" }}
        >
          <div className="flex items-center justify-between px-2 py-1 mb-1">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Parents & guardian</span>
            <button onClick={() => setOpen(false)} className="p-1 hover:bg-slate-100 rounded">
              <X size={12} />
            </button>
          </div>
          <ul className="space-y-1">
            {contacts.map((c) => (
              <li key={c.label} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-slate-50">
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{c.label}</div>
                  <div className="text-xs font-mono text-slate-800 truncate">{c.number}</div>
                </div>
                <a
                  href={`tel:${c.number}`}
                  data-testid={`parent-call-${c.label.toLowerCase()}`}
                  className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-emerald-600 text-white hover:bg-emerald-700"
                  title={`Call ${c.label}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Phone size={14} />
                </a>
                <a
                  href={`sms:${c.number}`}
                  data-testid={`parent-sms-${c.label.toLowerCase()}`}
                  className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-sky-600 text-white hover:bg-sky-700"
                  title={`Message ${c.label}`}
                  onClick={(e) => e.stopPropagation()}
                >
                  <MessageSquare size={14} />
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
