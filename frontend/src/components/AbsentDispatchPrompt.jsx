import React, { useEffect, useState, useCallback } from "react";
import { useEscape } from "../hooks/useEscape";
import { AlertTriangle, Send, X } from "lucide-react";
import { api } from "../api";
import { shareToWhatsApp } from "../utils/shareWhatsApp";
import { toast } from "sonner";
import { todayIso, sortByName } from "../utils";

/**
 * AbsentDispatchPrompt — admin-only nudge (user request, Jun 2026).
 *
 * Since this is a web app (no server push to phones), the first time an
 * admin opens/uses the app at or after 10:00 AM local on a day with
 * detected absentees, we pop a dismissible reminder to dispatch the
 * absentee list to the WhatsApp attendance group. Once any admin taps
 * Send, a shared server flag hides it for every admin that day; "Not now"
 * only hides it for this browser.
 */
const DISPATCH_HOUR = 10;

const todayKey = todayIso;

// Same A–Z, one-per-line shape as the WhatsApp message.
const sentTime = (iso) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

const sentNote = (st) => `Already sent by ${st.sent_by_name || "a colleague"} at ${sentTime(st.sent_at)}`;

// "NAME (IN 09:42 · 12m late)" — one-line late label from a roster.late
// or late-report contact row.
const lateLabel = (x) => {
  const t = x?.check_in_at ? sentTime(x.check_in_at) : "";
  const mins = Number(x?.late_minutes) > 0 ? `${x.late_minutes}m late` : "late";
  const detail = [t ? `IN ${t}` : "", mins].filter(Boolean).join(" · ");
  return detail ? `${x.name} (${detail})` : x.name;
};

const PreviewList = ({ testid, label, tone, names }) =>
  names?.length ? (
    <div data-testid={testid}>
      <div className={`font-bold ${tone}`}>{label} ({names.length}):</div>
      <ul className="text-slate-700">
        {sortByName(names).map((n, i) => <li key={`${n}-${i}`}>• {n}</li>)}
      </ul>
    </div>
  ) : null;

