import React from "react";
import { Link } from "react-router-dom";
import { ShieldAlert, ArrowRight } from "lucide-react";
import { useApiQuery } from "../hooks/useApiQuery";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Persistent banner: corrections waiting for THIS admin's approval. Turns red after 24 h. */
export default function CorrectionsWaitingBanner({ enabled }) {
  const { data } = useApiQuery("/admin/corrections/pending-for-me", null, {
    enabled, staleTime: 60_000, refetchInterval: 5 * 60_000, refetchIntervalInBackground: false,
  });
  if (!enabled || !data?.count) return null;
  const overdue = data.oldest_at && Date.now() - new Date(data.oldest_at).getTime() > DAY_MS;
  const tone = overdue ? "bg-rose-50 border-rose-300 text-rose-800" : "bg-amber-50 border-amber-300 text-amber-900";
  const first = data.items?.[0];
  return (
    <div className={`mx-4 md:mx-8 mt-3 rounded-xl border px-4 py-2.5 flex flex-wrap items-center gap-2 text-sm ${tone}`}
      data-testid="corrections-waiting-banner" data-state={overdue ? "overdue" : "waiting"}>
      <ShieldAlert size={16} className="shrink-0" />
      <b data-testid="corrections-waiting-count">{data.count} correction{data.count === 1 ? "" : "s"} waiting for your approval</b>
      {first && <span className="text-xs opacity-80">· oldest: {first.requester_name} ({first.target_date}) filed by {first.filed_by}</span>}
      {overdue && <span className="text-xs font-bold uppercase tracking-wide" data-testid="corrections-waiting-overdue">over 24 h</span>}
      <Link to="/admin/approvals" className="ml-auto inline-flex items-center gap-1 font-bold underline underline-offset-2" data-testid="corrections-waiting-review">
        Review <ArrowRight size={14} />
      </Link>
    </div>
  );
}
