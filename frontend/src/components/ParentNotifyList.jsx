import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Check } from "lucide-react";
import { api } from "../api";
import {
  openWhatsAppChat,
  normalizeWaNumber,
  formatParentMessage,
} from "../utils/shareWhatsApp";

const PARENT_ROLES = [
  { key: "father_mobile", role: "father", label: "Father", badge: "F" },
  { key: "mother_mobile", role: "mother", label: "Mother", badge: "M" },
  { key: "guardian_mobile", role: "guardian", label: "Guardian", badge: "G" },
];

// Tiny inline WhatsApp glyph (avoids pulling a brand asset).
const WaIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18a8 8 0 0 1-4.1-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8 8 0 1 1 12 20zm4.4-5.6c-.2-.1-1.4-.7-1.6-.8-.2-.1-.4-.1-.5.1-.2.2-.6.8-.7.9-.1.1-.3.2-.5.1a6.6 6.6 0 0 1-3.2-2.8c-.2-.4.2-.4.6-1.2.1-.1 0-.3 0-.4l-.7-1.7c-.2-.5-.4-.4-.5-.4h-.5a.9.9 0 0 0-.7.3c-.2.3-.9.9-.9 2.2s.9 2.5 1 2.7c.1.2 1.8 2.8 4.4 3.9 1.6.7 2.2.7 3 .6.5 0 1.4-.6 1.6-1.1.2-.6.2-1 .1-1.1 0-.1-.2-.2-.4-.3z"/>
  </svg>
);

