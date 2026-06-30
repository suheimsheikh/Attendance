import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, X, CalendarDays, Plane, Bed, AlertTriangle, RefreshCw, Clock, Search, Check, Briefcase } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";
import Avatar from "../components/Avatar";
import LeaveBalanceNotice from "../components/LeaveBalanceNotice";
import OverlapNotice from "../components/OverlapNotice";
import EventConflictNotice from "../components/EventConflictNotice";
import FormErrorBanner from "../components/FormErrorBanner";
import { useFormError } from "../hooks/useFormError";
import { shortDate, todayIso } from "../utils";
import { useEscape } from "../hooks/useEscape";

const TYPE_LABELS = {
  leave:        { label: "Leave",        color: "#F59E0B", Icon: Bed },
  tour:         { label: "Tour",         color: "#F97316", Icon: Plane },
  posting:      { label: "Posted",       color: "#0EA5E9", Icon: Briefcase },
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
  // Header dashboard fuel: every metric the member would want to know
  // BEFORE applying for more leave — comp-off, paid leave, pending,
  // future-approved, tour totals, LOP and approx absent days.
  const [summary, setSummary] = useState(null);

  const load = async () => {
    try {
      const [list, s] = await Promise.all([
        api.get("/leaves/mine"),
        api.get("/me/leave-summary").catch(() => null),
      ]);
      setItems(list);
      setSummary(s);
    }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const isAthlete = summary && !summary.paid_leave?.tracked && summary.comp_off?.accrued === 0 && summary.comp_off?.used === 0 && summary.paid_leave?.opening == null;

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto">
      <header className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">My Leave and Tour</h1>
          <p className="text-slate-500 text-sm mt-1">Your balances, applied requests and history — all in one place.</p>
        </div>
        <button data-testid="apply-leave-button" onClick={() => setShowForm(true)} className="iu-btn-primary">
          <Plus size={16} /> Apply
        </button>
      </header>

      {/* Stats dashboard — renders only when the summary is available and
          the user has any tracked balances. Athletes get a softer blurb. */}
      {summary && !isAthlete && (
        <StatsDashboard summary={summary} />
      )}
      {summary && isAthlete && (
        <div className="iu-card !p-3 mb-5 text-sm text-sky-900 bg-sky-50/60 border-sky-200" data-testid="myleaves-athlete-note">
          You don&apos;t use a numeric leave quota — your time-off is tracked via the team Breaks workflow.
          Tours and individual leave still appear here for your record.
        </div>
      )}

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
          {items.map((l) => <MyLeaveRow key={l.id} l={l} />)}
        </div>
      )}

      {showForm && <ApplyForm onClose={() => setShowForm(false)} onCreated={() => { setShowForm(false); load(); }} />}
    </div>
  );
}

/**
 * StatsDashboard — eight-tile grid summarising every relevant leave
 * number for the logged-in member. Drives directly from the unified
 * /me/leave-summary endpoint so the values stay consistent with what
 * the apply form's waterfall preview shows.
 */
