import React, { useEffect, useState } from "react";
import { Loader2, Plus, X, CalendarDays, Plane, Bed, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";
import { shortDate, todayIso } from "../utils";
import { useEscape } from "../hooks/useEscape";

const TYPE_LABELS = { leave: { label: "Leave", color: "#F59E0B", Icon: Bed }, tour: { label: "Tour", color: "#F97316", Icon: Plane } };
const STATUS_COLORS = {
  pending: { bg: "rgba(245,158,11,0.12)", color: "#B45309" },
  approved: { bg: "rgba(16,185,129,0.12)", color: "#047857" },
  rejected: { bg: "rgba(239,68,68,0.12)", color: "#B91C1C" },
};

export default function MyLeaves() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  const load = async () => {
    try { setItems(await api.get("/leaves/mine")); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto">
      <header className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">My Leave and Tour</h1>
          <p className="text-slate-500 text-sm mt-1">Track your leave and tour requests.</p>
        </div>
        <button data-testid="apply-leave-button" onClick={() => setShowForm(true)} className="iu-btn-primary">
          <Plus size={16} /> Apply
        </button>
      </header>

      {loading ? (
        <div className="text-center py-10"><Loader2 className="mx-auto animate-spin text-slate-400" /></div>
      ) : items.length === 0 ? (
        <div className="iu-card p-10 text-center" data-testid="myleaves-empty">
          <CalendarDays className="mx-auto text-slate-300 mb-2" size={36} />
          <p className="font-semibold text-slate-700">No requests yet</p>
          <p className="text-sm text-slate-500 mt-1">Tap Apply to submit a leave or tour.</p>
        </div>
      ) : (
        <div className="space-y-3" data-testid="myleaves-list">
          {items.map((l) => {
            const t = TYPE_LABELS[l.type] || TYPE_LABELS.leave;
            const s = STATUS_COLORS[l.status] || STATUS_COLORS.pending;
            return (
              <div key={l.id} className={`iu-card p-4 flex items-center gap-4 ${l.late_application ? "ring-2 ring-red-200 bg-red-50/50" : ""}`} data-testid={`myleave-${l.id}`}>
                <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: t.color + "22", color: t.color }}>
                  <t.Icon size={18} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="font-semibold">{t.label}{l.location ? ` · ${l.location}` : ""}</div>
                    {l.late_application && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-extrabold uppercase tracking-wide">
                        <AlertTriangle size={10} /> Late
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">{shortDate(l.start_date)} – {shortDate(l.end_date)}</div>
                  <div className="text-xs text-slate-600 mt-1 line-clamp-2">{l.reason}</div>
                </div>
                <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold capitalize" style={{ background: s.bg, color: s.color }}>
                  {l.status}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {showForm && <ApplyForm onClose={() => setShowForm(false)} onCreated={() => { setShowForm(false); load(); }} />}
    </div>
  );
}

function ApplyForm({ onClose, onCreated }) {
  useEscape(onClose);
  const [type, setType] = useState("leave");
  const [start, setStart] = useState(todayIso());
  const [end, setEnd] = useState(todayIso());
  const [reason, setReason] = useState("");
  const [location, setLocation] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!reason.trim()) { toast.error("Enter a reason"); return; }
    if (end < start) { toast.error("End date must be after start"); return; }
    setBusy(true);
    try {
      await api.post("/leaves", { type, start_date: start, end_date: end, reason, location: type === "tour" ? location : null });
      toast.success("Request submitted");
      onCreated();
    } catch (err) {
      toast.error(err?.message || "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50 p-0 md:p-4" onClick={onClose}>
      <div className="bg-white w-full md:max-w-md rounded-t-2xl md:rounded-2xl p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()} data-testid="apply-leave-form">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-extrabold">New request</h2>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg"><X size={18} /></button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="iu-label">Type</label>
            <div className="grid grid-cols-2 gap-2">
              <button data-testid="leave-type-leave" type="button" onClick={() => setType("leave")} className={`iu-btn ${type === "leave" ? "iu-btn-primary" : "iu-btn-secondary"}`}><Bed size={16}/> Leave</button>
              <button data-testid="leave-type-tour" type="button" onClick={() => setType("tour")} className={`iu-btn ${type === "tour" ? "iu-btn-primary" : "iu-btn-secondary"}`}><Plane size={16}/> Tour</button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="iu-label">From</label>
              <input data-testid="leave-start" type="date" value={start} onChange={(e) => setStart(e.target.value)} className="iu-input" />
            </div>
            <div>
              <label className="iu-label">To</label>
              <input data-testid="leave-end" type="date" value={end} onChange={(e) => setEnd(e.target.value)} min={start} className="iu-input" />
            </div>
          </div>
          {start < todayIso() && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 flex items-start gap-2" data-testid="late-application-notice">
              <AlertTriangle size={14} className="text-red-600 mt-0.5 shrink-0" />
              <div className="text-xs text-red-700">
                <strong>Late application.</strong> Start date is in the past — this will be flagged for the admin to review.
              </div>
            </div>
          )}
          {type === "tour" && (
            <div>
              <label className="iu-label">Tour location</label>
              <input data-testid="leave-location" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Mumbai Naval Base" className="iu-input" />
            </div>
          )}
          <div>
            <label className="iu-label">Reason</label>
            <textarea data-testid="leave-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Tell your admin why…" className="iu-input !h-auto py-2" />
          </div>
          <button data-testid="leave-submit" type="submit" disabled={busy} className="iu-btn-primary w-full">
            {busy ? <Loader2 className="animate-spin" size={16}/> : "Submit"}
          </button>
        </form>
      </div>
    </div>
  );
}
