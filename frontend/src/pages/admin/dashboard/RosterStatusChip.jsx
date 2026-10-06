import React, { useState } from "react";
import { CheckCircle2, Clock, Loader2, Share2 } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../../../api";
import { useApiQuery } from "../../../hooks/useApiQuery";
import { buildLeaveTourMessage } from "../../../components/LeaveReportPrompt";
import { shareToWhatsApp } from "../../../utils/shareWhatsApp";
import { fmtHmIst } from "../../../utils/dates";

/** Who posted today's Leave/Tour roster to WhatsApp — or a one-tap "Post now" if nobody has. */
export default function RosterStatusChip() {
  const { data, refetch } = useApiQuery("/leave-report/today-status", null, {
    staleTime: 30_000, refetchInterval: 60_000, refetchIntervalInBackground: false,
  });
  const [busy, setBusy] = useState(false);
  if (!data) return null;

  const postNow = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const roster = await api.get("/muster/daily-roster");
      await shareToWhatsApp({ text: buildLeaveTourMessage(roster) });
      await api.post("/leave-report/mark-posted");
      toast.success("Posted — pick the YCH Attendance group and send.");
      refetch();
    } catch (e) {
      showApiError(e, "Could not prepare today's roster");
    } finally { setBusy(false); }
  };

  if (data.posted) {
    return (
      <span
        data-testid="roster-status-chip"
        data-state="posted"
        title="Today's Leave/Tour roster has been shared to WhatsApp"
        className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200"
      >
        <CheckCircle2 size={13} />
        Roster posted by <span data-testid="roster-status-by">{data.posted_by_name || "an admin"}</span>
        {data.posted_at && <span data-testid="roster-status-time">· {fmtHmIst(data.posted_at)}</span>}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={postNow}
      disabled={busy}
      data-testid="roster-status-chip"
      data-state="pending"
      title="Nobody has shared today's Leave/Tour roster yet — tap to post it to WhatsApp"
      className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-300 hover:bg-amber-100 transition-colors"
    >
      <Clock size={13} />
      Roster not posted yet
      <span className="inline-flex items-center gap-1 ml-1 text-amber-900 underline underline-offset-2" data-testid="roster-status-post-now">
        {busy ? <Loader2 size={12} className="animate-spin" /> : <Share2 size={12} />} Post now
      </span>
    </button>
  );
}
