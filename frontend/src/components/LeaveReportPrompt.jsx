import React, { useEffect, useState } from "react";
import { useEscape } from "../hooks/useEscape";
import { Share2, X, CalendarClock, CheckCircle2 } from "lucide-react";
import { api } from "../api";
import { shareToWhatsApp } from "../utils/shareWhatsApp";
import { toast } from "sonner";

// Show at most once per browser session even across route changes.
let SHOWN_THIS_SESSION = false;

const fmtDate = (iso) => {
  if (!iso) return "";
  try {
    return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", {
      weekday: "short", day: "numeric", month: "short",
    });
  } catch { return iso; }
};

// "N more days" until an inclusive till-date. Same-day → "ends today".
const daysLeftLabel = (till, todayIso) => {
  if (!till) return "";
  try {
    const a = new Date(till + "T00:00:00");
    const b = new Date(todayIso + "T00:00:00");
    const n = Math.round((a - b) / 86400000);
    if (n <= 0) return "ends today";
    return n === 1 ? "1 more day" : `${n} more days`;
  } catch { return ""; }
};

/** Build the small, well-formatted WhatsApp message (leave + tour only). */
export function buildLeaveTourMessage(roster) {
  const today = roster.date;
  const lines = [`📋 YCH Attendance — Leave/Tour · ${fmtDate(today)}`];
  const section = (label, arr, emoji) => {
    if (!arr || !arr.length) return;
    lines.push("", `${emoji} ${label} (${arr.length}):`);
    arr.forEach((p) => {
      const nm = (p.name || "").trim();
      const dl = daysLeftLabel(p.till, today);
      lines.push(
        p.till ? `• ${nm} — till ${fmtDate(p.till)} (${dl})` : `• ${nm}`
      );
    });
  };
  section("On Leave", roster.on_leave, "🏖️");
  section("On Tour", roster.on_tour, "✈️");
  if (!(roster.on_leave || []).length && !(roster.on_tour || []).length) {
    lines.push("", "✅ No one on leave or tour today.");
  }
  return lines.join("\n");
}

/**
 * LeaveReportPrompt — on admin login, if today's leave/tour report hasn't
 * been posted by anyone yet, show a one-time modal with the formatted list
 * and a "Post to WhatsApp" button. Tapping it opens WhatsApp pre-filled AND
 * marks the day done (so no other admin is prompted).
 */
export default function LeaveReportPrompt() {
  const [open, setOpen] = useState(false);
  useEscape(open ? () => setOpen(false) : null);
  const [roster, setRoster] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (SHOWN_THIS_SESSION) return;
    let alive = true;
    (async () => {
      try {
        // Claim the day's nudge — only ONE admin wins and sees this pop-up
        // (others get {show:false}). Guarded per-session so a route change
        // doesn't re-open it. The dashboard "Post now" chip stays available
        // to everyone, so the report can still go out if this admin skips.
        SHOWN_THIS_SESSION = true;
        const res = await api.post("/leave-report/claim");
        if (!alive || !res?.show) return;
        const r = await api.get("/muster/daily-roster");
        if (!alive) return;
        setRoster(r);
        setOpen(true);
      } catch { /* silent — never block login on this nudge */ }
    })();
    return () => { alive = false; };
  }, []);

  if (!open || !roster) return null;

  const message = buildLeaveTourMessage(roster);
  const leaveCount = (roster.on_leave || []).length;
  const tourCount = (roster.on_tour || []).length;

  const post = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Lock the day FIRST, before the WhatsApp share navigates this tab
      // away — on mobile the OS share sheet backgrounds the page, so a
      // mark-posted call made AFTER the share was routinely lost and every
      // admin kept getting re-prompted (Jun 2026 user report). Tapping Post
      // = done (existing user decision), so locking up-front is safe.
      await api.post("/leave-report/mark-posted").catch(() => {});
      await shareToWhatsApp({ text: message });
      toast.success("Posted — pick the YCH Attendance group and send.");
      setOpen(false);
    } finally { setBusy(false); }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50"
      data-testid="leave-report-prompt"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 p-4 border-b border-slate-100 bg-emerald-50">
          <CalendarClock size={20} className="text-emerald-600 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <h2 className="text-base font-extrabold text-slate-800">Post today's Leave/Tour to WhatsApp</h2>
            <p className="text-xs text-slate-600 mt-0.5">
              {leaveCount + tourCount === 0
                ? "No one is on leave or tour today."
                : `${leaveCount} on leave · ${tourCount} on tour. Share it to the YCH Attendance group.`}
            </p>
          </div>
          <button
            type="button" data-testid="leave-report-dismiss"
            onClick={() => setOpen(false)}
            className="p-1 -mr-1 rounded-lg text-slate-400 hover:bg-white/60 hover:text-slate-600"
            title="Later"
          >
            <X size={18} />
          </button>
        </div>

        <pre
          data-testid="leave-report-preview"
          className="m-4 p-3 rounded-xl bg-slate-50 border border-slate-200 text-[13px] leading-relaxed text-slate-800 whitespace-pre-wrap font-sans max-h-[45vh] overflow-auto"
        >{message}</pre>

        <div className="flex items-center justify-end gap-2 px-4 pb-4">
          <button title="Remind me later"
            type="button" data-testid="leave-report-later"
            onClick={() => setOpen(false)}
            className="iu-btn iu-btn-secondary"
          >
            Later
          </button>
          <button
            type="button" data-testid="leave-report-post-btn"
            onClick={post} disabled={busy}
            className="iu-btn iu-btn-primary !bg-emerald-600 hover:!bg-emerald-700 !border-emerald-600"
          >
            {busy ? <CheckCircle2 size={15} /> : <Share2 size={15} />} Post to WhatsApp
          </button>
        </div>
      </div>
    </div>
  );
}