function fmtDay(dateIso) {
  const d = dateIso ? new Date(dateIso + "T00:00:00") : new Date();
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

/**
 * ParentNotifyList — reusable one-tap WhatsApp parent-notify list used by
 * both the Absent and Late banners on Muster. Each absent/late athlete row
 * shows a WhatsApp button per parent number on file. Tapping opens WhatsApp
 * with the bilingual (Telugu + English) message pre-filled and, on success,
 * records the contact to the shared server log so the ✓ tick shows for
 * everyone (not just this device).
 *
 * Props:
 *   reason     — "absent" | "late" (selects template + log bucket)
 *   contacts   — [{ id, name, father_mobile, mother_mobile, guardian_mobile,
 *                    check_in_at?, late_minutes? }]
 *   templates  — { absent_te, absent_en, late_te, late_en } from useNotifyTemplates
 *   academy    — office name for {academy}
 *   dateIso    — report date (YYYY-MM-DD) for {day} + tick scoping
 */
export default function ParentNotifyList({ reason, contacts, templates, academy, dateIso }) {
  const [notified, setNotified] = useState(() => new Set());

  // Load the shared "already notified today" keys from the server so ticks
  // are consistent across every coach/admin device.
  useEffect(() => {
    let alive = true;
    api.get("/notify/today", { reason })
      .then((r) => { if (alive && Array.isArray(r?.keys)) setNotified(new Set(r.keys)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [reason, contacts.length]);

  const mark = useCallback((key) => {
    setNotified((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, []);

  const day = useMemo(() => fmtDay(dateIso), [dateIso]);

  const buildText = useCallback((contact) => {
    const time = contact.check_in_at
      ? new Date(contact.check_in_at).toLocaleTimeString("en-GB", {
          hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata",
        })
      : "";
    const vars = {
      name: contact.name,
      academy: academy || "",
      day,
      time,
      minutes: contact.late_minutes != null ? contact.late_minutes : "",
    };
    return formatParentMessage({
      templateTe: templates?.[`${reason}_te`],
      templateEn: templates?.[`${reason}_en`],
      vars,
    });
  }, [templates, reason, academy, day]);

  const notify = useCallback((contact, roleDef) => {
    const number = (contact[roleDef.key] || "").trim();
    const ok = openWhatsAppChat({ phone: number, text: buildText(contact) });
    if (!ok) return;
    mark(`${contact.id}:${roleDef.key}`);
    // Fire-and-forget log write — the message already opened; a failed log
    // shouldn't block the coach. Server resolves name/number authoritatively.
    api.post("/notify/parent", {
      member_id: contact.id,
      parent_role: roleDef.role,
      reason,
    }).catch(() => {});
  }, [buildText, mark, reason]);

  const withNumbers = useMemo(
    () => contacts.filter((c) =>
      PARENT_ROLES.some((r) => (c[r.key] || "").trim() && normalizeWaNumber(c[r.key]))
    ).length,
    [contacts],
  );
  const doneCount = useMemo(
    () => contacts.filter((c) => {
      const nums = PARENT_ROLES.filter((r) => (c[r.key] || "").trim() && normalizeWaNumber(c[r.key]));
      return nums.length > 0 && nums.every((r) => notified.has(`${c.id}:${r.key}`));
    }).length,
    [contacts, notified],
  );

  return (
    <div data-testid={`parent-notify-${reason}`}>
      <div className="flex items-center gap-2 mb-2 text-[11px] font-semibold text-slate-600">
        <span className="inline-flex items-center px-1.5 h-4 rounded-full bg-slate-200 text-slate-700">
          {withNumbers}/{contacts.length} with number
        </span>
        {doneCount > 0 && (
          <span
            data-testid={`parent-notify-${reason}-done`}
            className="inline-flex items-center gap-0.5 px-1.5 h-4 rounded-full bg-emerald-100 text-emerald-700"
            title="Athletes whose parents you've already messaged today"
          >
            <Check size={9} /> {doneCount} done
          </span>
        )}
      </div>
      <ul className="space-y-1" data-testid={`parent-notify-${reason}-list`}>
        {contacts.map((c) => {
          const numbers = PARENT_ROLES
            .map((r) => ({ ...r, number: (c[r.key] || "").trim() }))
            .filter((r) => r.number && normalizeWaNumber(r.number));
          const allDone = numbers.length > 0 && numbers.every((r) => notified.has(`${c.id}:${r.key}`));
          return (
            <li
              key={c.id}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white/70"
              data-testid={`notify-contact-${reason}-${c.id}`}
            >
              <span className="flex-1 min-w-0 text-sm text-slate-800 truncate flex items-center gap-1.5">
                {c.name}
                {reason === "late" && c.late_minutes != null && (
                  <span className="text-[10px] text-amber-700 font-semibold shrink-0" title="Minutes late">
                    +{c.late_minutes}m
                  </span>
                )}
                {allDone && (
                  <span
                    data-testid={`notify-all-done-${reason}-${c.id}`}
                    title="All parents on file have been notified"
                    className="inline-flex items-center gap-0.5 px-1.5 h-4 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold shrink-0"
                  >
                    <Check size={9} /> notified
                  </span>
                )}
              </span>
              {numbers.length === 0 ? (
                <span className="text-[11px] text-slate-400 italic shrink-0" title="No parent WhatsApp number on file">
                  no number on file
                </span>
              ) : (
                <div className="flex items-center gap-1 shrink-0">
                  {numbers.map((r) => {
                    const done = notified.has(`${c.id}:${r.key}`);
                    return (
                      <button
                        key={r.key}
                        type="button"
                        onClick={() => notify(c, r)}
                        data-testid={`notify-${reason}-${r.key}-${c.id}`}
                        title={done
                          ? `Already notified ${c.name}'s ${r.label} (${r.number}) — tap to message again`
                          : `WhatsApp ${c.name}'s ${r.label} (${r.number}) — opens chat with the Telugu + English note ready to send`}
                        className={done
                          ? "inline-flex items-center gap-1 px-2 h-7 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-300 text-[11px] font-bold hover:bg-emerald-200 transition"
                          : "inline-flex items-center gap-1 px-2 h-7 rounded-full bg-[#25D366] text-white text-[11px] font-bold hover:brightness-95 transition"}
                      >
                        {done ? <Check size={12} /> : <WaIcon />} {r.badge}
                      </button>
                    );
                  })}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
