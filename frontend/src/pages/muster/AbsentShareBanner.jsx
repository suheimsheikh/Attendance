import React, { useEffect, useState, useCallback } from "react";
import { Share2, UserX, ChevronDown, ChevronRight, Check } from "lucide-react";
import { api } from "../../api";
import {
  shareToWhatsApp,
  openWhatsAppChat,
  normalizeWaNumber,
  formatAbsentParentMessage,
} from "../../utils/shareWhatsApp";

const fmtDay = (iso) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short",
  });

export function buildAbsentMessage(r) {
  const lines = [`❌ Absent without information — ${fmtDay(r.date)}`];
  if (r.athletes.length) {
    lines.push("", `Athletes (${r.athletes.length} of ${r.total_athletes}):`);
    r.athletes.forEach((n) => lines.push(`• ${n}`));
  }
  if (r.coaches.length) {
    lines.push("", `Coaches (${r.coaches.length} of ${r.total_coaches}):`);
    r.coaches.forEach((n) => lines.push(`• ${n}`));
  }
  if (r.office_name) lines.push("", `— ${r.office_name}`);
  return lines.join("\n");
}

// WhatsApp brand-ish icon button colour. One button per available parent
// number (Father / Mother / Guardian) so it's exactly one tap per person.
const PARENT_ROLES = [
  { key: "father_mobile", label: "Father", badge: "F" },
  { key: "mother_mobile", label: "Mother", badge: "M" },
  { key: "guardian_mobile", label: "Guardian", badge: "G" },
];

// ---- "notified ✓" persistence -------------------------------------------
// Keyed by report date so the ticks reset naturally each morning but
// survive a page refresh during the same day. Stored as a flat array of
// "<athleteId>:<roleKey>" strings under one localStorage key per date.
const NOTIFIED_LS_KEY = (dateIso) => `absent_notified_v1:${dateIso}`;

