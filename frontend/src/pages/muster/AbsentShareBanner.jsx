import React, { useEffect, useState } from "react";
import { Share2, UserX, ChevronDown, ChevronRight } from "lucide-react";
import { api } from "../../api";
import { shareToWhatsApp } from "../../utils/shareWhatsApp";
import useNotifyTemplates from "../../hooks/useNotifyTemplates";
import ParentNotifyList from "../../components/ParentNotifyList";

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

export const AbsentShareBanner = ({ defaultExpanded = false }) => {
  const [report, setReport] = useState(null);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const templates = useNotifyTemplates();

  useEffect(() => {
    let alive = true;
    api.get("/muster/absent-report")
      .then((r) => { if (alive) setReport(r); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  if (!report || !report.ready) return null;
  const n = report.athletes.length + report.coaches.length;
  if (n === 0) return null;

  const bits = [];
  if (report.athletes.length) bits.push(`${report.athletes.length} athlete${report.athletes.length > 1 ? "s" : ""}`);
  if (report.coaches.length) bits.push(`${report.coaches.length} coach${report.coaches.length > 1 ? "es" : ""}`);

  const contacts = report.athlete_contacts || [];

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

      {contacts.length > 0 && (
        <div className="mt-3 border-t border-amber-200 pt-2">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            data-testid="absent-notify-parents-toggle"
            title="Message each absent athlete's parent individually on WhatsApp (Telugu + English)"
            className="flex items-center gap-1.5 text-xs font-bold text-amber-800 hover:text-amber-900 mb-2"
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Notify parents individually
          </button>
          {expanded && (
            <ParentNotifyList
              reason="absent"
              contacts={contacts}
              templates={templates}
              academy={report.office_name}
              dateIso={report.date}
            />
          )}
        </div>
      )}
    </div>
  );
};

export default AbsentShareBanner;
