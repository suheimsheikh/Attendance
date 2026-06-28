import React, { useEffect, useMemo, useState, useCallback } from "react";
import { Clock, RefreshCw, UserPlus, UserX, Search, ChevronLeft, ChevronRight } from "lucide-react";
import { api, showApiError } from "../api";
import GuestCheckInModal from "../components/GuestCheckInModal";
import MemberForm from "./admin/MemberForm";
import { useAuth } from "../auth";
import { formatDate } from "../utils";
import { toast } from "sonner";
import UpcomingThisWeek from "../components/UpcomingThisWeek";
import EscortMissingBanner from "../components/EscortMissingBanner";

import { COLUMNS, PAIRED_COLUMN_KEYS } from "../components/presence/constants";
import { Column } from "../components/presence/Column";
import { GuestStrip } from "../components/presence/GuestStrip";
import { EscortsStrip } from "../components/presence/EscortsStrip";
import { SkeletonBoard } from "../components/presence/SkeletonBoard";

export default function Presence() {
  const { user: currentUser } = useAuth();
  const isAdmin = currentUser?.role === "admin";
  const canManageGuests = isAdmin || currentUser?.category === "coach";
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [lateOnly, setLateOnly] = useState(false);
  const [fleetFilter, setFleetFilter] = useState("");  // "" = all fleets
  const [query, setQuery] = useState("");
  const [guests, setGuests] = useState({ active: [], completed: [], active_count: 0 });
  const [showGuestModal, setShowGuestModal] = useState(false);
  const [editingMember, setEditingMember] = useState(null);
  // YYYY-MM-DD or "" for "today" (live mode). Picking a past date switches
  // the board to a read-only historical view (no auto-refresh, no notify).
  // Use LOCAL date — `toISOString()` would give UTC and trip the next-day
  // logic across IST midnight (off-by-one between UTC and Asia/Kolkata).
  const todayIso = useCallback(() => new Date().toLocaleDateString("sv-SE"), []);
  // Add `delta` days to a YYYY-MM-DD string, returning a YYYY-MM-DD string
  // in the *local* calendar (toISOString would silently convert to UTC and
  // break the right-arrow advance in IST).
  const shiftIso = useCallback((iso, delta) => {
    const d = new Date(iso + "T12:00:00");  // noon avoids DST edge cases
    d.setDate(d.getDate() + delta);
    return d.toLocaleDateString("sv-SE");
  }, []);
  const [viewDate, setViewDate] = useState("");
  const [expandedRows, setExpandedRows] = useState(() => new Set());
  const today = todayIso();
  const isHistorical = !!viewDate && viewDate !== today;

  const load = useCallback(async () => {
    try {
      setError(false);
      const qs = isHistorical ? `?on=${viewDate}` : "";
      const [res, gRes] = await Promise.all([
        api.get(`/presence${qs}`),
        canManageGuests && !isHistorical ? api.get("/guests/today").catch(() => null) : Promise.resolve(null),
      ]);
      setData(res);
      if (gRes) setGuests(gRes);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [canManageGuests, viewDate, isHistorical]);

  const toggleRow = useCallback((memberId) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
  }, []);

  // Open the Members edit modal by fetching the full doc (Presence rows only
  // carry a subset of fields). Admin-only — coaches don't see the option.
  const openEdit = useCallback(async (memberId) => {
    if (!isAdmin) return;
    try {
      const full = await api.get(`/members/${memberId}`);
      setEditingMember(full);
    } catch (err) {
      showApiError(err, "Couldn't load member");
    }
  }, [isAdmin]);

  // Remove a member from On Campus by deleting their open session for today.
  // The member instantly disappears from the board and can check in again via
  // Self Check-In or Muster Roll — useful when a member was wrongly marked
  // present (mis-tap, double-scan, accidental muster).
  const removeFromCampus = useCallback(async (memberId, memberName) => {
    if (!isAdmin) return;
    const ok = window.confirm(
      `Remove ${memberName} from On Campus?\n\n` +
      `Their current check-in for today will be cleared, and they can check in again via Self Check-In or Muster.\n\n` +
      `This does NOT affect their photo, profile, or past attendance.`
    );
    if (!ok) return;
    try {
      await api.del(`/admin/attendance/open-session/${memberId}`);
      toast.success(`${memberName} removed from On Campus`);
      load();
    } catch (err) {
      showApiError(err, "Couldn't remove — they may have already checked out");
    }
  }, [isAdmin, load]);

  // Single dispatcher for member-card double-clicks. On Campus members get the
  // "Remove from On Campus" confirm; every other status keeps the edit-modal
  // behavior (admins can fix a member's profile from anywhere on the board).
  const handleMemberDoubleClick = useCallback((memberId) => {
    if (!isAdmin) return;
    const m = (data?.members || []).find((x) => x.id === memberId);
    if (m && m.status === "on_campus") {
      removeFromCampus(memberId, m.full_name);
    } else {
      openEdit(memberId);
    }
  }, [isAdmin, data, openEdit, removeFromCampus]);

  const checkoutGuest = async (guestId, name) => {
    try {
      await api.post(`/guests/${guestId}/checkout`);
      toast.success(`${name} checked out`);
      load();
    } catch (err) {
      showApiError(err, "Failed");
    }
  };

  const deleteGuest = async (guestId, name) => {
    if (!window.confirm(`Remove ${name}'s check-in entry?`)) return;
    try {
      await api.del(`/guests/${guestId}`);
      toast.success("Guest entry removed");
      load();
    } catch (err) {
      showApiError(err, "Failed");
    }
  };

  useEffect(() => {
    load();
    // Historical view: read-only, no auto-refresh.
    if (isHistorical) return;
    // Gate polling on tab visibility — a backgrounded tab doesn't need
    // a fresh roster every 15 s and 60+ coaches all polling at once
    // hammers the API for nothing.
    let t = null;
    const start = () => {
      if (t == null) t = setInterval(load, 15000);
    };
    const stop = () => {
      if (t != null) { clearInterval(t); t = null; }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        load();    // catch up immediately on tab focus
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, isHistorical]);

  const byColumn = useMemo(() => {
    const buckets = Object.fromEntries(COLUMNS.map((c) => [c.key, []]));
    const q = query.trim().toLowerCase();
    const members = (data?.members || []).filter((m) => {
      if (lateOnly && !m.late) return false;
      if (fleetFilter && (m.fleet || "") !== fleetFilter) return false;
      if (!q) return true;
      return (m.full_name || "").toLowerCase().includes(q)
        || (m.rank || "").toLowerCase().includes(q)
        || (m.category || "").toLowerCase().includes(q)
        || (m.institution || "").toLowerCase().includes(q)
        || (m.fleet || "").toLowerCase().includes(q);
    });
    for (const m of members) {
      if (buckets[m.status]) buckets[m.status].push(m);
    }
    for (const k of Object.keys(buckets)) {
      buckets[k].sort((a, b) => {
        const da = a.since ? new Date(a.since).getTime() : 0;
        const db = b.since ? new Date(b.since).getTime() : 0;
        if (db !== da) return db - da;
        return (a.full_name || "").localeCompare(b.full_name || "");
      });
    }
    return buckets;
  }, [data, lateOnly, fleetFilter, query]);

  // Distinct fleet labels present across loaded members — used to render the
  // filter pill row. Athletes without a fleet set are not surfaced here.
  const fleetOptions = useMemo(() => {
    const set = new Set();
    for (const m of data?.members || []) {
      if (m.fleet) set.add(m.fleet);
    }
    return Array.from(set).sort();
  }, [data]);

  // Build the paired (vertically-aligned) display lists for the
  // Stepped Out + Checked Out pair. Each entry is `{member, visible}` — when
  // `visible=true` we render the real card, otherwise we render an INVISIBLE
  // clone of the OTHER column's member at this index so the row heights match
  // exactly across both columns. Union is sorted alphabetically so both
  // columns scroll in lockstep.
  const pairedDisplay = useMemo(() => {
    const union = [...byColumn.temp_out, ...byColumn.exited]
      .sort((a, b) => (a.full_name || "").localeCompare(b.full_name || ""));
    return {
      temp_out: union.map((m) => ({ member: m, visible: m.status === "temp_out" })),
      exited:   union.map((m) => ({ member: m, visible: m.status === "exited" })),
    };
  }, [byColumn]);

  const filteredTotal = useMemo(
    () => Object.values(byColumn).reduce((sum, list) => sum + list.length, 0),
    [byColumn]
  );

  // Bucket escorts by status so each column gets only its own rows.
  // Single pass keeps the strip + columns in sync (one data source).
  // Skipped on historical views (backend returns []).
  const escortsByStatus = useMemo(() => {
    const buckets = { on_campus: [], temp_out: [], exited: [] };
    for (const e of data?.escorts_present || []) {
      const k = buckets[e.status] ? e.status : (e.temp_out ? "temp_out" : "on_campus");
      buckets[k].push(e);
    }
    return buckets;
  }, [data]);
  // Keep `steppedOutEscorts` name for the existing testIds / messaging,
  // but it's now derived from the bucket map.
  const steppedOutEscorts = escortsByStatus.temp_out;

  const totalMembers = data?.counts?.total ?? (data?.members?.length || 0);
  const lateCount = data?.counts?.late || 0;
  const absentCount = data?.counts?.absent || 0;

  return (
    <div className="p-4 md:p-6 max-w-[1500px] mx-auto">
      {!isHistorical && <UpcomingThisWeek />}
      {!isHistorical && <EscortMissingBanner />}
      <header className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight" data-testid="presence-title">Presence Board</h1>
          <p className="text-slate-500 mt-1 text-sm">
            {data ? formatDate(data.date) : "Live campus roster"}
            {isHistorical && <span className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 text-[10px] font-bold uppercase tracking-wider">Read-only history</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="inline-flex items-center gap-1 bg-white border-2 border-slate-300 px-1.5 h-11 rounded-xl text-sm font-bold text-slate-800 shadow-sm">
            <button
              type="button"
              data-testid="presence-date-prev"
              onClick={() => {
                const cur = viewDate || today;
                const next = shiftIso(cur, -1);
                setViewDate(next === today ? "" : next);
                setExpandedRows(new Set());
              }}
              className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-700 hover:bg-slate-100 hover:text-slate-900 active:bg-slate-200 transition"
              title="Previous day"
              aria-label="Previous day"
            >
              <ChevronLeft size={18} strokeWidth={2.5} />
            </button>
            <input
              type="date"
              data-testid="presence-date-picker"
              value={viewDate || today}
              max={today}
              onChange={(e) => { setViewDate(e.target.value === today ? "" : e.target.value); setExpandedRows(new Set()); }}
              className="bg-transparent border-0 outline-none text-sm font-bold w-[130px] text-center"
              aria-label="View presence for a specific date"
            />
            <button
              type="button"
              data-testid="presence-date-next"
              onClick={() => {
                const cur = viewDate || today;
                if (cur >= today) return;
                const next = shiftIso(cur, 1);
                setViewDate(next >= today ? "" : next);
                setExpandedRows(new Set());
              }}
              disabled={!isHistorical}
              className="w-9 h-9 rounded-lg flex items-center justify-center text-slate-700 hover:bg-slate-100 hover:text-slate-900 active:bg-slate-200 transition disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              title={isHistorical ? "Next day" : "Already on today"}
              aria-label="Next day"
            >
              <ChevronRight size={18} strokeWidth={2.5} />
            </button>
            {isHistorical && (
              <button
                onClick={() => { setViewDate(""); setExpandedRows(new Set()); }}
                data-testid="presence-back-to-today"
                className="ml-1 px-2.5 h-7 rounded-md bg-sky-600 hover:bg-sky-700 text-white text-[11px] font-extrabold uppercase tracking-wider transition"
                title="Jump back to live today view"
              >
                Today
              </button>
            )}
          </div>
          <button
            data-testid="late-only-toggle"
            onClick={() => setLateOnly((v) => !v)}
            className={`inline-flex items-center gap-2 px-3 h-9 rounded-full text-xs font-semibold border transition ${
              lateOnly
                ? "bg-red-600 text-white border-transparent"
                : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
            }`}
            title="Show only members who are late today"
          >
            <Clock size={13} />
            {lateOnly ? `Showing late (${lateCount})` : `Late today · ${lateCount}`}
          </button>
          {absentCount > 0 && (
            <div className="inline-flex items-center gap-2 bg-red-50 border border-red-200 px-3 h-9 rounded-full text-xs font-semibold text-red-700">
              <UserX size={13} />
              {absentCount} absent
            </div>
          )}
          {canManageGuests && (
            <button
              data-testid="presence-add-guest"
              onClick={() => setShowGuestModal(true)}
              className="inline-flex items-center gap-1.5 bg-violet-600 hover:bg-violet-700 text-white px-3 h-9 rounded-full text-xs font-bold transition"
              title="Check in a visitor (parent, prospect, dignitary)"
            >
              <UserPlus size={13} />
              Guest
              {guests.active_count > 0 && (
                <span className="ml-1 px-1.5 h-5 rounded-full bg-white/25 text-[10px] flex items-center justify-center font-extrabold">
                  {guests.active_count}
                </span>
              )}
            </button>
          )}
          <div className="inline-flex items-center gap-2 bg-white border border-slate-200 px-3 h-9 rounded-full text-xs font-semibold text-slate-700">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            {totalMembers} members
          </div>
          <button onClick={load} className="iu-btn-secondary !h-9 !px-3" data-testid="presence-refresh-button">
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      {fleetOptions.length > 0 && (
        <div className="flex items-center gap-1.5 mb-3 flex-wrap" data-testid="fleet-filter-row">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mr-1">Fleet</span>
          <button
            type="button"
            data-testid="fleet-filter-all"
            onClick={() => setFleetFilter("")}
            className={`px-2.5 h-7 rounded-full text-[11px] font-bold transition border ${
              fleetFilter === "" ? "bg-sky-600 text-white border-transparent" : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
            }`}
          >
            All
          </button>
          {fleetOptions.map((f) => (
            <button
              key={f}
              type="button"
              data-testid={`fleet-filter-${f}`}
              onClick={() => setFleetFilter(f)}
              className={`px-2.5 h-7 rounded-full text-[11px] font-bold transition border ${
                fleetFilter === f ? "bg-sky-600 text-white border-transparent" : "bg-white border-slate-200 text-slate-700 hover:bg-slate-50"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      )}

      <div className="iu-card mb-4 px-3 py-2 flex items-center gap-3" data-testid="presence-search-wrap">
        <Search size={16} className="text-sky-500 shrink-0" />
        <input
          data-testid="presence-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, rank, category or institution…"
          className="flex-1 outline-none bg-transparent text-sm"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            data-testid="presence-search-clear"
            className="text-[11px] font-semibold text-sky-700 hover:text-sky-900"
          >
            Clear · {filteredTotal} match{filteredTotal === 1 ? "" : "es"}
          </button>
        )}
      </div>

      {canManageGuests && (
        <GuestStrip
          guests={guests}
          onCheckout={checkoutGuest}
          onDelete={deleteGuest}
          onAdd={() => setShowGuestModal(true)}
        />
      )}

      {/* Escorts checked in via /escort-checkin — non-user entities so they
          don't appear in any of the six columns. Only renders when at least
          one escort is on campus. Skipped on historical views (escort
          attendance isn't reconciled into past-day reads). The strip shows
          escorts who are still on campus (on_campus + temp_out) — checked-
          out escorts surface in the Exited column directly. */}
      {!isHistorical && (
        <EscortsStrip
          escorts={[...escortsByStatus.on_campus, ...escortsByStatus.temp_out]}
        />
      )}

      {loading && !data ? (
        <SkeletonBoard />
      ) : error ? (
        <div className="iu-card p-10 text-center">
          <p className="text-slate-500">Failed to load presence data.</p>
          <button onClick={load} className="iu-btn-primary mt-4">Retry</button>
        </div>
      ) : (
        <div
          className="grid gap-3 md:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6"
          data-testid="presence-board"
        >
          {COLUMNS.map((col) => (
            <Column
              key={col.key}
              col={col}
              members={byColumn[col.key]}
              displayList={PAIRED_COLUMN_KEYS.has(col.key) ? pairedDisplay[col.key] : null}
              escorts={escortsByStatus[col.key] || null}
              adminContacts={data?.admin_contacts || []}
              coachMobile={currentUser?.mobile}
              onSent={load}
              onRowDoubleClick={isAdmin ? handleMemberDoubleClick : null}
              expandedRows={expandedRows}
              toggleRow={toggleRow}
            />
          ))}
        </div>
      )}

      {showGuestModal && (
        <GuestCheckInModal
          onClose={() => setShowGuestModal(false)}
          onCheckedIn={load}
        />
      )}
      {editingMember && (
        <MemberForm
          initial={editingMember}
          onClose={() => setEditingMember(null)}
          onSaved={() => { setEditingMember(null); load(); }}
        />
      )}
    </div>
  );
}