function StatsDashboard({ summary }) {
  const co = summary.comp_off || { accrued: 0, used: 0, available: 0 };
  const pl = summary.paid_leave || { opening: null, used: 0, available: 0, tracked: false };
  const stats = [
    {
      key: "leave-availed",
      label: "Leave availed",
      value: pl.tracked ? round1(pl.used) : "—",
      hint: pl.tracked ? "Paid leave taken this year" : "Not tracked",
      tone: "amber",
      Icon: Bed,
    },
    {
      key: "leave-balance",
      label: "Paid Leave balance",
      value: pl.tracked ? round1(pl.available) : "—",
      hint: pl.tracked ? `Opening ${round1(pl.opening) || 0}` : "No opening balance",
      tone: pl.tracked && pl.available <= 0 ? "red" : "amber",
      Icon: Bed,
    },
    {
      key: "compoff-eligibility",
      label: "Comp-Off eligibility",
      value: co.available,
      hint: `Accrued ${co.accrued} − used ${co.used}`,
      // When some of the accrual came from approved tour days OR from an
      // admin-seeded opening balance (Jan-1 carry-forward), surface that
      // split as small foot-notes so the user can tell where the credits
      // came from. Sources are stacked when both are non-zero.
      footnotes: [
        (co.from_tours || 0) > 0 && { icon: Plane, text: `${co.from_tours} from tours`, tone: "orange" },
        (co.from_opening || 0) > 0 && { icon: RefreshCw, text: `${co.from_opening} opening`, tone: "violet" },
      ].filter(Boolean),
      tone: "violet",
      Icon: RefreshCw,
    },
    {
      key: "total-available",
      label: "Total leave available",
      value: pl.tracked ? round1(summary.total_available) : co.available,
      hint: "Comp-Off + Paid Leave",
      tone: "emerald",
      Icon: Check,
      emphasis: true,
    },
    {
      key: "applied-pending",
      label: "Applied, not yet taken",
      value: round1((summary.pending_leave_days || 0) + (summary.future_approved_leave_days || 0)),
      hint: `${round1(summary.pending_leave_days || 0)} pending · ${round1(summary.future_approved_leave_days || 0)} future approved`,
      tone: "sky",
      Icon: Clock,
    },
    {
      key: "tour-total",
      label: "Tour days (YTD)",
      value: summary.tour_ytd_days || 0,
      hint: summary.pending_tour_days ? `${summary.pending_tour_days} pending` : "Doesn't consume balance",
      tone: "orange",
      Icon: Plane,
    },
    {
      key: "absent",
      label: "Absent days",
      value: summary.absent_ytd_days || 0,
      hint: "Working days with no record",
      tone: summary.absent_ytd_days > 5 ? "red" : "slate",
      Icon: AlertTriangle,
    },
    {
      key: "lop",
      label: "LOP this year",
      value: round1(summary.lop_ytd_days || 0),
      hint: "Loss of Pay days",
      tone: summary.lop_ytd_days > 0 ? "red" : "slate",
      Icon: AlertTriangle,
    },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-5" data-testid="myleaves-stats">
      {stats.map(({ key, ...rest }) => <StatCard key={key} {...rest} />)}
    </div>
  );
}

const TONE = {
  amber:   { border: "border-amber-200",   bg: "bg-amber-50/60",   text: "text-amber-700",   value: "text-amber-900",   icon: "text-amber-600"   },
  violet:  { border: "border-violet-200",  bg: "bg-violet-50/60",  text: "text-violet-700",  value: "text-violet-900",  icon: "text-violet-600"  },
  emerald: { border: "border-emerald-300", bg: "bg-emerald-50/80", text: "text-emerald-700", value: "text-emerald-900", icon: "text-emerald-700" },
  sky:     { border: "border-sky-200",     bg: "bg-sky-50/60",     text: "text-sky-700",     value: "text-sky-900",     icon: "text-sky-600"     },
  orange:  { border: "border-orange-200",  bg: "bg-orange-50/60",  text: "text-orange-700",  value: "text-orange-900",  icon: "text-orange-600"  },
  red:     { border: "border-red-300",     bg: "bg-red-50/70",     text: "text-red-700",     value: "text-red-900",     icon: "text-red-600"     },
  slate:   { border: "border-slate-200",   bg: "bg-white",         text: "text-slate-500",   value: "text-slate-900",   icon: "text-slate-400"   },
};

