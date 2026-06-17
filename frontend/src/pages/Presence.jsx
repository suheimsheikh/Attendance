import React, { useEffect, useMemo, useState, useCallback } from "react";
import { CheckCircle2, Plane, Bed, LogOut as ExitIcon, AlertTriangle, Clock, RefreshCw, Coffee, MapPin } from "lucide-react";
import { api } from "../api";
import Avatar from "../components/Avatar";
import { categoryLabel, formatDate } from "../utils";

const COLUMNS = [
  { key: "on_campus",  label: "On Campus",    icon: CheckCircle2, accent: "#10B981", soft: "bg-emerald-50",  badge: "bg-emerald-100 text-emerald-700" },
  { key: "temp_out",   label: "Stepped Out",  icon: Coffee,       accent: "#06B6D4", soft: "bg-cyan-50",     badge: "bg-cyan-100 text-cyan-700" },
  { key: "on_tour",    label: "Tour",         icon: Plane,        accent: "#F97316", soft: "bg-orange-50",   badge: "bg-orange-100 text-orange-700" },
  { key: "on_leave",   label: "Leave",        icon: Bed,          accent: "#F59E0B", soft: "bg-amber-50",    badge: "bg-amber-100 text-amber-700" },
  { key: "exited",     label: "Left",         icon: ExitIcon,     accent: "#6B7280", soft: "bg-slate-50",    badge: "bg-slate-200 text-slate-700" },
];

export default function Presence() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

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
    for (const m of (data?.members || [])) {
      if (buckets[m.status]) buckets[m.status].push(m);
    }
    // Sort each column by most recent activity first (then name)
    for (const k of Object.keys(buckets)) {
      buckets[k].sort((a, b) => {
        const da = a.since ? new Date(a.since).getTime() : 0;
        const db = b.since ? new Date(b.since).getTime() : 0;
        if (db !== da) return db - da;
        return (a.full_name || "").localeCompare(b.full_name || "");
      });
    }
    return buckets;
  }, [data]);

  const totalMembers = data?.counts?.total ?? (data?.members?.length || 0);

  return (
    <div className="p-4 md:p-6 max-w-[1500px] mx-auto">
      <header className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight" data-testid="presence-title">Presence Board</h1>
          <p className="text-slate-500 mt-1 text-sm">{data ? formatDate(data.date) : "Live campus roster"}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center gap-2 bg-white border border-slate-200 px-3 h-9 rounded-full text-xs font-semibold text-slate-700">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            {totalMembers} members
          </div>
          <button onClick={load} className="iu-btn-secondary !h-9 !px-3" data-testid="presence-refresh-button">
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      {loading && !data ? (
        <SkeletonBoard />
      ) : error ? (
        <div className="iu-card p-10 text-center">
          <p className="text-slate-500">Failed to load presence data.</p>
          <button onClick={load} className="iu-btn-primary mt-4">Retry</button>
        </div>
      ) : (
        <div
          className="grid gap-3 md:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-5"
          data-testid="presence-board"
        >
          {COLUMNS.map((col) => (
            <Column key={col.key} col={col} members={byColumn[col.key]} />
          ))}
        </div>
      )}
    </div>
  );
}

function Column({ col, members }) {
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
          members.map((m) => <MemberCard key={m.id} m={m} accent={col.accent} columnKey={col.key} />)
        )}
      </div>
    </section>
  );
}

function MemberCard({ m, accent, columnKey }) {
  return (
    <div className="px-3 py-2.5 flex gap-2.5 items-start hover:bg-slate-50 transition" data-testid={`presence-row-${m.id}`}>
      <Avatar name={m.full_name} photo={m.photo} size={34} ring={columnKey === "on_campus" ? accent : null} />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold text-slate-900 leading-tight truncate">{m.full_name}</div>
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
    <div className="grid gap-3 md:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-5">
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
