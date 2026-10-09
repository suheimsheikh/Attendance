/**
 * AddItemForm — inline "add item" row inside a category on the Masters
 * tree. Extracted from MealMastersTab.jsx on 25 Jun 2026 (pure move).
 */
import React, { useState } from "react";
import { Loader2, Check, CornerDownRight } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../../../api";

export default function AddItemForm({ catKey, units, onDone, onCancel }) {
  const [d, setD] = useState({ name: "", unit: "kg", opening_stock: "", opening_stock_as_of: "", opening_rate: "", min_stock: "", norm_per_serving: "" });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!d.name.trim()) { toast.error("Item name is required"); return; }
    setBusy(true);
    try {
      await api.post("/meals/items", {
        category_key: catKey,
        name: d.name.trim(),
        unit: d.unit,
        opening_stock: parseFloat(d.opening_stock) || 0,
        opening_rate: parseFloat(d.opening_rate) || 0,
        min_stock: parseFloat(d.min_stock) || 0,
        norm_per_serving: parseFloat(d.norm_per_serving) || 0,
        ...(d.opening_stock_as_of ? { opening_stock_as_of: d.opening_stock_as_of } : {}),
      });
      toast.success(`Added ${d.name.trim()}`);
      onDone();
    } catch (err) {
      showApiError(err, "Couldn't add item");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ml-10 my-1 flex items-center gap-2 flex-wrap bg-emerald-50/60 border border-emerald-200 rounded-lg px-3 py-2" data-testid={`masters-add-item-form-${catKey}`}>
      <CornerDownRight size={13} className="text-emerald-600 shrink-0"/>
      <input autoFocus placeholder="Item name" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })}
             onKeyDown={(e) => e.key === "Enter" && save()}
             className="iu-input !h-8 !w-40 text-sm" data-testid={`masters-add-item-name-${catKey}`}/>
      <select value={d.unit} onChange={(e) => setD({ ...d, unit: e.target.value })} className="iu-input !h-8 !w-auto text-sm" data-testid={`masters-add-item-unit-${catKey}`}>
        {units.map((u) => <option key={u} value={u}>{u}</option>)}
      </select>
      <input type="number" min="0" step="any" placeholder="Opening stock" value={d.opening_stock}
             onChange={(e) => setD({ ...d, opening_stock: e.target.value })}
             className="iu-input !h-8 !w-28 text-sm" data-testid={`masters-add-item-opening-${catKey}`}/>
      <input type="date" value={d.opening_stock_as_of} onChange={(e) => setD({ ...d, opening_stock_as_of: e.target.value })}
             className="iu-input !h-8 !w-auto text-sm" title="Opening stock as-of date (defaults to today)"/>
      <input type="number" min="0" step="any" placeholder="Opening ₹/unit" value={d.opening_rate}
             onChange={(e) => setD({ ...d, opening_rate: e.target.value })}
             className="iu-input !h-8 !w-28 text-sm" title="Cost per unit of the opening stock — values the opening stock before the first purchase (0 = unknown)" data-testid={`masters-add-item-openrate-${catKey}`}/>
      <input type="number" min="0" step="any" placeholder="Min level" value={d.min_stock}
             onChange={(e) => setD({ ...d, min_stock: e.target.value })}
             className="iu-input !h-8 !w-24 text-sm" title="Low-stock alert level (0 = off)" data-testid={`masters-add-item-min-${catKey}`}/>
      <input type="number" min="0" step="any" placeholder="Norm/serving" value={d.norm_per_serving}
             onChange={(e) => setD({ ...d, norm_per_serving: e.target.value })}
             className="iu-input !h-8 !w-28 text-sm" title="Expected quantity per meal serving — used by the Cross-check tab (0 = untracked)" data-testid={`masters-add-item-norm-${catKey}`}/>
      <button onClick={save} disabled={busy} className="iu-btn-primary !h-8 !px-3 text-xs" data-testid={`masters-add-item-save-${catKey}`}>
        {busy ? <Loader2 size={13} className="animate-spin"/> : <Check size={13}/>} Add
      </button>
      <button title="Close without saving" onClick={onCancel} className="iu-btn-secondary !h-8 !px-3 text-xs">Cancel</button>
    </div>
  );
}
