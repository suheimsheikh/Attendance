import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Trash2, CalendarDays, Edit3, X } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../../api";
import { useEscape } from "../../hooks/useEscape";

/**
 * /admin/holidays — public-holiday master list.
 *
 * Holidays drive comp-off accrual: any attendance on a holiday date
 * (or the member's `weekly_off`) earns +1 comp-off credit. They are NOT
 * automatically converted to Breaks — if the admin also wants the
 * Presence Board to show "On break · Diwali", they file a separate
 * scope=all Break for the same date on `/admin/calendar`.
 */
export default function Holidays() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null); // null | "new" | row object

  const load = useCallback(async () => {
    try {
      const r = await api.get("/holidays");
      setRows(r || []);
    } catch (err) {
      showApiError(err, "Failed to load holidays");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Grouped by year for a tidier visual scroll on long master lists.
  const byYear = useMemo(() => {
    const groups = {};
    for (const h of rows) {
      const y = (h.date || "").slice(0, 4) || "—";
      (groups[y] = groups[y] || []).push(h);
    }
    return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a));
  }, [rows]);

  const remove = async (h) => {
    if (!window.confirm(`Delete "${h.name}" on ${h.date}? Comp-off credits already accrued from this day won't be recalculated.`)) return;
    try {
      await api.delete(`/holidays/${h.id}`);
      toast.success("Holiday removed");
      load();
    } catch (err) {
      showApiError(err, "Delete failed");
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-[1100px] mx-auto">
      <div className="flex items-center justify-between gap-4 mb-1">
        <div>
          <h1 className="iu-h1 flex items-center gap-2"><CalendarDays className="text-sky-600" size={28} /> Holidays</h1>
          <p className="text-slate-500 text-sm mt-1">
            Public-holiday master list. Any member who attends on a holiday
            (or on their <strong>weekly off</strong>) accrues <strong>+1 comp-off credit</strong> which
            they can later apply via the Comp Off leave type. {rows.length} on record.
          </p>
        </div>
        <button data-testid="add-holiday-button" className="iu-btn-primary inline-flex items-center gap-1.5" onClick={() => setEditing("new")}>
          <Plus size={16} /> Add holiday
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-slate-400"><Loader2 className="animate-spin mr-2" /> Loading…</div>
      ) : rows.length === 0 ? (
        <div className="iu-card text-center py-10 text-slate-500 mt-6">
          No holidays yet. Click <strong>Add holiday</strong> to start the list — Republic Day, Independence Day, Diwali, regional holidays, etc.
        </div>
      ) : (
        <div className="mt-6 space-y-6">
          {byYear.map(([year, list]) => (
            <div key={year} className="iu-card !p-0 overflow-hidden">
              <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 font-bold text-slate-700 text-sm">{year} · {list.length}</div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-slate-50 text-slate-500 text-xs">
                    <th className="iu-table-th !text-left w-32">Date</th>
                    <th className="iu-table-th !text-left">Name</th>
                    <th className="iu-table-th !text-left">Notes</th>
                    <th className="iu-table-th !w-24 !text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((h) => (
                    <tr key={h.id} data-testid={`holiday-row-${h.id}`} className="border-t border-slate-100 hover:bg-sky-50/30">
                      <td className="iu-table-td font-mono text-xs">{h.date}</td>
                      <td className="iu-table-td font-semibold text-slate-800">{h.name}</td>
                      <td className="iu-table-td text-slate-500 text-xs">{h.notes || <span className="text-slate-300">—</span>}</td>
                      <td className="iu-table-td text-right">
                        <button data-testid={`edit-holiday-${h.id}`} className="iu-icon-btn" title="Edit" onClick={() => setEditing(h)}>
                          <Edit3 size={14} />
                        </button>
                        <button data-testid={`delete-holiday-${h.id}`} className="iu-icon-btn !text-red-600" title="Delete" onClick={() => remove(h)}>
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <HolidayForm
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function HolidayForm({ initial, onClose, onSaved }) {
  const isEdit = !!initial?.id;
  useEscape(onClose);
  const [name, setName] = useState(initial?.name || "");
  const [dateStr, setDateStr] = useState(initial?.date || new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState(initial?.notes || "");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) { toast.error("Name is required"); return; }
    if (!dateStr) { toast.error("Date is required"); return; }
    setBusy(true);
    try {
      if (isEdit) {
        await api.patch(`/holidays/${initial.id}`, { name: name.trim(), date: dateStr, notes });
        toast.success("Holiday updated");
      } else {
        await api.post("/holidays", { name: name.trim(), date: dateStr, notes });
        toast.success("Holiday added");
      }
      onSaved();
    } catch (err) {
      showApiError(err, "Save failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="iu-modal-backdrop" onClick={onClose}>
      <div className="iu-modal" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={submit}>
          <header className="iu-modal-header">
            <h2 className="text-lg font-bold">{isEdit ? "Edit holiday" : "Add holiday"}</h2>
            <button type="button" onClick={onClose} className="iu-icon-btn"><X size={16} /></button>
          </header>
          <div className="iu-modal-body space-y-3">
            <div>
              <label className="iu-label">Name</label>
              <input data-testid="holiday-name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} className="iu-input" placeholder="e.g. Diwali" autoFocus />
            </div>
            <div>
              <label className="iu-label">Date</label>
              <input data-testid="holiday-date" required type="date" value={dateStr} onChange={(e) => setDateStr(e.target.value)} className="iu-input" />
            </div>
            <div>
              <label className="iu-label">Notes <span className="text-slate-400 text-xs">(optional)</span></label>
              <textarea data-testid="holiday-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className="iu-input !h-auto py-2" placeholder="e.g. Optional working day, paid holiday, etc." />
            </div>
            <div className="text-xs text-slate-500 bg-sky-50 border border-sky-200 rounded-md px-3 py-2 leading-snug">
              Heads-up: this adds the date to the comp-off accrual pool. To also block attendance on the Presence Board, file a matching <em>scope = Holiday for everyone</em> Break on <strong>Calendar &amp; Breaks</strong>.
            </div>
          </div>
          <footer className="iu-modal-footer">
            <button type="button" onClick={onClose} className="iu-btn-ghost">Cancel</button>
            <button data-testid="holiday-submit" type="submit" disabled={busy} className="iu-btn-primary">{busy ? <Loader2 size={14} className="animate-spin" /> : (isEdit ? "Update" : "Add")}</button>
          </footer>
        </form>
      </div>
    </div>
  );
}
