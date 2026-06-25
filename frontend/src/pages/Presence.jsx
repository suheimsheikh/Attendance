import React, { useEffect, useMemo, useState, useCallback } from "react";
import { CheckCircle2, Plane, Bed, LogOut as ExitIcon, AlertTriangle, Clock, RefreshCw, Coffee, MapPin, UserX, Search, UserPlus, X, ChevronDown, ChevronRight, ChevronLeft, LogIn } from "lucide-react";
import { api } from "../api";
import Avatar from "../components/Avatar";
import ParentContact from "../components/ParentContact";
import NotifyParentsButton from "../components/NotifyParentsButton";
import GuestCheckInModal from "../components/GuestCheckInModal";
import MemberForm from "./admin/MemberForm";
import { useAuth } from "../auth";
import { categoryLabel, formatDate } from "../utils";
import { toast } from "sonner";

const COLUMNS = [
  { key: "on_campus",  label: "On Campus",    icon: CheckCircle2, accent: "#10B981", soft: "bg-emerald-50",  badge: "bg-emerald-100 text-emerald-700" },
  { key: "exited",     label: "Checked Out",  icon: ExitIcon,     accent: "#6B7280", soft: "bg-slate-50",    badge: "bg-slate-200 text-slate-700" },
  { key: "temp_out",   label: "Stepped Out",  icon: Coffee,       accent: "#06B6D4", soft: "bg-cyan-50",     badge: "bg-cyan-100 text-cyan-700" },
  { key: "on_tour",    label: "Tour",         icon: Plane,        accent: "#F97316", soft: "bg-orange-50",   badge: "bg-orange-100 text-orange-700" },
  { key: "on_leave",   label: "Leave",        icon: Bed,          accent: "#F59E0B", soft: "bg-amber-50",    badge: "bg-amber-100 text-amber-700" },
  { key: "absent",     label: "Absent",       icon: UserX,        accent: "#DC2626", soft: "bg-red-50",      badge: "bg-red-100 text-red-700" },
];

// On Campus & Checked Out share a single sorted union so each member's row
// sits at the same vertical position in both columns (blank where the member
// isn't in that status). The two columns also scroll in lockstep — see the
// scroll-sync effect in the Presence component.
const PAIRED_COLUMN_KEYS = new Set(["on_campus", "exited"]);

