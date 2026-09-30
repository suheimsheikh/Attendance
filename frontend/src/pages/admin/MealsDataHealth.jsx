import React, { useEffect, useState } from "react";
import { api, showApiError } from "../../api";
import { toast } from "sonner";
import { HeartPulse, Loader2, AlertTriangle, PackageX, TrendingDown, RefreshCw, IndianRupee, Wrench, Check, X } from "lucide-react";

function Card({ icon: Icon, tint, label, value, hint }) {
  return (
    <div className={`iu-card p-4 flex items-center gap-3 ${tint}`}>
      <div className="w-10 h-10 rounded-lg bg-white/70 flex items-center justify-center shrink-0"><Icon size={18} /></div>
      <div>
        <div className="text-2xl font-black tabular-nums">{value}</div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
        <div className="text-[11px] text-slate-500">{hint}</div>
      </div>
    </div>
  );
}

// Plain read-only list (no_stock / low).
function ItemList({ title, items, note, testid }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="iu-card overflow-hidden" data-testid={testid}>
      <div className="px-3 py-2 bg-slate-50 border-b border-slate-100">
        <div className="font-bold text-sm text-slate-800">{title} <span className="text-slate-400 font-normal">({items.length})</span></div>
        {note && <div className="text-[11px] text-slate-500">{note}</div>}
      </div>
      <table className="w-full text-sm">
        <thead className="text-[11px] uppercase text-slate-400">
          <tr><th className="text-left p-2">Item</th><th className="text-left p-2">Category</th><th className="text-right p-2">On hand</th></tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.item_id} className="border-t border-slate-100">
              <td className="p-2 font-semibold text-slate-900">{it.name}</td>
              <td className="p-2 text-slate-500">{it.category}</td>
              <td className={`p-2 text-right tabular-nums font-bold ${(it.on_hand || 0) < 0 ? "text-rose-600" : "text-slate-700"}`}>{it.on_hand}{it.unit}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// One fixable row — expands to an inline "set opening balance as of today"
