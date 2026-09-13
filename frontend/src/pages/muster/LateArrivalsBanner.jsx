import React, { useEffect, useState } from "react";
import { Clock, ChevronDown, ChevronRight } from "lucide-react";
import { api } from "../../api";
import useNotifyTemplates from "../../hooks/useNotifyTemplates";
import ParentNotifyList from "../../components/ParentNotifyList";

/**
 * LateArrivalsBanner — today's LATE athletes with one-tap parent notify
 * (bilingual Telugu + English) and shared ✓ tracking. Mirrors the absent
 * banner but pulls from /muster/late-report and uses the "late" template
 * (includes check-in time + minutes late). Athletes only.
 */
export default function LateArrivalsBanner() {
  const [report, setReport] = useState(null);
  const [expanded, setExpanded] = useState(false);
  const templates = useNotifyTemplates();

  useEffect(() => {
    let alive = true;
    api.get("/muster/late-report")
      .then((r) => { if (alive) setReport(r); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const contacts = report?.athlete_contacts || [];
  if (!report || contacts.length === 0) return null;

  return (
    <div
      data-testid="late-arrivals-banner"
      className="mb-4 rounded-xl border border-orange-300 bg-orange-50 p-3"
    >
      <div className="flex items-center gap-3 flex-wrap">
        <Clock size={18} className="text-orange-600 shrink-0" />
        <div className="flex-1 min-w-[180px]">
          <p className="text-sm font-semibold text-orange-800">
            Late arrivals today: {contacts.length} athlete{contacts.length > 1 ? "s" : ""}
          </p>
          <p className="text-xs text-orange-700">
            Checked in after their reporting time. Notify parents with one tap.
          </p>
        </div>
      </div>

      <div className="mt-3 border-t border-orange-200 pt-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          data-testid="late-notify-parents-toggle"
          title="Message each late athlete's parent individually on WhatsApp (Telugu + English)"
          className="flex items-center gap-1.5 text-xs font-bold text-orange-800 hover:text-orange-900 mb-2"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Notify parents individually
        </button>
        {expanded && (
          <ParentNotifyList
            reason="late"
            contacts={contacts}
            templates={templates}
            academy={report.office_name}
            dateIso={report.date}
          />
        )}
      </div>
    </div>
  );
}
