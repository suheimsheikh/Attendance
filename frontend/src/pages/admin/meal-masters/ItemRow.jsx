/**
 * ItemRow — one item line on the Masters tree: LOW pill, drag handle,
 * admin ops (move up/down, move category, sub-cat, rename, nutrition,
 * (de)activate, delete), inline-editable Unit / Opening / Min / Norm,
 * and read-only Purch / Issue / Close stats. Extracted from
 * MealMastersTab.jsx on 25 Jun 2026 (pure move).
 */
import React, { useState } from "react";
import {
  AlertTriangle, GripVertical, ArrowUp, ArrowDown, Pencil, Flame, Power, Trash2,
} from "lucide-react";
import { InlineEdit, InlineNum, InlineRate, InlineDate, InlineUnit } from "./InlineEditors";
import NutritionEditorModal from "./NutritionEditorModal";
import { fmt, fmtRs, UNIT_OPTIONS, COL_GRID } from "./helpers";

export default function ItemRow({ item, stock, cats, subcats = [], isAdmin, onPatch, onDelete, onOpen, onMoveUp, onMoveDown, canMoveUp, canMoveDown, dnd }) {
  const [renaming, setRenaming] = useState(false);
  const [editingNutrition, setEditingNutrition] = useState(false);
  const inactive = item.active === false;
  const showStock = !inactive && stock;
  return (
    <div
      className={`rounded-lg border ${dnd.over ? "border-emerald-400 bg-emerald-50/60" : "border-transparent"} ${inactive ? "opacity-60" : ""}`}
      draggable={isAdmin && !renaming}
      onDragStart={dnd.onDragStart}
      onDragOver={dnd.onDragOver}
      onDrop={dnd.onDrop}
      onDragEnd={dnd.onDragEnd}
      data-testid={`masters-item-${item.id}`}
    >
      {/* Indent moved from outer `ml-6` to inner `pl-8` (was `px-2`) so
          the item row occupies the SAME width as category / grand-total
          rows — otherwise the right-aligned stat grid ended 24px shy of
          the category grid, breaking column alignment (Feb 2026 fix). */}
      <div className="flex items-center gap-1.5 pl-8 pr-2 py-1.5 hover:bg-slate-200/70 rounded-lg group">
        {/* Extreme-left LOW pill — moved here from beside the item name so
            it's the first thing you scan and can spot restock candidates
            at a glance without reading the row. Fixed-width slot keeps the
            grid aligned even for items that aren't low. */}
        <span className="w-6 shrink-0 flex justify-center" data-testid={`masters-item-lowcell-${item.id}`}>
          {!inactive && stock?.low && (
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-rose-100 text-rose-600" title="Low stock — at or below the minimum level" data-testid={`masters-item-low-${item.id}`}>
              <AlertTriangle size={11}/>
            </span>
          )}
        </span>
        {isAdmin && <GripVertical size={13} className="text-slate-300 group-hover:text-slate-400 cursor-grab shrink-0"/>}
        {isAdmin && (
          <span className="flex items-center gap-0.5 shrink-0" data-testid={`masters-item-ops-${item.id}`}>
            <button
              onClick={onMoveUp}
              disabled={!canMoveUp}
              className="p-1 rounded hover:bg-white text-slate-500 disabled:opacity-30 disabled:cursor-not-allowed"
              title="Move up within this category"
              data-testid={`masters-item-up-${item.id}`}
            ><ArrowUp size={12}/></button>
            <button
              onClick={onMoveDown}
              disabled={!canMoveDown}
              className="p-1 rounded hover:bg-white text-slate-500 disabled:opacity-30 disabled:cursor-not-allowed"
              title="Move down within this category"
              data-testid={`masters-item-down-${item.id}`}
            ><ArrowDown size={12}/></button>
            <select
              value=""
              onChange={(e) => e.target.value && onPatch(item.id, { category_key: e.target.value })}
              className="iu-input !h-6 !w-auto !py-0 !px-1 text-[11px]"
              title="Move to another category"
              data-testid={`masters-item-move-${item.id}`}
            >
              <option value="">Move…</option>
              {cats.filter((c) => c.key !== item.category_key && c.active !== false).map((c) => (
                <option key={c.key} value={c.key}>{c.label}</option>
              ))}
            </select>
            {subcats.length > 0 && (
              <select
                value={item.subcategory_key || ""}
                onChange={(e) => onPatch(item.id, { subcategory_key: e.target.value })}
                className="iu-input !h-6 !w-auto !py-0 !px-1 text-[11px]"
                title="Assign to a sub-category"
                data-testid={`masters-item-subcat-${item.id}`}
              >
                <option value="">No sub-group</option>
                {subcats.map((s) => <option key={s.key} value={s.key}>{s.name}</option>)}
              </select>
            )}
            <button onClick={() => setRenaming(true)} className="p-1 rounded hover:bg-white text-slate-500" title="Rename" data-testid={`masters-item-rename-btn-${item.id}`}><Pencil size={12}/></button>
            <button
              onClick={() => setEditingNutrition(true)}
              className="p-1 rounded hover:bg-rose-50 text-rose-500"
              title="Edit nutrition (per 100 g)"
              data-testid={`masters-item-nutrition-${item.id}`}
            ><Flame size={12}/></button>
            <button
              onClick={() => onPatch(item.id, { active: inactive })}
              className={`p-1 rounded ${inactive ? "hover:bg-emerald-100 text-emerald-600" : "hover:bg-amber-100 text-amber-600"}`}
              title={inactive ? "Reactivate" : "Deactivate"}
              data-testid={`masters-item-toggle-${item.id}`}
            ><Power size={12}/></button>
            <button onClick={() => onDelete(item)} className="p-1 rounded hover:bg-rose-100 text-rose-500" title="Delete permanently — only allowed when the item has no purchases / issues / wastage. Use ⏻ (Deactivate) to hide items that already have data." data-testid={`masters-item-delete-${item.id}`}><Trash2 size={12}/></button>
          </span>
        )}
        <span className="w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0"/>
        {renaming ? (
          <InlineEdit
            value={item.name}
            testid={`masters-item-rename-${item.id}`}
            onSave={async (v) => { if (v && v !== item.name) await onPatch(item.id, { name: v }); setRenaming(false); }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <button onClick={() => onOpen(item.id)} className="font-semibold text-sm text-slate-900 hover:text-emerald-700 hover:underline underline-offset-2 text-left truncate flex-1 min-w-[9rem]" data-testid={`masters-item-open-${item.id}`} title={`View purchase / issue / wastage history for ${item.name}`}>
            {item.name}
          </button>
        )}
        {inactive && (
          <span className="text-[10px] font-bold uppercase text-rose-700 bg-rose-100 px-1.5 h-4 rounded inline-flex items-center">inactive</span>
        )}
        <span className={`ml-auto ${COL_GRID} text-[11px] tabular-nums items-center`} data-testid={`masters-item-stock-${item.id}`}>
          {/* Unit — inline editable */}
          {isAdmin ? (
            <InlineUnit
              value={item.unit}
              options={UNIT_OPTIONS}
              onSave={(u) => onPatch(item.id, { unit: u })}
              testid={`masters-item-unit-${item.id}`}
            />
          ) : (
            <span className="text-[10px] font-bold uppercase text-slate-500 text-center">{item.unit}</span>
          )}
          {/* Opening (editable qty + optional editable ₹/unit rate + as-of date) */}
          {isAdmin ? (
            <span className="flex flex-col">
              <InlineNum
                value={item.opening_stock || 0}
                unit={item.unit}
                onSave={(n) => onPatch(item.id, { opening_stock: n })}
                testid={`masters-item-opening-${item.id}`}
                hint={`Click to edit opening stock${item.opening_stock_as_of ? ` (as of ${item.opening_stock_as_of})` : ""}`}
              />
              {Number(item.opening_stock) > 0 && (
                <InlineRate
                  value={item.opening_rate || 0}
                  unit={item.unit}
                  onSave={(n) => onPatch(item.id, { opening_rate: n })}
                  testid={`masters-item-openrate-${item.id}`}
                />
              )}
              {Number(item.opening_stock) > 0 && (
                <InlineDate
                  value={item.opening_stock_as_of || ""}
                  onSave={(iso) => onPatch(item.id, { opening_stock_as_of: iso })}
                  testid={`masters-item-openasof-${item.id}`}
                />
              )}
            </span>
          ) : (
            <span className="flex flex-col text-right">
              <span className="font-semibold text-slate-700">{fmt(item.opening_stock || 0, item.unit)}</span>
              {Number(item.opening_stock) > 0 && Number(item.opening_rate) > 0 && (
                <span className="text-[9px] leading-tight text-emerald-700 tabular-nums">@{fmtRs(item.opening_rate)}/{item.unit}</span>
              )}
              {Number(item.opening_stock) > 0 && item.opening_stock_as_of && (
                <span className="text-[9px] leading-tight text-slate-500 tabular-nums">
                  as of {new Date(item.opening_stock_as_of + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                </span>
              )}
            </span>
          )}
          {/* Min level (editable qty) */}
          {isAdmin ? (
            <InlineNum
              value={item.min_stock || 0}
              unit={item.unit}
              onSave={(n) => onPatch(item.id, { min_stock: n })}
              testid={`masters-item-min-${item.id}`}
              hint="Click to edit low-stock alert level (0 = off)"
            />
          ) : (
            <span className="text-right text-slate-500">{fmt(item.min_stock || 0, item.unit)}</span>
          )}
          {/* Norm per serving (editable qty) — expected quantity of THIS
              item consumed per meal serving. Used by the Cross-check tab
              to compare expected vs actual issues. 0 = untracked. */}
          {isAdmin ? (
            <InlineNum
              value={item.norm_per_serving || 0}
              unit={item.unit}
              onSave={(n) => onPatch(item.id, { norm_per_serving: n })}
              testid={`masters-item-norm-${item.id}`}
              hint="Click to edit norm per serving (expected qty per meal — used by Cross-check)"
            />
          ) : (
            <span className="text-right text-slate-500">{fmt(item.norm_per_serving || 0, item.unit)}</span>
          )}
          {/* Purch qty + ₹ inline */}
          <span className="text-right whitespace-nowrap" title="Total purchases since opening date">
            {showStock ? (
              <>
                <span className="font-semibold text-slate-700">{fmt(stock.purchased, item.unit)}</span>
                <span className="text-[10px] text-emerald-700 font-medium ml-1.5">{fmtRs(stock.purchased_amount)}</span>
              </>
            ) : <span className="text-slate-300">—</span>}
          </span>
          {/* Issue qty + ₹ inline */}
          <span className="text-right whitespace-nowrap" title="Total kitchen issues since opening date">
            {showStock ? (
              <>
                <span className="font-semibold text-slate-700">{fmt(stock.issued, item.unit)}</span>
                <span className="text-[10px] text-amber-700 font-medium ml-1.5">{fmtRs(stock.issued_value)}</span>
              </>
            ) : <span className="text-slate-300">—</span>}
          </span>
          {/* Close qty + ₹ inline */}
          <span
            className="text-right whitespace-nowrap"
            title={showStock && stock.avg_rate ? `Valued at ₹${stock.avg_rate}/${item.unit} (weighted-avg cost)` : "Closing stock on hand"}
          >
            {showStock ? (
              <>
                <span className={`font-bold ${stock.low ? "text-rose-600" : "text-emerald-700"}`}>{fmt(stock.on_hand, item.unit)}</span>
                <span className={`text-[10px] font-medium ml-1.5 ${stock.low ? "text-rose-500" : "text-slate-600"}`}>{fmtRs(stock.on_hand_value)}</span>
              </>
            ) : <span className="text-slate-300">—</span>}
          </span>
        </span>
      </div>
      {editingNutrition && (
        <NutritionEditorModal
          item={item}
          onClose={() => setEditingNutrition(false)}
          onSave={async (nutrition) => {
            await onPatch(item.id, { nutrition });
            setEditingNutrition(false);
          }}
        />
      )}
    </div>
  );
}