export default function Presence() {
  const { user: currentUser } = useAuth();
  const isAdmin = currentUser?.role === "admin";
  const canManageGuests = isAdmin || currentUser?.category === "coach";
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [lateOnly, setLateOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [guests, setGuests] = useState({ active: [], completed: [], active_count: 0 });
  const [showGuestModal, setShowGuestModal] = useState(false);
  const [editingMember, setEditingMember] = useState(null);
  // YYYY-MM-DD or "" for "today" (live mode). Picking a past date switches
  // the board to a read-only historical view (no auto-refresh, no notify).
  const todayIso = () => new Date().toISOString().slice(0, 10);
  const [viewDate, setViewDate] = useState("");
  const [expandedRows, setExpandedRows] = useState(() => new Set());
  const isHistorical = !!viewDate && viewDate !== todayIso();

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
      toast.error(err?.message || "Couldn't load member");
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
      toast.error(err?.message || "Couldn't remove — they may have already checked out");
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
      toast.error(err?.message || "Failed");
    }
  };

  const deleteGuest = async (guestId, name) => {
    if (!window.confirm(`Remove ${name}'s check-in entry?`)) return;
    try {
      await api.del(`/guests/${guestId}`);
      toast.success("Guest entry removed");
      load();
    } catch (err) {
      toast.error(err?.message || "Failed");
    }
  };

  useEffect(() => {
    load();
    // Historical view: read-only, no auto-refresh.
    if (isHistorical) return;
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load, isHistorical]);

  const byColumn = useMemo(() => {
    const buckets = Object.fromEntries(COLUMNS.map((c) => [c.key, []]));
    const q = query.trim().toLowerCase();
    const members = (data?.members || []).filter((m) => {
      if (lateOnly && !m.late) return false;
      if (!q) return true;
      return (m.full_name || "").toLowerCase().includes(q)
        || (m.rank || "").toLowerCase().includes(q)
        || (m.category || "").toLowerCase().includes(q)
        || (m.institution || "").toLowerCase().includes(q);
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
  }, [data, lateOnly, query]);

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

  const totalMembers = data?.counts?.total ?? (data?.members?.length || 0);
  const lateCount = data?.counts?.late || 0;
  const absentCount = data?.counts?.absent || 0;

  return (
    <div className="p-4 md:p-6 max-w-[1500px] mx-auto">
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
                const cur = viewDate || todayIso();
                const d = new Date(cur + "T00:00:00");
                d.setDate(d.getDate() - 1);
                const next = d.toISOString().slice(0, 10);
                setViewDate(next === todayIso() ? "" : next);
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
              value={viewDate || todayIso()}
              max={todayIso()}
              onChange={(e) => { setViewDate(e.target.value === todayIso() ? "" : e.target.value); setExpandedRows(new Set()); }}
              className="bg-transparent border-0 outline-none text-sm font-bold w-[130px] text-center"
              aria-label="View presence for a specific date"
            />
            <button
              type="button"
              data-testid="presence-date-next"
              onClick={() => {
                const cur = viewDate || todayIso();
                if (cur >= todayIso()) return;
                const d = new Date(cur + "T00:00:00");
                d.setDate(d.getDate() + 1);
                const next = d.toISOString().slice(0, 10);
                setViewDate(next >= todayIso() ? "" : next);
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

function Column({ col, members, displayList, adminContacts, coachMobile, onSent, onRowDoubleClick, expandedRows, toggleRow }) {
  const Icon = col.icon;
  // Per-category breakdown shown under the column label so coaches can see
  // "how many Athletes / Coaches / Staff" in each presence bucket at a glance.
  // Letters keep the chips legible inside the narrow 6-column grid.
  const catCounts = { athlete: 0, coach: 0, staff: 0, executive: 0 };
  for (const m of members) {
    const c = (m.category || "athlete").toLowerCase();
    if (catCounts[c] !== undefined) catCounts[c] += 1;
  }
  const breakdown = [
    { key: "athlete",   letter: "A", title: "Athletes",   chip: "bg-sky-100 text-sky-700",         n: catCounts.athlete },
    { key: "coach",     letter: "C", title: "Coaches",    chip: "bg-emerald-100 text-emerald-700", n: catCounts.coach },
    { key: "staff",     letter: "S", title: "Staff",      chip: "bg-amber-100 text-amber-700",     n: catCounts.staff },
    { key: "executive", letter: "E", title: "Executives", chip: "bg-violet-100 text-violet-700",   n: catCounts.executive },
  ];

  return (
    <section
      className={`flex flex-col rounded-2xl ${col.soft} border border-slate-200 overflow-hidden`}
      data-testid={`presence-column-${col.key}`}
    >
      <header
        className="px-4 py-3 bg-white/70 backdrop-blur border-b border-slate-200"
        style={{ boxShadow: `inset 4px 0 0 ${col.accent}` }}
      >
        <div className="flex items-center gap-2">
          <div
            className="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
            style={{ background: col.accent + "20", color: col.accent }}
          >
            <Icon size={15} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[11px] uppercase tracking-wider font-bold text-slate-500">{col.label}</div>
          </div>
          <span className={`min-w-[26px] h-6 px-2 rounded-full text-xs font-bold flex items-center justify-center ${col.badge}`} data-testid={`column-count-${col.key}`}>
            {members.length}
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-2 flex-wrap" data-testid={`column-breakdown-${col.key}`}>
          {breakdown.map((b) => (
            <span
              key={b.key}
              title={`${b.title}: ${b.n}`}
              data-testid={`column-breakdown-${col.key}-${b.key}`}
              className={`inline-flex items-center gap-1 px-1.5 h-5 rounded text-[10px] font-bold tracking-tight ${b.chip} ${b.n === 0 ? "opacity-40" : ""}`}
            >
              <span className="font-extrabold">{b.letter}</span>
              <span className="tabular-nums">{b.n}</span>
            </span>
          ))}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto max-h-[calc(100vh-220px)] min-h-[120px] divide-y divide-slate-100 bg-white">
        {displayList ? (
          displayList.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-slate-400">No one here.</div>
          ) : (
            displayList.map((entry, idx) => (
              <MemberCard
                key={`${col.key}-${entry.member.id}-${idx}`}
                m={entry.member}
                accent={col.accent}
                columnKey={col.key}
                adminContacts={adminContacts}
                coachMobile={coachMobile}
                onSent={onSent}
                onDoubleClick={entry.visible ? onRowDoubleClick : null}
                hidden={!entry.visible}
                expanded={entry.visible && expandedRows && expandedRows.has(entry.member.id)}
                onToggleExpand={entry.visible && toggleRow ? () => toggleRow(entry.member.id) : null}
              />
            ))
          )
        ) : members.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-slate-400">No one here.</div>
        ) : (
          members.map((m) => (
            <MemberCard
              key={m.id}
              m={m}
              accent={col.accent}
              columnKey={col.key}
              adminContacts={adminContacts}
              coachMobile={coachMobile}
              onSent={onSent}
              onDoubleClick={onRowDoubleClick}
              expanded={expandedRows && expandedRows.has(m.id)}
              onToggleExpand={toggleRow ? () => toggleRow(m.id) : null}
            />
          ))
        )}
      </div>
    </section>
  );
}

function MemberCard({ m, accent, columnKey, adminContacts, coachMobile, onSent, onDoubleClick, hidden, expanded, onToggleExpand }) {
  const lateBg = m.late ? "bg-red-50 hover:bg-red-100" : "hover:bg-slate-50";
  const notifyDueType = m.notify_due?.not_arrived
    ? "not_arrived"
    : (m.notify_due?.late ? "late" : null);
  const notifiedType = m.notified_today?.not_arrived
    ? "not_arrived"
    : (m.notified_today?.late ? "late" : null);
  const handleDouble = !hidden && onDoubleClick ? () => onDoubleClick(m.id) : undefined;
  // When `hidden`, the row reserves the same space as the real card in the
  // paired column at this index — guarantees pixel-aligned rows across the
  // Stepped Out / Checked Out pair without measurement hacks.
  const hiddenStyle = hidden ? { visibility: "hidden", pointerEvents: "none" } : undefined;
  // The timeline panel is only meaningful when there's actually a session
  // (check-in or excursions) to show — so the chevron is suppressed for
  // statuses like on_leave, on_tour, absent, not_due.
  const hasTimeline = !hidden && (m.check_in_at || (m.excursions && m.excursions.length > 0));
  return (
    <>
    <div
      className={`px-3 py-2.5 flex gap-2.5 items-start transition ${hidden ? "" : lateBg} ${!hidden && onDoubleClick ? "cursor-pointer select-none" : ""}`}
      data-testid={hidden ? `presence-blank-${columnKey}-${m.id}` : `presence-row-${m.id}`}
      onDoubleClick={handleDouble}
      title={!hidden && onDoubleClick ? (columnKey === "on_campus" ? "Double-click to remove from On Campus" : "Double-click to edit member") : undefined}
      style={hiddenStyle}
      aria-hidden={hidden ? true : undefined}
    >
      <Avatar name={m.full_name} photo={m.photo} size={34} ring={columnKey === "on_campus" ? accent : null} />
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-1.5">
          <div className={`text-[13px] font-semibold leading-tight truncate flex-1 ${m.late ? "text-red-700" : "text-slate-900"}`}>{m.full_name}</div>
          <ParentContact father={m.father_mobile} mother={m.mother_mobile} guardian={m.guardian_mobile} />
          {hasTimeline && onToggleExpand && (
            <button
              type="button"
              data-testid={`presence-expand-${m.id}`}
              onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}
              className={`shrink-0 w-5 h-5 rounded-md flex items-center justify-center transition ${expanded ? "bg-slate-200 text-slate-700" : "text-slate-400 hover:bg-slate-100"}`}
              title={expanded ? "Hide session timeline" : "Show full check-in / check-out timeline"}
              aria-label="Toggle timeline"
            >
              {expanded ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}
            </button>
          )}
        </div>
        <div className="text-[11px] text-slate-500 leading-tight mt-0.5 flex items-center gap-1.5 flex-wrap">
          <span className="truncate">{m.rank ? `${m.rank} · ` : ""}{categoryLabel(m.category)}</span>
          {m.institution && (
            <span
              title={`Institution: ${m.institution}`}
              data-testid={`presence-institution-chip-${m.id}`}
              className="inline-flex items-center px-1 h-4 rounded text-[9px] font-bold bg-sky-100 text-sky-700 max-w-[110px] truncate leading-none"
            >
              {m.institution}
            </span>
          )}
        </div>
        {m.detail && (
          <div className="text-[11px] text-slate-500 truncate mt-0.5">{m.detail}</div>
        )}
        <div className="flex flex-wrap gap-1 mt-1">
          {m.excursion_count > 0 && (
            <span
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-cyan-50 text-cyan-700 border border-cyan-200 text-[10px] font-bold"
              data-testid={`excursion-count-${m.id}`}
              title={`${m.excursion_count} excursion${m.excursion_count === 1 ? "" : "s"} today (stepped out and returned)`}
            >
              <Coffee size={9}/> {m.excursion_count}×
            </span>
          )}
          {m.days_remaining != null && m.days_remaining > 0 && (m.status === "on_leave" || m.status === "on_tour") && (
            <span
              className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold ${m.status === "on_tour" ? "bg-orange-100 text-orange-800" : "bg-amber-100 text-amber-800"}`}
              data-testid={`days-remaining-${m.id}`}
              title={`Returns after ${m.days_remaining} day${m.days_remaining === 1 ? "" : "s"}`}
            >
              {m.days_remaining}d more
            </span>
          )}
          {m.status === "absent" && m.days_absent_streak > 1 && (
            <span
              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-bold"
              data-testid={`days-absent-${m.id}`}
              title={`Absent for ${m.days_absent_streak} consecutive days${m.days_absent_streak >= 30 ? " (max lookback)" : ""}`}
            >
              {m.days_absent_streak}{m.days_absent_streak >= 30 ? "+" : ""}d absent
            </span>
          )}
          {m.flagged && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-bold">
              <AlertTriangle size={9} /> Off-site
            </span>
          )}
          {m.late && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-bold" data-testid={`late-chip-${m.id}`}>
              <Clock size={9} /> Late
            </span>
          )}
          {m.overdue_minutes > 0 && (
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-bold" data-testid={`overdue-chip-${m.id}`}>
              <AlertTriangle size={9} /> Overdue {m.overdue_minutes}m
            </span>
          )}
          {notifyDueType && (
            <NotifyParentsButton
              member={m}
              type={notifyDueType}
              adminContacts={adminContacts}
              coachMobile={coachMobile}
              onSent={onSent}
            />
          )}
          {!notifyDueType && notifiedType && (
            <NotifyParentsButton member={m} type={notifiedType} notified onSent={onSent} />
          )}
        </div>
        <GeoLine geoIn={m.geo_in} geoOut={m.geo_out} status={m.status} />
      </div>
    </div>
    {expanded && hasTimeline && <SessionTimeline m={m} />}
    </>
  );
}

/**
 * Compact session timeline shown when a Presence row is expanded.
 * Lays out check-in → step-outs → returns → check-out as a vertical stripe,
 * mirroring the old Daily Sessions page so the merger is lossless.
 */
function SessionTimeline({ m }) {
  const items = [];
  if (m.check_in_at) {
    items.push({
      key: `in-${m.check_in_at}`,
      icon: <LogIn size={11}/>,
      color: "#10B981",
      title: "Checked in",
      time: m.check_in_time,
      note: m.late ? `Late ${m.late_minutes || ""}m` : (m.geo_in?.out_of_geofence ? "Off-site" : ""),
    });
  }
  (m.excursions || []).forEach((e) => {
    items.push({
      key: `out-${e.id}`,
      icon: <Coffee size={11}/>,
      color: "#06B6D4",
      title: `Stepped out${e.reason ? " · " + e.reason : ""}`,
      time: e.out_time,
      note: e.expected_return_time ? `Expected back ${e.expected_return_time}` : "",
    });
    if (e.in_time) {
      items.push({
        key: `back-${e.id}`,
        icon: <LogIn size={11}/>,
        color: "#0EA5E9",
        title: "Returned",
        time: e.in_time,
        note: (e.duration_min != null ? `${e.duration_min}m away` : "")
              + (e.overdue_min ? ` · ${e.overdue_min}m overdue` : ""),
        overdue: !!e.overdue_min,
      });
    } else {
      items.push({
        key: `pending-${e.id}`,
        icon: <AlertTriangle size={11}/>,
        color: "#F59E0B",
        title: "Still away",
        time: "",
        note: e.expected_return_time ? `Expected back ${e.expected_return_time}` : "Awaiting return",
        overdue: !!e.overdue_min,
      });
    }
  });
  if (m.check_out_at) {
    items.push({
      key: `co-${m.check_out_at}`,
      icon: <ExitIcon size={11}/>,
      color: "#6B7280",
      title: m.auto_checkout ? "Auto-closed at midnight" : "Checked out",
      time: m.check_out_time,
      note: m.stored_hours != null ? `${m.stored_hours}h logged` : "",
    });
  }
  if (items.length === 0) return null;
  return (
    <div
      className="px-3 pb-3 pl-12 bg-slate-50/70 border-t border-slate-100"
      data-testid={`presence-timeline-${m.id}`}
    >
      <ol className="relative pl-4 pt-2">
        <span className="absolute left-[5px] top-3 bottom-1 w-px bg-slate-200" />
        {items.map((it) => (
          <li key={it.key} className="relative pb-2 last:pb-0">
            <span className="absolute -left-[11px] top-0.5 w-[14px] h-[14px] rounded-full flex items-center justify-center text-white" style={{ background: it.color }}>
              {it.icon}
            </span>
            <div className="flex items-baseline gap-1.5 flex-wrap pl-2">
              <span className="text-[11px] font-semibold text-slate-900">{it.title}</span>
              {it.time && <span className="text-[10px] font-mono text-slate-500">{it.time}</span>}
              {it.note && <span className={`text-[10px] ${it.overdue ? "text-amber-700 font-semibold" : "text-slate-500"}`}>· {it.note}</span>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function formatDist(m) {
  if (m == null) return null;
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

function GuestStrip({ guests, onCheckout, onDelete, onAdd }) {
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

function describeGeo(g) {
  if (!g || !g.method) return null;
  // GPS truly missing → "GPS unavailable", with the muster verifier as a
  // separate field so the UI can bold their name.
  if (g.geo_unavailable) {
    return {
      label: "GPS unavailable",
      verifierName: g.method === "muster" ? g.by || null : null,
      tone: "amber",
    };
  }
  const d = formatDist(g.distance_m);
  if (d == null) {
    if (g.method === "muster") {
      return { label: g.by ? "" : "Muster · no GPS", verifierName: g.by || null, tone: "slate" };
    }
    return { label: "distance not captured", verifierName: null, tone: "amber" };
  }
  // Distance present — always lead with it. For muster check-ins, hand the
  // verifier's name to the UI separately so it can render it in bold (saves
  // a few characters vs the previous "· muster by Name" prefix).
  const siteTag = g.out_of_geofence ? "off-site" : "on-site";
  return {
    label: `${d} ${siteTag}`,
    verifierName: g.method === "muster" ? g.by || null : null,
    tone: g.out_of_geofence ? "amber" : "emerald",
  };
}

function GeoLine({ geoIn, geoOut, status }) {
  const inInfo = describeGeo(geoIn);
  // Show check-out distance whenever it's recorded — exited members will
  // always have it, and an "on_campus" member with an open temp-exit may
  // have one as well. Today we only render it for "exited" to stay tight.
  const outInfo = status === "exited" ? describeGeo(geoOut) : null;
  if (!inInfo && !outInfo) return null;
  return (
    <div className="text-[10px] text-slate-500 mt-1 flex flex-col gap-0.5">
      {inInfo && <GeoChip label="IN" {...inInfo} />}
      {outInfo && <GeoChip label="OUT" {...outInfo} />}
    </div>
  );
}

function GeoChip({ label, tone, ...rest }) {
  const colour = tone === "amber" ? "text-amber-600" : tone === "emerald" ? "text-emerald-600" : "text-slate-500";
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
      <MapPin size={9} className={colour} />
      {rest.label && <span className={colour}>{rest.label}</span>}
      {rest.verifierName && (
        <span className={`font-bold ${colour}`}>{rest.verifierName}</span>
      )}
    </span>
  );
}

function SkeletonBoard() {
  return (
    <div className="grid gap-3 md:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {COLUMNS.map((col) => (
        <div key={col.key} className={`rounded-2xl ${col.soft} border border-slate-200 overflow-hidden`}>
          <div className="px-4 py-3 bg-white/70 border-b border-slate-200 h-12" />
          <div className="bg-white divide-y divide-slate-100">
            {[...Array(4)].map((_, i) => (
              <div key={`sk-${col.key}-${i}`} className="px-3 py-3 flex items-start gap-2.5">
                <div className="w-9 h-9 rounded-full bg-slate-200 animate-pulse" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-2.5 bg-slate-200 rounded w-3/4 animate-pulse" />
                  <div className="h-2 bg-slate-200 rounded w-1/2 animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
