import React, { useEffect, useState, useCallback, useMemo } from "react";
import { api, showApiError } from "../../api";
import { toast } from "sonner";
import {
  BookOpen, ChevronRight, ChevronDown, Plus, Pencil, Trash2, Loader2,
  Sparkles, X, UtensilsCrossed, Soup, Carrot, ChevronsDownUp, ChevronsUpDown,
  Printer, Scale, AlertTriangle, Calendar, Check,
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

// mirror backend _norm: lowercase, strip non-alphanumerics
const normName = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
// unit -> dimension (mass/vol), mirrors backend UNIT_BASE
const UNIT_DIM = {
  g: "mass", gram: "mass", grams: "mass", gm: "mass", gms: "mass", kg: "mass", kgs: "mass",
  kilogram: "mass", kilograms: "mass", mg: "mass",
  ml: "vol", milliliter: "vol", millilitre: "vol", l: "vol", lt: "vol", ltr: "vol",
  litre: "vol", liter: "vol", litres: "vol", liters: "vol",
};
const unitDim = (u) => UNIT_DIM[String(u || "").toLowerCase()] || null;

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

// Inline-editable weight cell for an ingredient, aligned under the Weight column.
function InlineWeight({ ing, dishId, onSaved }) {
  const [amt, setAmt] = useState(ing.amount ?? "");
  const [unit, setUnit] = useState(ing.unit || "g");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setAmt(ing.amount ?? ""); setUnit(ing.unit || "g"); }, [ing.amount, ing.unit]);
  const commit = async (aVal, uVal) => {
    const newAmt = aVal === "" ? null : Number(aVal);
    if (newAmt === (ing.amount ?? null) && uVal === (ing.unit || "g")) return;
    setBusy(true);
    try {
      await api.put(`/recipes/dishes/${dishId}/ingredients/${ing.id}`, { name: ing.name, amount: newAmt, unit: uVal });
      onSaved();
    } catch (e) { showApiError(e); } finally { setBusy(false); }
  };
  return (
    <div className="hidden md:flex items-stretch shrink-0 text-[11px]" data-testid={`recipe-ing-weight-${ing.id}`}>
      <div className="flex items-center justify-end gap-0.5 px-1.5 border-l border-slate-100" style={{ width: WEIGHT_W }}>
        {busy ? <Loader2 size={11} className="animate-spin text-slate-400" /> : null}
        <input value={amt} inputMode="decimal" onChange={(e) => setAmt(e.target.value)}
          onBlur={() => commit(amt, unit)} onKeyDown={(e) => { if (e.key === "Enter") e.target.blur(); }}
          className="w-10 text-right bg-transparent border-b border-dashed border-slate-300 focus:border-emerald-500 outline-none tabular-nums text-emerald-800 font-semibold"
          data-testid={`recipe-ing-amount-${ing.id}`} />
        <select value={unit} onChange={(e) => { setUnit(e.target.value); commit(amt, e.target.value); }}
          className="bg-transparent text-[10px] text-slate-500 outline-none cursor-pointer" data-testid={`recipe-ing-unit-${ing.id}`}>
          <option value="g">g</option><option value="ml">ml</option>
        </select>
      </div>
      <div style={{ width: MAC.length * MAC_W + MIC.length * MIC_W }} />
    </div>
  );
}

// Shows whether a recipe ingredient matches a Stock Master item (by name),
// and flags a unit-dimension mismatch. Rendered inline on the recipe tree.
function MatchBadge({ ing, pantryByNorm }) {
  const it = pantryByNorm.get(normName(ing.name));
  if (!it) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-rose-50 text-rose-600 border border-rose-200 shrink-0"
        title="No Stock Master item matches this name" data-testid={`recipe-ing-match-${ing.id}`}>
        <AlertTriangle size={10} /> no stock match
      </span>
    );
  }
  const iDim = unitDim(ing.unit || "g"), pDim = unitDim(it.unit);
  const unitOk = pDim && iDim === pDim;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full border shrink-0 ${unitOk ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-amber-50 text-amber-700 border-amber-200"}`}
      title={unitOk ? `Matches Stock Master item “${it.name}” (${it.unit})` : `Name matches “${it.name}” but its unit is ${it.unit || "?"} — not compatible with ${ing.unit || "g"}`}
      data-testid={`recipe-ing-match-${ing.id}`}>
      {unitOk ? <Check size={10} /> : <AlertTriangle size={10} />} {it.name}{unitOk ? "" : ` · unit ${it.unit || "?"}`}
    </span>
  );
}

