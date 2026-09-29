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
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Loader2, ClipboardCheck, Save, Search, ChevronDown, ChevronRight, TrendingDown, TrendingUp, Printer, ClipboardList, BarChart3 } from "lucide-react";
import { api, showApiError } from "../../api";
import { formatDate, fmtQty } from "../../utils";
import StockVarianceReport from "./StockVarianceReport";

const todayISO = () => new Date().toLocaleDateString("sv-SE");
const num = (v) => { const n = Number(v); return isFinite(n) ? n : 0; };
const rupee = (n) => `₹${Math.abs(Number(n) || 0).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

export default function MealStockTakeTab({ liveSig }) {
  const [view, setView] = useState("count");   // count | report
  const [dateStr, setDateStr] = useState(todayISO());
  const [rows, setRows] = useState([]);
  const [cats, setCats] = useState([]);
  const [physical, setPhysical] = useState({});   // item_id -> string
  const [rates, setRates] = useState({});         // item_id -> string (₹/unit, first-count only)
  const [lastRates, setLastRates] = useState({}); // item_id -> {rate, date} last buying rate (read-only)
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rowSaving, setRowSaving] = useState(null);   // item_id currently saving via Enter
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState(new Set());
  const dirty = useRef(false);

  const load = useCallback((silent = false) => {
    if (!silent) setLoading(true);
    // "Before" = day AFTER the count date so a purchase made on the
    // count day still counts as the last buying rate.
    const nextDay = (() => {
      const d = new Date(dateStr + "T00:00:00"); d.setDate(d.getDate() + 1);
      return d.toLocaleDateString("sv-SE");
    })();
    Promise.all([
      api.get(`/meals/stock-take?date=${dateStr}`),
      api.get(`/meals/items/last-rates?before=${nextDay}`).catch(() => ({ rates: {} })),
    ])
      .then(([r, lr]) => {
        setRows(r.rows || []);
        setCats(r.categories || []);
        setLastRates(lr.rates || {});
        // Prefill any already-recorded physical counts for the day.
        const pre = {};
        (r.rows || []).forEach((x) => { if (x.physical_qty != null) pre[x.item_id] = String(x.physical_qty); });
        setPhysical(pre);
        setRates({});
        dirty.current = false;
      })
      .catch((e) => { if (!silent) showApiError(e, "Couldn't load stock-take sheet"); })
      .finally(() => { if (!silent) setLoading(false); });
  }, [dateStr]);

  useEffect(() => { load(); }, [load]);
  // Refetch on live pantry signals — SILENTLY (no full-page spinner, no
  // flicker) and only when the user has no unsaved edits, so another
  // machine's change updates the sheet in place instead of "refreshing".
  useEffect(() => { if (liveSig && !dirty.current) load(true); }, [liveSig, load]);

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

  const isOpening = (r) => r.needs_rate && rates[r.item_id] !== undefined && rates[r.item_id] !== "" && num(rates[r.item_id]) > 0;

  const summary = useMemo(() => {
    let counted = 0, losses = 0, extras = 0, openings = 0, lossValue = 0, extraValue = 0;
    rows.forEach((r) => {
      const v = physical[r.item_id];
      if (v === undefined || v === "") return;
      counted += 1;
      if (r.needs_rate && num(rates[r.item_id]) > 0) { openings += 1; return; }
      const variance = num(v) - num(r.system_qty);
      if (Math.abs(variance) < 1e-9) return;
      const rate = num(lastRates[r.item_id]?.rate ?? r.avg_rate);
      if (variance > 0) { extras += 1; extraValue += variance * rate; }
      else { losses += 1; lossValue += Math.abs(variance) * rate; }
    });
    return { counted, losses, extras, openings, lossValue, extraValue };
  }, [rows, physical, rates, lastRates]);

  const setPhys = (id, val) => { dirty.current = true; setPhysical((p) => ({ ...p, [id]: val })); };
  const setRate = (id, val) => { dirty.current = true; setRates((p) => ({ ...p, [id]: val })); };
  const needsRateCount = useMemo(() => rows.filter((r) => r.needs_rate).length, [rows]);
  const toggle = (k) => setCollapsed((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const save = async () => {
    const lines = rows
      .filter((r) => { const v = physical[r.item_id]; return v !== undefined && v !== ""; })
      .map((r) => {
        const line = { item_id: r.item_id, physical_qty: num(physical[r.item_id]) };
        const rt = rates[r.item_id];
        if (r.needs_rate && rt !== undefined && rt !== "" && num(rt) > 0) line.rate = num(rt);
        return line;
      });
    if (lines.length === 0) { toast.info("Enter at least one physical count first."); return; }
    setSaving(true);
    try {
      const res = await api.post("/meals/stock-take", { date: dateStr, lines });
      const opening = res.opening_set ? ` · ${res.opening_set} opening balance${res.opening_set === 1 ? "" : "s"} set` : "";
      toast.success(`Stock-take saved · ${res.counted} counted · ${res.losses} loss${res.losses === 1 ? "" : "es"} · ${res.extras} extra${res.extras === 1 ? "" : "s"}${opening}`);
      dirty.current = false;
      load();
    } catch (e) {
      showApiError(e, "Couldn't save stock-take");
    } finally {
      setSaving(false);
    }
  };

  // Save a single row immediately (Enter key). Optimistically marks the row
  // as counted without reloading the whole sheet, so entering item-by-item
  // feels instant and doesn't disturb other rows being edited.
  const saveRow = async (r) => {
    const v = physical[r.item_id];
    if (v === undefined || v === "") { toast.info(`Enter a count for ${r.name} first.`); return; }
    const line = { item_id: r.item_id, physical_qty: num(v) };
    const rt = rates[r.item_id];
    if (r.needs_rate && rt !== undefined && rt !== "" && num(rt) > 0) line.rate = num(rt);
    setRowSaving(r.item_id);
    try {
      const res = await api.post("/meals/stock-take", { date: dateStr, lines: [line] });
      const rl = (res.lines || [])[0] || {};
      setRows((rws) => rws.map((x) => x.item_id === r.item_id ? {
        ...x,
        physical_qty: num(v),
        variance: rl.kind === "opening" ? null : (rl.qty ?? (num(v) - num(x.system_qty))),
        recorded: true,
        recorded_by: rl.by_name || "you",
        recorded_at: rl.at || new Date().toISOString(),
      } : x));
      toast.success(`${r.name} saved`);
    } catch (e) {
      showApiError(e, `Couldn't save ${r.name}`);
    } finally {
      setRowSaving(null);
    }
  };

  const handlePrint = () => {
    document.body.classList.add("stocktake-print-active");
    const cleanup = () => {
      document.body.classList.remove("stocktake-print-active");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.print();
  };

  return (
    <div data-testid="meal-stocktake-tab">
      <div className="flex rounded-lg overflow-hidden ring-1 ring-slate-200 w-fit mb-4" data-testid="stocktake-view-toggle">
        {[["count", "Count sheet", ClipboardList], ["report", "Variance & audit", BarChart3]].map(([v, l, Ic]) => (
          <button key={v} onClick={() => setView(v)} data-testid={`stocktake-view-${v}`}
                  title={v === "count" ? "Enter this week's physical stock count" : "See ranked losses/extras and the who/when audit trail"}
                  className={`px-4 h-9 text-sm font-bold inline-flex items-center gap-1.5 ${view === v ? "bg-violet-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}>
            <Ic size={15} /> {l}
          </button>
        ))}
      </div>

      {view === "report" ? <StockVarianceReport liveSig={liveSig} /> : (
      <>
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
            <b>{summary.counted}</b> counted · <span className="text-rose-600 font-semibold">{summary.losses} loss{summary.lossValue > 0 && <> (−{rupee(summary.lossValue)})</>}</span> · <span className="text-emerald-600 font-semibold">{summary.extras} extra{summary.extraValue > 0 && <> (+{rupee(summary.extraValue)})</>}</span>{summary.openings > 0 && <> · <span className="text-amber-700 font-semibold">{summary.openings} opening</span></>}
          </span>
          <button onClick={handlePrint} data-testid="stocktake-print"
                  className="iu-btn-secondary !h-9 !px-3 text-sm" title="Print a blank count sheet to tick on paper first">
            <Printer size={15} /> Print sheet
          </button>
          <button onClick={save} disabled={saving || summary.counted === 0} data-testid="stocktake-save"
                  className="iu-btn-primary !h-9 !px-4 text-sm disabled:opacity-50"
                  title="Save every physical count entered on this sheet in one go. (You can also press Enter in any row to save just that item.)">
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Save all
          </button>
        </div>
      </div>

      <p className="text-xs text-slate-500 mb-3 flex items-start gap-1.5">
        <ClipboardCheck size={14} className="text-violet-500 shrink-0 mt-0.5" />
        Counts are taken at the <b className="mx-1">start</b> of the chosen day. Any difference vs the system on-hand is posted as a stock-take loss/gain so the ledgers reconcile — untouched items are left as-is. <b className="ml-1">Tip:</b>&nbsp;press <kbd className="px-1 py-0.5 rounded bg-slate-100 border border-slate-300 text-[10px] font-mono">Enter</kbd> in a row to save just that item, or <b>Save all</b> to save the whole sheet at once.
      </p>
      {needsRateCount > 0 && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3" data-testid="stocktake-opening-hint">
          <b>{needsRateCount} item{needsRateCount === 1 ? " has" : "s have"} no cost history yet.</b> Enter a ₹/unit rate alongside the count and it becomes the item's <b>opening balance</b> as of this date (so stock value is right from day one). Leave the rate blank to record just the quantity.
        </p>
      )}

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
                <button onClick={() => toggle(ck)} className="w-full flex items-center gap-2 px-4 py-2.5 bg-slate-50 hover:bg-slate-100 text-left" data-testid={`stocktake-cat-toggle-${ck}`} title={isCollapsed ? "Expand this category" : "Collapse this category"}>
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
                          <th className="text-right p-2.5 w-32">Rate ₹/unit</th>
                          <th className="text-right p-2.5 w-32">Variance</th>
                          <th className="text-right p-2.5 w-32">Loss / Gain (₹)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((r) => {
                          const v = physical[r.item_id];
                          const has = v !== undefined && v !== "";
                          const opening = has && isOpening(r);
                          const variance = has && !opening ? num(v) - num(r.system_qty) : null;
                          const loss = variance != null && variance < -1e-9;
                          const extra = variance != null && variance > 1e-9;
                          const rate = num(lastRates[r.item_id]?.rate ?? r.avg_rate);
                          const varValue = variance != null && rate > 0 ? variance * rate : null;
                          return (
                            <tr key={r.item_id} className="border-t border-slate-100 hover:bg-slate-50/60" data-testid={`stocktake-row-${r.item_id}`}>
                              <td className="p-2.5 font-semibold text-slate-900">
                                {r.name}
                                {r.recorded && r.recorded_by && (
                                  <span className="block text-[10px] font-normal text-violet-600 mt-0.5" data-testid={`stocktake-by-${r.item_id}`} title={r.recorded_at ? `Counted on ${formatDate(r.recorded_at)}` : ""}>
                                    ✓ counted by {r.recorded_by}
                                  </span>
                                )}
                              </td>
                              <td className="p-2.5 text-slate-500 text-xs">{r.unit}</td>
                              <td className="p-2.5 text-right tabular-nums text-slate-600" data-testid={`stocktake-system-${r.item_id}`}>{fmtQty(r.system_qty, r.unit)}</td>
                              <td className="p-2.5 text-right">
                                <input type="number" min="0" step="0.01" value={v ?? ""}
                                       onChange={(e) => setPhys(r.item_id, e.target.value)}
                                       onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveRow(r); } }}
                                       placeholder="—"
                                       title={`Enter the physical quantity of ${r.name} you counted (system shows ${fmtQty(r.system_qty, r.unit)} ${r.unit || ""}). Press Enter to save this row.`}
                                       className="iu-input !h-8 !px-2 text-sm w-28 text-right tabular-nums"
                                       data-testid={`stocktake-physical-${r.item_id}`} />
                                {rowSaving === r.item_id && <Loader2 size={12} className="inline animate-spin ml-1 text-violet-500" />}
                              </td>
                              <td className="p-2.5 text-right">
                                {r.needs_rate ? (
                                  <div className="inline-flex flex-col items-end gap-0.5">
                                    <input type="number" min="0" step="0.01" value={rates[r.item_id] ?? ""}
                                           onChange={(e) => setRate(r.item_id, e.target.value)}
                                           onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveRow(r); } }}
                                           placeholder="₹/unit"
                                           title={`No purchase history for ${r.name} yet — enter its ₹ per ${r.unit || "unit"} to set a valued opening balance`}
                                           className="iu-input !h-8 !px-2 text-sm w-24 text-right tabular-nums border-amber-300"
                                           data-testid={`stocktake-rate-${r.item_id}`} />
                                    {num(lastRates[r.item_id]?.rate) > 0 && (
                                      <button type="button"
                                              onClick={() => setRate(r.item_id, String(num(lastRates[r.item_id].rate)))}
                                              className="text-[10px] font-semibold text-violet-600 hover:text-violet-800 hover:underline"
                                              title={`Use last purchase rate ₹${num(lastRates[r.item_id].rate).toFixed(2)}${lastRates[r.item_id]?.date ? ` from ${formatDate(lastRates[r.item_id].date)}` : ""}`}
                                              data-testid={`stocktake-uselastrate-${r.item_id}`}>
                                        use ₹{num(lastRates[r.item_id].rate).toFixed(2)}
                                      </button>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-xs text-slate-500 tabular-nums" data-testid={`stocktake-avgrate-${r.item_id}`}
                                        title={lastRates[r.item_id]?.date ? `Last buying rate, from the purchase on ${formatDate(lastRates[r.item_id].date)}` : "Weighted-average purchase rate"}>
                                    ₹{num(lastRates[r.item_id]?.rate ?? r.avg_rate).toFixed(2)}
                                  </span>
                                )}
                              </td>
                              <td className={`p-2.5 text-right tabular-nums font-bold ${loss ? "text-rose-700" : extra ? "text-emerald-700" : "text-slate-300"}`} data-testid={`stocktake-variance-${r.item_id}`}>
                                {opening ? (
                                  <span className="text-amber-700 font-semibold text-xs">opening balance</span>
                                ) : variance == null ? "—" : Math.abs(variance) < 1e-9 ? (
                                  <span className="text-slate-400 font-medium">no change</span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 justify-end">
                                    {loss ? <TrendingDown size={13} /> : <TrendingUp size={13} />}
                                    {variance > 0 ? "+" : "−"}{fmtQty(Math.abs(variance), r.unit)}
                                  </span>
                                )}
                              </td>
                              <td className="p-2.5 text-right tabular-nums" data-testid={`stocktake-varvalue-${r.item_id}`}>
                                {opening || variance == null || Math.abs(variance) < 1e-9 ? (
                                  <span className="text-slate-300">—</span>
                                ) : varValue == null ? (
                                  <span className="text-slate-300 text-xs" title="No rate available to value this variance">no rate</span>
                                ) : (
                                  <span className={`font-bold ${loss ? "text-rose-600" : "text-emerald-600"}`}>
                                    {loss ? `−${rupee(varValue)}` : `+${rupee(varValue)}`}
                                    <span className="block text-[10px] font-semibold opacity-80">{loss ? "loss" : "gain"}</span>
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
      </>
      )}

      {/* Printable count sheet — blank physical column to tick on paper. */}
      {view === "count" && typeof document !== "undefined" && createPortal(
        <div className="hidden print:block bg-white" data-testid="stocktake-print-region">
          <div className="border-b-2 border-slate-800 pb-3 mb-4">
            <h1 className="text-2xl font-extrabold text-slate-900">Stock-take Count Sheet</h1>
            <p className="text-sm text-slate-600 mt-1">Count date: {formatDate(dateStr)} · Printed {new Date().toLocaleString("en-GB", { timeZone: "Asia/Kolkata" })}</p>
            <p className="text-xs text-slate-500 mt-1">Fill <b>Physical count</b> for every item. Where the Rate column is blank the item has no cost history yet — write its ₹ per unit so the opening value is captured. Use the write-in rows for items not on the list (add them to Stock Master afterwards).</p>
          </div>
          {grouped.map(([ck, list]) => (
            <section key={ck} className="mb-4 break-inside-avoid">
              <h2 className="text-sm font-extrabold uppercase tracking-wider bg-slate-100 px-2 py-1 mb-2">{catLabel[ck] || ck}</h2>
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-slate-400 text-xs text-slate-600 uppercase">
                    <th className="text-left p-1 w-8">#</th>
                    <th className="text-left p-1">Item</th>
                    <th className="text-left p-1 w-16">Unit</th>
                    <th className="text-right p-1 w-24">System</th>
                    <th className="text-right p-1 w-32">Physical count</th>
                    <th className="text-right p-1 w-28">Rate ₹/unit</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r, idx) => (
                    <tr key={r.item_id} className="border-b border-slate-200">
                      <td className="p-1 text-slate-500 tabular-nums">{idx + 1}</td>
                      <td className="p-1 font-semibold">{r.name}</td>
                      <td className="p-1 text-slate-600">{r.unit}</td>
                      <td className="p-1 text-right tabular-nums text-slate-700">{fmtQty(r.system_qty, r.unit)}</td>
                      <td className="p-1 text-right">______________</td>
                      <td className="p-1 text-right tabular-nums text-slate-700">{r.needs_rate ? "__________" : `₹${num(lastRates[r.item_id]?.rate ?? r.avg_rate).toFixed(2)}`}</td>
                    </tr>
                  ))}
                  {[0, 1].map((i) => (
                    <tr key={`blank-${i}`} className="border-b border-dashed border-slate-300 text-slate-400">
                      <td className="p-1 tabular-nums">{list.length + i + 1}</td>
                      <td className="p-1 italic text-xs">write-in: ____________________________</td>
                      <td className="p-1">______</td>
                      <td className="p-1 text-right">—</td>
                      <td className="p-1 text-right">______________</td>
                      <td className="p-1 text-right">__________</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
          <div className="mt-8 flex gap-16 text-sm text-slate-700">
            <div>Counted by: ______________________</div>
            <div>Verified by: ______________________</div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
