import React, { useEffect, useMemo, useState, useCallback } from "react";
import { CheckCircle2, Plane, Bed, LogOut as ExitIcon, AlertTriangle, Clock, RefreshCw, Coffee, MapPin, UserX, Search } from "lucide-react";
import { api } from "../api";
import Avatar from "../components/Avatar";
import ParentContact from "../components/ParentContact";
import NotifyParentsButton from "../components/NotifyParentsButton";
import { useAuth } from "../auth";
import { categoryLabel, formatDate } from "../utils";

const COLUMNS = [
  { key: "on_campus",  label: "On Campus",    icon: CheckCircle2, accent: "#10B981", soft: "bg-emerald-50",  badge: "bg-emerald-100 text-emerald-700" },
  { key: "temp_out",   label: "Stepped Out",  icon: Coffee,       accent: "#06B6D4", soft: "bg-cyan-50",     badge: "bg-cyan-100 text-cyan-700" },
  { key: "on_tour",    label: "Tour",         icon: Plane,        accent: "#F97316", soft: "bg-orange-50",   badge: "bg-orange-100 text-orange-700" },
  { key: "on_leave",   label: "Leave",        icon: Bed,          accent: "#F59E0B", soft: "bg-amber-50",    badge: "bg-amber-100 text-amber-700" },
  { key: "absent",     label: "Absent",       icon: UserX,        accent: "#DC2626", soft: "bg-red-50",      badge: "bg-red-100 text-red-700" },
  { key: "exited",     label: "Left",         icon: ExitIcon,     accent: "#6B7280", soft: "bg-slate-50",    badge: "bg-slate-200 text-slate-700" },
];

export default function Presence() {
  const { user: currentUser } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [lateOnly, setLateOnly] = useState(false);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      setError(false);
      const res = await api.get("/presence");
      setData(res);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

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
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Column({ col, members, adminContacts, coachMobile, onSent }) {
  const Icon = col.icon;
  return (
    <section
      className={`flex flex-col rounded-2xl ${col.soft} border border-slate-200 overflow-hidden`}
      data-testid={`presence-column-${col.key}`}
    >
      <header
        className="px-4 py-3 flex items-center gap-2 bg-white/70 backdrop-blur border-b border-slate-200"
        style={{ boxShadow: `inset 4px 0 0 ${col.accent}` }}
      >
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
            />
          ))
        )}
      </div>
    </section>
  );
}

function MemberCard({ m, accent, columnKey, adminContacts, coachMobile, onSent }) {
  const lateBg = m.late ? "bg-red-50 hover:bg-red-100" : "hover:bg-slate-50";
  const notifyDueType = m.notify_due?.not_arrived
    ? "not_arrived"
    : (m.notify_due?.late ? "late" : null);
  const notifiedType = m.notified_today?.not_arrived
    ? "not_arrived"
    : (m.notified_today?.late ? "late" : null);
  return (
    <div className={`px-3 py-2.5 flex gap-2.5 items-start transition ${lateBg}`} data-testid={`presence-row-${m.id}`}>
      <Avatar name={m.full_name} photo={m.photo} size={34} ring={columnKey === "on_campus" ? accent : null} />
      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-1.5">
          <div className="text-[13px] font-semibold text-slate-900 leading-tight truncate flex-1">{m.full_name}</div>
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
            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-orange-100 text-orange-800 text-[10px] font-bold">
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

function describeGeo(g) {
  if (!g || !g.method) return null;
  if (g.method === "muster") {
    return { label: g.by ? `Muster · by ${g.by}` : "Muster · no GPS", tone: "slate" };
  }
  if (g.geo_unavailable) {
    return { label: "GPS unavailable", tone: "amber" };
  }
  const d = formatDist(g.distance_m);
  if (d == null) return { label: "distance not captured", tone: "amber" };
  return {
    label: `${d} ${g.out_of_geofence ? "off-site" : "on-site"}`,
    tone: g.out_of_geofence ? "amber" : "emerald",
  };
}

function GeoLine({ geoIn, geoOut, status }) {
  const inInfo = describeGeo(geoIn);
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
