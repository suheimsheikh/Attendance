import React, { useEffect, useMemo, useState } from "react";
import { api, showApiError } from "../../api";
import { formatDate } from "../../utils";
import { ScrollText, Loader2, RefreshCw } from "lucide-react";

const ACTIONS = [
  { v: "", label: "All changes" },
  { v: "meals.issue.save", label: "Issue saved" },
  { v: "meals.issue.edit", label: "Issue edited" },
  { v: "meals.purchase.save", label: "Purchase saved" },
  { v: "meals.purchase.edit", label: "Purchase edited" },
  { v: "meals.wastage.save", label: "Wastage saved" },
  { v: "meals.wastage.edit", label: "Wastage edited" },
  { v: "meals.stocktake.save", label: "Stock-take" },
];

const LABEL = {
  "meals.issue.save": ["Issue", "bg-sky-100 text-sky-700"],
  "meals.issue.edit": ["Issue", "bg-sky-100 text-sky-700"],
  "meals.purchase.save": ["Purchase", "bg-emerald-100 text-emerald-700"],
  "meals.purchase.edit": ["Purchase", "bg-emerald-100 text-emerald-700"],
  "meals.wastage.save": ["Wastage", "bg-amber-100 text-amber-700"],
  "meals.wastage.edit": ["Wastage", "bg-amber-100 text-amber-700"],
  "meals.stocktake.save": ["Stock-take", "bg-violet-100 text-violet-700"],
};

function fmtWhen(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${formatDate(iso.slice(0, 10))} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

export default function KitchenAuditLog() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");

  const load = () => {
    setLoading(true);
    const p = new URLSearchParams();
    if (action) p.set("action", action);
    if (since) p.set("since", since);
    if (until) p.set("until", until);
    p.set("limit", "500");
    api.get(`/meals/audit-log?${p.toString()}`)
      .then((r) => setRows(r.rows || []))
      .catch((e) => showApiError(e, "Couldn't load the audit log"))
      .finally(() => setLoading(false));
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [action, since, until]);

  const summary = useMemo(() => {
    const by = {};
    rows.forEach((r) => { const t = (LABEL[r.action] || ["Other"])[0]; by[t] = (by[t] || 0) + 1; });
    return by;
  }, [rows]);

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto" data-testid="kitchen-audit-log">
      <div className="flex items-center gap-2 mb-1">
        <ScrollText size={20} className="text-slate-700" />
        <h1 className="text-xl font-black text-slate-900">Kitchen Audit Log</h1>
      </div>
      <p className="text-xs text-slate-500 mb-4">Every change to kitchen data — purchases, consumption, wastage and stock-take — with who did it and when. Newest first.</p>

      <div className="flex flex-wrap items-end gap-2 mb-3">
        <label className="text-xs text-slate-500 flex flex-col gap-1">Type
          <select value={action} onChange={(e) => setAction(e.target.value)} className="iu-input !h-8 text-sm !w-44" data-testid="audit-filter-action">
            {ACTIONS.map((a) => <option key={a.v} value={a.v}>{a.label}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-500 flex flex-col gap-1">From
          <input type="date" value={since} onChange={(e) => setSince(e.target.value)} className="iu-input !h-8 text-sm" data-testid="audit-filter-since" />
        </label>
        <label className="text-xs text-slate-500 flex flex-col gap-1">To
          <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} className="iu-input !h-8 text-sm" data-testid="audit-filter-until" />
        </label>
        <button onClick={load} className="iu-btn-secondary !h-8 !px-3 text-sm inline-flex items-center gap-1" data-testid="audit-refresh">
          <RefreshCw size={13} /> Refresh
        </button>
        <div className="ml-auto text-xs text-slate-500 self-center" data-testid="audit-count">
          {rows.length} change{rows.length === 1 ? "" : "s"}
          {Object.keys(summary).length > 0 && ` · ${Object.entries(summary).map(([k, v]) => `${v} ${k}`).join(" · ")}`}
        </div>
      </div>

      <div className="iu-card overflow-hidden">
        {loading ? (
          <div className="p-10 text-center text-slate-400"><Loader2 className="animate-spin inline" size={18} /></div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-slate-400" data-testid="audit-empty">No changes recorded for this filter yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="text-left p-2">When</th>
                <th className="text-left p-2">Type</th>
                <th className="text-left p-2">What</th>
                <th className="text-left p-2">By</th>
                <th className="text-left p-2">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const [lab, cls] = LABEL[r.action] || ["Change", "bg-slate-100 text-slate-600"];
                const meta = r.meta || {};
                const metaStr = Object.entries(meta).map(([k, v]) => `${k}: ${v}`).join(", ");
                return (
                  <tr key={r.id} className="border-t border-slate-100 hover:bg-slate-50" data-testid={`audit-row-${r.id}`}>
                    <td className="p-2 whitespace-nowrap text-slate-600 tabular-nums">{fmtWhen(r.at)}</td>
                    <td className="p-2"><span className={`inline-flex px-1.5 py-0.5 rounded text-[11px] font-semibold ${cls}`}>{lab}</span></td>
                    <td className="p-2 font-semibold text-slate-900">{r.entity_name || r.entity_id}</td>
                    <td className="p-2 text-slate-600">{r.actor_name || "—"}</td>
                    <td className="p-2 text-slate-500 text-xs">{metaStr || (r.changes ? `${Object.keys(r.changes).length} field(s) changed` : "—")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