export default function AbsentDispatchPrompt({ kind = "camp" }) {
  const [data, setData] = useState(null); // { allAbsent, onLeave, onTour, onLop, late, office }
  const [open, setOpen] = useState(false);
  useEscape(open ? () => setOpen(false) : null);

  const dismissedToday = useCallback(
    () => localStorage.getItem(`absent-dispatch-dismissed-${kind}-${todayKey()}`) === "1",
    [kind],
  );

  const evaluate = useCallback(async () => {
    if (dismissedToday()) return;
    try {
      const status = await api.get(`/muster/absent-dispatch?kind=${kind}`);
      if (status?.eligible === false) return;
      // Camp dispatch runs on camp days only; staff dispatch runs every day.
      if (kind === "camp" && !status?.is_camp_day) return;
      // Due once the local clock reaches the cutoff (camp start, or 10:00).
      const [sh, sm] = (status?.dispatch_after_hm || `${DISPATCH_HOUR}:00`)
        .split(":").map(Number);
      const now = new Date();
      if (now.getHours() < sh || (now.getHours() === sh && now.getMinutes() < sm)) return;
      if (status?.sent) {
        setOpen((wasOpen) => {
          if (wasOpen) toast.info(sentNote(status));
          return false;
        });
        return;
      }
      if (kind === "camp") {
        // Only the camp's participating athletes (absent + late).
        const [absentRep, lateRep] = await Promise.all([
          api.get("/muster/absent-report").catch(() => null),
          api.get("/muster/late-report").catch(() => null),
        ]);
        const allAbsent = absentRep?.athletes || [];
        const late = (lateRep?.athlete_contacts || []).map(lateLabel)
          .sort((a, b) => a.localeCompare(b));
        if (allAbsent.length === 0 && late.length === 0) return;
        // Claim the nudge — only one admin per day sees this pop-up.
        const claim = await api.post(`/muster/absent-dispatch/claim?kind=${kind}`).catch(() => null);
        if (!claim?.show) return;
        setData({ allAbsent, onLeave: [], onTour: [], onLop: [], late,
          office: (absentRep?.office_name || "").trim(),
          date: absentRep?.date || todayKey() });
      } else {
        // Non-athletes: staff/coach absentees, leave, tour, LOP, late.
        const roster = await api.get("/muster/daily-roster").catch(() => null);
        const allAbsent = (roster?.absent || []).map((x) => x.name);
        const onLeave = (roster?.on_leave || []).map((x) => x.name);
        const onTour = (roster?.on_tour || []).map((x) => x.name);
        const onLop = (roster?.on_lop || []).map((x) => x.name);
        const late = (roster?.late || []).map(lateLabel).sort((a, b) => a.localeCompare(b));
        if (allAbsent.length === 0 && onLeave.length === 0 && onTour.length === 0 && late.length === 0) return;
        // Claim the nudge — only one admin per day sees this pop-up.
        const claim = await api.post(`/muster/absent-dispatch/claim?kind=${kind}`).catch(() => null);
        if (!claim?.show) return;
        setData({ allAbsent, onLeave, onTour, onLop, late,
          office: (roster?.office_name || "").trim(),
          date: roster?.date || todayKey() });
      }
      setOpen(true);
    } catch { /* silent */ }
  }, [dismissedToday, kind]);

  useEffect(() => {
    evaluate();
    // Re-check periodically so someone who had the app open before the camp
    // start time still gets the nudge once it passes.
    const t = setInterval(evaluate, 5 * 60 * 1000);
    window.addEventListener("focus", evaluate);
    return () => { clearInterval(t); window.removeEventListener("focus", evaluate); };
  }, [evaluate]);

  const dismiss = () => {
    localStorage.setItem(`absent-dispatch-dismissed-${kind}-${todayKey()}`, "1");
    setOpen(false);
  };

  const buildMessage = () => {
    const d = data || {};
    const day = new Date((d.date || todayKey()) + "T00:00:00").toLocaleDateString("en-GB", {
      weekday: "long", day: "numeric", month: "long",
    });
    const scope = kind === "camp" ? "Camp attendance" : "Staff attendance";
    const lines = [`📋 *${scope} — ${d.office || "Academy"}* · ${day}`];
    // A–Z, one person per line (user request, Oct 2026).
    const section = (label, names) => {
      if (!names?.length) return;
      lines.push("", `${label} (${names.length}):`, ...sortByName(names).map((n) => `• ${n}`));
    };
    section("❗ *Absent (no info)*", d.allAbsent);
    section("⏰ *Late*", d.late);
    section("📝 *On leave*", d.onLeave);
    section("✈️ *On tour*", d.onTour);
    section("🔴 *LOP*", d.onLop);
    return lines.join("\n");
  };

  // Share must start synchronously in the tap (mobile share-sheet rule).
  const dispatch = () => {
    shareToWhatsApp({ text: buildMessage() });
    dismiss();
    api.post(`/muster/absent-dispatch?kind=${kind}`).then((res) => {
      if (res.first) toast.success(`Marked as sent at ${sentTime(res.sent_at)} — others won't be prompted today`);
      else toast.info(sentNote(res));
    }).catch(() => {});
  };

  if (!open || !data) return null;

  const title = kind === "camp" ? "Dispatch camp absentees" : "Dispatch staff absentees";
  const subtitle = kind === "camp"
    ? "The camp has started — send the participants' attendance summary to the WhatsApp group."
    : "It's past 10 AM — send today's staff attendance summary to the WhatsApp group.";

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/40 p-3" data-testid={`absent-dispatch-prompt-${kind}`}>
      <div className="w-full max-w-md rounded-2xl bg-white shadow-xl border border-amber-200 overflow-hidden">
        <div className="flex items-start gap-3 p-4 bg-amber-50 border-b border-amber-100">
          <div className="w-10 h-10 rounded-lg bg-amber-500/15 text-amber-700 flex items-center justify-center shrink-0">
            <AlertTriangle size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-extrabold text-slate-900">{title}</div>
            <div className="text-xs text-slate-600 mt-0.5">
              {subtitle}
            </div>
          </div>
          <button data-testid={`absent-dispatch-close-${kind}`} onClick={dismiss} className="p-1.5 rounded-lg hover:bg-amber-100 text-slate-500" title="Dismiss for today">
            <X size={16} />
          </button>
        </div>
        <div className="p-4 space-y-2 text-sm max-h-[40vh] overflow-y-auto">
          <PreviewList testid="dispatch-absent" label="Absent (no info)" tone="text-rose-700" names={data.allAbsent} />
          <PreviewList testid="dispatch-late" label="Late" tone="text-orange-700" names={data.late} />
          <PreviewList testid="dispatch-on-leave" label="On leave" tone="text-amber-700" names={data.onLeave} />
          <PreviewList testid="dispatch-on-tour" label="On tour" tone="text-sky-700" names={data.onTour} />
          <PreviewList testid="dispatch-lop" label="LOP" tone="text-red-700" names={data.onLop} />
        </div>
        <div className="flex gap-2 p-4 border-t border-slate-100">
          <button title="Hide this for now" data-testid={`absent-dispatch-dismiss-${kind}`} onClick={dismiss} className="iu-btn-secondary flex-1">Not now</button>
          <button data-testid={`absent-dispatch-send-${kind}`} onClick={dispatch} className="iu-btn-primary flex-1 inline-flex items-center justify-center gap-2">
            <Send size={15} /> Send to WhatsApp
          </button>
        </div>
      </div>
    </div>
  );
}
