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
import { Loader2, RefreshCw, ShieldAlert, CheckCircle2, Wrench, Trash2, ClipboardList } from "lucide-react";
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

/** Render a context-sensitive "Fix" button for a finding. Two modes:
 *   - Auto-fix (`finding.auto_fix === true`): POST to
 *     `/admin/data-quality/fix/<code>` — safe bulk mutation with a
 *     confirm prompt. Toast reports the count, then the report
 *     refreshes.
 *   - Navigate (default): a plain <Link> to the appropriate edit page
 *     with the offender pre-highlighted.
 * Falls back to an em-dash when no automated jump target exists. */
function FixButton({ finding, onFixed }) {
  const fix = finding.fix;
  const [busy, setBusy] = React.useState(false);
  if (finding.auto_fix) {
    const trigger = async () => {
      if (busy) return;
      if (!window.confirm(`Auto-fix all "${finding.code}" issues in bulk? Deletions run immediately for a Super Admin, otherwise they are queued for Super Admin approval.`)) return;
      setBusy(true);
      try {
        const r = await api.post(`/admin/data-quality/fix/${finding.code}`);
        if (r?.queued) {
          toast.info(r.detail || "Queued for Super Admin approval", { duration: 8000 });
        } else {
          toast.success(`Fixed ${r?.fixed ?? 0} record${(r?.fixed ?? 0) === 1 ? "" : "s"}.`);
        }
        onFixed?.();
      } catch (err) {
        toast.error(err?.message || "Auto-fix failed");
      } finally { setBusy(false); }
    };
    return (
      <button
        type="button"
        onClick={trigger}
        disabled={busy}
        title="Run all data-quality checks now instead of waiting for the daily scan"
        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-600 text-white text-[11px] font-bold hover:bg-emerald-700 transition disabled:opacity-50"
        data-testid={`dq-autofix-${finding.code}`}
      >
        {busy ? <Loader2 size={11} className="animate-spin"/> : <Wrench size={11}/>}
        Fix all
      </button>
    );
  }
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

function AttendanceDedupePanel() {
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState(null);

  const runPreview = async () => {
    setLoading(true); setDone(null);
    try {
      const r = await api.get("/admin/tools/attendance-dedupe/preview");
      setPreview(r);
    } catch (e) {
      toast.error(e?.message || "Preview failed");
    } finally { setLoading(false); }
  };

  const runApply = async () => {
    if (!preview || preview.rows_to_remove === 0) return;
    if (!window.confirm(
      `Repair ${preview.days_affected} day(s) across ${preview.members_affected} member(s)?\n\n` +
      `This removes ${preview.rows_to_remove} extra same-day check-in row(s), keeps the first session, and recomputes hours + late.\n\n` +
      `Removed rows are archived (reversible) and audit-logged. Super Admin only.`
    )) return;
    setApplying(true);
    try {
      const r = await api.post("/admin/tools/attendance-dedupe/apply");
      setDone(r);
      toast.success(`Repaired — ${r.rows_removed} row(s) removed, ${r.kept_rows_fixed} session(s) fixed.`);
      await runPreview();
    } catch (e) {
      toast.error(/403/.test(e?.message || "") ? "Super Admin only — ask the Super Admin to run this." : (e?.message || "Apply failed"));
    } finally { setApplying(false); }
  };

  return (
    <div className="iu-card p-4 md:p-5 mb-6 border-2 border-amber-200 bg-amber-50/40" data-testid="dedupe-panel">
      <div className="flex items-start gap-2 mb-2">
        <Wrench size={18} className="text-amber-600 mt-0.5 shrink-0" />
        <div>
          <h2 className="text-base md:text-lg font-extrabold tracking-tight text-slate-800">Repair auto check-in duplicates</h2>
          <p className="text-sm text-slate-600 mt-0.5">
            Cleans up extra same-day check-ins left by the old auto check-in bug. Keeps the first
            session per day, carries the day's last check-out onto it, recomputes hours + late.
            Removed rows are archived and audit-logged. <span className="font-semibold">Preview is safe; Apply is Super-Admin only.</span>
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <button
          type="button" onClick={runPreview} disabled={loading || applying}
          data-testid="dedupe-preview-btn"
          className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-white border border-slate-300 text-slate-800 text-sm font-bold hover:bg-slate-100 transition disabled:opacity-60"
        >
          {loading ? <Loader2 size={15} className="animate-spin" /> : <ClipboardList size={15} />} Preview
        </button>
        {preview && preview.rows_to_remove > 0 && (
          <button
            type="button" onClick={runApply} disabled={applying || loading}
            data-testid="dedupe-apply-btn"
            className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-rose-600 text-white text-sm font-bold hover:bg-rose-700 transition disabled:opacity-60"
          >
            {applying ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />} Apply repair
          </button>
        )}
      </div>

      {preview && (
        <div className="mt-4" data-testid="dedupe-summary">
          <div className="grid grid-cols-3 gap-3 max-w-md">
            <div className="rounded-xl bg-white border border-slate-200 p-3">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 font-bold">Days affected</div>
              <div className="text-2xl font-extrabold tabular-nums text-slate-800">{preview.days_affected}</div>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-3">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 font-bold">Members</div>
              <div className="text-2xl font-extrabold tabular-nums text-slate-800">{preview.members_affected}</div>
            </div>
            <div className="rounded-xl bg-white border border-slate-200 p-3">
              <div className="text-[10px] uppercase tracking-wide text-slate-500 font-bold">Rows to remove</div>
              <div className="text-2xl font-extrabold tabular-nums text-rose-700">{preview.rows_to_remove}</div>
            </div>
          </div>
          {preview.rows_to_remove === 0 ? (
            <p className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-700">
              <CheckCircle2 size={15} /> All clean — every day has a single check-in.
            </p>
          ) : (
            <div className="mt-3 max-h-72 overflow-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500 sticky top-0">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-bold">Member</th>
                    <th className="px-3 py-2 font-bold">Date</th>
                    <th className="px-3 py-2 font-bold">Remove</th>
                    <th className="px-3 py-2 font-bold">Late</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.plan.slice(0, 300).map((p) => (
                    <tr key={p.keep_id} className="border-t border-slate-100" data-testid="dedupe-row">
                      <td className="px-3 py-1.5 font-semibold text-slate-800">{p.name}</td>
                      <td className="px-3 py-1.5 tabular-nums text-slate-600">{p.date}</td>
                      <td className="px-3 py-1.5 tabular-nums text-rose-700 font-bold">{p.remove_count}</td>
                      <td className="px-3 py-1.5">
                        {p.late_was !== p.late_now ? (
                          <span className="text-emerald-700 font-semibold">{p.late_was ? "LT→on-time" : "→LT"}</span>
                        ) : (
                          <span className="text-slate-400">{p.late_now ? "LT" : "—"}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.plan.length > 300 && (
                <div className="px-3 py-2 text-[11px] text-slate-500">Showing first 300 of {preview.plan.length} days.</div>
              )}
            </div>
          )}
          {done && (
            <p className="mt-2 text-sm font-semibold text-emerald-700" data-testid="dedupe-done">
              ✓ Removed {done.rows_removed}, fixed {done.kept_rows_fixed}. Archived to attendance_removed.
            </p>
          )}
        </div>
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

      <AttendanceDedupePanel />

      {/* Summary strip */}
      {data && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
          <button
            type="button"
            onClick={() => setSeverityFilter("all")}
            title="Show findings of every severity"
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
              title={`Show only ${sev}-severity findings`}
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
                    <td className="py-2 px-3"><FixButton finding={f} onFixed={load} /></td>
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
