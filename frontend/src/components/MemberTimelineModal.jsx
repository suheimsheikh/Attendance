/**
 * MemberTimelineModal — day-by-day drill-down modal for the Attendance
 * report. Triggered by double-clicking a member's row in Reports.jsx.
 *
 * Shows every calendar day in the report window with:
 *   • Date + weekday
 *   • Primary bucket badge (Present / Leave / Tour / Absent / Off / …)
 *   • Details: check-in/out times + hours, leave reasons, half-day
 *     flags, late-coming expected arrivals, break names, etc.
 *
 * Design notes:
 *   • Compact table (text-xs, tight rows) — matches the parent report's
 *     visual density so it doesn't feel like a different app.
 *   • Bucket colours mirror the parent-table group colours (emerald =
 *     present, amber = leave, red = absent, slate = off, …).
 *   • "Copy" button dumps the timeline as a Markdown table into the
 *     clipboard — admins pasted it into WhatsApp / email during the
 *     first-user tests (7 Jul 2026).
 */
import React, { useEffect, useState } from "react";
import { X, Loader2, Copy, Check } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";

const BUCKET_STYLES = {
  present:         { bg: "bg-emerald-100", text: "text-emerald-800", ring: "ring-emerald-200" },
  leave:           { bg: "bg-amber-100",   text: "text-amber-800",   ring: "ring-amber-200"   },
  tour:            { bg: "bg-orange-100",  text: "text-orange-800",  ring: "ring-orange-200"  },
  posting:         { bg: "bg-orange-100",  text: "text-orange-800",  ring: "ring-orange-200"  },
  comp_off:        { bg: "bg-sky-100",     text: "text-sky-800",     ring: "ring-sky-200"     },
  late_coming:     { bg: "bg-yellow-100",  text: "text-yellow-800",  ring: "ring-yellow-200"  },
  "break":         { bg: "bg-purple-100",  text: "text-purple-800",  ring: "ring-purple-200"  },
  escort:          { bg: "bg-teal-100",    text: "text-teal-800",    ring: "ring-teal-200"    },
  off_weekly:      { bg: "bg-slate-100",   text: "text-slate-600",   ring: "ring-slate-200"   },
  off_in_progress: { bg: "bg-slate-50",    text: "text-slate-500",   ring: "ring-slate-200"   },
  absent:          { bg: "bg-red-100",     text: "text-red-800",     ring: "ring-red-200"     },
};

