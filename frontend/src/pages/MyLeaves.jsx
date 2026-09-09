import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, X, CalendarDays, Plane, Bed, AlertTriangle, Clock, Briefcase } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";
import LeaveBalanceNotice from "../components/LeaveBalanceNotice";
import OverlapNotice from "../components/OverlapNotice";
import EventConflictNotice from "../components/EventConflictNotice";
import CorrectionRequestModal from "../components/CorrectionRequestModal";
import ConflictAcknowledgeModal from "../components/ConflictAcknowledgeModal";
import ReasonPicker from "../components/ReasonPicker";
import FormErrorBanner from "../components/FormErrorBanner";
import { useFormError } from "../hooks/useFormError";
import { shortDate, todayIso, tomorrowIso } from "../utils";
import { useDirtyForm } from "../hooks/useDirtyForm";
import TopSaveButton from "../components/TopSaveButton";
import MemberMultiPicker from "./leaves/MemberMultiPicker";
import HalfDayPicker from "./leaves/HalfDayPicker";
import StatsDashboard from "./leaves/StatsDashboard";
import MyLeaveRow from "./leaves/MyLeaveRow";

export default function MyLeaves() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  // Header dashboard fuel: every metric the member would want to know
  // BEFORE applying for more leave — comp-off, paid leave, pending,
  // future-approved, tour totals, LOP and approx absent days.
  const [summary, setSummary] = useState(null);
  const [correctionOpen, setCorrectionOpen] = useState(false);

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
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="myleaves-request-correction"
            onClick={() => setCorrectionOpen(true)}
            title="Report a mistake on one of your existing leaves (wrong dates, wrong type, or shouldn't have run)"
            className="text-xs text-slate-500 hover:text-slate-800 underline underline-offset-2"
          >
            Request a correction
          </button>
          <button data-testid="apply-leave-button" onClick={() => setShowForm(true)} title="Apply for a leave, tour or late arrival" className="iu-btn-primary">
            <Plus size={16} /> Apply
          </button>
        </div>
      </header>
      <CorrectionRequestModal
        open={correctionOpen}
        onClose={() => setCorrectionOpen(false)}
        entityType="leave"
        initialKind="leave_date_change"
      />

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

