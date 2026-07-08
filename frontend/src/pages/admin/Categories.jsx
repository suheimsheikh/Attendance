/**
 * Categories master — full CRUD for the 5 seeded + any custom member
 * categories used across the app (attendance rules, Chef's View tiles,
 * dashboard breakdowns, filter chips).
 *
 * • Seeded rows (athlete/elite/coach/staff/executive) can be recoloured
 *   and re-labelled but cannot be deleted or deactivated — attendance
 *   rules branch on their KEYS.
 * • Custom rows can be added freely; deletion is blocked while members
 *   still reference the category (backend returns 409, we surface it).
 */
import React, { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Pencil, Trash2, X, ShieldCheck, Palette } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../../api";

const COLORS = [
  { key: "sky",     tw: "bg-sky-500" },
  { key: "rose",    tw: "bg-rose-500" },
  { key: "emerald", tw: "bg-emerald-500" },
  { key: "amber",   tw: "bg-amber-500" },
  { key: "violet",  tw: "bg-violet-500" },
  { key: "slate",   tw: "bg-slate-500" },
];

// Keys of the 5 seeded categories — mirrors SEEDED_CATEGORY_KEYS in
// backend/routes/meals.py. Locked from key-rename because hard-coded
// business rules (overtime accrual, chef's-view meal eligibility, athlete
// leave-balance opt-out, etc.) branch on these exact strings.
const SEEDED_KEYS = new Set(["athlete", "elite", "coach", "staff", "executive"]);