function BucketBadge({ bucket, label }) {
  const s = BUCKET_STYLES[bucket] || BUCKET_STYLES.absent;
  return (
    <span
      data-testid={`timeline-bucket-${bucket}`}
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ring-1 ${s.bg} ${s.text} ${s.ring}`}
    >
      {label}
    </span>
  );
}

/** Format a details row into a short human-readable string. */
function renderDetail(d) {
  if (d.type === "attendance") {
    const parts = [];
    if (d.check_in_time) parts.push(`in ${d.check_in_time}`);
    if (d.check_out_time) parts.push(`out ${d.check_out_time}`);
    if (d.hours) parts.push(`${d.hours}h`);
    if (d.late) parts.push(`late ${d.late_minutes || 0}m`);
    if (d.auto_checkout) parts.push("auto-checkout");
    if (d.out_of_geofence) parts.push("off-geo");
    if (d.overtime_total_min) {
      parts.push(`OT ${d.overtime_total_min}m (${d.overtime_status || "n/a"})`);
    }
    return parts.join(" · ");
  }
  if (d.type === "escort") return "Escort duty";
  if (d.type === "break") return d.name ? `Break: ${d.name}` : "Break / Holiday";
  const parts = [];
  if (d.status && d.status !== "approved") parts.push(d.status.toUpperCase());
  if (d.half_day) parts.push(d.half_day);
  if (d.expected_arrival) parts.push(`expected ${d.expected_arrival}`);
  if (d.location) parts.push(d.location);
  if (d.reason) parts.push(`"${d.reason}"`);
  return parts.join(" · ") || d.type;
}

function prettyDate(iso) {
  try {
    return new Date(iso + "T00:00:00").toLocaleDateString(undefined,
      { day: "2-digit", month: "short", year: "numeric" });
  } catch { return iso; }
}

export default function MemberTimelineModal({ memberId, start, end, onClose }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get("/reports/member-timeline", { member_id: memberId, start, end })
      .then((r) => { if (!cancelled) setData(r); })
      .catch((err) => { if (!cancelled) toast.error(err?.message || "Failed"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [memberId, start, end]);

  // Close on ESC — keyboard-first admins expect this.
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copyMarkdown = async () => {
    if (!data) return;
    const lines = [
      `# ${data.member_name} — ${prettyDate(data.start)} to ${prettyDate(data.end)}`,
      "",
      "| Date | Day | Status | Details |",
      "| --- | --- | --- | --- |",
      ...data.days.map((d) => {
        const detail = (d.details || []).map(renderDetail).filter(Boolean).join(" | ") || "—";
        return `| ${d.date} | ${d.weekday} | ${d.label} | ${detail} |`;
      }),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      toast.success("Copied timeline as Markdown");
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Clipboard blocked by browser");
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-4 md:p-10"
      onClick={onClose}
      data-testid="timeline-backdrop"
    >
      <div
        className="w-full max-w-3xl bg-white rounded-xl shadow-2xl ring-1 ring-slate-200 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        data-testid="timeline-modal"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <h2 className="font-extrabold tracking-tight text-lg truncate" data-testid="timeline-title">
              {data?.member_name || "Loading…"}
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              {data && (
                <>
                  {data.rank ? `${data.rank} · ` : ""}
                  {(data.category || "").toString().toUpperCase()}
                  {data.weekly_off ? ` · Weekly off: ${data.weekly_off}` : ""}
                  {" · "}
                  {prettyDate(data.start)} → {prettyDate(data.end)}
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={copyMarkdown}
            disabled={!data}
            className="iu-btn-secondary !h-8 !py-1 !px-2 text-xs"
            data-testid="timeline-copy"
            title="Copy as Markdown"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="iu-btn-secondary !h-8 !w-8 !p-0 justify-center"
            data-testid="timeline-close"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="max-h-[70vh] overflow-y-auto">
          {loading && (
            <div className="p-10 text-center text-slate-400">
              <Loader2 className="mx-auto animate-spin" />
            </div>
          )}
          {!loading && data && (
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200">
                <tr className="text-[10px] uppercase tracking-wider font-bold text-slate-500">
                  <th className="py-2 px-3 text-left">Date</th>
                  <th className="py-2 px-3 text-left">Day</th>
                  <th className="py-2 px-3 text-left">Status</th>
                  <th className="py-2 px-3 text-left">Details</th>
                </tr>
              </thead>
              <tbody data-testid="timeline-body">
                {data.days.map((d) => (
                  <tr
                    key={d.date}
                    className={`border-t border-slate-100 hover:bg-slate-50 ${d.is_today ? "bg-amber-50/40" : ""}`}
                    data-testid={`timeline-row-${d.date}`}
                  >
                    <td className="py-1.5 px-3 font-mono tabular-nums text-slate-800">
                      {d.date.split("-").reverse().join("/")}
                    </td>
                    <td className="py-1.5 px-3 text-slate-500">{d.weekday}</td>
                    <td className="py-1.5 px-3">
                      <BucketBadge bucket={d.bucket} label={d.label} />
                    </td>
                    <td className="py-1.5 px-3 text-slate-600 leading-tight">
                      {(d.details || []).length === 0 ? (
                        <span className="text-slate-300">—</span>
                      ) : (
                        <ul className="space-y-0.5">
                          {d.details.map((det, i) => (
                            // `details` items don't carry stable ids —
                            // a leave + a check-in for the same date can
                            // coexist. Compose a key from the type +
                            // stable payload fields so React re-uses
                            // rows correctly across re-renders.
                            <li key={`${det.type}-${det.status || det.check_in_time || det.expected_arrival || i}`}>
                              {renderDetail(det)}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer helper */}
        <div className="px-5 py-2 border-t border-slate-100 text-[10px] text-slate-400 flex items-center justify-between">
          <span>Double-click any name in the report to open this view.</span>
          <span>ESC to close</span>
        </div>
      </div>
    </div>
  );
}
