import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, X, CalendarDays, Plane, Bed, AlertTriangle, RefreshCw, Clock, Search, Check } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../api";
import Avatar from "../components/Avatar";
import LeaveBalanceNotice from "../components/LeaveBalanceNotice";
import { shortDate, todayIso } from "../utils";
import { useEscape } from "../hooks/useEscape";

const TYPE_LABELS = {
  leave:        { label: "Leave",        color: "#F59E0B", Icon: Bed },
  tour:         { label: "Tour",         color: "#F97316", Icon: Plane },
  comp_off:     { label: "Comp Off",     color: "#8B5CF6", Icon: RefreshCw }, // legacy rows only — no longer applicable
  late_coming:  { label: "Late Coming",  color: "#DC2626", Icon: Clock },
};
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

export function ApplyForm({ onClose, onCreated, asAdmin = false }) {
  useEscape(onClose);
  const [type, setType] = useState("leave");
  const [start, setStart] = useState(todayIso());
  const [end, setEnd] = useState(todayIso());
  const [reason, setReason] = useState("");
  const [location, setLocation] = useState("");
  const [expectedArrival, setExpectedArrival] = useState("");
  const [busy, setBusy] = useState(false);
  const [memberId, setMemberId] = useState("");          // legacy single-pick (non-admin path unchanged)
  const [members, setMembers] = useState([]);
  // Admin multi-select state
  const [institutions, setInstitutions] = useState([]);
  const [instFilter, setInstFilter] = useState("");
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState(new Set());
  const [autoApprove, setAutoApprove] = useState(true);

  // Self path needs the current user's live balance for the notice block.
  // (Admin path already loads /members, which carries balances per row.)
  const [me, setMe] = useState(null);
  // Unified balance summary: { comp_off:{accrued,used,available}, paid_leave:{opening,used,available,tracked}, total_available }
  // For self path: fetched from /api/me/leave-summary on mount.
  // For admin path single-pick: fetched from /api/members/{id}/leave-summary.
  // For admin multi-pick: null (per-member balances differ — Notice falls back to per-member rows).
  const [balanceSummary, setBalanceSummary] = useState(null);
  useEffect(() => {
    if (asAdmin) return;
    api.get("/auth/me").then(setMe).catch(() => {});
    api.get("/me/leave-summary").then(setBalanceSummary).catch(() => {});
  }, [asAdmin]);

  // Admin single-pick: refetch unified summary whenever the picked target
  // changes. Multi-pick clears the summary (per-member balances differ).
  useEffect(() => {
    if (!asAdmin) return;
    let cancelled = false;
    const ids = Array.from(picked);
    if (ids.length !== 1) { setBalanceSummary(null); return; }
    (async () => {
      try {
        const r = await api.get(`/members/${ids[0]}/leave-summary`);
        if (!cancelled) setBalanceSummary(r);
      } catch {
        if (!cancelled) setBalanceSummary(null);
      }
    })();
    return () => { cancelled = true; };
  }, [asAdmin, picked]);

  useEffect(() => {
    if (!asAdmin) return;
    api.get("/members").then((m) => setMembers(m || [])).catch(() => {});
    api.get("/institutions").then((r) => setInstitutions(r || [])).catch(() => {});
  }, [asAdmin]);

  // Filtered list of athletes/members for the multi-select panel.
  const filteredMembers = useMemo(() => {
    if (!asAdmin) return [];
    const q = search.trim().toLowerCase();
    return members.filter((m) => {
      if (instFilter && m.institution !== instFilter) return false;
      if (!q) return true;
      return (m.full_name || "").toLowerCase().includes(q) ||
             (m.rank || "").toLowerCase().includes(q) ||
             (m.email || "").toLowerCase().includes(q);
    });
  }, [asAdmin, members, instFilter, search]);

  const togglePick = (id) => setPicked((p) => {
    const n = new Set(p);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const pickAllFiltered = () => setPicked(new Set(filteredMembers.map((m) => m.id)));
  const clearPicked = () => setPicked(new Set());

  // ── Leave-balance preview (for the notice block) ─────────────────────────
  // Calendar days inclusive — matches the backend formula (`end - start + 1`).
  const requestedDays = useMemo(() => {
    try {
      const s = new Date(start + "T00:00:00");
      const e = new Date(end + "T00:00:00");
      if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return 0;
      return Math.floor((e - s) / 86400000) + 1;
    } catch {
      return 0;
    }
  }, [start, end]);

  // Build the per-member row(s) the notice expects. Self path = 1 row from
  // /auth/me. Admin path = one row per picked member from /members.
  const noticeMembers = useMemo(() => {
    if (asAdmin) {
      return Array.from(picked).map((id) => {
        const m = members.find((x) => x.id === id);
        if (!m) return null;
        return {
          id: m.id,
          full_name: m.full_name,
          category: m.category,
          opening: m.leave_balance_opening,
          remaining: m.leave_balance_remaining,
        };
      }).filter(Boolean);
    }
    if (!me) return [];
    return [{
      id: me.id,
      full_name: me.full_name,
      category: me.category,
      opening: me.leave_balance_opening,
      remaining: me.leave_balance_remaining,
    }];
  }, [asAdmin, picked, members, me]);

  // Late-coming is single-day & today
  useEffect(() => {
    if (type === "late_coming") {
      const t = todayIso();
      setStart(t); setEnd(t);
    }
  }, [type]);

  const submit = async (e) => {
    e.preventDefault();
    if (asAdmin && picked.size === 0) { toast.error("Pick at least one member"); return; }
    if (!reason.trim()) { toast.error("Enter a reason"); return; }
    if (type === "late_coming" && !expectedArrival) { toast.error("Tell us when you'll arrive"); return; }
    if (end < start) { toast.error("End date must be after start"); return; }
    setBusy(true);
    try {
      if (asAdmin) {
        // Admin path → always use the group endpoint, even for a single pick.
        // expected_arrival isn't accepted by /leaves/group; fold it into the reason
        // so the admin's intent isn't lost.
        const reasonOut = type === "late_coming" && expectedArrival
          ? `${reason.trim()} (expected arrival ${expectedArrival})`
          : reason.trim();
        const r = await api.post("/leaves/group", {
          user_ids: [...picked],
          type,
          start_date: start,
          end_date: end,
          reason: reasonOut,
          location: type === "tour" ? location : null,
          auto_approve: autoApprove,
        });
        toast.success(`${r.created} ${r.created === 1 ? "request" : "requests"} created (${r.status})`);
      } else {
        const payload = {
          type, start_date: start, end_date: end, reason,
          location: type === "tour" ? location : null,
          expected_arrival: type === "late_coming" ? expectedArrival : null,
        };
        await api.post("/leaves", payload);
        toast.success("Request submitted");
      }
      onCreated();
    } catch (err) {
      showApiError(err, "Failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50 p-0 md:p-4" onClick={onClose}>
      <div className={`bg-white w-full ${asAdmin ? "md:max-w-3xl" : "md:max-w-md"} rounded-t-2xl md:rounded-2xl p-6 max-h-[90vh] overflow-y-auto`} onClick={(e) => e.stopPropagation()} data-testid="apply-leave-form">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-extrabold">{asAdmin ? "Apply on behalf of members" : "New request"}</h2>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg"><X size={18} /></button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          {asAdmin && (
            <div className="rounded-xl border border-slate-200 bg-slate-50/50 p-3 space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <label className="iu-label !mb-0">Pick members ({picked.size} selected)</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={pickAllFiltered}
                    data-testid="ob-pick-all"
                    className="iu-btn-secondary !h-8 !px-2 !text-xs"
                  >Pick all ({filteredMembers.length})</button>
                  <button
                    type="button"
                    onClick={clearPicked}
                    data-testid="ob-clear"
                    className="iu-btn-secondary !h-8 !px-2 !text-xs"
                    disabled={picked.size === 0}
                  >Clear</button>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1 flex items-center gap-2 px-2 h-9 rounded-lg border border-slate-200 bg-white">
                  <Search size={14} className="text-slate-400" />
                  <input
                    data-testid="ob-search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search by name, rank or email…"
                    className="flex-1 outline-none bg-transparent text-sm"
                  />
                </div>
                <select
                  data-testid="ob-inst-filter"
                  value={instFilter}
                  onChange={(e) => setInstFilter(e.target.value)}
                  className="iu-input !h-9 !w-44"
                >
                  <option value="">All institutions</option>
                  {institutions.map((i) => <option key={i.id} value={i.name}>{i.name}</option>)}
                </select>
              </div>
              <div className="bg-white rounded-lg border border-slate-200 max-h-[34vh] overflow-auto divide-y divide-slate-100" data-testid="ob-member-list">
                {filteredMembers.length === 0 ? (
                  <div className="px-3 py-6 text-center text-sm text-slate-500">No members match.</div>
                ) : filteredMembers.map((m) => {
                  const on = picked.has(m.id);
                  return (
                    <label
                      key={m.id}
                      className={`px-3 py-2 flex items-center gap-3 cursor-pointer transition ${on ? "bg-emerald-50/70" : "hover:bg-slate-50"}`}
                      data-testid={`ob-row-${m.id}`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => togglePick(m.id)}
                        data-testid={`ob-checkbox-${m.id}`}
                      />
                      <Avatar name={m.full_name} photo={m.photo} size={28} />
                      <div className="flex-1 min-w-0">
                        <div className="font-semibold text-sm text-slate-900 truncate">{m.full_name}</div>
                        <div className="text-[11px] text-slate-500 truncate">
                          {m.rank ? `${m.rank} · ` : ""}{m.institution || "—"}
                        </div>
                      </div>
                      {on && <Check size={14} className="text-emerald-600" />}
                    </label>
                  );
                })}
              </div>
              <label className="flex items-center gap-2 text-sm cursor-pointer pt-1">
                <input
                  type="checkbox"
                  checked={autoApprove}
                  onChange={(e) => setAutoApprove(e.target.checked)}
                  data-testid="ob-auto-approve"
                />
                Auto-approve (skip the pending queue)
              </label>
            </div>
          )}
          <div>
            <label className="iu-label">Type</label>
            <div className="grid grid-cols-3 gap-2">
              <button data-testid="leave-type-leave" type="button" onClick={() => setType("leave")} className={`iu-btn ${type === "leave" ? "iu-btn-primary" : "iu-btn-secondary"}`}><Bed size={16}/> Leave</button>
              <button data-testid="leave-type-tour" type="button" onClick={() => setType("tour")} className={`iu-btn ${type === "tour" ? "iu-btn-primary" : "iu-btn-secondary"}`}><Plane size={16}/> Tour</button>
              <button data-testid="leave-type-late-coming" type="button" onClick={() => setType("late_coming")} className={`iu-btn ${type === "late_coming" ? "iu-btn-primary" : "iu-btn-secondary"}`}><Clock size={16}/> Late Coming</button>
            </div>
            {type === "leave" && (
              <p className="text-[11px] text-slate-500 mt-1.5">Days are deducted from your Comp-Off balance first, then your Paid Leave. Anything left is treated as Loss of Pay.</p>
            )}
            {type === "late_coming" && (
              <p className="text-[11px] text-slate-500 mt-1.5">Use this when you&apos;ll arrive late today. Admin gets pinged so you&apos;re not flagged as absent.</p>
            )}
          </div>
          {type === "late_coming" && (
            <div>
              <label className="iu-label">Expected arrival today</label>
              <input
                data-testid="leave-expected-arrival"
                type="time"
                value={expectedArrival}
                onChange={(e) => setExpectedArrival(e.target.value)}
                className="iu-input"
              />
            </div>
          )}
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
          {/* Balance preview + LOP warning + "subject to approval" line.
              Always rendered (with content adapted by leave type), so the
              approval policy stays visible across self-apply and
              apply-on-behalf paths. */}
          {(noticeMembers.length > 0 || !asAdmin) && (
            <LeaveBalanceNotice
              requestedDays={Math.max(1, requestedDays || 1)}
              leaveType={type}
              members={noticeMembers}
              autoApprove={autoApprove}
              asAdmin={asAdmin}
              balanceSummary={balanceSummary}
            />
          )}
          <button data-testid="leave-submit" type="submit" disabled={busy} className="iu-btn-primary w-full disabled:opacity-60 disabled:cursor-not-allowed">
            {busy ? <Loader2 className="animate-spin" size={16}/> : "Submit"}
          </button>
        </form>
      </div>
    </div>
  );
}