function loadNotified(dateIso) {
  try {
    const raw = localStorage.getItem(NOTIFIED_LS_KEY(dateIso));
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function saveNotified(dateIso, set) {
  try {
    localStorage.setItem(NOTIFIED_LS_KEY(dateIso), JSON.stringify([...set]));
  } catch { /* storage full / disabled — ticks just won't persist */ }
}

/** One absent-athlete row with a WhatsApp button per parent on file. */
function AbsentContactRow({ contact, dateIso, academy, notified, onNotified }) {
  const numbers = PARENT_ROLES
    .map((r) => ({ ...r, number: (contact[r.key] || "").trim() }))
    .filter((r) => r.number && normalizeWaNumber(r.number));

  const notify = (role) => {
    const ok = openWhatsAppChat({
      phone: role.number,
      text: formatAbsentParentMessage({ name: contact.name, dateIso, academy }),
    });
    if (ok) onNotified(`${contact.id}:${role.key}`);
  };

  const allDone = numbers.length > 0 && numbers.every((r) => notified.has(`${contact.id}:${r.key}`));

  return (
    <li
      className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white/70"
      data-testid={`absent-contact-${contact.id}`}
    >
      <span className="flex-1 min-w-0 text-sm text-slate-800 truncate flex items-center gap-1.5">
        {contact.name}
        {allDone && (
          <span
            data-testid={`absent-all-notified-${contact.id}`}
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
          {numbers.map((role) => {
            const done = notified.has(`${contact.id}:${role.key}`);
            return (
              <button
                key={role.key}
                type="button"
                onClick={() => notify(role)}
                data-testid={`absent-notify-${role.key}-${contact.id}`}
                title={
                  done
                    ? `Already notified ${contact.name}'s ${role.label} (${role.number}) — tap to message again`
                    : `WhatsApp ${contact.name}'s ${role.label} (${role.number}) — opens chat with the Telugu + English absence note ready to send`
                }
                className={
                  done
                    ? "inline-flex items-center gap-1 px-2 h-7 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-300 text-[11px] font-bold hover:bg-emerald-200 transition"
                    : "inline-flex items-center gap-1 px-2 h-7 rounded-full bg-[#25D366] text-white text-[11px] font-bold hover:brightness-95 transition"
                }
              >
                {done ? <Check size={12} /> : <MessageIcon />} {role.badge}
              </button>
            );
          })}
        </div>
      )}
    </li>
  );
}

// Tiny inline WhatsApp-ish glyph (avoids pulling a brand asset).
const MessageIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18a8 8 0 0 1-4.1-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8 8 0 1 1 12 20zm4.4-5.6c-.2-.1-1.4-.7-1.6-.8-.2-.1-.4-.1-.5.1-.2.2-.6.8-.7.9-.1.1-.3.2-.5.1a6.6 6.6 0 0 1-3.2-2.8c-.2-.4.2-.4.6-1.2.1-.1 0-.3 0-.4l-.7-1.7c-.2-.5-.4-.4-.5-.4h-.5a.9.9 0 0 0-.7.3c-.2.3-.9.9-.9 2.2s.9 2.5 1 2.7c.1.2 1.8 2.8 4.4 3.9 1.6.7 2.2.7 3 .6.5 0 1.4-.6 1.6-1.1.2-.6.2-1 .1-1.1 0-.1-.2-.2-.4-.3z"/>
  </svg>
);

export const AbsentShareBanner = () => {
  const [report, setReport] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const [notified, setNotified] = useState(() => new Set());

  useEffect(() => {
    let alive = true;
    api.get("/muster/absent-report")
      .then((r) => {
        if (!alive) return;
        setReport(r);
        if (r?.date) setNotified(loadNotified(r.date));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const markNotified = useCallback((key) => {
    setNotified((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      if (report?.date) saveNotified(report.date, next);
      return next;
    });
  }, [report]);

  if (!report || !report.ready) return null;
  const n = report.athletes.length + report.coaches.length;
  if (n === 0) return null;

  const bits = [];
  if (report.athletes.length) bits.push(`${report.athletes.length} athlete${report.athletes.length > 1 ? "s" : ""}`);
  if (report.coaches.length) bits.push(`${report.coaches.length} coach${report.coaches.length > 1 ? "es" : ""}`);

  const contacts = report.athlete_contacts || [];
  const withNumbers = contacts.filter((c) =>
    PARENT_ROLES.some((r) => (c[r.key] || "").trim() && normalizeWaNumber(c[r.key]))
  ).length;
  // Athletes where every parent number on file has been messaged.
  const doneCount = contacts.filter((c) => {
    const nums = PARENT_ROLES.filter((r) => (c[r.key] || "").trim() && normalizeWaNumber(c[r.key]));
    return nums.length > 0 && nums.every((r) => notified.has(`${c.id}:${r.key}`));
  }).length;

  return (
    <div
      data-testid="absent-share-banner"
      className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3"
    >
      <div className="flex items-center gap-3 flex-wrap">
        <UserX size={18} className="text-amber-600 shrink-0" />
        <div className="flex-1 min-w-[180px]">
          <p className="text-sm font-semibold text-amber-800">
            Absent without information: {bits.join(", ")}
          </p>
          <p className="text-xs text-amber-700">
            Not checked in by {report.ready_at_hm} and not on approved leave.
          </p>
        </div>
        <button
          type="button"
          data-testid="absent-share-whatsapp-btn"
          onClick={() => shareToWhatsApp({ text: buildAbsentMessage(report) })}
          title="Share the whole absent list to the parents' WhatsApp group"
          className="iu-btn iu-btn-secondary !border-emerald-300 !text-emerald-700 hover:!bg-emerald-50"
        >
          <Share2 size={15} /> Share to group
        </button>
      </div>

      {/* Per-athlete parent notify — one tap per parent, Telugu+English pre-filled. */}
      {contacts.length > 0 && (
        <div className="mt-3 border-t border-amber-200 pt-2">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            data-testid="absent-notify-parents-toggle"
            title="Message each absent athlete's parent individually on WhatsApp (Telugu + English)"
            className="flex items-center gap-1.5 text-xs font-bold text-amber-800 hover:text-amber-900"
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Notify parents individually
            <span className="ml-1 inline-flex items-center px-1.5 h-4 rounded-full bg-amber-200 text-amber-800 text-[10px]">
              {withNumbers}/{contacts.length} with number
            </span>
            {doneCount > 0 && (
              <span
                data-testid="absent-notified-count"
                className="inline-flex items-center gap-0.5 px-1.5 h-4 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold"
                title="Athletes whose parents you've already messaged today"
              >
                <Check size={9} /> {doneCount} done
              </span>
            )}
          </button>
          {expanded && (
            <ul className="mt-2 space-y-1" data-testid="absent-notify-list">
              {contacts.map((c) => (
                <AbsentContactRow
                  key={c.id}
                  contact={c}
                  dateIso={report.date}
                  academy={report.office_name}
                  notified={notified}
                  onNotified={markNotified}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

export default AbsentShareBanner;
