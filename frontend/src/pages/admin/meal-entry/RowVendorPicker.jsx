import React from "react";
import { Store } from "lucide-react";

/**
 * Per-row Supplier picker — visible column on the Daily-entry grid
 * (Feb 2026 user request: "modify to enter a supplier which carries
 * over for all items thereafter but with the facility to change the
 * supplier for a given item").
 *
 * Behaviour:
 *   • Every row shows a full inline <select> so the chef can pick or
 *     change the supplier without extra clicks or menus.
 *   • Whichever supplier is picked becomes the "sticky last-used"
 *     default that auto-fills the vendor of any BLANK row the chef
 *     touches next (existing rows are left alone).
 *
 * Extracted from MealEntryTab.jsx on 25 Jun 2026 (pure move).
 */
export default function RowVendorPicker({ rowVendorId, vendors, onChange, onAddNew, onArrowRight, onArrowUp, onArrowDown, onOpenScorecard, testid }) {
  const selected = vendors.find((v) => v.id === rowVendorId);
  return (
    <div className="flex items-center gap-1">
      <select
        value={rowVendorId || ""}
        onChange={(ev) => {
          const v = ev.target.value;
          if (v === "__add__") { onAddNew(); return; }
          onChange(v);
        }}
        onKeyDown={(ev) => {
          // Arrow keys navigate BETWEEN cells rather than cycling
          // options — matches the spreadsheet muscle memory the chefs
          // already have from the numeric cells. Space, click and
          // first-letter type still open the dropdown for picking.
          if (ev.key === "ArrowRight") { ev.preventDefault(); onArrowRight?.(); }
          else if (ev.key === "ArrowUp") { ev.preventDefault(); onArrowUp?.(); }
          else if (ev.key === "ArrowDown") { ev.preventDefault(); onArrowDown?.(); }
        }}
        className={`iu-input !h-8 !px-2 text-xs flex-1 min-w-0 text-slate-700 ${rowVendorId ? "font-semibold" : "text-slate-400"}`}
        data-testid={testid}
        title="Supplier for this item on this day. Click or press Space to pick; arrow keys move between cells."
      >
        <option value="">— pick supplier —</option>
        {vendors.map((v) => (
          <option key={v.id} value={v.id}>{v.name}</option>
        ))}
        <option value="__add__">＋ Add new vendor…</option>
      </select>
      {selected && (
        <button
          type="button"
          onClick={(ev) => { ev.stopPropagation(); onOpenScorecard(selected); }}
          title={`Vendor scorecard · ${selected.name}`}
          className="shrink-0 p-1 rounded text-emerald-600 hover:bg-emerald-100 transition"
          data-testid={`${testid}-scorecard-btn`}
        >
          <Store size={13}/>
        </button>
      )}
    </div>
  );
}
