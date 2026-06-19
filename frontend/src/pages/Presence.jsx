import React, { useEffect, useMemo, useState, useCallback } from "react";
import { CheckCircle2, Plane, Bed, LogOut as ExitIcon, AlertTriangle, Clock, RefreshCw, Coffee, MapPin, UserX, Search, UserPlus, X } from "lucide-react";
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
  { key: "temp_out",   label: "Stepped Out",  icon: Coffee,       accent: "#06B6D4", soft: "bg-cyan-50",     badge: "bg-cyan-100 text-cyan-700" },
  { key: "on_tour",    label: "Tour",         icon: Plane,        accent: "#F97316", soft: "bg-orange-50",   badge: "bg-orange-100 text-orange-700" },
  { key: "on_leave",   label: "Leave",        icon: Bed,          accent: "#F59E0B", soft: "bg-amber-50",    badge: "bg-amber-100 text-amber-700" },
  { key: "absent",     label: "Absent",       icon: UserX,        accent: "#DC2626", soft: "bg-red-50",      badge: "bg-red-100 text-red-700" },
  { key: "exited",     label: "Check Out",    icon: ExitIcon,     accent: "#6B7280", soft: "bg-slate-50",    badge: "bg-slate-200 text-slate-700" },
];

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

  const load = useCallback(async () => {
    try {
      setError(false);
      const [res, gRes] = await Promise.all([
        api.get("/presence"),
        canManageGuests ? api.get("/guests/today").catch(() => null) : Promise.resolve(null),
      ]);
      setData(res);
      if (gRes) setGuests(gRes);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [canManageGuests]);

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
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

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
          <p className="text-slate-500 mt-1 text-sm">{data ? formatDate(data.date) : "Live campus roster"}</p>
        </div>
        <div className="flex items-center gap-2">
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
              adminContacts={data?.admin_contacts || []}
              coachMobile={currentUser?.mobile}
              onSent={load}
              onRowDoubleClick={isAdmin ? openEdit : null}
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

function Column({ col, members, adminContacts, coachMobile, onSent, onRowDoubleClick }) {
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
        {members.length === 0 ? (
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
            />
          ))
        )}
      </div>
    </section>
  );
}

function MemberCard({ m, accent, columnKey, adminContacts, coachMobile, onSent, onDoubleClick }) {
  const lateBg = m.late ? "bg-red-50 hover:bg-red-100" : "hover:bg-slate-50";
  const notifyDueType = m.notify_due?.not_arrived
    ? "not_arrived"
    : (m.notify_due?.late ? "late" : null);
  const notifiedType = m.notified_today?.not_arrived
    ? "not_arrived"
    : (m.notified_today?.late ? "late" : null);
  const handleDouble = onDoubleClick ? () => onDoubleClick(m.id) : undefined;
  return (
    <div
      className={`px-3 py-2.5 flex gap-2.5 items-start transition ${lateBg} ${onDoubleClick ? "cursor-pointer select-none" : ""}`}
      data-testid={`presence-row-${m.id}`}
      onDoubleClick={handleDouble}
      title={onDoubleClick ? "Double-click to edit member" : undefined}
    >
      <Avatar name={m.full_name} photo={m.photo} size={34} ring={columnKey === "on_campus" ? accent : null} />
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-1.5">
          <div className={`text-[13px] font-semibold leading-tight truncate flex-1 ${m.late ? "text-red-700" : "text-slate-900"}`}>{m.full_name}</div>
          {m.institution && (
            <span
              title={`Institution: ${m.institution}`}
              data-testid={`presence-institution-chip-${m.id}`}
              className="inline-flex items-center px-1 h-4 rounded text-[9px] font-bold bg-sky-100 text-sky-700 shrink-0 max-w-[80px] truncate leading-none"
            >
              {m.institution}
            </span>
          )}
          <ParentContact father={m.father_mobile} mother={m.mother_mobile} guardian={m.guardian_mobile} />
        </div>
        <div className="text-[11px] text-slate-500 leading-tight truncate mt-0.5">
          {m.rank ? `${m.rank} · ` : ""}{categoryLabel(m.category)}
        </div>
        {m.detail && (
          <div className="text-[11px] text-slate-500 truncate mt-0.5">{m.detail}</div>
        )}
        <div className="flex flex-wrap gap-1 mt-1">
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
  // GPS truly missing → "GPS unavailable", optionally annotated with the muster verifier.
  if (g.geo_unavailable) {
    const suffix = g.method === "muster" && g.by ? ` · muster by ${g.by}` : "";
    return { label: `GPS unavailable${suffix}`, tone: "amber" };
  }
  const d = formatDist(g.distance_m);
  // No distance value at all → fall back to whatever annotation we have.
  if (d == null) {
    if (g.method === "muster") {
      return { label: g.by ? `Muster · by ${g.by}` : "Muster · no GPS", tone: "slate" };
    }
    return { label: "distance not captured", tone: "amber" };
  }
  // Distance present — always lead with it. For muster check-ins, append the
  // coach name so admins can still see who marked attendance.
  const siteTag = g.out_of_geofence ? "off-site" : "on-site";
  const verifier = g.method === "muster" && g.by ? ` · muster by ${g.by}` : "";
  return {
    label: `${d} ${siteTag}${verifier}`,
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
      <span className={colour}>{rest.label}</span>
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