export function ApplyForm({ onClose, onCreated, asAdmin = false }) {
  const [type, setType] = useState("leave");
  const [start, setStart] = useState(todayIso());
  const [end, setEnd] = useState(todayIso());
  const [reason, setReason] = useState("");
  const [location, setLocation] = useState("");
  const [expectedArrival, setExpectedArrival] = useState("");
  const [busy, setBusy] = useState(false);
  // Conflict-gate state (2 Feb 2026): when the requested window
  // overlaps a camp / regatta, we intercept submit and show an ack
  // modal before firing the API. `pendingSubmit` holds the callback
  // to invoke once the member ticks "I understand".
  const [conflictGate, setConflictGate] = useState(null);
  const [pendingSubmit, setPendingSubmit] = useState(null);
  // Half-day (30 Jun 2026): only valid when type=leave AND single-day.
  // `halfDay` ∈ null | "FN" | "PN". null means full-day.
  const [halfDay, setHalfDay] = useState(null);
  // Office half-day clock windows — surfaced in the UI copy so members
  // know what "FN" and "PN" actually mean for their academy. Populated
  // by the same /api/office fetch that already resolves noticeDays.
  const [halfDayWindows, setHalfDayWindows] = useState({
    fn: "09:30–13:30", pn: "13:30–18:00",
  });
  // Legacy single-pick state was removed 06/2026 during the admin
  // multi-select migration; the setter was kept for a brief transition
  // but no longer has any callers. Purged 7 Jul 2026 after the code
  // review flagged it as unused.
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
  // Dirty-guard: Esc / backdrop / X ask before discarding unsaved edits,
  // and the top-of-modal Save button glows amber while anything changed.
  const guard = useDirtyForm(
    { type, start, end, reason, location, expectedArrival, halfDay, picked: Array.from(picked), autoApprove },
    onClose,
  );

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
        setHalfDayWindows({
          fn: `${o.half_day_fn_start || "09:30"}–${o.half_day_fn_end || "13:30"}`,
          pn: `${o.half_day_pn_start || "13:30"}–${o.half_day_pn_end || "18:00"}`,
        });
      }).catch(() => {});
    }).catch(() => {});
    api.get("/me/leave-summary").then(setBalanceSummary).catch(() => {});
  }, [asAdmin]);

  // Admin path also needs the half-day windows for the on-behalf modal.
  useEffect(() => {
    if (!asAdmin) return;
    api.get("/office").then((o) => {
      setHalfDayWindows({
        fn: `${o.half_day_fn_start || "09:30"}–${o.half_day_fn_end || "13:30"}`,
        pn: `${o.half_day_pn_start || "13:30"}–${o.half_day_pn_end || "18:00"}`,
      });
    }).catch(() => {});
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
  // A half-day counts as 0.5 (no matter how the dates look).
  const requestedDays = useMemo(() => {
    if (halfDay && type === "leave") return 0.5;
    try {
      const s = new Date(start + "T00:00:00");
      const e = new Date(end + "T00:00:00");
      if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return 0;
      return Math.floor((e - s) / 86400000) + 1;
    } catch {
      return 0;
    }
  }, [start, end, halfDay, type]);

  // Weekend guard (Jun 2026 user request): count Sat/Sun days inside the
  // requested Leave window so the form can warn — at the point of
  // application — that weekend leave is mostly not allowed and likely to
  // be rejected into LOP. Tours/postings/late-coming are duty-adjacent
  // and exempt.
  const weekendDays = useMemo(() => {
    if (type !== "leave") return 0;
    try {
      const s = new Date(start + "T00:00:00");
      const e = new Date(((halfDay ? start : end) < start ? start : (halfDay ? start : end)) + "T00:00:00");
      if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 0;
      let n = 0;
      for (let d = new Date(s), i = 0; d <= e && i < 370; d.setDate(d.getDate() + 1), i++) {
        const dow = d.getDay();
        if (dow === 0 || dow === 6) n++;
      }
      return n;
    } catch { return 0; }
  }, [type, start, end, halfDay]);

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

  // Late-coming is single-day. Defaults to TOMORROW (7 Jul 2026 —
  // most late-coming applications are filed the previous night for
  // the next-morning delay). User can flip back to today via the
  // date picker; anything else is out of range.
  useEffect(() => {
    if (type === "late_coming") {
      const t = tomorrowIso();
      setStart(t); setEnd(t);
    }
    // Half-day is only valid on the Leave type — clear it whenever the
    // type changes to anything else.
    if (type !== "leave") setHalfDay(null);
  }, [type]);

  // Keep `end` in lock-step with `start` for late_coming (single-day
  // application; the To picker is disabled but the state still needs
  // to track so the backend receives start_date == end_date).
  useEffect(() => {
    if (type === "late_coming") setEnd(start);
  }, [type, start]);

  // Force `end === start` whenever a half-day is selected. The backend
  // rejects otherwise, but this keeps the picker consistent with the
  // preview / notice / submit flow.
  useEffect(() => {
    if (halfDay) setEnd(start);
  }, [halfDay, start]);

  const submit = async (e) => {
    e.preventDefault();
    formErr.clear();
    if (noticeBlocked) { formErr.setMessage(`Leaves need at least ${noticeDays} day${noticeDays === 1 ? "" : "s"} of advance notice — ask an admin to file on your behalf.`); return; }
    if (asAdmin && picked.size === 0) { formErr.setMessage("Pick at least one member"); return; }
    if (!reason.trim()) { formErr.setMessage("Enter a reason"); return; }
    if (type === "late_coming" && !expectedArrival) { formErr.setMessage("Tell us when you'll arrive"); return; }
    if (end < start) { formErr.setMessage("End date must be after start"); return; }
    if (halfDay && (type !== "leave" || start !== end)) {
      formErr.setMessage("Half-day is only for single-day Leave applications");
      return;
    }

    // The actual submit, invoked either immediately (no conflicts) or
    // after the ack modal (with conflicts).
    const doSubmit = async () => {
      setBusy(true);
      try {
        if (asAdmin) {
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
            half_day: (type === "leave" && halfDay) ? halfDay : null,
          });
          toast.success(`${r.created} ${r.created === 1 ? "request" : "requests"} created (${r.status})`);
        } else {
          const payload = {
            type, start_date: start, end_date: end, reason,
            location: (type === "tour" || type === "posting") ? location : null,
            expected_arrival: type === "late_coming" ? expectedArrival : null,
            half_day: (type === "leave" && halfDay) ? halfDay : null,
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

    // Only gate leave/tour/posting — the other types don't have a
    // "during the period" semantic (comp_off is legacy, late_coming
    // is a same-day arrival note).
    const gatedTypes = ["leave", "tour", "posting"];
    if (!gatedTypes.includes(type)) {
      return doSubmit();
    }

    // Fetch conflicts for the window. For admin multi-pick this is
    // ambiguous per-member — we skip the gate then (the caller can
    // still see individual notices on the row when approving). Only
    // gate self-apply or single-pick admin apply.
    if (asAdmin && picked.size !== 1) {
      return doSubmit();
    }
    setBusy(true);
    try {
      const params = { start_date: start, end_date: end };
      if (asAdmin) params.user_id = Array.from(picked)[0];
      const res = await api.get("/leaves/event-conflicts", params);
      const camps = res?.camps || [];
      const regattas = res?.regattas || [];
      if (camps.length === 0 && regattas.length === 0) {
        // Clean path — no overlaps, no modal.
        await doSubmit();
      } else {
        setConflictGate({ camps, regattas });
        setPendingSubmit(() => doSubmit);
      }
    } catch (err) {
      // Conflict lookup failed — don't block the user's workflow.
      console.debug("event-conflicts lookup failed", err);
      await doSubmit();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50 p-0 md:p-4" onClick={(e) => e.target === e.currentTarget && guard.close()}>
      <div className={`bg-white w-full ${asAdmin ? "md:max-w-3xl" : "md:max-w-md"} rounded-t-2xl md:rounded-2xl p-6 max-h-[90vh] overflow-y-auto`} onClick={(e) => e.stopPropagation()} data-testid="apply-leave-form">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-extrabold">{asAdmin ? "Apply on behalf of members" : "New request"}</h2>
          <div className="flex items-center gap-2">
            <TopSaveButton formId="apply-leave-form-el" dirty={guard.dirty} saving={busy} label="Submit" testId="leave-top-save" />
            <button onClick={guard.close} className="p-2 hover:bg-slate-100 rounded-lg" title="Close without saving"><X size={18} /></button>
          </div>
        </div>
        <form id="apply-leave-form-el" onSubmit={submit} className="space-y-4">
          {asAdmin && (
            <MemberMultiPicker
              members={filteredMembers}
              institutions={institutions}
              instFilter={instFilter}
              onInstFilter={setInstFilter}
              search={search}
              onSearch={setSearch}
              picked={picked}
              onTogglePick={togglePick}
              onPickAllFiltered={pickAllFiltered}
              onClearPicked={clearPicked}
              autoApprove={autoApprove}
              onAutoApprove={setAutoApprove}
            />
          )}
          <div>
            <label className="iu-label">Type</label>
            <div className={`grid ${asAdmin ? "grid-cols-2 md:grid-cols-4" : "grid-cols-3"} gap-2`}>
              <button data-testid="leave-type-leave" type="button" onClick={() => setType("leave")} title="Full or half day off — deducted from comp-off first, then paid leave" className={`iu-btn ${type === "leave" ? "iu-btn-primary" : "iu-btn-secondary"}`}><Bed size={16}/> Leave</button>
              <button data-testid="leave-type-tour" type="button" onClick={() => setType("tour")} title="Away on official duty — counts as present, not leave" className={`iu-btn ${type === "tour" ? "iu-btn-primary" : "iu-btn-secondary"}`}><Plane size={16}/> Tour</button>
              <button data-testid="leave-type-late-coming" type="button" onClick={() => setType("late_coming")} title="Inform in advance that you'll arrive late on a day" className={`iu-btn ${type === "late_coming" ? "iu-btn-primary" : "iu-btn-secondary"}`}><Clock size={16}/> Late Coming</button>
              {/* R2: Posting is admin-only on-behalf — member self-apply
                  must never see this option. */}
              {asAdmin && (
                <button data-testid="leave-type-posting" type="button" onClick={() => setType("posting")} title="Long assignment away from campus (admin only)" className={`iu-btn ${type === "posting" ? "iu-btn-primary" : "iu-btn-secondary"}`}><Briefcase size={16}/> Posting</button>
              )}
            </div>
            {type === "leave" && (
              <p className="text-[11px] text-slate-500 mt-1.5">Days are deducted from your Comp-Off balance first, then your Paid Leave. Anything left is treated as Loss of Pay. <span className="text-amber-700 font-semibold">Leave on Saturdays &amp; Sundays is mostly not allowed and is likely to be rejected into LOP.</span></p>
            )}
            {type === "leave" && (
              <HalfDayPicker
                halfDay={halfDay}
                onChange={setHalfDay}
                windows={halfDayWindows}
              />
            )}
            {type === "late_coming" && (
              <p className="text-[11px] text-slate-500 mt-1.5">Use this when you&apos;ll arrive late today or tomorrow. Admin gets pinged so you&apos;re not flagged as absent. <span className="text-slate-400">Defaults to tomorrow — flip to today via the date picker if needed.</span></p>
            )}
            {type === "posting" && (
              <p className="text-[11px] text-sky-700 mt-1.5" data-testid="posting-note">
                Posting = member is on deputation to another academy. <strong>Zero comp-off accrual</strong> on weekly-off days and <strong>zero paid-leave consumption</strong>. They check in normally; the Presence board labels them <strong>POSTED</strong>.
              </p>
            )}
          </div>
          {type === "late_coming" && (
            <div>
              <label className="iu-label">Expected arrival time</label>
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
              <input
                data-testid="leave-start"
                type="date"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                min={type === "late_coming" ? todayIso() : undefined}
                max={type === "late_coming" ? tomorrowIso() : undefined}
                className="iu-input"
              />
            </div>
            <div>
              <label className="iu-label">To</label>
              <input
                data-testid="leave-end"
                type="date"
                value={halfDay ? start : end}
                onChange={(e) => setEnd(e.target.value)}
                min={start}
                max={type === "late_coming" ? tomorrowIso() : undefined}
                disabled={!!halfDay || type === "late_coming"}
                className="iu-input disabled:bg-slate-100 disabled:cursor-not-allowed"
              />
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
          {weekendDays > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 flex items-start gap-2" data-testid="weekend-leave-notice">
              <AlertTriangle size={14} className="text-amber-700 mt-0.5 shrink-0" />
              <div className="text-xs text-amber-900 leading-snug">
                <strong>Your dates include {weekendDays} Saturday/Sunday day{weekendDays === 1 ? "" : "s"}.</strong>{" "}
                Leave on Sat &amp; Sun (training days) is mostly not allowed and is likely to be
                rejected or converted to <strong>Loss of Pay (LOP)</strong>.
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
            {type === "comp_off" ? (
              <ReasonPicker
                value={reason}
                onChange={setReason}
                placeholder="Why are you taking comp-off?"
                variant="slate"
                testId="leave-reason-picker"
              />
            ) : (
              <textarea data-testid="leave-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Tell your admin why…" className="iu-input !h-auto py-2" />
            )}
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
      {conflictGate && (
        <ConflictAcknowledgeModal
          open
          camps={conflictGate.camps}
          regattas={conflictGate.regattas}
          heading={asAdmin ? "You're about to file a leave during a scheduled event" : "You'll miss scheduled events during this window"}
          subheading={
            <>
              Your {type === "posting" ? "posting" : type} runs{" "}
              <span className="font-mono">{shortDate(start)} → {shortDate(end)}</span>
              , overlapping{" "}
              <span className="font-bold">{conflictGate.camps.length + conflictGate.regattas.length}</span>{" "}
              scheduled event{(conflictGate.camps.length + conflictGate.regattas.length) === 1 ? "" : "s"}.
            </>
          }
          ackLabel={asAdmin
            ? "I've reviewed the conflicts above and want to file this leave regardless."
            : "I understand I'll miss the events listed above and still want to submit this request."}
          confirmLabel="Submit request"
          testIdPrefix="apply-conflict-gate"
          onCancel={() => { setConflictGate(null); setPendingSubmit(null); }}
          onConfirm={async () => {
            const p = pendingSubmit;
            setConflictGate(null);
            setPendingSubmit(null);
            if (p) await p();
          }}
        />
      )}
    </div>
  );
}
