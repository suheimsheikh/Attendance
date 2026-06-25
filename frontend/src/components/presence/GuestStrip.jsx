import React from "react";
import { UserPlus, LogOut as ExitIcon, X } from "lucide-react";
import Avatar from "../Avatar";

function GuestStripRow({ guest, active, onCheckout, onDelete }) {
  const inAt = new Date(guest.checked_in_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const outAt = guest.checked_out_at ? new Date(guest.checked_out_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <div className={`px-4 py-2.5 flex items-center gap-3 ${active ? "" : "opacity-60"}`} data-testid={`guest-row-${guest.id}`}>
      <Avatar name={guest.name} photo={guest.photo} size={34} ring={active ? "#7C3AED" : null} />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold text-slate-900 leading-tight truncate">{guest.name}</div>
        <div className="text-[10px] text-slate-500 mt-0.5 leading-tight truncate">
          In {inAt} by {guest.checked_in_by_name}
          {outAt && <> · Out {outAt} by {guest.checked_out_by_name}</>}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {active && (
          <button
            onClick={() => onCheckout(guest.id, guest.name)}
            data-testid={`guest-checkout-${guest.id}`}
            className="inline-flex items-center gap-1 px-2 h-7 rounded-md text-[11px] font-bold bg-slate-700 text-white hover:bg-slate-900"
          >
            <ExitIcon size={11} /> Check out
          </button>
        )}
        <button
          onClick={() => onDelete(guest.id, guest.name)}
          data-testid={`guest-delete-${guest.id}`}
          className="inline-flex items-center px-1.5 h-7 rounded-md text-rose-700 hover:bg-rose-50"
          title="Remove this guest entry"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}

export function GuestStrip({ guests, onCheckout, onDelete, onAdd }) {
  const active = guests.active || [];
  const completed = guests.completed || [];
  const total = active.length + completed.length;
  return (
    <section
      className="mb-4 rounded-2xl bg-violet-50 border border-violet-200 overflow-hidden"
      data-testid="presence-guests-strip"
    >
      <header
        className="px-4 py-2.5 flex items-center gap-3 bg-white/70 backdrop-blur border-b border-violet-200"
        style={{ boxShadow: `inset 4px 0 0 #7C3AED` }}
      >
        <div className="w-7 h-7 rounded-md flex items-center justify-center bg-violet-100 text-violet-700 shrink-0">
          <UserPlus size={15} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-wider font-bold text-violet-700">Guests today</div>
          <div className="text-[11px] text-slate-500">
            {active.length} on campus
            {completed.length > 0 && <> · {completed.length} checked out</>}
            {total === 0 && <>· no visitors yet</>}
          </div>
        </div>
        <span className="min-w-[26px] h-6 px-2 rounded-full text-xs font-bold flex items-center justify-center bg-violet-200 text-violet-800" data-testid="strip-count-guests">
          {active.length}
        </span>
        <button
          onClick={onAdd}
          data-testid="guests-add-inline"
          className="inline-flex items-center gap-1 px-3 h-8 rounded-md text-xs font-bold bg-violet-600 text-white hover:bg-violet-700 transition shrink-0"
        >
          <UserPlus size={12} /> Check in a guest
        </button>
      </header>

      {/* ~3 rows visible (avatar 34 + py 2.5*2 + meta ≈ 64 px each). Scrolls if more. */}
      <div className="overflow-y-auto bg-white" style={{ maxHeight: "13rem" }}>
        {total === 0 ? (
          <div className="px-4 py-5 text-center text-xs text-slate-400">No guests today. Tap “Check in a guest” to log a visitor.</div>
        ) : (
          <div className="divide-y divide-violet-100">
            {active.map((g) => (
              <GuestStripRow key={g.id} guest={g} active onCheckout={onCheckout} onDelete={onDelete} />
            ))}
            {completed.length > 0 && (
              <div className="px-4 py-1 text-[10px] uppercase tracking-wider font-bold text-slate-400 bg-slate-50">
                Checked out today
              </div>
            )}
            {completed.map((g) => (
              <GuestStripRow key={g.id} guest={g} active={false} onCheckout={onCheckout} onDelete={onDelete} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
