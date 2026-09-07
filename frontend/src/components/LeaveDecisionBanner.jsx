/**
 * LeaveDecisionBanner — shows the logged-in member their latest
 * unacknowledged leave decisions the moment they open the app.
 *
 * Feb 2026 · Slice 2 of the Approvals rework.
 * Backend endpoint: GET /api/me/leave-notifications  → unacked decisions
 *                    POST /api/me/leave-notifications/{id}/ack
 *
 * Design decisions:
 *   • Rendered inside Layout.jsx so it appears above every page, not
 *     only MyLeaves — a member checking in at 06:00 needs to know
 *     yesterday's rejection before they head to the pier.
 *   • ONE banner at a time — we show the newest decision and, if the
 *     applicant has multiple pending acks, chevron through them
 *     rather than stacking a wall of cards.
 *   • Dismissing is an ACK on the server (persists across devices).
 *     Closing the banner without ack (tab close) means it re-appears
 *     next visit — the whole point of the feature.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Check, X, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { api } from "../api";
import { shortDate } from "../utils";

export default function LeaveDecisionBanner() {
  const [rows, setRows] = useState([]);
  const [idx, setIdx] = useState(0);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await api.get("/me/leave-notifications");
      setRows(list || []);
      setIdx(0);
    } catch {
      // Silent — the banner is a nice-to-have, don't scare the user.
      setRows([]);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (rows.length === 0) return null;

  const current = rows[idx];
  if (!current) return null;

  const isApproved = current.status === "approved";
  const range = current.start_date === current.end_date
    ? shortDate(current.start_date)
    : `${shortDate(current.start_date)} → ${shortDate(current.end_date)}`;
  const typeLabel = (current.type || "leave").toUpperCase();

  const ack = async () => {
    setBusy(true);
    try {
      await api.post(`/me/leave-notifications/${current.id}/ack`);
      // Optimistically drop the row so the banner either advances or
      // disappears without a round-trip.
      setRows((prev) => prev.filter((r) => r.id !== current.id));
      setIdx((i) => Math.max(0, i - 1));
    } catch {
      // Server refused (rare — usually a stale id). Best-effort refetch.
      load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="leave-decision-banner"
      className={`w-full border-b ${isApproved
        ? "bg-emerald-50 border-emerald-200 text-emerald-900"
        : "bg-rose-50 border-rose-200 text-rose-900"}`}
    >
      <div className="max-w-6xl mx-auto px-4 md:px-6 py-2.5 flex items-center gap-3 flex-wrap">
        <span
          className={`inline-flex items-center gap-1 px-2 h-5 rounded-full text-[10px] font-extrabold uppercase tracking-wider ${
            isApproved ? "bg-emerald-200 text-emerald-900" : "bg-rose-200 text-rose-900"
          }`}
        >
          {isApproved ? <Check size={11} /> : <X size={11} />}
          {isApproved ? "Approved" : "Rejected"}
        </span>
        <div className="flex-1 min-w-0 text-sm">
          <div className="font-semibold">
            Your {typeLabel} for <span className="font-mono">{range}</span>
            {current.half_day && <span className="ml-1 text-xs opacity-70">· half day ({current.half_day})</span>}
            {" "}was <span className="font-extrabold">{current.status}</span>
            {current.decided_by && <span className="opacity-70"> by {current.decided_by}</span>}
            {current.decided_at && <span className="opacity-60 text-xs"> · {shortDate(current.decided_at)}</span>}
          </div>
          {!isApproved && current.denial_reason && (
            <div className="text-xs mt-0.5" data-testid="banner-denial-reason">
              <span className="font-bold uppercase tracking-wide opacity-80 text-[10px]">Reason:</span>{" "}
              {current.denial_reason}
            </div>
          )}
          {isApproved && current.approval_override_reason && (
            <div className="text-xs mt-0.5" data-testid="banner-override-reason">
              <span className="font-bold uppercase tracking-wide opacity-80 text-[10px]">LOP note:</span>{" "}
              {current.approval_override_reason}
            </div>
          )}
        </div>
        {rows.length > 1 && (
          <div className="inline-flex items-center gap-1 text-xs opacity-80" data-testid="banner-pager">
            <button
              type="button"
              data-testid="banner-prev"
              onClick={() => setIdx((i) => Math.max(0, i - 1))}
              disabled={idx === 0}
              className="p-1 rounded hover:bg-white/50 disabled:opacity-30"
              aria-label="Previous"
            >
              <ChevronLeft size={13} />
            </button>
            <span className="tabular-nums">{idx + 1} / {rows.length}</span>
            <button
              type="button"
              data-testid="banner-next"
              onClick={() => setIdx((i) => Math.min(rows.length - 1, i + 1))}
              disabled={idx >= rows.length - 1}
              className="p-1 rounded hover:bg-white/50 disabled:opacity-30"
              aria-label="Next"
            >
              <ChevronRight size={13} />
            </button>
          </div>
        )}
        <button
          type="button"
          data-testid="banner-ack"
          onClick={ack}
          disabled={busy}
          className={`inline-flex items-center gap-1 h-8 px-3 rounded-md text-xs font-bold ${
            isApproved
              ? "bg-emerald-600 text-white hover:bg-emerald-700"
              : "bg-rose-600 text-white hover:bg-rose-700"
          } disabled:opacity-60`}
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          Got it
        </button>
      </div>
    </div>
  );
}
