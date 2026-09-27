import React, { useEffect, useState, useCallback, useMemo } from "react";
import { api, showApiError } from "../../api";
import { toast } from "sonner";
import {
  BookOpen, ChevronRight, ChevronDown, Plus, Pencil, Trash2, Loader2,
  Sparkles, X, UtensilsCrossed, Soup, Carrot, ChevronsDownUp, ChevronsUpDown,
} from "lucide-react";

const MAC = [
  { k: "energy", label: "kcal" }, { k: "carbs", label: "Carbs" }, { k: "protein", label: "Prot" },
  { k: "fat", label: "Fats" }, { k: "fiber", label: "Fibre" },
];
const MIC = [
  { k: "iron", label: "Fe", unit: "mg" }, { k: "calcium", label: "Ca", unit: "mg" }, { k: "sodium", label: "Na", unit: "mg" },
  { k: "potassium", label: "K", unit: "mg" }, { k: "magnesium", label: "Mg", unit: "mg" }, { k: "zinc", label: "Zn", unit: "mg" },
  { k: "vitamin_d", label: "VitD", unit: "µg" }, { k: "vitamin_b12", label: "B12", unit: "µg" },
];
const WEIGHT_W = 82, MAC_W = 52, MIC_W = 46;

const n1 = (v) => (v === null || v === undefined || v === "" || Number(v) === 0 ? "" : Number(v).toFixed(1));
const w1 = (v) => (!v || Number(v) === 0 ? "" : (Number.isInteger(Number(v)) ? String(Number(v)) : Number(v).toFixed(1)));

// numeric strip shared by every row so columns line up across indent levels
function Stats({ obj, bold }) {
  const g = obj?.weight_g, ml = obj?.weight_ml;
  return (
    <div className="hidden md:flex items-stretch text-[11px] tabular-nums shrink-0" data-testid="recipe-stats">
      {/* weight */}
      <div className="flex flex-col items-end justify-center px-1.5 leading-tight border-l border-slate-200" style={{ width: WEIGHT_W }}>
        {g ? <span className={bold ? "font-bold text-emerald-800" : "text-emerald-700"}>{w1(g)} g</span> : null}
        {ml ? <span className="text-sky-600">{w1(ml)} ml</span> : null}
      </div>
      {/* macro nutrients */}
      <div className="grid border-l border-amber-200/70" style={{ gridTemplateColumns: `repeat(${MAC.length}, ${MAC_W}px)` }}>
        {MAC.map((c) => (
          <div key={c.k} className={`text-right px-1.5 py-0.5 ${bold ? "font-bold text-amber-900" : "text-amber-700/90"}`}>{n1(obj?.[c.k])}</div>
        ))}
      </div>
      {/* micro nutrients */}
      <div className="grid border-l border-indigo-200/70" style={{ gridTemplateColumns: `repeat(${MIC.length}, ${MIC_W}px)` }}>
        {MIC.map((c) => (
          <div key={c.k} className={`text-right px-1.5 py-0.5 ${bold ? "font-bold text-indigo-900" : "text-indigo-600/80"}`}>{n1(obj?.[c.k])}</div>
        ))}
      </div>
    </div>
  );
}

function IconBtn({ title, onClick, children, testid, cls = "" }) {
  return (
    <button type="button" title={title} onClick={onClick} data-testid={testid}
      className={`p-1 rounded hover:bg-white/70 text-slate-500 hover:text-slate-800 transition ${cls}`}>
      {children}
    </button>
  );
}

