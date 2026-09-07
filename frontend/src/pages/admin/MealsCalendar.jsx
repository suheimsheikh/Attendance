/**
 * MealsCalendar — read + edit daily meal-count log.
 *
 * Mirrors the July 2026 spreadsheet the chef ingested (Breakfast /
 * Lunch / Dinner / Total per date, sailors + staff combined). Admins
 * can also type new days here — a single PUT upserts the row.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Loader2, CalendarDays, Utensils, Coffee, Moon, Sun, IndianRupee, Pencil, Check, X as CloseIcon, Upload, BarChart3, ChevronDown, ChevronUp, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../../api";
import { formatDate, dayOfWeek } from "../../utils";
import { useAuth } from "../../auth";
import MealsAnalyticsPanel from "./MealsAnalyticsPanel";

const p2 = (n) => String(n).padStart(2, "0");
function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - (n - 1));
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
function firstOfMonth(iso) {
  const [y, m] = iso.split("-");
  return `${y}-${m}-01`;
}
function lastOfMonth(iso) {
  const [y, m] = iso.split("-").map(Number);
  const nxt = new Date(y, m, 0);
  return `${nxt.getFullYear()}-${p2(nxt.getMonth() + 1)}-${p2(nxt.getDate())}`;
}
const inr = (n) => (n == null ? "—" : Number(n).toLocaleString("en-IN"));

function KpiPill({ icon: Icon, label, value, tint }) {
  return (
    <div className={`iu-card !py-1.5 !px-2.5 flex items-center gap-2 ${tint || ""}`}>
      <Icon size={14} className="shrink-0 opacity-70" />
      <div className="text-[10px] uppercase tracking-wide font-semibold text-slate-500 whitespace-nowrap">{label}</div>
      <div className="ml-auto text-sm font-black tabular-nums">{inr(value)}</div>
    </div>
  );
}

function EditRow({ date, initial, onSave, onCancel }) {
  const [d, setD] = useState({
    breakfast: initial?.breakfast ?? 0,
    lunch:     initial?.lunch ?? 0,
    dinner:    initial?.dinner ?? 0,
  });
  const [saving, setSaving] = useState(false);
  const num = (v) => Math.max(0, parseInt(v, 10) || 0);
  const submit = async () => {
    setSaving(true);
    try {
      await onSave({ date, ...d });
    } finally { setSaving(false); }
  };
  const total = d.breakfast + d.lunch + d.dinner;
  return (
    <>
      <td className="p-2 text-right">
        <input type="number" min="0" value={d.breakfast}
               onChange={(e) => setD({ ...d, breakfast: num(e.target.value) })}
               className="iu-input !h-8 !w-20 text-right tabular-nums" data-testid={`mc-edit-bf-${date}`} />
      </td>
      <td className="p-2 text-right">
        <input type="number" min="0" value={d.lunch}
               onChange={(e) => setD({ ...d, lunch: num(e.target.value) })}
               className="iu-input !h-8 !w-20 text-right tabular-nums" data-testid={`mc-edit-l-${date}`} />
      </td>
      <td className="p-2 text-right">
        <input type="number" min="0" value={d.dinner}
               onChange={(e) => setD({ ...d, dinner: num(e.target.value) })}
               className="iu-input !h-8 !w-20 text-right tabular-nums" data-testid={`mc-edit-d-${date}`} />
      </td>
      <td className="p-2 text-right font-bold tabular-nums text-slate-700">{total}</td>
      <td className="p-2 text-right">
        <div className="inline-flex gap-1">
          <button onClick={submit} disabled={saving}
                  className="p-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                  title="Save" data-testid={`mc-save-${date}`}>
            {saving ? <Loader2 size={12} className="animate-spin"/> : <Check size={12}/>}
          </button>
          <button onClick={onCancel} disabled={saving}
                  className="p-1.5 rounded-md bg-slate-200 text-slate-700 hover:bg-slate-300"
                  title="Cancel" data-testid={`mc-cancel-${date}`}>
            <CloseIcon size={12}/>
          </button>
        </div>
      </td>
    </>
  );
}

function ImportCalendarButton({ onDone }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const inputRef = React.useRef(null);
  const pickFile = () => inputRef.current?.click();
  const onPick = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await api.post("/meals/meal-calendar/import", fd);
      setResult(res);
      if (res.inserted || res.updated) onDone?.();
      if (res.skipped > 0 && !res.inserted && !res.updated) {
        toast.info(`${res.skipped} dates already present — none re-imported.`, { duration: 4000 });
      } else if (res.inserted) {
        toast.success(`Imported ${res.inserted} new days.`);
      }
    } catch (err) {
      showApiError(err, "Import failed");
    } finally {
      setBusy(false);
    }
  };
  const overwrite = async () => {
    if (!result?.skipped_dates?.length) return;
    // Re-upload with overwrite=true — cheapest path via the same picker
    const f = inputRef.current?.files?.[0];
    if (!f) { toast.error("Please re-pick the same file to overwrite."); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", f);
      const res = await api.post("/meals/meal-calendar/import?overwrite=true", fd);
      setResult(res);
      if (res.updated || res.inserted) {
        toast.success(`Overwrote ${res.updated}, inserted ${res.inserted}.`);
        onDone?.();
      }
    } catch (err) {
      showApiError(err, "Overwrite failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <input ref={inputRef} type="file" accept=".xlsx" className="hidden"
             onChange={onPick} data-testid="mc-import-input" />
      <button
        type="button" onClick={pickFile} disabled={busy}
        className="iu-btn-secondary !h-9 inline-flex items-center gap-1.5 text-sm"
        data-testid="mc-import-btn"
        title="Import daily meal counts from a monthly spreadsheet (Sailors + Staff B/L/D)"
      >
        {busy ? <Loader2 size={14} className="animate-spin"/> : <Upload size={14}/>}
        Import Daily Meals (.xlsx)
      </button>
      {result && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
             onClick={() => setResult(null)}
             data-testid="mc-import-result-modal">
          <div className="bg-white rounded-xl max-w-md w-full p-5 shadow-2xl"
               onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-2">
              <Upload size={18} className="text-emerald-600"/>
              <h3 className="font-extrabold text-lg">Import result</h3>
            </div>
            <ul className="text-sm space-y-1 mt-3 mb-4">
              <li><b>Sheets read:</b> {result.sheets?.join(", ")}</li>
              <li><b>Rows parsed:</b> {result.parsed}</li>
              <li className="text-emerald-700"><b>Inserted:</b> {result.inserted}</li>
              <li className="text-sky-700"><b>Updated:</b> {result.updated}</li>
              <li className="text-amber-700"><b>Skipped (already present):</b> {result.skipped}</li>
              {result.errors?.length > 0 && (
                <li className="text-rose-700"><b>Errors:</b> {result.errors.length}</li>
              )}
            </ul>
            {result.skipped_dates?.length > 0 && (
              <div className="text-xs bg-amber-50 border border-amber-200 rounded p-2 mb-3">
                <div className="font-semibold text-amber-900 mb-1">Skipped dates ({result.skipped_dates.length}):</div>
                <div className="text-amber-800 max-h-24 overflow-auto">
                  {result.skipped_dates.slice(0, 20).join(", ")}
                  {result.skipped_dates.length > 20 ? ` … +${result.skipped_dates.length - 20} more` : ""}
                </div>
              </div>
            )}
            <div className="flex justify-end gap-2">
              {result.skipped > 0 && (
                <button onClick={overwrite}
                        className="iu-btn-secondary !h-9 !text-rose-700 !border-rose-300 hover:!bg-rose-50"
                        data-testid="mc-import-overwrite">Overwrite existing</button>
              )}
              <button onClick={() => setResult(null)}
                      className="iu-btn-primary !h-9" data-testid="mc-import-close">Done</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default function MealsCalendar() {
  const { user } = useAuth();
  const canEdit = user?.role === "admin" || user?.is_super_admin;
  const today = isoToday();
  // Default the window to the ENTIRE available history so admins
  // see the whole dataset in one shot. `from` starts null and is
  // filled from /meals/meal-calendar/bounds on mount (falls back to
  // ~90 days ago if the endpoint hasn't returned yet or has no data).
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(today);
  const [data, setData] = useState(null);
  const [events, setEvents] = useState(null);
  const [loading, setLoading] = useState(false);
  const [editingDate, setEditingDate] = useState(null);
  const [showEmpty, setShowEmpty] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(true);
  // Track which months are currently EXPANDED. Empty set = all collapsed
  // (the default state each time the window changes).
  const [openMonths, setOpenMonths] = useState(new Set());
  const toggleMonth = (key) => setOpenMonths((prev) => {
    const nxt = new Set(prev);
    if (nxt.has(key)) nxt.delete(key); else nxt.add(key);
    return nxt;
  });

  // On mount, ask the backend for the earliest date we have any data
  // for and use that as the default `from`. Runs once — subsequent
  // manual date-picker changes are respected.
  useEffect(() => {
    api.get("/meals/meal-calendar/bounds")
      .then((b) => {
        if (b?.min_date) setFrom(b.min_date);
        else setFrom(firstOfMonth(today));
      })
      .catch(() => setFrom(firstOfMonth(today)));
  }, []);

  const load = () => {
    if (!from || !to || from > to) return;
    setLoading(true);
    Promise.all([
      api.get(`/meals/meal-calendar?start=${from}&end=${to}`),
      api.get(`/meals/meal-calendar/events?start=${from}&end=${to}`).catch(() => null),
    ])
      .then(([cal, evs]) => { setData(cal); setEvents(evs); })
      .catch((err) => showApiError(err, "Couldn't load meals calendar"))
      .finally(() => setLoading(false));
  };
  useEffect(load, [from, to]);

  const rows = useMemo(() => {
    if (!data?.days) return [];
    return showEmpty ? data.days : data.days.filter((d) => d.has_data || d.date === today);
  }, [data, showEmpty, today]);

  // ── Group rows into month buckets (with populated-only totals) ──
  // Sorted newest month first so the current month sits at the top;
  // all months start collapsed so admins see the year-at-a-glance and
  // expand only the month they care about.
  const months = useMemo(() => {
    const map = new Map();
    (rows || []).forEach((d) => {
      const key = d.date.slice(0, 7);   // "YYYY-MM"
      if (!map.has(key)) {
        map.set(key, {
          key,
          label: new Date(d.date + "T00:00:00").toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
          rows: [],
          totals: { breakfast: 0, lunch: 0, dinner: 0, total: 0, days: 0 },
        });
      }
      const g = map.get(key);
      g.rows.push(d);
      if (d.has_data) {
        g.totals.breakfast += d.breakfast;
        g.totals.lunch += d.lunch;
        g.totals.dinner += d.dinner;
        g.totals.total += d.total;
        g.totals.days += 1;
      }
    });
    // Newest first (Aug, Jul, Jun, …)
    return [...map.values()].sort((a, b) => b.key.localeCompare(a.key));
  }, [rows]);

  // Default: every month collapsed. Whenever the fetched range changes,
  // reset the expansion so the user always starts at the year-at-a-glance
  // view (a preserved-open month from a different range would be confusing).
  useEffect(() => {
    setOpenMonths(new Set());
  }, [data?.start, data?.end]);

  const shift = (months) => {
    const [y, m] = from.split("-").map(Number);
    const d = new Date(y, m - 1 + months, 15);
    const iso = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-15`;
    setFrom(firstOfMonth(iso));
    setTo(lastOfMonth(iso));
  };

  const saveRow = async (payload) => {
    try {
      await api.put(`/meals/meal-calendar`, payload);
      toast.success(`Saved ${formatDate(payload.date)}`);
      setEditingDate(null);
      load();
    } catch (err) {
      showApiError(err, "Couldn't save");
    }
  };

  return (
    <div className="p-4 sm:p-6 max-w-[1200px] mx-auto" data-testid="meals-calendar-page">
      <div className="flex flex-wrap items-center gap-2 mb-4 pr-4 lg:pr-56">
        <CalendarDays size={22} className="text-emerald-600" />
        <h1 className="text-2xl sm:text-3xl font-black text-slate-900">Consumption</h1>
        <div className="flex-1 min-w-[16px]" />
        <div className="flex items-center gap-2 flex-wrap">
        {canEdit && (
          <ImportCalendarButton onDone={load} />
        )}
        </div>
      </div>
      <p className="text-sm text-slate-500 mb-5">
        Daily meal counts (Sailors + Staff combined). Data before Aug 2026 was imported from the historical
        &ldquo;Sailors and Staff food consumption&rdquo; spreadsheet.
      </p>

      <div className="iu-card p-3 mb-4 flex items-center gap-2 flex-wrap" data-testid="meals-calendar-controls">
        <button onClick={() => shift(-1)} className="iu-btn-secondary !h-9" data-testid="mc-prev-month">‹ Prev month</button>
        <div className="flex items-center gap-1 mx-2">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                 className="iu-input !h-9 !w-auto text-sm" data-testid="mc-from" />
          <span className="text-slate-400 text-xs">→</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                 className="iu-input !h-9 !w-auto text-sm" data-testid="mc-to" />
        </div>
        <button onClick={() => shift(1)} className="iu-btn-secondary !h-9" data-testid="mc-next-month">Next month ›</button>
        <button onClick={() => { setFrom(isoDaysAgo(30)); setTo(today); }} className="iu-btn-secondary !h-9 text-xs" data-testid="mc-last-30">Last 30d</button>
        <div className="flex-1" />
        <label className="text-xs text-slate-600 inline-flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} data-testid="mc-show-empty" />
          Show days with no data
        </label>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        <KpiPill icon={Coffee}   label="Breakfast" value={data?.totals?.breakfast || 0} tint="bg-amber-50" />
        <KpiPill icon={Sun}      label="Lunch"     value={data?.totals?.lunch || 0}     tint="bg-orange-50" />
        <KpiPill icon={Moon}     label="Dinner"    value={data?.totals?.dinner || 0}    tint="bg-indigo-50" />
        <KpiPill icon={Utensils} label="Total"     value={data?.totals?.total || 0}     tint="bg-emerald-50" />
      </div>

      {data?.days && (
        <div className="mb-4">
          <button
            type="button"
            onClick={() => setShowAnalytics((v) => !v)}
            className="inline-flex items-center gap-1.5 text-sm font-bold text-slate-700 hover:text-slate-900 mb-2"
            data-testid="mc-toggle-analytics"
          >
            <BarChart3 size={16} className="text-emerald-600"/>
            Analytics
            {showAnalytics ? <ChevronUp size={14}/> : <ChevronDown size={14}/>}
          </button>
          {showAnalytics && <MealsAnalyticsPanel days={data.days} events={events} />}
        </div>
      )}

      <div className="iu-card overflow-auto" data-testid="meals-calendar-table-wrap">
        <table className="w-full text-sm">
          <thead className="bg-slate-900 text-white">
            <tr className="text-[11px] uppercase tracking-wider">
              <th className="text-left p-2.5">Date</th>
              <th className="text-right p-2.5"><Coffee size={12} className="inline mr-1" />Breakfast</th>
              <th className="text-right p-2.5"><Sun size={12} className="inline mr-1" />Lunch</th>
              <th className="text-right p-2.5"><Moon size={12} className="inline mr-1" />Dinner</th>
              <th className="text-right p-2.5 bg-emerald-700">Total</th>
              {canEdit && <th className="text-right p-2.5 w-16"> </th>}
            </tr>
          </thead>
          <tbody data-testid="meals-calendar-tbody">
            {loading ? (
              <tr><td colSpan={canEdit ? 6 : 5} className="text-center py-10"><Loader2 className="animate-spin inline text-slate-400"/></td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={canEdit ? 6 : 5} className="text-center py-10 text-slate-400">No data in this window.</td></tr>
            ) : months.map((month) => {
              const collapsed = !openMonths.has(month.key);
              return (
                <React.Fragment key={month.key}>
                  <tr
                    className="bg-slate-100 hover:bg-slate-200 cursor-pointer border-t-2 border-slate-300 sticky"
                    onClick={() => toggleMonth(month.key)}
                    data-testid={`mc-month-header-${month.key}`}
                  >
                    <td className="p-2.5 font-black text-slate-900 whitespace-nowrap">
                      {collapsed ? <ChevronRight size={14} className="inline mr-1 -mt-0.5"/> : <ChevronDown size={14} className="inline mr-1 -mt-0.5"/>}
                      {month.label}
                      <span className="ml-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                        {month.totals.days} day{month.totals.days !== 1 ? "s" : ""}
                      </span>
                    </td>
                    <td className="p-2.5 text-right font-black tabular-nums text-slate-800">{inr(month.totals.breakfast)}</td>
                    <td className="p-2.5 text-right font-black tabular-nums text-slate-800">{inr(month.totals.lunch)}</td>
                    <td className="p-2.5 text-right font-black tabular-nums text-slate-800">{inr(month.totals.dinner)}</td>
                    <td className="p-2.5 text-right font-black tabular-nums text-emerald-700 bg-emerald-50">{inr(month.totals.total)}</td>
                    {canEdit && <td className="p-2.5"/>}
                  </tr>
                  {!collapsed && month.rows.map((d) => {
                    const isEdit = editingDate === d.date;
                    const isSun = dayOfWeek(d.date) === "Sun";
                    return (
                      <tr key={d.date}
                          className={`border-t border-slate-100 ${isSun ? "bg-rose-50/40" : "hover:bg-slate-50"} ${isEdit ? "bg-emerald-50/40" : ""}`}
                          data-testid={`mc-row-${d.date}`}>
                        <td className="p-2 pl-8 font-semibold text-slate-800 whitespace-nowrap" data-testid={`mc-date-${d.date}`}>
                          {formatDate(d.date)}
                          {d.source === "spreadsheet-jul2026" && (
                            <span className="ml-2 text-[9px] font-bold uppercase tracking-wider bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded" title="Imported from the July 2026 spreadsheet">Imported</span>
                          )}
                          {d.source === "muster" && (
                            <span className="ml-2 text-[9px] font-bold uppercase tracking-wider bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded" title="Auto-derived from per-person Meals Muster marks">From Muster</span>
                          )}
                          {d.source === "manual" && (
                            <span className="ml-2 text-[9px] font-bold uppercase tracking-wider bg-sky-100 text-sky-800 px-1.5 py-0.5 rounded" title="Typed in by an admin">Manual</span>
                          )}
                          {d.source?.startsWith?.("upload:") && (
                            <span className="ml-2 text-[9px] font-bold uppercase tracking-wider bg-amber-100 text-amber-800 px-1.5 py-0.5 rounded" title={`Imported from ${d.source.slice(7)}`}>Imported</span>
                          )}
                        </td>
                        {isEdit ? (
                          <EditRow
                            date={d.date}
                            initial={d}
                            onSave={saveRow}
                            onCancel={() => setEditingDate(null)}
                          />
                        ) : (
                          <>
                            <td className="p-2 text-right tabular-nums" data-testid={`mc-bf-${d.date}`}>{d.has_data ? d.breakfast : <span className="text-slate-300">—</span>}</td>
                            <td className="p-2 text-right tabular-nums" data-testid={`mc-l-${d.date}`}>{d.has_data ? d.lunch : <span className="text-slate-300">—</span>}</td>
                            <td className="p-2 text-right tabular-nums" data-testid={`mc-d-${d.date}`}>{d.has_data ? d.dinner : <span className="text-slate-300">—</span>}</td>
                            <td className={`p-2 text-right tabular-nums font-bold ${d.has_data ? "text-emerald-700" : "text-slate-300"}`} data-testid={`mc-total-${d.date}`}>
                              {d.has_data ? d.total : "—"}
                            </td>
                            {canEdit && (
                              <td className="p-2 text-right">
                                <button
                                  onClick={() => setEditingDate(d.date)}
                                  className="p-1.5 rounded-md text-slate-500 hover:bg-slate-200"
                                  title="Edit this day"
                                  data-testid={`mc-edit-btn-${d.date}`}
                                ><Pencil size={12}/></button>
                              </td>
                            )}
                          </>
                        )}
                      </tr>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </tbody>
          {rows.length > 0 && data?.totals && (
            <tfoot className="bg-slate-900 text-white">
              <tr>
                <td className="p-2.5 font-black">TOTAL</td>
                <td className="p-2.5 text-right font-black tabular-nums">{inr(data.totals.breakfast)}</td>
                <td className="p-2.5 text-right font-black tabular-nums">{inr(data.totals.lunch)}</td>
                <td className="p-2.5 text-right font-black tabular-nums">{inr(data.totals.dinner)}</td>
                <td className="p-2.5 text-right font-black tabular-nums text-emerald-300">{inr(data.totals.total)}</td>
                {canEdit && <td/>}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