const LEVELS = [
  { label: "Day", cls: "bg-emerald-100 border-emerald-500" },
  { label: "Meal", cls: "bg-sky-100 border-sky-400" },
  { label: "Dish", cls: "bg-amber-100 border-amber-400" },
  { label: "Ingredient", cls: "bg-white border-slate-300" },
];

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-3 mb-3 text-[11px] text-slate-500" data-testid="recipe-legend">
      <span className="font-semibold text-slate-600">Levels:</span>
      {LEVELS.map((l) => (
        <span key={l.label} className="inline-flex items-center gap-1.5">
          <span className={`inline-block w-4 h-3 rounded-sm border-l-4 ${l.cls}`} />
          {l.label}
        </span>
      ))}
    </div>
  );
}

// Menu-vs-Actual: map each weekday to a real date + servings, compare planned recipe
// consumption against actual pantry issues.
function MvaModal({ days, onClose, onChanged }) {
  const [rows, setRows] = useState(() => days.map((d) => ({ day_id: d.id, name: d.name, date: "", servings: "" })));
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [pantry, setPantry] = useState([]);
  const [fixVals, setFixVals] = useState({});
  const [fixing, setFixing] = useState(null);
  useEffect(() => { api.get("/recipes/pantry-items").then((r) => setPantry(r.items || [])).catch(() => {}); }, []);
  useEffect(() => {
    if (res?.mismatches) {
      const init = {};
      res.mismatches.forEach((u) => { init[u.name] = u.suggestions?.[0] || ""; });
      setFixVals(init);
    }
  }, [res]);
  const setRow = (i, k, v) => setRows((p) => p.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)));
  const run = async () => {
    const payload = { rows: rows.filter((r) => r.date && Number(r.servings) > 0).map((r) => ({ day_id: r.day_id, date: r.date, servings: Number(r.servings) })) };
    if (!payload.rows.length) { toast.error("Enter a date and servings for at least one day"); return; }
    setBusy(true);
    try { const r = await api.post("/recipes/menu-vs-actual", payload); setRes(r); }
    catch (e) { showApiError(e); } finally { setBusy(false); }
  };
  const applyFix = async (u) => {
    const to = (fixVals[u.name] || "").trim();
    if (!to) { toast.error(`Pick the correct pantry name for "${u.name}"`); return; }
    setFixing(u.name);
    try {
      const r = await api.post("/recipes/rename-ingredient", { from_name: u.name, to_name: to });
      toast.success(`Renamed ${r.updated} "${u.name}" → "${to}"`);
      onChanged?.();
      await run();
    } catch (e) { showApiError(e); } finally { setFixing(null); }
  };
  const badge = (s) => s === "over" ? "bg-rose-100 text-rose-700" : s === "under" ? "bg-amber-100 text-amber-700" : s === "ok" ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4" data-testid="recipe-mva-modal">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <h3 className="font-extrabold text-slate-900 flex items-center gap-2"><Scale size={18} className="text-indigo-600" /> Menu vs Actual</h3>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-slate-100" data-testid="recipe-mva-close"><X size={18} /></button>
        </div>
        <div className="p-5 overflow-y-auto space-y-4">
          <p className="text-xs text-slate-500">Map each day of the weekly plan to a real date, and enter how many servings were prepared. We compare the planned recipe quantities against the actual pantry <b>issues</b> for those dates.</p>
          <div className="grid sm:grid-cols-2 gap-2">
            {rows.map((r, i) => (
              <div key={r.day_id} className="flex items-center gap-2 bg-slate-50 border border-slate-100 rounded-lg px-3 py-1.5">
                <span className="font-semibold text-slate-700 text-sm w-24 shrink-0 truncate">{r.name}</span>
                <div className="flex items-center gap-1 flex-1">
                  <Calendar size={13} className="text-slate-400" />
                  <input type="date" value={r.date} onChange={(e) => setRow(i, "date", e.target.value)} className="iu-input !h-8 !w-full text-xs" data-testid={`mva-date-${i}`} />
                </div>
                <input type="number" min="0" placeholder="servings" value={r.servings} onChange={(e) => setRow(i, "servings", e.target.value)} className="iu-input !h-8 !w-24 text-xs" data-testid={`mva-servings-${i}`} />
              </div>
            ))}
          </div>
          <button className="iu-btn-primary !h-9 inline-flex items-center gap-1.5" onClick={run} disabled={busy} data-testid="recipe-mva-run">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Scale size={14} />} Compare
          </button>

          {res && (
            <div className="space-y-4" data-testid="recipe-mva-results">
              <datalist id="pantry-item-names">
                {pantry.map((it) => <option key={it.id} value={it.name} />)}
              </datalist>
              {res.mismatches?.length > 0 && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 p-3" data-testid="recipe-mva-unmatched">
                  <div className="flex items-center gap-2 font-bold text-rose-800 text-sm mb-1"><AlertTriangle size={15} /> {res.mismatches.length} ingredient(s) don't exactly match a pantry item</div>
                  <p className="text-[11px] text-rose-700 mb-2">Recipe name <b>and</b> unit must match your Stock Master. Pick the correct pantry item for each and click Fix — this renames it everywhere in the recipe. These are <b>excluded</b> from the numbers below until fixed.</p>
                  <div className="space-y-1.5">
                    {res.mismatches.map((u) => (
                      <div key={u.name} className="flex items-center gap-2 bg-white border border-rose-200 rounded-lg px-2.5 py-1.5" data-testid={`mva-fix-row-${u.name}`}>
                        <div className="min-w-[11rem]">
                          <div className="text-sm font-semibold text-slate-800 truncate" title={u.name}>{u.name} <span className="text-rose-400 text-[11px] font-normal">×{u.count}</span></div>
                          {u.reason === "unit"
                            ? <div className="text-[10px] text-rose-600">unit mismatch — pantry <b>{u.pantry_name}</b> is in <b>{u.pantry_unit}</b>, recipe uses <b>{u.ing_unit}</b></div>
                            : <div className="text-[10px] text-rose-500">no pantry item with this name</div>}
                        </div>
                        <span className="text-slate-300">→</span>
                        <input list="pantry-item-names" value={fixVals[u.name] ?? ""} placeholder="type / pick exact pantry item…"
                          onChange={(e) => setFixVals((p) => ({ ...p, [u.name]: e.target.value }))}
                          className="iu-input !h-8 flex-1 text-xs" data-testid={`mva-fix-input-${u.name}`} />
                        <button className="iu-btn-primary !h-8 !px-3 text-xs inline-flex items-center gap-1" onClick={() => applyFix(u)} disabled={fixing === u.name} data-testid={`mva-fix-btn-${u.name}`}>
                          {fixing === u.name ? <Loader2 size={12} className="animate-spin" /> : <Pencil size={12} />} Fix
                        </button>
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-rose-500 mt-2">For a <b>unit mismatch</b>, either pick a differently-named pantry item that uses g/ml, or change that item's stocking unit in Stock Master.</p>
                </div>
              )}
              {res.mismatches?.length === 0 && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 font-semibold" data-testid="recipe-mva-allmatched">✓ All recipe ingredients match pantry items by name and unit.</div>
              )}
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
                    <tr>
                      <th className="text-left px-3 py-2">Item</th>
                      <th className="text-right px-3 py-2">Planned</th>
                      <th className="text-right px-3 py-2">Actual issued</th>
                      <th className="text-right px-3 py-2">Diff</th>
                      <th className="text-right px-3 py-2">%</th>
                      <th className="text-center px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {res.results.map((r) => (
                      <tr key={r.item_id} className="hover:bg-slate-50" data-testid={`mva-row-${r.item_id}`}>
                        <td className="px-3 py-1.5 font-medium text-slate-800">{r.name}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{r.planned} {r.base_unit}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{r.comparable ? `${r.actual} ${r.base_unit}` : `${r.actual_item_qty} ${r.item_unit}`}</td>
                        <td className={`px-3 py-1.5 text-right tabular-nums ${r.diff > 0 ? "text-rose-600" : r.diff < 0 ? "text-amber-600" : "text-slate-500"}`}>{r.diff != null ? `${r.diff > 0 ? "+" : ""}${r.diff} ${r.base_unit}` : "—"}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{r.pct != null ? `${r.pct > 0 ? "+" : ""}${r.pct}%` : "—"}</td>
                        <td className="px-3 py-1.5 text-center"><span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${badge(r.status)}`}>{r.comparable ? (r.status || "—") : "unit?"}</span></td>
                      </tr>
                    ))}
                    {res.results.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">No matching planned items for the selected dates.</td></tr>}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-slate-400">Over = more issued than planned (&gt;10%); Under = less issued (&gt;10%); OK = within ±10%.</p>
            </div>
          )}
        </div>
      </div>
    </div>
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
          <button title="Close without saving" className="iu-btn-secondary !h-9" onClick={onClose}>Cancel</button>
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
  const [pantry, setPantry] = useState([]);
  const [openDays, setOpenDays] = useState(() => new Set());
  const [openMeals, setOpenMeals] = useState(() => new Set());
  const [openDishes, setOpenDishes] = useState(() => new Set());
  const [modal, setModal] = useState(null);
  const [showMva, setShowMva] = useState(false);
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
  const loadPantry = useCallback(() => { api.get("/recipes/pantry-items").then((r) => setPantry(r.items || [])).catch(() => {}); }, []);
  useEffect(() => { loadPantry(); }, [loadPantry]);

  // normalised-name -> pantry item, mirrors backend _norm (lowercase, strip non-alnum)
  const pantryByNorm = useMemo(() => {
    const m = new Map();
    pantry.forEach((it) => { const k = normName(it.name); if (k && !m.has(k)) m.set(k, it); });
    return m;
  }, [pantry]);

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

  const printDay = (day) => {
    const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const wt = (o) => [o?.weight_g ? `${w1(o.weight_g)} g` : "", o?.weight_ml ? `${w1(o.weight_ml)} ml` : ""].filter(Boolean).join(" + ");
    const body = (day.meals || []).map((m) => {
      const dishRows = (m.dishes || []).map((di) => {
        const ings = (di.ingredients || []).map((g) => `${esc(g.name)}${g.amount != null ? ` (${g.amount}${g.unit || "g"})` : ""}`).join(", ");
        return `<tr><td class="dish"><b>${esc(di.name)}</b>${di.cooked_qty ? ` <span class="cq">— ${esc(di.cooked_qty)}</span>` : ""}${ings ? `<div class="ings">${ings}</div>` : ""}</td>
          <td>${n1(di.energy)}</td><td>${n1(di.carbs)}</td><td>${n1(di.protein)}</td><td>${n1(di.fat)}</td><td>${n1(di.fiber)}</td><td>${wt(di)}</td></tr>`;
      }).join("");
      const t = m.totals || {};
      return `<tr class="meal"><td>${esc(m.name)}</td><td>${n1(t.energy)}</td><td>${n1(t.carbs)}</td><td>${n1(t.protein)}</td><td>${n1(t.fat)}</td><td>${n1(t.fiber)}</td><td>${wt(t)}</td></tr>${dishRows}`;
    }).join("");
    const dt = day.totals || {};
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(day.name)} — Menu</title>
    <style>
      *{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;box-sizing:border-box}
      body{margin:24px;color:#0f172a}
      h1{font-size:22px;margin:0 0 2px}.sub{color:#64748b;font-size:12px;margin-bottom:16px}
      table{width:100%;border-collapse:collapse;font-size:12px}
      th,td{border-bottom:1px solid #e2e8f0;padding:6px 8px;text-align:right}
      th:first-child,td:first-child{text-align:left}
      thead th{background:#f1f5f9;text-transform:uppercase;font-size:10px;color:#475569}
      tr.meal td{background:#e0f2fe;font-weight:700}
      td.dish{padding-left:18px}.ings{color:#64748b;font-weight:400;font-size:11px;margin-top:2px}
      .cq{color:#94a3b8;font-weight:400}
      tr.total td{background:#dcfce7;font-weight:800;border-top:2px solid #86efac}
      @media print{body{margin:10mm}}
    </style></head><body>
      <h1>${esc(day.name)} — Daily Menu</h1>
      <div class="sub">The Yacht Club of Hyderabad · macros per serving · weights are per dish</div>
      <table><thead><tr><th>Meal / Dish</th><th>kcal</th><th>Carbs</th><th>Prot</th><th>Fats</th><th>Fibre</th><th>Weight</th></tr></thead>
      <tbody>${body}
        <tr class="total"><td>DAY TOTAL</td><td>${n1(dt.energy)}</td><td>${n1(dt.carbs)}</td><td>${n1(dt.protein)}</td><td>${n1(dt.fat)}</td><td>${n1(dt.fiber)}</td><td>${wt(dt)}</td></tr>
      </tbody></table>
    </body></html>`;
    const w = window.open("", "_blank");
    if (!w) { toast.error("Allow pop-ups to print"); return; }
    w.document.write(html); w.document.close(); w.focus();
    setTimeout(() => w.print(), 300);
  };

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
        <button onClick={() => setShowMva(true)} className="iu-btn-secondary !h-9 inline-flex items-center gap-1.5" data-testid="recipe-open-mva">
          <Scale size={14} /> Menu vs Actual
        </button>
        <button onClick={runAI} disabled={aiBusy} className="iu-btn-primary !h-9 inline-flex items-center gap-1" data-testid="recipe-ai-fill">
          {aiBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Fill micronutrients with AI
        </button>
        {aiMsg && <span className="text-xs text-emerald-700" data-testid="recipe-ai-msg">{aiMsg}</span>}
      </div>

      <Legend />

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
                    <IconBtn title="Print this day's menu" onClick={() => printDay(day)} testid={`recipe-print-day-${day.id}`}><Printer size={14} /></IconBtn>
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
                                <MatchBadge ing={ing} pantryByNorm={pantryByNorm} />
                                {ing.per100 && Object.values(ing.per100).every((v) => v === null) ? (
                                  <span className="text-[10px] text-slate-400 ml-1">· no micros yet</span>
                                ) : null}
                                <span className="opacity-0 group-hover:opacity-100 flex items-center transition ml-1">
                                  <IconBtn title="Edit ingredient" onClick={() => mIng(dish.id, ing)}><Pencil size={12} /></IconBtn>
                                  <IconBtn title="Delete ingredient" onClick={() => del(`/recipes/dishes/${dish.id}/ingredients/${ing.id}`, ing.name)} cls="hover:text-rose-600"><Trash2 size={12} /></IconBtn>
                                </span>
                                <span className="flex-1" />
                                <InlineWeight ing={ing} dishId={dish.id} onSaved={load} />
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
      {showMva && <MvaModal days={tree} onClose={() => setShowMva(false)} onChanged={load} />}
    </div>
  );
}
