/**
 * ShoppingListPanel — reorder suggestions shown at the top of the
 * Masters tree: low items + items running out at their recent pace.
 */
import React, { useState } from "react";
import { ShoppingCart, ChevronDown, ChevronRight, Copy, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 3 }));

export default function ShoppingListPanel({ data }) {
  const [open, setOpen] = useState(false);
  const items = data?.items || [];
  if (items.length === 0) return null;

  const copyList = async () => {
    const lines = items.map((i) => `• ${i.name}: buy ${fmt(i.suggested_qty)} ${i.unit} (${fmt(i.on_hand)} on hand)`);
    try {
      await navigator.clipboard.writeText(`Pantry shopping list — ${new Date().toLocaleDateString("en-IN")}\n${lines.join("\n")}`);
      toast.success("Shopping list copied");
    } catch {
      toast.error("Couldn't copy — your browser blocked clipboard access");
    }
  };

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50/70 mb-4 overflow-hidden" data-testid="shopping-list-panel">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-amber-100/60"
        title="Items to buy, based on low stock and the last 30 days' consumption pace"
        data-testid="shopping-list-toggle"
      >
        {open ? <ChevronDown size={15} className="text-amber-700"/> : <ChevronRight size={15} className="text-amber-700"/>}
        <ShoppingCart size={16} className="text-amber-700"/>
        <span className="font-bold text-sm text-amber-900">Suggested shopping list</span>
        <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-amber-600 text-white text-[11px] font-bold" data-testid="shopping-list-count">
          {items.length}
        </span>
        <span className="ml-auto text-[11px] text-amber-700">covers next {data.horizon_days} days · pace from last {data.window_days} days</span>
      </button>
      {open && (
        <div className="px-4 pb-4">
          <table className="w-full text-sm" data-testid="shopping-list-table">
            <thead className="text-[11px] uppercase text-amber-800/70">
              <tr>
                <th className="text-left p-1.5">Item</th>
                <th className="text-right p-1.5" title="Current stock on hand">On hand</th>
                <th className="text-right p-1.5" title="Average daily consumption (issues + wastage, last 30 days)">Pace/day</th>
                <th className="text-right p-1.5" title="Days until stock runs out at the current pace">Days left</th>
                <th className="text-right p-1.5" title="Suggested purchase to cover the next 2 weeks plus the min level">Buy</th>
                <th className="text-left p-1.5">Why</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.item_id} className="border-t border-amber-200/60" data-testid={`shopping-row-${i.item_id}`}>
                  <td className="p-1.5 font-semibold text-slate-900">{i.name} <span className="text-[10px] text-slate-400">{i.category_label}</span></td>
                  <td className={`p-1.5 text-right tabular-nums ${i.low ? "text-rose-600 font-bold" : "text-slate-700"}`}>{fmt(i.on_hand)} {i.unit}</td>
                  <td className="p-1.5 text-right tabular-nums text-slate-600">{i.daily_rate > 0 ? `${fmt(i.daily_rate)} ${i.unit}` : "—"}</td>
                  <td className={`p-1.5 text-right tabular-nums font-semibold ${i.days_left != null && i.days_left <= 3 ? "text-rose-600" : "text-slate-700"}`}>
                    {i.days_left != null ? `~${fmt(i.days_left)}` : "—"}
                  </td>
                  <td className="p-1.5 text-right tabular-nums font-extrabold text-emerald-800" data-testid={`shopping-buy-${i.item_id}`}>{fmt(i.suggested_qty)} {i.unit}</td>
                  <td className="p-1.5">
                    {i.reasons.map((r, idx) => (
                      <span key={idx} className="inline-flex items-center gap-0.5 text-[10px] font-bold text-amber-800 bg-amber-100 border border-amber-200 rounded px-1.5 py-0.5 mr-1">
                        <AlertTriangle size={9}/> {r}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button onClick={copyList} className="iu-btn-secondary !h-8 !px-3 text-xs mt-3" title="Copy the list as plain text to paste into WhatsApp or a note" data-testid="shopping-list-copy">
            <Copy size={12}/> Copy list
          </button>
        </div>
      )}
    </div>
  );
}
