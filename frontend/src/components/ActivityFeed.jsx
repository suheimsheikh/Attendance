import React, { useEffect, useState, useCallback } from "react";
import { LogIn, LogOut, Bed, Plane, IdCard, Clock, RefreshCw, Loader2, Coffee, ArrowLeftRight } from "lucide-react";
import { api } from "../api";
import Avatar from "./Avatar";
import { categoryLabel } from "../utils";

const TYPE_META = {
  check_in:        { label: "Check-in",   Icon: LogIn,   color: "#10B981" },
  check_out:       { label: "Check-out",  Icon: LogOut,  color: "#6B7280" },
  temp_exit:       { label: "Temp exit",  Icon: Coffee,  color: "#06B6D4" },
  temp_return:     { label: "Returned",   Icon: ArrowLeftRight, color: "#0EA5E9" },
  application:     { label: "Application", Icon: Bed,    color: "#F59E0B" },
  access_request:  { label: "Access",     Icon: IdCard,  color: "#0EA5E9" },
};

const FILTERS = [
  { key: "all", label: "All" },
  { key: "check_in", label: "Check-ins" },
  { key: "check_out", label: "Check-outs" },
  { key: "temp_exit", label: "Temp exits" },
  { key: "temp_return", label: "Returns" },
  { key: "application", label: "Applications" },
  { key: "access_request", label: "Access requests" },
];

function fmtTime(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
}

function fmtAgo(iso) {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 60_000) return "just now";
  const m = Math.floor(diffMs / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function ActivityFeed() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState("all");

  const load = useCallback(async () => {
    try {
      setError(false);
      setData(await api.get("/admin/activity"));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const events = (data?.events || []).filter(
    (e) => filter === "all" || e.type === filter
  );
  const counts = data?.counts || {};

  return (
    <section className="iu-card" data-testid="activity-feed">
      <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-extrabold tracking-tight">Today&apos;s Activity</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {data ? `${data.date} · ${data.timezone}` : "Live feed — resets each day"}
            {data ? ` · ${counts.total || 0} events` : ""}
          </p>
        </div>
        <button
          data-testid="activity-refresh"
          onClick={load}
          className="iu-btn-secondary !h-8 !px-2.5"
          title="Refresh"
        >
          {loading ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}
        </button>
      </div>

      <div className="px-5 py-3 border-b border-slate-100 flex gap-2 overflow-x-auto">
        {FILTERS.map((f) => {
          const active = filter === f.key;
          const c = f.key === "all" ? (counts.total || 0) :
                    (f.key === "application" ? (counts.applications || 0) :
                     f.key === "access_request" ? (counts.access_requests || 0) :
                     (counts[f.key] || 0));
          return (
            <button
              key={f.key}
              data-testid={`activity-filter-${f.key}`}
              onClick={() => setFilter(f.key)}
              className={`iu-chip whitespace-nowrap shrink-0 ${active ? "iu-chip-active" : ""}`}
            >
              {f.label}
              <span className={`min-w-[20px] h-5 px-1.5 rounded-full text-[10px] flex items-center justify-center ${active ? "bg-white/20 text-white" : "bg-white border border-slate-200 text-slate-600"}`}>{c}</span>
            </button>
          );
        })}
      </div>

      {loading && !data ? (
        <div className="p-10 text-center"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
      ) : error ? (
        <div className="p-10 text-center">
          <p className="text-sm text-slate-500">Couldn&apos;t load the activity feed.</p>
          <button onClick={load} className="iu-btn-secondary mt-3 mx-auto">Retry</button>
        </div>
      ) : events.length === 0 ? (
        <div className="p-10 text-center" data-testid="activity-empty">
          <Clock className="mx-auto text-slate-300 mb-2" size={32} />
          <p className="font-semibold text-slate-700">No activity yet today</p>
          <p className="text-xs text-slate-500 mt-1">As soon as members check in / out or submit requests, they&apos;ll show up here.</p>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 max-h-[520px] overflow-y-auto">
          {events.map((e) => <ActivityRow key={e.id} e={e} />)}
        </ul>
      )}
    </section>
  );
}

function ActivityRow({ e }) {
  const meta = TYPE_META[e.type] || TYPE_META.check_in;
  // For 'application', subtype determines the icon (tour vs leave).
  const Icon = e.type === "application" && e.subtype === "tour" ? Plane : meta.Icon;
  const color = e.type === "application" && e.subtype === "tour" ? "#F97316" : meta.color;

  return (
    <li className="px-5 py-3 flex items-center gap-3" data-testid={`activity-row-${e.id}`}>
      <div className="relative shrink-0">
        <Avatar name={e.member_name} photo={e.photo} size={40} />
        <span
          className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center border-2 border-white"
          style={{ background: color, color: "#fff" }}
          title={meta.label}
        >
          <Icon size={11} />
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-slate-900 truncate">
          {e.member_name}
          {e.member_rank ? <span className="text-slate-400 font-normal"> · {e.member_rank}</span> : null}
          {e.member_category ? <span className="text-slate-400 font-normal"> · {categoryLabel(e.member_category)}</span> : null}
        </div>
        <div className="text-xs text-slate-600 truncate">{e.detail}</div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-xs font-semibold text-slate-700">{fmtTime(e.at)}</div>
        <div className="text-[10px] text-slate-400">{fmtAgo(e.at)}</div>
      </div>
    </li>
  );
}
