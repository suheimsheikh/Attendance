/**
 * NutritionEditorModal — per-item nutrition (per 100 g) editor. Extracted
 * from MealMastersTab.jsx on 25 Jun 2026 (pure move).
 */
import React, { useState } from "react";
import { useEscape } from "../../../hooks/useEscape";
import { createPortal } from "react-dom";
import { Flame } from "lucide-react";

export default function NutritionEditorModal({ item, onClose, onSave }) {
  useEscape(onClose);
  const initial = item.nutrition || {};
  const [d, setD] = useState({
    kcal:          initial.kcal ?? "",
    protein_g:     initial.protein_g ?? "",
    carbs_g:       initial.carbs_g ?? "",
    fat_g:         initial.fat_g ?? "",
    fibre_g:       initial.fibre_g ?? "",
    grams_per_unit: initial.grams_per_unit ?? "",
  });
  const [saving, setSaving] = useState(false);
  const fields = [
    { k: "kcal",           label: "Calories (kcal / 100 g)", hint: "e.g. 355 for rice" },
    { k: "protein_g",      label: "Protein (g / 100 g)",     hint: "e.g. 22 for toor dal" },
    { k: "carbs_g",        label: "Carbs (g / 100 g)",       hint: "e.g. 78 for rice" },
    { k: "fat_g",          label: "Fat (g / 100 g)",         hint: "e.g. 100 for oil" },
    { k: "fibre_g",        label: "Fibre (g / 100 g)",       hint: "e.g. 11 for atta" },
    { k: "grams_per_unit", label: "Grams per unit",          hint: "Fill only when unit is pcs / packet / bunch. Weight/volume units auto-convert." },
  ];
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const submit = async (e) => {
    e.preventDefault();
    const out = {};
    fields.forEach((f) => {
      const n = num(d[f.k]);
      if (n != null && d[f.k] !== "") out[f.k] = n;
    });
    setSaving(true);
    try { await onSave(Object.keys(out).length ? out : null); }
    finally { setSaving(false); }
  };
  return createPortal(
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose} data-testid={`nutrition-modal-${item.id}`}>
      <div className="bg-white rounded-xl max-w-md w-full p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-2">
          <Flame size={18} className="text-rose-500" />
          <h3 className="font-extrabold text-lg">Nutrition — {item.name}</h3>
        </div>
        <p className="text-xs text-slate-500 mb-3">Values are per <b>100 g</b>. Leave blank to use the built-in lookup (matched by item name).</p>
        <form onSubmit={submit} className="space-y-2">
          {fields.map((f) => (
            <div key={f.k} className="grid grid-cols-2 gap-2 items-center">
              <label className="text-xs font-semibold text-slate-700" title={f.hint}>{f.label}</label>
              <input
                type="number" min="0" step="any"
                value={d[f.k]}
                onChange={(e) => setD({ ...d, [f.k]: e.target.value })}
                placeholder={f.hint}
                className="iu-input !h-8 text-sm"
                data-testid={`nutrition-field-${f.k}`}
              />
            </div>
          ))}
          <div className="flex justify-end gap-2 pt-3">
            <button title="Close without saving" type="button" onClick={onClose} className="iu-btn-secondary !h-8 text-sm" data-testid="nutrition-cancel">Cancel</button>
            <button type="submit" disabled={saving} className="iu-btn-primary !h-8 text-sm" data-testid="nutrition-save">{saving ? "Saving…" : "Save"}</button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
