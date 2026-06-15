import React, { useEffect, useState, useCallback } from "react";
import { CheckCircle2, Plane, Bed, LogOut as ExitIcon, AlertTriangle, Clock, RefreshCw, Coffee } from "lucide-react";
import { api } from "../api";
import Avatar from "../components/Avatar";
import StatusBadge from "../components/StatusBadge";
import { categoryLabel, formatDate } from "../utils";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "on_campus", label: "On Campus" },
  { key: "temp_out", label: "Stepped Out" },
  { key: "exited", label: "Exited" },
  { key: "on_tour", label: "On Tour" },
  { key: "on_leave", label: "On Leave" },
];

export default function Presence() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState("all");

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

  const members = (data?.members || []).filter((m) => filter === "all" || m.status === filter);
  const counts = data?.counts || {};

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      <header className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight" data-testid="presence-title">Presence Board</h1>
          <p className="text-slate-500 mt-1 text-sm">{data ? formatDate(data.date) : "Live campus roster"}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center gap-2 bg-white border border-slate-200 px-3 h-9 rounded-full text-xs font-semibold text-slate-700">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            {counts.total || 0} members
          </div>
          <button onClick={load} className="iu-btn-secondary !h-9 !px-3" data-testid="presence-refresh-button">
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <StatCard label="On Campus" value={counts.on_campus || 0} color="#10B981" Icon={CheckCircle2} />
        <StatCard label="Stepped Out" value={counts.temp_out || 0} color="#06B6D4" Icon={Coffee} />
        <StatCard label="On Tour" value={counts.on_tour || 0} color="#F97316" Icon={Plane} />
        <StatCard label="On Leave" value={counts.on_leave || 0} color="#F59E0B" Icon={Bed} />
        <StatCard label="Exited" value={counts.exited || 0} color="#6B7280" Icon={ExitIcon} />
      </div>

      <div className="flex gap-2 overflow-x-auto pb-3 mb-2 -mx-1 px-1">
        {FILTERS.map((f) => {
          const active = filter === f.key;
          const c = counts[f.key === "all" ? "total" : f.key] ?? 0;
          return (
            <button
              key={f.key}
              data-testid={`filter-chip-${f.key}`}
              onClick={() => setFilter(f.key)}
              className={`iu-chip whitespace-nowrap shrink-0 ${active ? "iu-chip-active" : ""}`}
            >
              {f.label}
              <span className={`min-w-[22px] h-5 px-1.5 rounded-full text-[10px] flex items-center justify-center ${active ? "bg-white/20 text-white" : "bg-white border border-slate-200 text-slate-600"}`}>{c}</span>
            </button>
          );
        })}
      </div>

      {loading ? (
        <SkeletonList />
      ) : error ? (
        <div className="iu-card p-10 text-center">
          <p className="text-slate-500">Failed to load presence data.</p>
          <button onClick={load} className="iu-btn-primary mt-4">Retry</button>
        </div>
      ) : members.length === 0 ? (
        <div className="iu-card p-10 text-center" data-testid="presence-empty">
          <p className="text-slate-500 font-semibold">Nobody matches this filter right now.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3" data-testid="presence-list">
          {members.map((m) => <MemberRow key={m.id} m={m} />)}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color, Icon }) {
  return (
    <div className="iu-card p-4">
      <div className="flex items-center justify-between">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: color + "22", color }}>
          <Icon size={18} />
        </div>
      </div>
      <div className="text-2xl font-extrabold mt-3" data-testid={`stat-${label.toLowerCase().replace(/\s+/g, "-")}`}>{value}</div>
      <div className="text-xs text-slate-500 font-semibold uppercase tracking-wide mt-0.5">{label}</div>
    </div>
  );
}

function MemberRow({ m }) {
  return (
    <div className="iu-card p-4 flex items-center gap-4" data-testid={`presence-row-${m.id}`}>
      <Avatar name={m.full_name} photo={m.photo} size={48} ring={m.status === "on_campus" ? "#10B981" : null} />
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-slate-900 truncate">{m.full_name}</div>
        <div className="text-xs text-slate-500 truncate">
          {m.rank ? `${m.rank} · ` : ""}{categoryLabel(m.category)}
        </div>
        <div className="text-xs text-slate-600 mt-1 flex items-center gap-1.5 flex-wrap">
          <span>{m.detail}</span>
          {m.flagged && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-bold">
              <AlertTriangle size={10} /> Off-site
            </span>
          )}
          {m.late && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-orange-100 text-orange-800 text-[10px] font-bold">
              <Clock size={10} /> Late
            </span>
          )}
        </div>
      </div>
      <StatusBadge status={m.status} />
    </div>
  );
}

function SkeletonList() {
  // Static placeholder list — never reorders and has no underlying data,
  // so using the array index as key is React-idiomatic here.
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {[...Array(6)].map((_, i) => (
        <div key={`skeleton-${i}`} className="iu-card p-4 flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-slate-200 animate-pulse" />
          <div className="flex-1">
            <div className="h-3 bg-slate-200 rounded w-1/2 animate-pulse" />
            <div className="h-2.5 bg-slate-200 rounded w-1/3 animate-pulse mt-2" />
          </div>
          <div className="h-6 w-20 bg-slate-200 rounded-full animate-pulse" />
        </div>
      ))}
    </div>
  );
}
