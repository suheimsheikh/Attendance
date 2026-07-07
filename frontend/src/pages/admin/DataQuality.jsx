/**
 * DataQuality — one-shot admin scan for bad / missing / duplicate data.
 *
 * Renders findings grouped by category with a colour-coded severity
 * badge and a member-linked "affected entities" cell. Two goals:
 *   1. Give admins a pre-launch clean-up checklist.
 *   2. Give admins a post-launch monitoring dashboard so silent data
 *      drift (say, someone typing a 9-digit mobile) surfaces fast.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, ShieldAlert, CheckCircle2, Wrench } from "lucide-react";
import { toast } from "sonner";
import { Link } from "react-router-dom";
import { api } from "../../api";

const SEVERITY_STYLES = {
  high:   { bg: "bg-red-100",     text: "text-red-800",     ring: "ring-red-200",     dot: "bg-red-500" },
  medium: { bg: "bg-amber-100",   text: "text-amber-800",   ring: "ring-amber-200",   dot: "bg-amber-500" },
  low:    { bg: "bg-sky-100",     text: "text-sky-700",     ring: "ring-sky-200",     dot: "bg-sky-500" },
  info:   { bg: "bg-slate-100",   text: "text-slate-600",   ring: "ring-slate-200",   dot: "bg-slate-400" },
};

function SeverityBadge({ severity }) {
  const s = SEVERITY_STYLES[severity] || SEVERITY_STYLES.info;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide ring-1 ${s.bg} ${s.text} ${s.ring}`}
      data-testid={`dq-badge-${severity}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {severity}
    </span>
  );
}

/** Render a context-sensitive "Fix" button for a finding, if the
 * backend attached a `fix` action (route + params). Falls back to
 * an em-dash when no automated jump target exists (e.g. review-only
 * findings like session-open-too-long which need human judgement). */
function FixButton({ finding }) {
  const fix = finding.fix;
  if (!fix) return <span className="text-slate-300">—</span>;
  const qs = new URLSearchParams(fix.params || {}).toString();
  const to = qs ? `${fix.to}?${qs}` : fix.to;
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-slate-900 text-white text-[11px] font-bold hover:bg-slate-700 transition"
      data-testid={`dq-fix-${finding.code}`}
    >
      <Wrench size={11} />
      {fix.label}
    </Link>
  );
}

function EntityRefs({ f }) {
  const type = f.entity_type;
  const ids = f.entity_ids || [];
  const names = f.entity_names || [];
  const shown = ids.slice(0, 5);
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((id, i) => {
        const name = names[i] || id;
        // Members are the only entity type we currently deep-link into.
        const href = type === "member" ? `/admin/members?highlight=${id}` : null;
        return href ? (
          <Link
            key={id}
            to={href}
            className="inline-flex px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-medium"
          >
            {name}
          </Link>
        ) : (
          <span key={id} className="inline-flex px-2 py-0.5 rounded bg-slate-100 text-slate-700 text-[11px] font-medium">
            {name}
          </span>
        );
      })}
      {ids.length > shown.length && (
        <span className="text-[11px] text-slate-400 self-center">+{ids.length - shown.length}</span>
      )}
    </div>
  );
}

export default function DataQuality() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [severityFilter, setSeverityFilter] = useState("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get("/admin/data-quality");
      setData(r);
    } catch (err) {
      toast.error(err?.message || "Load failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    if (!data) return [];
    if (severityFilter === "all") return data.findings;
    return data.findings.filter((f) => f.severity === severityFilter);
  }, [data, severityFilter]);

  const grouped = useMemo(() => {
    const g = {};
    for (const f of filtered) {
      const cat = f.category || "Other";
      if (!g[cat]) g[cat] = [];
      g[cat].push(f);
    }
    return g;
  }, [filtered]);

  return (
    <div className="p-4 md:p-8">
      <div className="mb-6 flex items-center gap-2">
        <ShieldAlert size={20} className="text-slate-500" />
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Data Quality</h1>
      </div>

      {/* Summary strip */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
          <button
            type="button"
            onClick={() => setSeverityFilter("all")}
            className={`iu-card p-3 text-left transition ${severityFilter === "all" ? "ring-2 ring-slate-800" : ""}`}
            data-testid="dq-total"
          >
            <div className="text-[10px] uppercase tracking-wide text-slate-500 font-bold">Total findings</div>
            <div className="text-2xl font-extrabold tabular-nums text-slate-800">{data.total_findings}</div>
          </button>
          {["high", "medium", "low", "info"].map((sev) => (
            <button
              type="button"
              key={sev}
              onClick={() => setSeverityFilter(sev)}
              className={`iu-card p-3 text-left transition ${severityFilter === sev ? "ring-2 ring-slate-800" : ""}`}
              data-testid={`dq-count-${sev}`}
            >
              <div className="text-[10px] uppercase tracking-wide text-slate-500 font-bold flex items-center gap-1">
                <span className={`w-1.5 h-1.5 rounded-full ${SEVERITY_STYLES[sev].dot}`} />
                {sev}
              </div>
              <div className="text-2xl font-extrabold tabular-nums text-slate-800">
                {(data.by_severity || {})[sev] || 0}
              </div>
            </button>
          ))}
        </div>
      )}

      <div className="mb-4 flex items-center gap-3">
        <button
          data-testid="dq-refresh"
          onClick={load}
          disabled={loading}
          className="iu-btn-primary"
        >
          {loading ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}
          Re-scan
        </button>
        {data && (
          <span className="text-xs text-slate-500">
            Generated {new Date(data.generated_at).toLocaleString()}
          </span>
        )}
      </div>

      {/* Findings, grouped by category */}
      {data && data.total_findings === 0 && (
        <div className="iu-card p-10 text-center">
          <CheckCircle2 size={40} className="mx-auto text-emerald-500 mb-3" />
          <h2 className="text-xl font-bold text-slate-800">All clean 🎉</h2>
          <p className="text-sm text-slate-500 mt-1">
            No data-quality issues found in the current sweep.
          </p>
        </div>
      )}

      {Object.entries(grouped).map(([category, items]) => (
        <div key={category} className="mb-6" data-testid={`dq-group-${category.toLowerCase().replace(/\s+/g, "-")}`}>
          <h2 className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-2">
            {category} <span className="text-slate-400">({items.length})</span>
          </h2>
          <div className="iu-card overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr className="text-[10px] uppercase tracking-wider font-bold text-slate-500">
                  <th className="py-2 px-3 text-left w-24">Severity</th>
                  <th className="py-2 px-3 text-left">Issue</th>
                  <th className="py-2 px-3 text-left">Affected</th>
                  <th className="py-2 px-3 text-left w-32">Fix</th>
                  <th className="py-2 px-3 text-left w-40 font-mono text-[10px] normal-case">Code</th>
                </tr>
              </thead>
              <tbody>
                {items.map((f, i) => (
                  <tr key={`${f.code}-${i}`} className="border-t border-slate-100 hover:bg-slate-50 align-top">
                    <td className="py-2 px-3"><SeverityBadge severity={f.severity} /></td>
                    <td className="py-2 px-3 text-slate-800">{f.message}</td>
                    <td className="py-2 px-3"><EntityRefs f={f} /></td>
                    <td className="py-2 px-3"><FixButton finding={f} /></td>
                    <td className="py-2 px-3 font-mono text-[10px] text-slate-400">{f.code}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