function CategoryForm({ initial, onClose, onSaved }) {
  const isEdit = !!initial?.id;
  const isSeeded = !!initial?.is_seeded;
  const [form, setForm] = useState({
    key:  initial?.key  ?? "",
    label: initial?.label ?? "",
    color: initial?.color ?? "slate",
    is_athlete_like: initial?.is_athlete_like ?? false,
    meal_eligible:   initial?.meal_eligible   ?? true,
    sort_order:      initial?.sort_order      ?? 100,
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async (e) => {
    e.preventDefault();
    if (!form.label.trim()) { toast.error("Label is required"); return; }
    if (!isEdit && !form.key.trim()) { toast.error("Key is required"); return; }
    setSaving(true);
    try {
      if (isEdit) {
        const patch = {
          key: form.key.trim().toLowerCase(),
          label: form.label,
          color: form.color,
          is_athlete_like: form.is_athlete_like,
          meal_eligible: form.meal_eligible,
          sort_order: Number(form.sort_order),
        };
        const r = await api.patch(`/masters/categories/${initial.id}`, patch);
        const n = r?._cascaded_members || 0;
        toast.success(n > 0
          ? `Category updated · ${n} member${n === 1 ? "" : "s"} re-tagged to "${patch.key}"`
          : "Category updated");
      } else {
        await api.post("/masters/categories", {
          key: form.key.trim().toLowerCase(),
          label: form.label.trim(),
          color: form.color,
          is_athlete_like: form.is_athlete_like,
          meal_eligible: form.meal_eligible,
          sort_order: Number(form.sort_order),
        });
        toast.success("Category created");
      }
      onSaved?.();
    } catch (err) {
      showApiError(err, "Save failed");
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4"
         onClick={onClose} data-testid="category-form-modal">
      <form className="bg-white rounded-2xl w-full max-w-md shadow-2xl"
            onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="flex items-center justify-between p-4 border-b border-slate-100">
          <h2 className="text-lg font-bold">{isEdit ? "Edit category" : "New category"}</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700">
            <X size={18} />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="iu-label" htmlFor="cat-key">Key</label>
            <input
              id="cat-key" data-testid="cat-form-key"
              value={form.key}
              disabled={isEdit && SEEDED_KEYS.has(initial?.key)}
              onChange={(e) => set("key", e.target.value)}
              className="iu-input"
              placeholder="e.g. volunteer"
            />
            <p className="text-[11px] text-slate-500 mt-1">
              {isEdit && SEEDED_KEYS.has(initial?.key)
                ? "Seeded category — key is locked (referenced by hard-coded rules)."
                : isEdit
                ? "Renaming will cascade to every member currently tagged with this category."
                : "Lowercase, alphanumeric + underscore. Used as the stored category value."}
            </p>
          </div>
          <div>
            <label className="iu-label" htmlFor="cat-label">Label</label>
            <input
              id="cat-label" data-testid="cat-form-label"
              value={form.label}
              onChange={(e) => set("label", e.target.value)}
              className="iu-input"
              placeholder="Human-facing name (e.g. Volunteers)"
            />
          </div>
          <div>
            <label className="iu-label flex items-center gap-1">
              <Palette size={12} /> Colour
            </label>
            <div className="flex gap-1.5">
              {COLORS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => set("color", c.key)}
                  className={`w-8 h-8 rounded-full ${c.tw} ${
                    form.color === c.key ? "ring-2 ring-slate-900 ring-offset-2" : "opacity-70 hover:opacity-100"
                  }`}
                  aria-label={c.key}
                  data-testid={`cat-form-color-${c.key}`}
                />
              ))}
            </div>
          </div>
          <div className="flex items-start gap-4 pt-1">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" data-testid="cat-form-meal-eligible"
                     checked={form.meal_eligible}
                     onChange={(e) => set("meal_eligible", e.target.checked)} />
              Meal eligible
            </label>
            <label className="flex items-center gap-2 text-sm" title="Athletes and Elite share the same rules — no OT, use Breaks not Leaves, etc.">
              <input type="checkbox" data-testid="cat-form-athlete-like"
                     checked={form.is_athlete_like}
                     disabled={isSeeded}
                     onChange={(e) => set("is_athlete_like", e.target.checked)} />
              Athlete-like {isSeeded && <span className="text-[10px] text-slate-400">(locked)</span>}
            </label>
          </div>
          <div>
            <label className="iu-label" htmlFor="cat-sort">Sort order</label>
            <input id="cat-sort" type="number" data-testid="cat-form-sort"
                   value={form.sort_order}
                   onChange={(e) => set("sort_order", e.target.value)}
                   className="iu-input w-24" />
            <p className="text-[11px] text-slate-500 mt-1">Lower numbers appear first. Seeded: 10 (athlete) → 50 (executive).</p>
          </div>
        </div>
        <div className="p-3 border-t border-slate-100 flex justify-end gap-2 bg-slate-50">
          <button type="button" onClick={onClose} className="px-3 h-9 rounded-lg text-sm font-semibold text-slate-700 hover:bg-slate-200">
            Cancel
          </button>
          <button type="submit" disabled={saving}
                  data-testid="cat-form-save"
                  className="px-3 h-9 rounded-lg text-sm font-semibold bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50">
            {saving ? "Saving…" : isEdit ? "Save changes" : "Create"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function Categories() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);   // {} = new, {...} = edit, null = closed

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get("/masters/categories?include_inactive=true");
      setRows(Array.isArray(r) ? r : []);
    } catch (err) {
      showApiError(err, "Couldn't load categories");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const remove = async (r) => {
    if (r.is_seeded) { toast.error("Seeded categories are protected."); return; }
    if (r.member_count > 0) { toast.error(`${r.member_count} member(s) still use this — reassign first.`); return; }
    if (!window.confirm(`Delete "${r.label}"?\n\nThis cannot be undone.`)) return;
    try {
      await api.del(`/masters/categories/${r.id}`);
      toast.success("Deleted");
      load();
    } catch (err) { showApiError(err, "Delete failed"); }
  };

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto" data-testid="categories-page">
      <header className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight flex items-center gap-2">
            <ShieldCheck className="text-sky-600" size={28} /> Categories
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            The 5 seeded rows drive attendance rules and cannot be deleted.
            You can add custom categories (e.g. Volunteers) for reporting and Chef&apos;s View grouping.
          </p>
        </div>
        <button onClick={() => setEditing({})} data-testid="category-new" className="iu-btn-primary">
          <Plus size={16} /> New category
        </button>
      </header>

      {loading ? (
        <div className="py-16 text-center text-slate-400"><Loader2 className="animate-spin mx-auto" /></div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.id}
                 className="iu-card p-3 flex items-center gap-3"
                 data-testid={`category-row-${r.key}`}>
              <span className={`w-4 h-4 rounded-full shrink-0 ${
                { sky:"bg-sky-500", rose:"bg-rose-500", emerald:"bg-emerald-500", amber:"bg-amber-500", violet:"bg-violet-500", slate:"bg-slate-500" }[r.color] || "bg-slate-500"
              }`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-slate-900">{r.label}</span>
                  <span className="text-[11px] font-mono text-slate-400">{r.key}</span>
                  {r.is_seeded && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 h-4 rounded bg-sky-100 text-sky-700 border border-sky-200">
                      <ShieldCheck size={9} /> Seeded
                    </span>
                  )}
                  {!r.active && (
                    <span className="text-[10px] font-bold px-1.5 h-4 rounded bg-slate-200 text-slate-600">Inactive</span>
                  )}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5 flex flex-wrap gap-3">
                  <span>{r.member_count ?? 0} member{r.member_count === 1 ? "" : "s"}</span>
                  {r.is_athlete_like && <span>athlete-like</span>}
                  {r.meal_eligible ? <span>meal ✓</span> : <span className="opacity-50">meal ✗</span>}
                  <span>sort {r.sort_order}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setEditing(r)}
                className="p-2 rounded-lg text-slate-500 hover:bg-slate-100"
                title="Edit"
                data-testid={`category-edit-${r.key}`}
              >
                <Pencil size={15} />
              </button>
              <button
                type="button"
                onClick={() => remove(r)}
                disabled={r.is_seeded || r.member_count > 0}
                className="p-2 rounded-lg text-rose-500 hover:bg-rose-50 disabled:opacity-30 disabled:cursor-not-allowed"
                title={r.is_seeded ? "Seeded — protected"
                       : r.member_count > 0 ? "Reassign members first"
                       : "Delete"}
                data-testid={`category-delete-${r.key}`}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}

      {editing !== null && (
        <CategoryForm
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}