function StatCard({ label, value, hint, tone = "slate", Icon, emphasis, footnotes }) {
  const t = TONE[tone] || TONE.slate;
  const safeId = label.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-+|-+$/g, "");
  return (
    <div
      className={`iu-card !p-3 border ${t.border} ${t.bg} ${emphasis ? "ring-2 ring-emerald-200/60" : ""}`}
      data-testid={`stat-${safeId}`}
    >
      <div className={`flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold ${t.text}`}>
        {Icon && <Icon size={12} className={t.icon} />}
        <span className="truncate">{label}</span>
      </div>
      <div className={`font-extrabold text-2xl leading-tight mt-1 ${t.value}`}>{value}</div>
      <div className={`text-[10px] mt-0.5 ${t.text} opacity-80 line-clamp-1`} title={hint}>{hint}</div>
      {(footnotes || []).map((fn, idx) => {
        const ft = TONE[fn.tone] || TONE.slate;
        const FIcon = fn.icon;
        // Stable key derived from tone+text so footnotes survive re-renders
        // and reorderings (was: array index, flagged by code review).
        const key = `${fn.tone || "slate"}::${fn.text}`;
        return (
          <div
            key={key}
            className={`text-[10px] mt-0.5 flex items-center gap-1 font-semibold ${ft.text}`}
            data-testid={idx === 0 ? `stat-footnote-${safeId}` : `stat-footnote-${safeId}-${idx}`}
          >
            {FIcon && <FIcon size={10} className={ft.icon} />}
            <span>{fn.text}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * MyLeaveRow — historical/active row in My Leave & Tour.
 *
 * Always shows: type pill · date range · status pill · reason.
 * On approved rows: who decided + decided-at + (for type=leave) the
 * ladder split that landed (Comp-Off used / Paid used / LOP).
 * On pending rows: nothing extra — the row is awaiting decision.
 * On rejected rows: who rejected + when.
 */
function MyLeaveRow({ l }) {
  const t = TYPE_LABELS[l.type] || TYPE_LABELS.leave;
  const s = STATUS_COLORS[l.status] || STATUS_COLORS.pending;
  const showLadder = l.status === "approved" && l.type === "leave"
    && (l.comp_off_used != null || l.paid_leave_used != null || l.lop_days != null);
  return (
    <div className={`iu-card p-4 ${l.late_application ? "ring-2 ring-red-200 bg-red-50/50" : ""}`} data-testid={`myleave-${l.id}`}>
      <div className="flex items-start gap-4">
        <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0" style={{ background: t.color + "22", color: t.color }}>
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
          <div className="text-xs text-slate-500" data-testid={`myleave-dates-${l.id}`}>
            {shortDate(l.start_date)} – {shortDate(l.end_date)}
            {l.expected_arrival ? ` · arrival ${l.expected_arrival}` : ""}
          </div>
          {l.reason && (
            <div className="text-xs text-slate-700 mt-1.5" data-testid={`myleave-reason-${l.id}`}>
              <span className="text-slate-400 text-[10px] uppercase tracking-wider font-bold mr-1">Reason</span>
              {l.reason}
            </div>
          )}
          {/* Decision audit — visible on approved/rejected rows */}
          {(l.status === "approved" || l.status === "rejected") && l.decided_by && (
            <div className="text-[11px] text-slate-500 mt-1.5" data-testid={`myleave-decided-${l.id}`}>
              {l.status === "approved" ? "Approved" : "Rejected"} by <span className="font-semibold text-slate-700">{l.decided_by}</span>
              {l.decided_at ? ` · ${shortDate(l.decided_at)}` : ""}
            </div>
          )}
          {/* Ladder split — shown only when the backend stamped the row. */}
          {showLadder && (
            <div className="mt-2 flex flex-wrap gap-1.5" data-testid={`myleave-ladder-${l.id}`}>
              {l.comp_off_used ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-violet-100 text-violet-800 border border-violet-200">
                  <RefreshCw size={9}/> {l.comp_off_used} Comp-Off
                </span>
              ) : null}
              {l.paid_leave_used ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200">
                  <Bed size={9}/> {round1(l.paid_leave_used)} Paid Leave
                </span>
              ) : null}
              {l.lop_days ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-extrabold uppercase tracking-wide bg-red-100 text-red-800 border border-red-200">
                  <AlertTriangle size={9}/> {l.lop_days} LOP
                </span>
              ) : null}
            </div>
          )}
        </div>
        <span className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold capitalize" style={{ background: s.bg, color: s.color }} data-testid={`myleave-status-${l.id}`}>
          {l.status}
        </span>
      </div>
    </div>
  );
}

function round1(v) {
  if (v == null) return 0;
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 10) / 10;
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
  // Inline submit-error banner (sits above the Submit button, replaces
  // the easily-missed top-of-screen toast on POST /leaves failures).
  const formErr = useFormError();

  // Self path needs the current user's live balance for the notice block.
  // (Admin path already loads /members, which carries balances per row.)
  const [me, setMe] = useState(null);
  // Unified balance summary: { comp_off:{accrued,used,available}, paid_leave:{opening,used,available,tracked}, total_available }
  // For self path: fetched from /api/me/leave-summary on mount.
  // For admin path single-pick: fetched from /api/members/{id}/leave-summary.
  // For admin multi-pick: null (per-member balances differ — Notice falls back to per-member rows).
  const [balanceSummary, setBalanceSummary] = useState(null);
  // R3 (30 Jun 2026): minimum days of notice required for self-applied
  // leaves. Per-category (athlete/staff/coach/executive); falls back to 3
  // if the category is unset in office config. Tours / postings /
  // late-coming are exempt — checked further below.
  const [noticeDays, setNoticeDays] = useState(3);
  useEffect(() => {
    if (asAdmin) return;
    api.get("/auth/me").then((u) => {
      setMe(u);
      // Pull office config and resolve the category-specific threshold.
      api.get("/office").then((o) => {
        const raw = (o || {}).leave_notice_days;
        const cat = (u || {}).category || "";
        let n = 3;
        if (raw == null) {
          n = 3;
        } else if (typeof raw === "number") {
          n = Math.max(0, Math.floor(raw));
        } else if (typeof raw === "object" && cat && raw[cat] != null) {
          const v = Number(raw[cat]);
          n = Number.isFinite(v) && v >= 0 ? Math.floor(v) : 3;
        }
        setNoticeDays(n);
      }).catch(() => {});
    }).catch(() => {});
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

  // R3 — calendar days between today and `start`. Negative when start is
  // in the past (a late application). Used to gate the Submit button on
  // the member-side path when type=leave & notice_days > 0.
  const daysOfNotice = useMemo(() => {
    try {
      const s = new Date(start + "T00:00:00");
      const t = new Date();
      t.setHours(0, 0, 0, 0);
      if (Number.isNaN(s.getTime())) return null;
      return Math.floor((s - t) / 86400000);
    } catch {
      return null;
    }
  }, [start]);
  // The gate fires only for self-applied Leaves below the threshold.
  // Tours, postings, late-coming and the admin on-behalf path bypass it.
  const noticeBlocked = !asAdmin
    && type === "leave"
    && noticeDays > 0
    && daysOfNotice != null
    && daysOfNotice < noticeDays;

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
    formErr.clear();
    if (asAdmin && picked.size === 0) { formErr.setMessage("Pick at least one member"); return; }
    if (!reason.trim()) { formErr.setMessage("Enter a reason"); return; }
    if (type === "late_coming" && !expectedArrival) { formErr.setMessage("Tell us when you'll arrive"); return; }
    if (end < start) { formErr.setMessage("End date must be after start"); return; }
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
          location: (type === "tour" || type === "posting") ? location : null,
          auto_approve: autoApprove,
        });
        toast.success(`${r.created} ${r.created === 1 ? "request" : "requests"} created (${r.status})`);
      } else {
        const payload = {
          type, start_date: start, end_date: end, reason,
          location: (type === "tour" || type === "posting") ? location : null,
          expected_arrival: type === "late_coming" ? expectedArrival : null,
        };
        await api.post("/leaves", payload);
        toast.success("Request submitted");
      }
      onCreated();
    } catch (err) {
      formErr.setFromApi(err, "Failed to submit request");
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
            <div className={`grid ${asAdmin ? "grid-cols-2 md:grid-cols-4" : "grid-cols-3"} gap-2`}>
              <button data-testid="leave-type-leave" type="button" onClick={() => setType("leave")} className={`iu-btn ${type === "leave" ? "iu-btn-primary" : "iu-btn-secondary"}`}><Bed size={16}/> Leave</button>
              <button data-testid="leave-type-tour" type="button" onClick={() => setType("tour")} className={`iu-btn ${type === "tour" ? "iu-btn-primary" : "iu-btn-secondary"}`}><Plane size={16}/> Tour</button>
              <button data-testid="leave-type-late-coming" type="button" onClick={() => setType("late_coming")} className={`iu-btn ${type === "late_coming" ? "iu-btn-primary" : "iu-btn-secondary"}`}><Clock size={16}/> Late Coming</button>
              {/* R2: Posting is admin-only on-behalf — member self-apply
                  must never see this option. */}
              {asAdmin && (
                <button data-testid="leave-type-posting" type="button" onClick={() => setType("posting")} className={`iu-btn ${type === "posting" ? "iu-btn-primary" : "iu-btn-secondary"}`}><Briefcase size={16}/> Posting</button>
              )}
            </div>
            {type === "leave" && (
              <p className="text-[11px] text-slate-500 mt-1.5">Days are deducted from your Comp-Off balance first, then your Paid Leave. Anything left is treated as Loss of Pay.</p>
            )}
            {type === "late_coming" && (
              <p className="text-[11px] text-slate-500 mt-1.5">Use this when you&apos;ll arrive late today. Admin gets pinged so you&apos;re not flagged as absent.</p>
            )}
            {type === "posting" && (
              <p className="text-[11px] text-sky-700 mt-1.5" data-testid="posting-note">
                Posting = member is on deputation to another academy. <strong>Zero comp-off accrual</strong> on weekly-off days and <strong>zero paid-leave consumption</strong>. They check in normally; the Presence board labels them <strong>POSTED</strong>.
              </p>
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
          {(type === "tour" || type === "posting") && (
            <div>
              <label className="iu-label">{type === "posting" ? "Host academy / location" : "Tour location"}</label>
              <input data-testid="leave-location" value={location} onChange={(e) => setLocation(e.target.value)} placeholder={type === "posting" ? "e.g. INS Chilka" : "e.g. Mumbai Naval Base"} className="iu-input" />
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

          {/* Conflict guard — only relevant for multi-day absences.
              Late-coming is a same-day notice with no overlap value. */}
          {start && end && (type === "leave" || type === "tour" || type === "posting") && (
            <>
              <OverlapNotice
                startDate={start}
                endDate={end}
                excludeUserId={asAdmin ? undefined : me?.id}
                title="Who else is on leave/tour during this period?"
                defaultOpen={false}
              />
              {/* Camp/Regatta conflict — only meaningful for self-apply or
                  admin single-pick. Multi-pick involves per-member rosters
                  so the chip would be ambiguous. */}
              {(!asAdmin || picked.size === 1) && (
                <EventConflictNotice
                  startDate={start}
                  endDate={end}
                  userId={asAdmin ? Array.from(picked)[0] : null}
                  defaultOpen={false}
                />
              )}
            </>
          )}

          <FormErrorBanner
            error={formErr.error}
            requestId={formErr.requestId}
            onDismiss={formErr.clear}
            testId="leave-submit-error"
          />
          {/* R3: 3-day notice rule for self-applied Leaves. Tours,
              postings, late-coming and the admin on-behalf path are all
              exempt. */}
          {noticeBlocked && (
            <div
              className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 flex items-start gap-2"
              data-testid="leave-notice-blocked"
            >
              <AlertTriangle size={14} className="text-amber-700 mt-0.5 shrink-0" />
              <div className="text-xs text-amber-900 leading-snug">
                Leave needs at least <strong>{noticeDays} day{noticeDays === 1 ? "" : "s"}</strong> of notice
                {daysOfNotice >= 0
                  ? <> — your start date is only <strong>{daysOfNotice} day{daysOfNotice === 1 ? "" : "s"}</strong> away.</>
                  : <> — your start date is in the past.</>}
                {" "}Please ask your admin to file this on your behalf.
              </div>
            </div>
          )}
          <button
            data-testid="leave-submit"
            type="submit"
            disabled={busy || noticeBlocked}
            className="iu-btn-primary w-full disabled:opacity-60 disabled:cursor-not-allowed"
            title={noticeBlocked ? `Leaves need at least ${noticeDays} day${noticeDays === 1 ? "" : "s"} of advance notice — ask an admin to file on your behalf.` : undefined}
          >
            {busy ? <Loader2 className="animate-spin" size={16}/> : "Submit"}
          </button>
        </form>
      </div>
    </div>
  );
}
