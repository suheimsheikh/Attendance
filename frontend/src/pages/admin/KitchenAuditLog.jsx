import React, { useEffect, useMemo, useState } from "react";
import { api, showApiError } from "../../api";
import { formatDate } from "../../utils";
import { ScrollText, Loader2, RefreshCw, ChevronRight, ChevronDown, Plus, Minus, ArrowRight } from "lucide-react";

const ACTIONS = [
  { v: "", label: "All changes" },
  { v: "meals.purchase.save", label: "Purchase saved" },
  { v: "meals.purchase.edit", label: "Purchase edited" },
  { v: "meals.issue.save", label: "Issue saved" },
  { v: "meals.issue.edit", label: "Issue edited" },
  { v: "meals.wastage.save", label: "Wastage saved" },
  { v: "meals.wastage.edit", label: "Wastage edited" },
  { v: "meals.stocktake.save", label: "Stock-take" },
  { v: "meals.item.edit", label: "Item edited" },
  { v: "meals.item.delete", label: "Item deleted" },
];

const LABEL = {
  "meals.issue.save": ["Issue", "bg-sky-100 text-sky-700"],
  "meals.issue.edit": ["Issue", "bg-sky-100 text-sky-700"],
  "meals.purchase.save": ["Purchase", "bg-emerald-100 text-emerald-700"],
  "meals.purchase.edit": ["Purchase", "bg-emerald-100 text-emerald-700"],
  "meals.wastage.save": ["Wastage", "bg-amber-100 text-amber-700"],
  "meals.wastage.edit": ["Wastage", "bg-amber-100 text-amber-700"],
  "meals.stocktake.save": ["Stock-take", "bg-violet-100 text-violet-700"],
  "meals.item.edit": ["Item", "bg-slate-200 text-slate-700"],
  "meals.item.delete": ["Item", "bg-rose-100 text-rose-700"],
};

// Human labels + formatting for each change field.
const FIELD = {
  qty: "Qty", rate: "Rate", amount: "Amount", vendor_id: "Vendor",
  reason: "Reason", notes: "Note", on_hand: "On-hand", variance: "Variance",
  opening_stock: "Opening stock", opening_rate: "Opening rate",
  min_stock: "Min level", norm_per_serving: "Norm/serving",
  category_key: "Category", unit: "Unit", active: "Active",
  subcategory_key: "Sub-group", name: "Name", nutrition: "Nutrition",
};
const MONEY = new Set(["rate", "amount", "opening_rate"]);
const QTYF = new Set(["qty", "on_hand", "variance", "opening_stock", "min_stock", "norm_per_serving"]);

