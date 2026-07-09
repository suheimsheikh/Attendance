/**
 * Category Health — one-shot diagnostic sweep that surfaces places where
 * Elite (or any custom athlete-like category) may be silently
 * mishandled because code still hardcodes `category == "athlete"`
 * instead of consulting the `is_athlete_like` flag on the categories
 * master.
 *
 * Backed by GET /api/admin/category-health — read-only, admin-gated.
 * Safe to leave open in a browser tab as a regression tripwire.
 */
import React, { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Loader2, ShieldAlert, RefreshCw, CheckCircle2, AlertTriangle,
  Info, FileCode2,
} from "lucide-react";
import { api } from "../../api";

export default function CategoryHealth() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("warn");   // 'warn' | 'all'

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get("/admin/category-health");
      setData(r);
    } catch (err) {
      toast.error(err?.message || "Failed to load category health");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const shown = useMemo(() => {
    if (!data?.hotspots) return [];
    return filter === "warn"
      ? data.hotspots.filter((h) => h.severity === "warn")
      : data.hotspots;
  }, [data, filter]);

  const warnCount = data?.warn_count ?? 0;
  const infoCount = (data?.hotspot_count ?? 0) - warnCount;

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-8" data-testid="category-health-page">
      <header className="flex items-end justify-between flex-wrap gap-3 mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight flex items-center gap-2">
            <ShieldAlert className="text-rose-600" size={28} /> Category Health
          </h1>
          <p className="text-sm text-slate-500 mt-1 max-w-2xl">
            Diagnostic sweep that flags any code still hardcoding{" "}
            <code className="text-xs bg-slate-100 px-1.5 py-0.5 rounded">
              category == &quot;athlete&quot;
            </code>{" "}
            — which silently excludes Elite squad members from features like
            Muster, Fleet assign, Reports, and Break scoping.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="iu-btn-secondary"
          data-testid="cat-health-refresh"
        >
          {loading ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}
          Refresh
        </button>
      </header>

      {loading && !data ? (
        <div className="flex items-center gap-2 text-slate-500">
          <Loader2 className="animate-spin" size={16} /> Scanning…
        </div>
      ) : !data ? null : (
        <div className="space-y-6">
          {/* Summary cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <StatCard
              testId="cat-health-warn"
              icon={AlertTriangle}
              tone={warnCount > 0 ? "warn" : "ok"}
              label="Hotspots (warn)"
              value={warnCount}
              hint={warnCount > 0 ? "Likely regressions — review below" : "None — all clean"}
            />
            <StatCard
              testId="cat-health-info"
              icon={Info}
              tone="info"
              label="Hotspots (info)"
              value={infoCount}
              hint="Tests / scripts / docstrings — usually safe"
            />
            <StatCard
              testId="cat-health-keys"
              icon={CheckCircle2}
              tone="ok"
              label="Athlete-like keys"
              value={(data.athlete_like_keys || []).length}
              hint={(data.athlete_like_keys || []).join(", ") || "—"}
            />
          </div>

          {/* Categories roster */}
          <section className="iu-card p-4">
            <h2 className="font-bold mb-3">Categories master</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wide text-slate-500 border-b">
                  <tr>
                    <th className="text-left py-2 pr-4">Key</th>
                    <th className="text-left py-2 pr-4">Label</th>
                    <th className="text-right py-2 pr-4">Members</th>
                    <th className="text-center py-2 pr-4">Athlete-like</th>
                    <th className="text-center py-2 pr-4">Meal-eligible</th>
                    <th className="text-center py-2">Active</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.categories || []).map((c) => (
                    <tr key={c.key} className="border-b last:border-0" data-testid={`cat-row-${c.key}`}>
                      <td className="py-2 pr-4 font-mono text-xs">{c.key}</td>
                      <td className="py-2 pr-4">{c.label}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{c.count}</td>
                      <td className="py-2 pr-4 text-center">{c.is_athlete_like ? "✓" : "—"}</td>
                      <td className="py-2 pr-4 text-center">{c.meal_eligible ? "✓" : "—"}</td>
                      <td className="py-2 text-center">{c.active ? "✓" : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Hotspots */}
          <section className="iu-card p-4" data-testid="cat-health-hotspots">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <h2 className="font-bold flex items-center gap-2">
                <FileCode2 size={18} className="text-slate-500" />
                Code hotspots
              </h2>
              <div className="flex gap-1 text-xs">
                <button
                  onClick={() => setFilter("warn")}
                  className={`px-3 py-1.5 rounded-full ${filter === "warn"
                    ? "bg-rose-100 text-rose-800 font-semibold"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
                  data-testid="cat-health-filter-warn"
                >
                  Warnings ({warnCount})
                </button>
                <button
                  onClick={() => setFilter("all")}
                  className={`px-3 py-1.5 rounded-full ${filter === "all"
                    ? "bg-slate-800 text-white font-semibold"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
                  data-testid="cat-health-filter-all"
                >
                  All ({data.hotspot_count})
                </button>
              </div>
            </div>

            {shown.length === 0 ? (
              <div className="text-sm text-emerald-700 bg-emerald-50 rounded-lg p-4 flex items-center gap-2">
                <CheckCircle2 size={18} /> No hotspots at this severity — codebase is clean.
              </div>
            ) : (
              <ul className="space-y-2">
                {shown.map((h, idx) => (
                  <li
                    key={`${h.file}:${h.line}:${idx}`}
                    className="border rounded-lg p-3 flex items-start gap-3 text-sm"
                    data-testid={`cat-health-hotspot-${idx}`}
                  >
                    <SeverityIcon sev={h.severity} />
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-xs text-slate-500 truncate">
                        {h.file}
                        <span className="text-slate-400"> : </span>
                        <span className="text-slate-700">line {h.line}</span>
                      </div>
                      <pre className="font-mono text-xs bg-slate-50 rounded mt-1 p-2 overflow-x-auto whitespace-pre-wrap break-all">
                        {h.snippet}
                      </pre>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <p className="text-xs text-slate-400">
            Scanned at {data.generated_at ? new Date(data.generated_at).toLocaleString() : "—"}.
            This page reads only — nothing is modified.
          </p>
        </div>
      )}
    </div>
  );
}

function StatCard({ icon: Icon, tone, label, value, hint, testId }) {
  const toneClasses = {
    ok:   "bg-emerald-50  border-emerald-200 text-emerald-800",
    warn: "bg-rose-50     border-rose-200    text-rose-800",
    info: "bg-slate-50    border-slate-200   text-slate-700",
  }[tone] || "bg-white border-slate-200";
  return (
    <div className={`rounded-xl border p-4 ${toneClasses}`} data-testid={testId}>
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide opacity-80">
        <Icon size={14} /> {label}
      </div>
      <div className="text-3xl font-extrabold mt-1 tabular-nums">{value}</div>
      <div className="text-xs mt-1 opacity-75">{hint}</div>
    </div>
  );
}

function SeverityIcon({ sev }) {
  if (sev === "warn") return <AlertTriangle className="text-rose-600 flex-shrink-0 mt-0.5" size={18} />;
  return <Info className="text-slate-400 flex-shrink-0 mt-0.5" size={18} />;
}