// Single generic modal for create/edit of any node type
function NodeModal({ node, onClose, onSaved }) {
  const [f, setF] = useState(node.data || {});
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((p) => ({ ...p, [k]: v }));
  const save = async () => {
    setBusy(true);
    try {
      await node.onSubmit(f);
      toast.success("Saved");
      onSaved();
    } catch (e) { showApiError(e); } finally { setBusy(false); }
  };
  const fields = node.fields;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4" data-testid="recipe-node-modal">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <h3 className="font-extrabold text-slate-900">{node.title}</h3>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-100" data-testid="recipe-modal-close"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-3">
          {fields.map((fl) => (
            <label key={fl.k} className="block text-xs font-semibold text-slate-600">
              <div className="mb-1">{fl.label}</div>
              {fl.type === "select" ? (
                <select value={f[fl.k] ?? fl.options[0]} onChange={(e) => set(fl.k, e.target.value)} className="iu-input !h-10 !w-full text-sm" data-testid={`recipe-field-${fl.k}`}>
                  {fl.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input autoFocus={fl.k === fields[0].k} type={fl.type || "text"} value={f[fl.k] ?? ""}
                  onChange={(e) => set(fl.k, fl.type === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)}
                  placeholder={fl.ph || ""} className="iu-input !h-10 !w-full text-sm" data-testid={`recipe-field-${fl.k}`}
                  onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
              )}
            </label>
          ))}
          {node.note && <p className="text-[11px] text-slate-500">{node.note}</p>}
        </div>
        <div className="px-5 py-3 border-t border-slate-100 flex justify-end gap-2">
          <button className="iu-btn-secondary !h-9" onClick={onClose}>Cancel</button>
          <button className="iu-btn-primary !h-9" onClick={save} disabled={busy} data-testid="recipe-modal-save">
            {busy ? <Loader2 size={14} className="animate-spin" /> : null} Save
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Recipes() {
  const [tree, setTree] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openDays, setOpenDays] = useState(() => new Set());
  const [openMeals, setOpenMeals] = useState(() => new Set());
  const [openDishes, setOpenDishes] = useState(() => new Set());
  const [modal, setModal] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    api.get("/recipes/tree")
      .then((r) => { setTree(r.days || []); if (openDays.size === 0 && r.days?.[0]) setOpenDays(new Set([r.days[0].id])); })
      .catch((e) => showApiError(e, "Couldn't load recipes"))
      .finally(() => setLoading(false));
  }, []); // eslint-disable-line
  useEffect(() => { load(); }, [load]);

  const tset = (setter) => (id) => setter((p) => { const s = new Set(p); s.has(id) ? s.delete(id) : s.add(id); return s; });
  const toggleDay = tset(setOpenDays), toggleMeal = tset(setOpenMeals), toggleDish = tset(setOpenDishes);

  const allIds = useMemo(() => {
    const days = [], meals = [], dishes = [];
    tree.forEach((d) => {
      days.push(d.id);
      (d.meals || []).forEach((m) => { meals.push(m.id); (m.dishes || []).forEach((di) => dishes.push(di.id)); });
    });
    return { days, meals, dishes };
  }, [tree]);
  const anyOpen = openDays.size > 0 || openMeals.size > 0 || openDishes.size > 0;
  const expandAll = () => { setOpenDays(new Set(allIds.days)); setOpenMeals(new Set(allIds.meals)); setOpenDishes(new Set(allIds.dishes)); };
  const collapseAll = () => { setOpenDays(new Set()); setOpenMeals(new Set()); setOpenDishes(new Set()); };

  const refresh = () => { setModal(null); load(); };
  const del = async (url, label) => {
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    try { await api.delete(url); toast.success("Deleted"); load(); } catch (e) { showApiError(e); }
  };

  const runAI = async () => {
    setAiBusy(true); setAiMsg("Filling micronutrients with Claude…");
    try {
      let remaining = 1, done = 0, guard = 0;
      while (remaining > 0 && guard < 30) {
        const r = await api.post("/recipes/fill-micros?limit=15");
        done += r.processed; remaining = r.remaining; guard += 1;
        setAiMsg(`Filled ${done} ingredients… ${remaining} remaining`);
        if (r.processed === 0) break;
      }
      toast.success("Micronutrients updated");
      setAiMsg(""); load();
    } catch (e) { showApiError(e, "AI fill failed"); setAiMsg(""); }
    finally { setAiBusy(false); }
  };

  // modal builders
  const mDay = (data) => setModal({ title: data?.id ? "Rename day" : "Add day", data: data || {},
    fields: [{ k: "name", label: "Day name", ph: "e.g. Monday" }],
    onSubmit: (f) => data?.id ? api.put(`/recipes/days/${data.id}`, { name: f.name }) : api.post("/recipes/days", { name: f.name }) });
  const mMeal = (dayId, data) => setModal({ title: data?.id ? "Rename meal" : "Add meal", data: data || {},
    fields: [{ k: "name", label: "Meal name", ph: "e.g. Breakfast" }],
    onSubmit: (f) => data?.id ? api.put(`/recipes/meals/${data.id}`, { name: f.name }) : api.post("/recipes/meals", { day_id: dayId, name: f.name }) });
  const mDish = (mealId, data) => setModal({ title: data?.id ? "Edit dish" : "Add dish", data: data || {},
    note: "Macros are per serving. Micronutrients are computed from the ingredients you add.",
    fields: [
      { k: "name", label: "Dish name", ph: "e.g. Vegetable omlete" }, { k: "cooked_qty", label: "Cooked qty", ph: "e.g. 150g" },
      { k: "energy", label: "Energy (kcal)", type: "number" }, { k: "carbs", label: "Carbs (g)", type: "number" },
      { k: "protein", label: "Protein (g)", type: "number" }, { k: "fat", label: "Fat (g)", type: "number" }, { k: "fiber", label: "Fibre (g)", type: "number" },
    ],
    onSubmit: (f) => data?.id ? api.put(`/recipes/dishes/${data.id}`, f) : api.post("/recipes/dishes", { meal_id: mealId, ...f }) });
  const mIng = (dishId, data) => setModal({ title: data?.id ? "Edit ingredient" : "Add ingredient", data: data || { unit: "g" },
    note: "Saving fetches per-100g micronutrients from Claude for this ingredient (cached by name).",
    fields: [
      { k: "name", label: "Ingredient", ph: "e.g. Almonds" }, { k: "amount", label: "Amount", type: "number", ph: "grams / ml" },
      { k: "unit", label: "Unit", type: "select", options: ["g", "ml"] },
    ],
    onSubmit: (f) => data?.id ? api.put(`/recipes/dishes/${dishId}/ingredients/${data.id}`, f) : api.post(`/recipes/dishes/${dishId}/ingredients`, f) });

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto" data-testid="recipes-page">
      <div className="flex items-center gap-2 mb-1">
        <BookOpen size={20} className="text-emerald-700" />
        <h1 className="text-xl font-black text-slate-900">Recipes</h1>
      </div>
      <p className="text-xs text-slate-500 mb-4">Weekly menu tree — <b>Day → Meal → Dish → Ingredients</b>. Macros are per serving; micronutrients (per serving) are computed from each ingredient's per-100g values filled by AI. Click a row to expand.</p>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button onClick={anyOpen ? collapseAll : expandAll} className="iu-btn-secondary !h-9 inline-flex items-center gap-1.5" data-testid="recipe-toggle-all">
          {anyOpen ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />} {anyOpen ? "Collapse all" : "Expand all"}
        </button>
        <button onClick={runAI} disabled={aiBusy} className="iu-btn-primary !h-9 inline-flex items-center gap-1" data-testid="recipe-ai-fill">
          {aiBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Fill micronutrients with AI
        </button>
        {aiMsg && <span className="text-xs text-emerald-700" data-testid="recipe-ai-msg">{aiMsg}</span>}
      </div>

      {/* sticky two-tier column header */}
      <div className="hidden md:block sticky top-0 z-30 shadow-sm" data-testid="recipe-header">
        {/* tier 1 — group titles */}
        <div className="flex items-stretch bg-white border border-slate-200 rounded-t-lg px-3">
          <div className="flex-1 flex items-end py-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">Day / Meal / Dish / Ingredient</div>
          <div className="flex items-center justify-center border-l border-slate-200 bg-slate-50 text-[10px] font-bold uppercase tracking-wide text-slate-500" style={{ width: WEIGHT_W }}>Weight</div>
          <div className="flex items-center justify-center border-l border-amber-200 bg-amber-100 text-[11px] font-extrabold uppercase tracking-wide text-amber-800" style={{ width: MAC.length * MAC_W }}>Macro Nutrients</div>
          <div className="flex items-center justify-center border-l border-indigo-200 bg-indigo-100 text-[11px] font-extrabold uppercase tracking-wide text-indigo-800" style={{ width: MIC.length * MIC_W }}>Micro Nutrients</div>
        </div>
        {/* tier 2 — column labels */}
        <div className="flex items-stretch bg-slate-100 border border-t-0 border-slate-200 px-3">
          <div className="flex-1" />
          <div className="flex items-center justify-center border-l border-slate-200 text-[9px] font-semibold text-slate-400" style={{ width: WEIGHT_W }}>g · ml</div>
          <div className="grid border-l border-amber-200/70 bg-amber-50" style={{ gridTemplateColumns: `repeat(${MAC.length}, ${MAC_W}px)` }}>
            {MAC.map((c) => <div key={c.k} className="text-right px-1.5 py-1 text-[10px] font-bold text-amber-700">{c.label}</div>)}
          </div>
          <div className="grid border-l border-indigo-200/70 bg-indigo-50" style={{ gridTemplateColumns: `repeat(${MIC.length}, ${MIC_W}px)` }}>
            {MIC.map((c) => (
              <div key={c.k} className="text-right px-1.5 py-1 leading-none text-[10px] font-bold text-indigo-700">
                {c.label}<span className="block text-[8px] font-normal text-indigo-400 mt-0.5">{c.unit}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="p-10 text-center text-slate-400"><Loader2 className="animate-spin inline" size={20} /></div>
      ) : (
        <div className="border border-slate-200 border-t-0 rounded-b-lg divide-y divide-slate-100 bg-white" data-testid="recipe-tree">
          {tree.map((day) => {
            const dOpen = openDays.has(day.id);
            return (
              <div key={day.id}>
                <div className="flex items-center gap-1 px-3 py-2 bg-emerald-50 hover:bg-emerald-100/70 border-l-4 border-emerald-500 group" data-testid={`recipe-day-${day.id}`}>
                  <button onClick={() => toggleDay(day.id)} className="p-0.5" data-testid={`recipe-day-toggle-${day.id}`}>
                    {dOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>
                  <span className="font-extrabold text-slate-900 flex-1">{day.name}</span>
                  <span className="opacity-0 group-hover:opacity-100 flex items-center transition">
                    <IconBtn title="Add meal" onClick={() => mMeal(day.id)} testid={`recipe-add-meal-${day.id}`}><Plus size={14} /></IconBtn>
                    <IconBtn title="Rename day" onClick={() => mDay(day)}><Pencil size={13} /></IconBtn>
                  </span>
                  <Stats obj={day.totals} bold />
                </div>

                {dOpen && day.meals.map((meal) => {
                  const mOpen = openMeals.has(meal.id);
                  return (
                    <div key={meal.id}>
                      <div className="flex items-center gap-1 pl-8 pr-3 py-1.5 bg-sky-50 hover:bg-sky-100/70 border-l-4 border-sky-400 group" data-testid={`recipe-meal-${meal.id}`}>
                        <button onClick={() => toggleMeal(meal.id)} className="p-0.5">{mOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button>
                        <Soup size={13} className="text-sky-600 shrink-0" />
                        <span className="font-bold text-slate-800 flex-1">{meal.name}</span>
                        <span className="opacity-0 group-hover:opacity-100 flex items-center transition">
                          <IconBtn title="Add dish" onClick={() => mDish(meal.id)} testid={`recipe-add-dish-${meal.id}`}><Plus size={14} /></IconBtn>
                          <IconBtn title="Rename meal" onClick={() => mMeal(day.id, meal)}><Pencil size={13} /></IconBtn>
                          <IconBtn title="Delete meal" onClick={() => del(`/recipes/meals/${meal.id}`, meal.name)} cls="hover:text-rose-600"><Trash2 size={13} /></IconBtn>
                        </span>
                        <Stats obj={meal.totals} bold />
                      </div>

                      {mOpen && meal.dishes.map((dish) => {
                        const diOpen = openDishes.has(dish.id);
                        const stat = { ...dish, ...dish.micros };
                        return (
                          <div key={dish.id}>
                            <div className="flex items-center gap-1 pl-16 pr-3 py-1.5 bg-amber-50/60 hover:bg-amber-100/60 border-l-4 border-amber-400 group" data-testid={`recipe-dish-${dish.id}`}>
                              <button onClick={() => toggleDish(dish.id)} className="p-0.5">{diOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
                              <UtensilsCrossed size={12} className="text-amber-600 shrink-0" />
                              <span className="font-semibold text-slate-900">{dish.name}</span>
                              {dish.cooked_qty ? <span className="text-[11px] text-slate-400 ml-1">{dish.cooked_qty}</span> : null}
                              <span className="flex-1" />
                              <span className="opacity-0 group-hover:opacity-100 flex items-center transition">
                                <IconBtn title="Add ingredient" onClick={() => mIng(dish.id)} testid={`recipe-add-ing-${dish.id}`}><Plus size={14} /></IconBtn>
                                <IconBtn title="Edit dish" onClick={() => mDish(meal.id, dish)}><Pencil size={12} /></IconBtn>
                                <IconBtn title="Delete dish" onClick={() => del(`/recipes/dishes/${dish.id}`, dish.name)} cls="hover:text-rose-600"><Trash2 size={12} /></IconBtn>
                              </span>
                              <Stats obj={stat} bold />
                            </div>

                            {diOpen && (dish.ingredients || []).map((ing) => (
                              <div key={ing.id} className="flex items-center gap-1 pl-24 pr-3 py-1 bg-white hover:bg-slate-50 border-l-4 border-slate-200 group text-sm" data-testid={`recipe-ing-${ing.id}`}>
                                <Carrot size={11} className="text-emerald-500 shrink-0" />
                                <span className="text-slate-700">{ing.name}</span>
                                <span className="text-[11px] text-slate-400 ml-1 tabular-nums">
                                  {ing.amount != null ? `${ing.amount}${ing.unit || "g"}` : ""}
                                  {ing.per100 && Object.values(ing.per100).every((v) => v === null) ? " · no micros yet" : ""}
                                </span>
                                <span className="flex-1" />
                                <span className="opacity-0 group-hover:opacity-100 flex items-center transition">
                                  <IconBtn title="Edit ingredient" onClick={() => mIng(dish.id, ing)}><Pencil size={12} /></IconBtn>
                                  <IconBtn title="Delete ingredient" onClick={() => del(`/recipes/dishes/${dish.id}/ingredients/${ing.id}`, ing.name)} cls="hover:text-rose-600"><Trash2 size={12} /></IconBtn>
                                </span>
                              </div>
                            ))}
                            {diOpen && (dish.ingredients || []).length === 0 && (
                              <div className="pl-24 pr-3 py-1 text-xs text-slate-400 italic">No ingredients yet — add one.</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {tree.length === 0 && <div className="p-10 text-center text-slate-400">No recipes yet. Add a day to begin.</div>}
        </div>
      )}

      {modal && <NodeModal node={modal} onClose={() => setModal(null)} onSaved={refresh} />}
    </div>
  );
}