// editor that resets the item's baseline (prior movements are excluded once
// opening_stock_as_of = today), correcting the qty and/or attaching a rate.
function FixRow({ it, mode, asOf, onSaved }) {
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState("");
  const [rate, setRate] = useState("");
  const [saving, setSaving] = useState(false);

  const start = () => {
    // Negative → default the corrected count to 0 (admin adjusts). Rate-only →
    // keep the current on-hand quantity, just attach a cost.
    setQty(mode === "negative" ? "0" : String(it.on_hand ?? ""));
    setRate(String(it.opening_rate || it.suggested_rate || ""));
    setOpen(true);
  };

  const save = async () => {
    const q = Number(qty);
    const r = Number(rate);
    if (!isFinite(q) || q < 0) { toast.error("Enter a valid quantity (0 or more)."); return; }
    if (rate !== "" && (!isFinite(r) || r < 0)) { toast.error("Enter a valid ₹/unit rate."); return; }
    if (mode === "rate" && !(r > 0)) { toast.error("Enter a ₹/unit rate greater than 0."); return; }
    setSaving(true);
    try {
      const body = { opening_stock: q, opening_stock_as_of: asOf };
      if (rate !== "") body.opening_rate = r;
      await api.patch(`/meals/items/${it.item_id}`, body);
      toast.success(`${it.name} — opening balance set (${q}${it.unit || ""}${rate !== "" ? ` @ ₹${r}` : ""})`);
      setOpen(false);
      onSaved();
    } catch (e) {
      showApiError(e, `Couldn't fix ${it.name}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <tr className="border-t border-slate-100" data-testid={`fix-row-${it.item_id}`}>
        <td className="p-2 font-semibold text-slate-900">{it.name}</td>
        <td className="p-2 text-slate-500">{it.category}</td>
        <td className={`p-2 text-right tabular-nums font-bold ${(it.on_hand || 0) < 0 ? "text-rose-600" : "text-slate-700"}`}>{it.on_hand}{it.unit}</td>
        <td className="p-2 text-right tabular-nums text-slate-500">
          {mode === "rate"
            ? (it.suggested_rate > 0 ? <span title="Last purchase rate">₹{it.suggested_rate}</span> : <span className="text-rose-500">no rate</span>)
            : (it.opening_rate > 0 ? `₹${it.opening_rate}` : "—")}
        </td>
        <td className="p-2 text-right">
          {!open && (
            <button onClick={start} className="iu-btn-secondary !h-7 !px-2 text-xs inline-flex items-center gap-1" data-testid={`fix-btn-${it.item_id}`}>
              <Wrench size={12} /> Fix
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="bg-sky-50/50 border-t border-sky-100" data-testid={`fix-editor-${it.item_id}`}>
          <td colSpan={5} className="p-3">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wide text-slate-500 mb-1">Correct on-hand ({it.unit || "qty"})</label>
                <input type="number" min="0" step="0.01" value={qty} onChange={(e) => setQty(e.target.value)}
                       className="iu-input !h-8 text-sm w-28 text-right tabular-nums" data-testid={`fix-qty-${it.item_id}`} />
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wide text-slate-500 mb-1">₹/unit rate {mode === "rate" && <span className="text-rose-500">*</span>}</label>
                <div className="flex items-center gap-1">
                  <input type="number" min="0" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} placeholder="0.00"
                         className="iu-input !h-8 text-sm w-28 text-right tabular-nums" data-testid={`fix-rate-${it.item_id}`} />
                  {it.suggested_rate > 0 && (
                    <button type="button" onClick={() => setRate(String(it.suggested_rate))}
                            className="text-[10px] font-semibold text-violet-600 hover:underline" title="Use last purchase rate"
                            data-testid={`fix-use-rate-${it.item_id}`}>use ₹{it.suggested_rate}</button>
                  )}
                </div>
              </div>
              <div className="text-[11px] text-slate-500 max-w-xs">
                Sets a valued opening balance as of <b>{asOf}</b>. Earlier movements stop affecting this item's stock, so the count &amp; value start clean from today.
              </div>
              <div className="ml-auto flex items-center gap-2">
                <button onClick={() => setOpen(false)} className="iu-btn-secondary !h-8 !px-3 text-xs inline-flex items-center gap-1" data-testid={`fix-cancel-${it.item_id}`}><X size={13} /> Cancel</button>
                <button onClick={save} disabled={saving} className="iu-btn-primary !h-8 !px-3 text-xs inline-flex items-center gap-1 disabled:opacity-50" data-testid={`fix-save-${it.item_id}`}>
                  {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Save
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function FixableList({ title, items, note, testid, mode, asOf, onSaved }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="iu-card overflow-hidden" data-testid={testid}>
      <div className="px-3 py-2 bg-slate-50 border-b border-slate-100">
        <div className="font-bold text-sm text-slate-800">{title} <span className="text-slate-400 font-normal">({items.length})</span></div>
        {note && <div className="text-[11px] text-slate-500">{note}</div>}
      </div>
      <table className="w-full text-sm">
        <thead className="text-[11px] uppercase text-slate-400">
          <tr>
            <th className="text-left p-2">Item</th>
            <th className="text-left p-2">Category</th>
            <th className="text-right p-2">On hand</th>
            <th className="text-right p-2">{mode === "rate" ? "Suggested ₹" : "Rate"}</th>
            <th className="text-right p-2"></th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => <FixRow key={it.item_id} it={it} mode={mode} asOf={asOf} onSaved={onSaved} />)}
        </tbody>
      </table>
    </div>
  );
}

export default function MealsDataHealth() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api.get("/meals/data-health")
      .then(setData)
      .catch((e) => showApiError(e, "Couldn't load data health"))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const c = data?.counts || {};
  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto" data-testid="meals-data-health">
      <div className="flex items-center gap-2 mb-1">
        <HeartPulse size={20} className="text-slate-700" />
        <h1 className="text-xl font-black text-slate-900">Kitchen Data Health</h1>
        <button onClick={load} className="iu-btn-secondary !h-7 !px-2 text-xs ml-auto inline-flex items-center gap-1" data-testid="health-refresh"><RefreshCw size={12} /> Refresh</button>
      </div>
      <p className="text-xs text-slate-500 mb-4">Items that need attention so stock stays accurate and issuing never gets blocked.{data?.as_of ? ` As of ${data.as_of}.` : ""}</p>

      {loading ? (
        <div className="p-10 text-center text-slate-400"><Loader2 className="animate-spin inline" size={18} /></div>
      ) : !data ? null : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
            <Card icon={AlertTriangle} tint="bg-rose-50" label="Negative stock" value={c.negative_stock ?? 0} hint="Issued/wasted more than received — fix the count" />
            <Card icon={IndianRupee} tint="bg-violet-50" label="Needs a rate" value={c.needs_rate ?? 0} hint="Has stock but no ₹/unit cost — can't be valued" />
            <Card icon={PackageX} tint="bg-amber-50" label="No stock tracked" value={c.no_stock_untracked ?? 0} hint="No opening & no purchase — issuing is blocked" />
            <Card icon={TrendingDown} tint="bg-sky-50" label="Low stock" value={c.low_stock ?? 0} hint="At or below the item's minimum level" />
          </div>

          {(c.negative_stock || 0) + (c.no_stock_untracked || 0) + (c.needs_rate || 0) === 0 && (
            <div className="iu-card p-6 text-center text-emerald-700 bg-emerald-50 mb-4" data-testid="health-all-good">
              ✓ No blocking issues — every item can be issued and valued.
            </div>
          )}

          <div className="space-y-4">
            <FixableList testid="health-negative" title="Negative stock" mode="negative" asOf={data.as_of} onSaved={load}
                         note="Over-issued in the past. Enter the correct physical count (and rate if known) to reset the balance from today."
                         items={data.negative_stock} />
            <FixableList testid="health-needs-rate" title="Needs a cost rate" mode="rate" asOf={data.as_of} onSaved={load}
                         note="These items have stock on hand but no ₹/unit cost, so their value and loss/gain can't be computed. Set a rate — the current quantity is kept."
                         items={data.needs_rate} />
            <ItemList testid="health-untracked" title="No stock tracked" note="Enter opening stock (Stock Master → item → Opening stock) or record a purchase before issuing." items={data.no_stock_untracked} />
            <ItemList testid="health-low" title="Low stock" note="Below the minimum level — consider restocking." items={data.low_stock} />
          </div>
        </>
      )}
    </div>
  );
}
