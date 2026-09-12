/**
 * MealStockTakeTab — weekly physical stock count.
 *
 * Pick a date; the sheet shows each item's SYSTEM on-hand at the start
 * of that day. Enter the PHYSICAL count you actually found and the
 * variance (loss / extra) is computed live. Saving posts a signed
 * adjustment line so the continuous ledger reconciles to reality.
 * Partial counts are fine — only rows you type into are touched.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, ClipboardCheck, Save, Search, ChevronDown, ChevronRight, TrendingDown, TrendingUp } from "lucide-react";
import { api, showApiError } from "../../api";
import { formatDate, fmtQty } from "../../utils";

const todayISO = () => new Date().toLocaleDateString("sv-SE");
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };

export default function MealStockTakeTab({ liveSig }) {
  const [dateStr, setDateStr] = useState(todayISO());
  const [rows, setRows] = useState([]);
  const [cats, setCats] = useState([]);
  const [physical, setPhysical] = useState({});   // item_id -> string
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState(new Set());
  const dirty = useRef(false);

  const load = useCallback(() => {
    setLoading(true);
    api.get(`/meals/stock-take?date=${dateStr}`)
      .then((r) => {
        setRows(r.rows || []);
        setCats(r.categories || []);
        // Prefill any already-recorded physical counts for the day.
        const pre = {};
        (r.rows || []).forEach((x) => { if (x.physical_qty != null) pre[x.item_id] = String(x.physical_qty); });
        setPhysical(pre);
        dirty.current = false;
      })
      .catch((e) => showApiError(e, "Couldn't load stock-take sheet"))
      .finally(() => setLoading(false));
  }, [dateStr]);

  useEffect(() => { load(); }, [load]);
  // Refetch on live pantry signals (unless the user has unsaved edits).
  useEffect(() => { if (liveSig && !dirty.current) load(); }, [liveSig, load]);

  const catLabel = useMemo(() => Object.fromEntries((cats || []).map((c) => [c.key, c.label])), [cats]);

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const m = new Map();
    rows.forEach((r) => {
      if (q && !(r.name || "").toLowerCase().includes(q)) return;
      const k = r.category_key || "other";
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    });
    return [...m.entries()];
  }, [rows, search]);

  const summary = useMemo(() => {
    let counted = 0, losses = 0, extras = 0;
    rows.forEach((r) => {
      const v = physical[r.item_id];
      if (v === undefined || v === "") return;
      counted += 1;
      const variance = num(v) - num(r.system_qty);
      if (Math.abs(variance) < 1e-9) return;
      if (variance > 0) extras += 1; else losses += 1;
    });
    return { counted, losses, extras };
  }, [rows, physical]);

  const setPhys = (id, val) => { dirty.current = true; setPhysical((p) => ({ ...p, [id]: val })); };
  const toggle = (k) => setCollapsed((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const save = async () => {
    const lines = rows
      .filter((r) => { const v = physical[r.item_id]; return v !== undefined && v !== ""; })
      .map((r) => ({ item_id: r.item_id, physical_qty: num(physical[r.item_id]) }));
    if (lines.length === 0) { toast.info("Enter at least one physical count first."); return; }
    setSaving(true);
    try {
      const res = await api.post("/meals/stock-take", { date: dateStr, lines });
      toast.success(`Stock-take saved · ${res.counted} counted · ${res.losses} loss${res.losses === 1 ? "" : "es"} · ${res.extras} extra${res.extras === 1 ? "" : "s"}`);
      dirty.current = false;
      load();
    } catch (e) {
      showApiError(e, "Couldn't save stock-take");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="meal-stocktake-tab">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-xs font-semibold text-slate-600" htmlFor="stocktake-date">Count date</label>
          <input id="stocktake-date" data-testid="stocktake-date" type="date" value={dateStr} max={todayISO()}
                 onChange={(e) => setDateStr(e.target.value)} className="iu-input !h-9 !w-auto text-sm" />
          <span className="text-xs text-slate-500">{formatDate(dateStr)}</span>
        </div>
        <div className="relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search items…"
                 className="iu-input !h-9 text-sm !pl-7 !w-52" data-testid="stocktake-search" />
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-xs text-slate-500" data-testid="stocktake-summary">
            <b>{summary.counted}</b> counted · <span className="text-rose-600 font-semibold">{summary.losses} loss</span> · <span className="text-emerald-600 font-semibold">{summary.extras} extra</span>
          </span>
          <button onClick={save} disabled={saving || summary.counted === 0} data-testid="stocktake-save"
                  className="iu-btn-primary !h-9 !px-4 text-sm disabled:opacity-50">
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save count
          </button>
        </div>
      </div>

      <p className="text-xs text-slate-500 mb-3 flex items-start gap-1.5">
        <ClipboardCheck size={14} className="text-violet-500 shrink-0 mt-0.5" />
        Counts are taken at the <b className="mx-1">start</b> of the chosen day. Any difference vs the system on-hand is posted as a stock-take loss/extra so the ledgers reconcile — untouched items are left as-is.
      </p>

      {loading ? (
        <div className="text-center py-12"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
      ) : grouped.length === 0 ? (
        <div className="iu-card p-10 text-center text-slate-500" data-testid="stocktake-empty">No items found.</div>
      ) : (
        <div className="space-y-3">
          {grouped.map(([ck, list]) => {
            const isCollapsed = collapsed.has(ck);
            return (
              <div key={ck} className="iu-card overflow-hidden" data-testid={`stocktake-cat-${ck}`}>
                <button onClick={() => toggle(ck)} className="w-full flex items-center gap-2 px-4 py-2.5 bg-slate-50 hover:bg-slate-100 text-left" data-testid={`stocktake-cat-toggle-${ck}`}>
                  {isCollapsed ? <ChevronRight size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
                  <span className="font-bold text-slate-800 text-sm">{catLabel[ck] || ck}</span>
                  <span className="text-xs text-slate-400">· {list.length} item{list.length === 1 ? "" : "s"}</span>
                </button>
                {!isCollapsed && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-[11px] uppercase text-slate-500 bg-white border-b border-slate-100">
                        <tr>
                          <th className="text-left p-2.5">Item</th>
                          <th className="text-left p-2.5 w-16">Unit</th>
                          <th className="text-right p-2.5 w-32">System on-hand</th>
                          <th className="text-right p-2.5 w-36">Physical count</th>
                          <th className="text-right p-2.5 w-36">Variance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((r) => {
                          const v = physical[r.item_id];
                          const has = v !== undefined && v !== "";
                          const variance = has ? num(v) - num(r.system_qty) : null;
                          const loss = variance != null && variance < -1e-9;
                          const extra = variance != null && variance > 1e-9;
                          return (
                            <tr key={r.item_id} className="border-t border-slate-100 hover:bg-slate-50/60" data-testid={`stocktake-row-${r.item_id}`}>
                              <td className="p-2.5 font-semibold text-slate-900">{r.name}</td>
                              <td className="p-2.5 text-slate-500 text-xs">{r.unit}</td>
                              <td className="p-2.5 text-right tabular-nums text-slate-600" data-testid={`stocktake-system-${r.item_id}`}>{fmtQty(r.system_qty, r.unit)}</td>
                              <td className="p-2.5 text-right">
                                <input type="number" min="0" step="0.01" value={v ?? ""}
                                       onChange={(e) => setPhys(r.item_id, e.target.value)}
                                       placeholder="—"
                                       className="iu-input !h-8 !px-2 text-sm w-28 text-right tabular-nums"
                                       data-testid={`stocktake-physical-${r.item_id}`} />
                              </td>
                              <td className={`p-2.5 text-right tabular-nums font-bold ${loss ? "text-rose-700" : extra ? "text-emerald-700" : "text-slate-300"}`} data-testid={`stocktake-variance-${r.item_id}`}>
                                {variance == null ? "—" : Math.abs(variance) < 1e-9 ? (
                                  <span className="text-slate-400 font-medium">no change</span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 justify-end">
                                    {loss ? <TrendingDown size={13} /> : <TrendingUp size={13} />}
                                    {variance > 0 ? "+" : "−"}{fmtQty(Math.abs(variance), r.unit)}
                                  </span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
