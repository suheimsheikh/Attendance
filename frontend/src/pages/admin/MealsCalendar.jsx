/**
 * MealsCalendar — read + edit daily meal-count log.
 *
 * Mirrors the July 2026 spreadsheet the chef ingested (Breakfast /
 * Lunch / Dinner / Total per date, sailors + staff combined). Admins
 * can also type new days here — a single PUT upserts the row.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Loader2, CalendarDays, Utensils, Coffee, Moon, Sun, IndianRupee, Pencil, Check, X as CloseIcon } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../../api";
import { formatDate, dayOfWeek } from "../../utils";
import { useAuth } from "../../auth";

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

function KpiCard({ icon: Icon, label, value, tint }) {
  return (
    <div className={`iu-card p-3 flex items-center gap-3 ${tint || ""}`}>
      <div className="w-10 h-10 rounded-lg bg-white/70 flex items-center justify-center shrink-0">
        <Icon size={18} />
      </div>
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wide font-semibold text-slate-500">{label}</div>
        <div className="text-2xl font-black tabular-nums truncate">{inr(value)}</div>
      </div>
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

export default function MealsCalendar() {
  const { user } = useAuth();
  const canEdit = user?.role === "admin" || user?.is_super_admin;
  const today = isoToday();
  const [from, setFrom] = useState(firstOfMonth(today));
  const [to, setTo] = useState(lastOfMonth(today));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [editingDate, setEditingDate] = useState(null);
  const [showEmpty, setShowEmpty] = useState(false);

  const load = () => {
    if (!from || !to || from > to) return;
    setLoading(true);
    api.get(`/meals/meal-calendar?start=${from}&end=${to}`)
      .then(setData)
      .catch((err) => showApiError(err, "Couldn't load meals calendar"))
      .finally(() => setLoading(false));
  };
  useEffect(load, [from, to]);

  const rows = useMemo(() => {
    if (!data?.days) return [];
    return showEmpty ? data.days : data.days.filter((d) => d.has_data || d.date === today);
  }, [data, showEmpty, today]);

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
      <div className="flex items-center gap-2 mb-4">
        <CalendarDays size={22} className="text-emerald-600" />
        <h1 className="text-2xl sm:text-3xl font-black text-slate-900">Meals Calendar</h1>
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
        <KpiCard icon={Coffee}   label="Breakfast total" value={data?.totals?.breakfast || 0} tint="bg-amber-50" />
        <KpiCard icon={Sun}      label="Lunch total"     value={data?.totals?.lunch || 0}     tint="bg-orange-50" />
        <KpiCard icon={Moon}     label="Dinner total"    value={data?.totals?.dinner || 0}    tint="bg-indigo-50" />
        <KpiCard icon={Utensils} label="Grand total"     value={data?.totals?.total || 0}     tint="bg-emerald-50" />
      </div>

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
            ) : rows.map((d) => {
              const isEdit = editingDate === d.date;
              const isSun = dayOfWeek(d.date) === "Sun";
              return (
                <tr key={d.date}
                    className={`border-t border-slate-100 ${isSun ? "bg-rose-50/40" : "hover:bg-slate-50"} ${isEdit ? "bg-emerald-50/40" : ""}`}
                    data-testid={`mc-row-${d.date}`}>
                  <td className="p-2 font-semibold text-slate-800 whitespace-nowrap" data-testid={`mc-date-${d.date}`}>
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
