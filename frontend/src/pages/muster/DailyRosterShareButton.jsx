import React, { useEffect, useState } from "react";
import { ClipboardList, Share2 } from "lucide-react";
import { api } from "../../api";
import { shareToWhatsApp } from "../../utils/shareWhatsApp";

// Human-friendly "Fri 22 Aug" for the till-date line.
const fmtTill = (iso) => {
  if (!iso) return "";
  try {
    return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", {
      weekday: "short", day: "numeric", month: "short",
    });
  } catch { return iso; }
};

// Today header line, matches the AbsentShareBanner caption style.
const fmtToday = (iso) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short",
  });

/** Turn the /muster/daily-roster payload into the WhatsApp share text. */
export function buildRosterMessage(r) {
  const lines = [`📋 Today's Staff & Coach Roster — ${fmtToday(r.date)}`];
  const section = (label, arr, emoji) => {
    if (!arr || !arr.length) return;
    lines.push("", `${emoji} ${label} (${arr.length}):`);
    arr.forEach((p) => {
      lines.push(p.till ? `• ${p.name} — till ${fmtTill(p.till)}` : `• ${p.name}`);
    });
  };
  section("On Leave", r.on_leave, "🏖️");
  section("On Tour",  r.on_tour,  "✈️");
  section("On LOP",   r.on_lop,   "⚠️");
  // "absent" = not checked in AND not on any approved leave/tour/LOP.
  section("Not in / Reason unknown", r.absent, "❌");
  if (!r.on_leave.length && !r.on_tour.length && !r.on_lop.length && !r.absent.length) {
    lines.push("", "✅ Everyone accounted for.");
  }
  if (r.office_name) lines.push("", `— ${r.office_name}`);
  return lines.join("\n");
}

/** Permanent "Share Today's Roster" button — no auto-prompt, admin-visible. */
export const DailyRosterShareButton = () => {
  const [roster, setRoster] = useState(null);
  useEffect(() => {
    let alive = true;
    api.get("/muster/daily-roster")
      .then((r) => { if (alive) setRoster(r); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!roster) return null;
  const awayCount =
    roster.on_leave.length + roster.on_tour.length +
    roster.on_lop.length + roster.absent.length;

  const summary = [];
  if (roster.on_leave.length) summary.push(`${roster.on_leave.length} leave`);
  if (roster.on_tour.length)  summary.push(`${roster.on_tour.length} tour`);
  if (roster.on_lop.length)   summary.push(`${roster.on_lop.length} LOP`);
  if (roster.absent.length)   summary.push(`${roster.absent.length} absent`);

  return (
    <div
      data-testid="daily-roster-share-banner"
      className="mb-4 rounded-xl border border-sky-300 bg-sky-50 p-3 flex items-center gap-3 flex-wrap"
    >
      <ClipboardList size={18} className="text-sky-600 shrink-0" />
      <div className="flex-1 min-w-[180px]">
        <p className="text-sm font-semibold text-sky-800">
          Today's Roster · Staff &amp; Coaches
        </p>
        <p className="text-xs text-sky-700">
          {awayCount === 0
            ? "Everyone accounted for."
            : `Away today: ${summary.join(", ")}`}
        </p>
      </div>
      <button
        type="button"
        data-testid="daily-roster-share-whatsapp-btn"
        onClick={() => shareToWhatsApp({ text: buildRosterMessage(roster) })}
        title="Share today's leave / tour / LOP / absent list to WhatsApp"
        className="iu-btn iu-btn-secondary !border-emerald-300 !text-emerald-700 hover:!bg-emerald-50"
      >
        <Share2 size={15} /> Share Today's Roster
      </button>
    </div>
  );
};

export default DailyRosterShareButton;
