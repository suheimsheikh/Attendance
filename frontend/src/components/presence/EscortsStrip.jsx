import React from "react";
import { Shield, Coffee, Users, AlertTriangle } from "lucide-react";
import Avatar from "../Avatar";
import { ExpectedReturnPill } from "./ExpectedReturnPill";

/**
 * Days between today (local) and a YYYY-MM-DD ISO date string.
 * Returns null if the date string is missing or unparseable.
 * Negative result means the date is in the past.
 */
function daysUntil(isoDate) {
  if (!isoDate) return null;
  try {
    const [y, m, d] = isoDate.split("-").map(Number);
    if (!y || !m || !d) return null;
    const target = new Date(y, m - 1, d);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.floor((target - today) / 86400000);
  } catch {
    return null;
  }
}

/**
 * EscortsStrip — small list shown above the column grid on the Presence
 * Board surfacing every escort who has checked in (via /escort-checkin)
 * and not yet checked out. Escorts aren't in the `users` collection, so
 * they never appear in the columns themselves.
 *
 * Visually mirrors GuestStrip (purple) but uses teal so the two
 * non-member surfaces stay distinct at a glance.
 */
function EscortStripRow({ escort }) {
  const inAt = escort.check_in_at
    ? new Date(escort.check_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "—";
  const onStepOut = !!escort.temp_out;
  // Enhancement (30 Jun 2026): warn the on-duty officer when an escort's
  // access window is about to lapse. Amber dot = ≤7 days, red dot =
  // already expired (shouldn't happen as the gate blocks login, but
  // historical/stuck sessions can drift past it).
  const dLeft = daysUntil(escort.valid_until);
  const expiringSoon = dLeft != null && dLeft >= 0 && dLeft <= 7;
  const expired = dLeft != null && dLeft < 0;
  return (
    <div
      className="px-4 py-2.5 flex items-center gap-3"
      data-testid={`escort-presence-row-${escort.escort_id}`}
    >
      <Avatar name={escort.name} photo={escort.photo} size={34} ring={onStepOut ? "#06B6D4" : "#0D9488"} />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold text-slate-900 leading-tight truncate flex items-center gap-2 flex-wrap">
          {escort.name}
          {(expiringSoon || expired) && (
            <span
              className={`inline-flex items-center gap-1 px-1.5 h-4 rounded text-[9px] font-bold shrink-0 ${expired ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}
              title={expired
                ? `Access expired ${Math.abs(dLeft)} day${Math.abs(dLeft) === 1 ? "" : "s"} ago (${escort.valid_until}) — renew before next sign-in.`
                : `Access expires in ${dLeft} day${dLeft === 1 ? "" : "s"} (${escort.valid_until}) — renew soon.`}
              data-testid={`escort-presence-expiry-${escort.escort_id}`}
            >
              <AlertTriangle size={9}/>
              {expired ? "expired" : (dLeft === 0 ? "expires today" : `${dLeft}d left`)}
            </span>
          )}
          {onStepOut && (
            <span
              className="inline-flex items-center gap-1 px-1.5 h-4 rounded text-[9px] font-bold bg-cyan-100 text-cyan-700 shrink-0"
              title={escort.temp_out_reason || "Stepped out"}
              data-testid={`escort-presence-stepout-${escort.escort_id}`}
            >
              <Coffee size={9}/> stepped out
            </span>
          )}
          {onStepOut && (
            <ExpectedReturnPill
              expectedReturnTime={escort.expected_return_time}
              expectedReturnIso={escort.expected_return}
              overdueMinutes={escort.overdue_minutes}
              testId={`strip-escort-due-${escort.escort_id}`}
            />
          )}
        </div>
        <div className="text-[10px] text-slate-500 mt-0.5 leading-tight truncate">
          {escort.institution || "no institution"} · In {inAt}
          {escort.athletes_count > 0 && (
            <> · <span className="inline-flex items-center gap-0.5"><Users size={9}/>{escort.athletes_count} athlete{escort.athletes_count === 1 ? "" : "s"}</span></>
          )}
        </div>
      </div>
    </div>
  );
}

export function EscortsStrip({ escorts }) {
  const list = escorts || [];
  if (list.length === 0) return null;
  return (
    <section
      className="mb-4 rounded-2xl bg-teal-50 border border-teal-200 overflow-hidden"
      data-testid="presence-escorts-strip"
    >
      <header
        className="px-4 py-2.5 flex items-center gap-3 bg-white/70 backdrop-blur border-b border-teal-200"
        style={{ boxShadow: `inset 4px 0 0 #0D9488` }}
      >
        <div className="w-7 h-7 rounded-md flex items-center justify-center bg-teal-100 text-teal-700 shrink-0">
          <Shield size={15} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-wider font-bold text-teal-700">Escorts on campus</div>
          <div className="text-[11px] text-slate-500">
            {list.length} escort{list.length === 1 ? "" : "s"} accompanying athletes today
          </div>
        </div>
        <span
          className="min-w-[26px] h-6 px-2 rounded-full text-xs font-bold flex items-center justify-center bg-teal-200 text-teal-800"
          data-testid="strip-count-escorts"
        >
          {list.length}
        </span>
      </header>

      {/* ~3 rows visible (avatar 34 + py 2.5*2 + meta ≈ 64 px each). Scrolls if more. */}
      <div className="overflow-y-auto bg-white" style={{ maxHeight: "13rem" }}>
        <div className="divide-y divide-teal-100">
          {list.map((e) => (
            <EscortStripRow key={e.attendance_id || e.escort_id} escort={e} />
          ))}
        </div>
      </div>
    </section>
  );
}
