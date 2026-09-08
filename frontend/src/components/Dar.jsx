import React from "react";
import { FileText, Share2 } from "lucide-react";
import { shareToWhatsApp } from "../utils/shareWhatsApp";

const fmtHM = (iso) => iso
  ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" })
  : "";

const fmtDay = (iso) => iso
  ? new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "2-digit" })
  : "";

export function formatDarCaption({ groupName, name, date, checkIn, checkOut, text }) {
  const times = [fmtHM(checkIn), fmtHM(checkOut)].filter(Boolean).join("–");
  const head = [`📝 *DAR — ${name}*`, `📅 ${fmtDay(date)}${times ? ` · ${times}` : ""}`];
  if (groupName) head.unshift(`👥 ${groupName}`);
  return `${head.join("\n")}\n\n${(text || "").trim()}`;
}

export function DarTextarea({ value, onChange, minChars = 20, headline, footnote, testId = "dar-text" }) {
  const len = value.trim().length;
  const short = len > 0 && len < minChars;
  return (
    <div className="text-left rounded-2xl border border-sky-200 bg-sky-50 p-4 mb-4" data-testid={`${testId}-card`}>
      <div className="flex items-center gap-2 text-sky-800 font-bold text-sm">
        <FileText size={16} /> {headline || "Daily Activity Report (required to check out)"}
      </div>
      <textarea
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={6}
        placeholder="Paste or type today's DAR — what you worked on, outcomes, follow-ups…"
        className="iu-input w-full mt-2 !h-auto min-h-[140px] text-sm leading-relaxed resize-y"
      />
      <div className="flex justify-between mt-1 text-[11px]">
        <span className="text-sky-700">{footnote || "No length limit. Saved against your name and shared to the DAR WhatsApp group."}</span>
        <span className={short ? "text-rose-600 font-semibold" : "text-slate-400"} data-testid={`${testId}-count`}>
          {len} chars{short ? ` · min ${minChars}` : ""}
        </span>
      </div>
    </div>
  );
}

export function DarShareButton({ dar, name, groupName, className = "" }) {
  if (!dar) return null;
  const onShare = () => shareToWhatsApp({
    text: formatDarCaption({
      groupName, name, date: dar.date, checkIn: dar.check_in_at, checkOut: dar.check_out_at, text: dar.text,
    }),
  });
  return (
    <button
      type="button"
      data-testid="share-dar-btn"
      onClick={onShare}
      title={`Share this DAR to the ${groupName || "DAR"} WhatsApp group`}
      className={`inline-flex items-center gap-2 px-4 h-10 rounded-full bg-sky-600 hover:bg-sky-700 text-white text-sm font-semibold shadow-sm transition ${className}`}
    >
      <Share2 size={15} /> Share DAR to WhatsApp
    </button>
  );
}
