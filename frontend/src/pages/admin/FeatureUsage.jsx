/**
 * FeatureUsage — super-admin dashboard showing every sidebar page/module
 * with its live-visit count, last-used date and an ageing bucket
 * (Active / Stale / Dormant / Never). Helps decide which dormant screens
 * are safe to retire. Last-used is backfilled from the audit log for
 * pages that already log actions, so the view isn't blank on day one.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Activity, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";

const BUCKETS = {
  active:  { label: "Active",  sub: "< 30 days",  dot: "bg-emerald-500", chip: "bg-emerald-100 text-emerald-800 ring-emerald-200" },
  stale:   { label: "Stale",   sub: "30–90 days", dot: "bg-amber-500",   chip: "bg-amber-100 text-amber-800 ring-amber-200" },
  dormant: { label: "Dormant", sub: "90 days+",   dot: "bg-red-500",     chip: "bg-red-100 text-red-800 ring-red-200" },
  never:   { label: "Never",   sub: "no activity",dot: "bg-slate-400",   chip: "bg-slate-100 text-slate-600 ring-slate-200" },
};
const BUCKET_ORDER = ["never", "dormant", "stale", "active"];

function BucketChip({ bucket }) {
  const b = BUCKETS[bucket] || BUCKETS.never;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ring-1 ${b.chip}`}
      data-testid={`fu-bucket-${bucket}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${b.dot}`} />
      {b.label}
    </span>
  );
}

function ageLabel(row) {
  if (row.bucket === "never") return "—";
  if (row.days_since === 0) return "today";
  if (row.days_since === 1) return "yesterday";
  return `${row.days_since} days ago`;
}

export default function FeatureUsage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState("all");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      setData(await api.get("/usage/report"));
    } catch (err) {
      setError(err?.message || "Load failed");
      toast.error(err?.message || "Load failed");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    const all = data?.rows || [];
    const list = filter === "all" ? all : all.filter((r) => r.bucket === filter);
    // Sort worst-first (never → dormant → stale → active), then by ageing.
    const rank = { never: 0, dormant: 1, stale: 2, active: 3 };
    return [...list].sort((a, b) =>
      (rank[a.bucket] - rank[b.bucket])
      || ((b.days_since ?? -1) - (a.days_since ?? -1))
      || a.label.localeCompare(b.label));
  }, [data, filter]);

  const retireCandidates = (data?.summary?.never || 0) + (data?.summary?.dormant || 0);

  return (
    <div className="p-4 md:p-8" data-testid="feature-usage-page">
      <div className="mb-2 flex items-center gap-2">
        <Activity size={20} className="text-slate-500" />
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Feature Usage &amp; Ageing</h1>
      </div>
      <p className="text-sm text-slate-500 mb-6 max-w-3xl">
        Every sidebar page with its visit count and when it was last touched. Dormant and never-used
        screens are candidates to retire. Last-used is backfilled from the audit log where available,
        and live visits are tracked from now on.
      </p>

      {error && (
        <div className="iu-card p-4 mb-4 flex items-center gap-2 text-sm text-red-700 bg-red-50 border border-red-200" data-testid="fu-error">
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {/* Summary strip — click a bucket to filter */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
          <button
            type="button"
            onClick={() => setFilter("all")}
            className={`iu-card p-3 text-left transition ${filter === "all" ? "ring-2 ring-slate-800" : ""}`}
            data-testid="fu-summary-all"
          >
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-bold">All screens</div>
            <div className="text-2xl font-extrabold tabular-nums text-slate-800">{data.total}</div>
          </button>
          {BUCKET_ORDER.slice().reverse().map((key) => (
            <button
              type="button"
              key={key}
              onClick={() => setFilter(key)}
              className={`iu-card p-3 text-left transition ${filter === key ? "ring-2 ring-slate-800" : ""}`}
              data-testid={`fu-summary-${key}`}
            >
              <div className="text-[10px] uppercase tracking-wide text-slate-500 font-bold flex items-center gap-1">
                <span className={`w-1.5 h-1.5 rounded-full ${BUCKETS[key].dot}`} />
                {BUCKETS[key].label}
              </div>
              <div className="text-2xl font-extrabold tabular-nums text-slate-800">
                {(data.summary || {})[key] || 0}
              </div>
              <div className="text-[10px] text-slate-400">{BUCKETS[key].sub}</div>
            </button>
          ))}
        </div>
      )}

      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <button data-testid="fu-refresh" onClick={load} disabled={loading} className="iu-btn-primary">
          {loading ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />} Refresh
        </button>
        {data && retireCandidates > 0 && (
          <span className="text-xs font-semibold text-red-700 bg-red-50 border border-red-200 rounded-full px-3 py-1">
            {retireCandidates} screen{retireCandidates === 1 ? "" : "s"} dormant or never used
          </span>
        )}
        {data && (
          <span className="text-xs text-slate-500">Generated {new Date(data.generated_at).toLocaleString()}</span>
        )}
      </div>

      <div className="iu-card overflow-hidden">
        <div className="overflow-auto max-h-[70vh]">
          <table className="w-full text-xs" data-testid="fu-table">
            <thead className="bg-slate-50 border-b border-slate-200 sticky top-0 z-10">
              <tr className="text-[10px] uppercase tracking-wider font-bold text-slate-500 text-left">
                <th className="py-2 px-3">Screen</th>
                <th className="py-2 px-3">Section</th>
                <th className="py-2 px-3 w-28">Status</th>
                <th className="py-2 px-3 text-right w-24">Visits</th>
                <th className="py-2 px-3 w-32">Last used</th>
                <th className="py-2 px-3">By</th>
                <th className="py-2 px-3 font-mono normal-case">Path</th>
              </tr>
            </thead>
            <tbody>
              {!loading && rows.length === 0 && (
                <tr><td colSpan={7} className="py-10 text-center text-slate-500">No screens in this filter.</td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-slate-100 hover:bg-slate-50" data-testid={`fu-row-${r.key}`}>
                  <td className="py-2 px-3 font-semibold text-slate-800">{r.label}</td>
                  <td className="py-2 px-3 text-slate-500">{r.group}</td>
                  <td className="py-2 px-3"><BucketChip bucket={r.bucket} /></td>
                  <td className="py-2 px-3 text-right tabular-nums font-semibold text-slate-700">
                    {r.views || 0}
                    {r.audit_events > 0 && (
                      <span className="text-slate-400 font-normal" title="Historical audit-log events for this screen"> +{r.audit_events}</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-slate-600" title={r.last_used_at || ""}>{ageLabel(r)}</td>
                  <td className="py-2 px-3 text-slate-500">{r.last_used_by_name || "—"}</td>
                  <td className="py-2 px-3 font-mono text-[10px] text-slate-400">{r.key}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-[11px] text-slate-400 mt-3">
        Visits count page opens since usage-tracking shipped (throttled to once per screen per 5 min per session).
        The <span className="font-mono">+n</span> beside a count is historical audit-log activity used to seed last-used.
      </p>
    </div>
  );
}
