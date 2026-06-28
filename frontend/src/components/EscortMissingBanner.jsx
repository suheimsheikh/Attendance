import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { UserCheck, AlertCircle, ArrowRight } from "lucide-react";
import { api } from "../api";

/**
 * EscortMissingBanner — admin-facing strip on the Presence page (the
 * landing screen) summarising today's escort status: how many are
 * expected, how many haven't checked in yet. Tap → drills to the
 * Escorts Check in/Out kiosk so the admin can mark someone in on
 * their behalf.
 *
 * Renders nothing when there are no active escorts or everyone is in,
 * so it stays out of the way on normal days.
 */
export default function EscortMissingBanner() {
  const [data, setData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await api.get("/escort-attendance/today");
        if (!cancelled) setData(snap);
      } catch {
        // Endpoint may 401 for tokens without escort-read access — silent.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!data) return null;
  const total = (data.escorts || []).length;
  if (total === 0) return null;
  const attMap = Object.fromEntries((data.attendance || []).map((a) => [a.escort_id, a]));
  const checkedIn = (data.escorts || []).filter((e) => attMap[e.id]?.check_in_at).length;
  const missing = total - checkedIn;
  if (missing === 0) {
    return (
      <Link
        to="/escort-checkin"
        className="block rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-900 mb-3 hover:bg-emerald-100/60 transition"
        data-testid="escort-banner-all-in"
      >
        <span className="inline-flex items-center gap-1.5">
          <UserCheck size={13} className="text-emerald-700" />
          <strong>All {total} escort{total === 1 ? "" : "s"} in</strong> ·
          <span className="opacity-70">today is settled</span>
        </span>
      </Link>
    );
  }
  return (
    <Link
      to="/escort-checkin"
      className="block rounded-lg border border-amber-300 bg-amber-50/80 px-3 py-2.5 mb-3 hover:bg-amber-100/70 transition"
      data-testid="escort-banner-missing"
    >
      <div className="flex items-center gap-2 text-sm">
        <AlertCircle size={16} className="text-amber-700 shrink-0"/>
        <div className="flex-1 min-w-0 text-amber-900">
          <strong>{missing} of {total} escort{total === 1 ? "" : "s"} not checked in yet</strong>
          <span className="opacity-70 ml-1">— mark them in if they&apos;re here</span>
        </div>
        <span className="text-amber-700 inline-flex items-center gap-1 text-xs font-bold">
          Open kiosk <ArrowRight size={12} />
        </span>
      </div>
    </Link>
  );
}