function fmtVal(field, v, unit) {
  if (v === null || v === undefined || v === "") return "—";
  if (field === "active") return v ? "Active" : "Inactive";
  if (field === "nutrition") return typeof v === "object" ? "custom" : String(v);
  if (MONEY.has(field)) return `₹${Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (QTYF.has(field)) return `${v}${unit ? " " + unit : ""}`;
  return String(v);
}

const TYPE_STYLE = {
  added:   { cls: "bg-emerald-100 text-emerald-700", Icon: Plus, word: "added" },
  removed: { cls: "bg-rose-100 text-rose-700",       Icon: Minus, word: "removed" },
  changed: { cls: "bg-sky-100 text-sky-700",         Icon: ArrowRight, word: "changed" },
  opening: { cls: "bg-violet-100 text-violet-700",   Icon: Plus, word: "opening set" },
};

function fmtWhen(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${formatDate(iso.slice(0, 10))} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function ChangeRow({ c }) {
  const ts = TYPE_STYLE[c.type] || TYPE_STYLE.changed;
  const fields = c.fields || {};
  const fieldKeys = Object.keys(fields);
  return (
    <div className="flex items-start gap-2 py-1 border-b border-slate-100 last:border-0" data-testid="audit-change-row">
      <span className={`inline-flex items-center gap-1 shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${ts.cls}`}>
        <ts.Icon size={10} /> {ts.word}
      </span>
      <span className="font-semibold text-slate-900 min-w-[7rem] shrink-0">{c.item}</span>
      <span className="text-slate-600 text-xs flex flex-wrap gap-x-3 gap-y-0.5">
        {fieldKeys.length === 0 ? (
          <span className="italic text-slate-400">no field detail</span>
        ) : fieldKeys.map((f) => {
          const { before, after } = fields[f] || {};
          return (
            <span key={f} className="tabular-nums">
              <span className="text-slate-400">{FIELD[f] || f}:</span>{" "}
              {c.type === "added" ? (
                <b className="text-emerald-700">{fmtVal(f, after, c.unit)}</b>
              ) : c.type === "removed" ? (
                <span>was <b className="text-rose-700">{fmtVal(f, before, c.unit)}</b></span>
              ) : (
                <>
                  <span className="text-slate-500 line-through">{fmtVal(f, before, c.unit)}</span>
                  {" → "}
                  <b className="text-slate-900">{fmtVal(f, after, c.unit)}</b>
                </>
              )}
            </span>
          );
        })}
      </span>
    </div>
  );
}

export default function KitchenAuditLog() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [expanded, setExpanded] = useState(() => new Set());

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

  const toggle = (id) => setExpanded((prev) => {
    const n = new Set(prev);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  const summary = useMemo(() => {
    const by = {};
    rows.forEach((r) => { const t = (LABEL[r.action] || ["Other"])[0]; by[t] = (by[t] || 0) + 1; });
    return by;
  }, [rows]);

  const changesOf = (r) => (r.meta && Array.isArray(r.meta.changes)) ? r.meta.changes : [];
  const countsLabel = (r) => {
    const cts = (r.meta && r.meta.counts) || {};
    const parts = [];
    if (cts.added) parts.push(`+${cts.added} added`);
    if (cts.changed) parts.push(`${cts.changed} changed`);
    if (cts.removed) parts.push(`−${cts.removed} removed`);
    return parts.join(" · ");
  };

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto" data-testid="kitchen-audit-log">
      <div className="flex items-center gap-2 mb-1">
        <ScrollText size={20} className="text-slate-700" />
        <h1 className="text-xl font-black text-slate-900">Kitchen Audit Log</h1>
      </div>
      <p className="text-xs text-slate-500 mb-4">Every change to kitchen data — purchases, consumption, wastage, stock-take and item masters — with exactly what changed, who did it and when. Click a row to see the item-by-item before → after detail. Newest first.</p>

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
                <th className="w-6 p-2"></th>
                <th className="text-left p-2">When</th>
                <th className="text-left p-2">Type</th>
                <th className="text-left p-2">What</th>
                <th className="text-left p-2">By</th>
                <th className="text-left p-2">Changes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const [lab, cls] = LABEL[r.action] || ["Change", "bg-slate-100 text-slate-600"];
                const changes = changesOf(r);
                const hasDetail = changes.length > 0;
                const isOpen = expanded.has(r.id);
                return (
                  <React.Fragment key={r.id}>
                    <tr
                      className={`border-t border-slate-100 hover:bg-slate-50 ${hasDetail ? "cursor-pointer" : ""}`}
                      onClick={() => hasDetail && toggle(r.id)}
                      data-testid={`audit-row-${r.id}`}
                    >
                      <td className="p-2 text-slate-400">
                        {hasDetail && (isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
                      </td>
                      <td className="p-2 whitespace-nowrap text-slate-600 tabular-nums">{fmtWhen(r.at)}</td>
                      <td className="p-2"><span className={`inline-flex px-1.5 py-0.5 rounded text-[11px] font-semibold ${cls}`}>{lab}</span></td>
                      <td className="p-2 font-semibold text-slate-900">{r.entity_name || r.entity_id}</td>
                      <td className="p-2 text-slate-600 whitespace-nowrap">{r.actor_name || "—"}</td>
                      <td className="p-2 text-slate-500 text-xs" data-testid={`audit-summary-${r.id}`}>
                        {hasDetail
                          ? (countsLabel(r) || `${changes.length} item${changes.length === 1 ? "" : "s"}`)
                          : <span className="text-slate-300">—</span>}
                      </td>
                    </tr>
                    {isOpen && hasDetail && (
                      <tr className="bg-slate-50/70" data-testid={`audit-detail-${r.id}`}>
                        <td></td>
                        <td colSpan={5} className="p-3">
                          <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                            {changes.map((c, idx) => <ChangeRow key={idx} c={c} />)}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
