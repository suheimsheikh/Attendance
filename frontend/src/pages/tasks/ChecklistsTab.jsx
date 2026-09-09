import React, { useEffect, useState } from "react";
import { Plus, Trash2, Loader2, Repeat } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";

const DOW = [["monday", "Mon"], ["tuesday", "Tue"], ["wednesday", "Wed"], ["thursday", "Thu"], ["friday", "Fri"], ["saturday", "Sat"], ["sunday", "Sun"]];
const EMPTY = { title: "", recurrence: "daily", days_of_week: [], day_of_month: "1" };

export function recurrenceLabel(c) {
  if (c.recurrence === "daily") return "Every day";
  if (c.recurrence === "dow") return (c.days_of_week || []).map((d) => d.slice(0, 3)).map((s) => s[0].toUpperCase() + s.slice(1)).join(", ");
  return c.day_of_month === "last_working" ? "Last working day of month" : `Day ${c.day_of_month} of every month`;
}

export default function ChecklistsTab({ user, group }) {
  const [ownerId, setOwnerId] = useState(user.id);
  const [rows, setRows] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const mine = ownerId === user.id;

  const load = () => api.get("/checklists", { owner_id: ownerId }).then((r) => setRows(r.rows)).catch((e) => toast.error(e?.message || "Failed"));
  useEffect(() => { load(); }, [ownerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/checklists", form);
      setForm(EMPTY); toast.success("Checklist item added"); load();
    } catch (err) { toast.error(err?.message || "Couldn't add"); }
    finally { setBusy(false); }
  };
  const remove = async (c) => {
    if (!window.confirm(`Remove "${c.title}" from the checklist?`)) return;
    try { await api.del(`/checklists/${c.id}`); load(); } catch (err) { toast.error(err?.message || "Not allowed"); }
  };
  const toggleActive = async (c) => {
    try { await api.patch(`/checklists/${c.id}`, { ...c, active: !c.active }); load(); } catch (err) { toast.error(err?.message || "Not allowed"); }
  };
  const toggleDow = (d) => setForm((f) => ({ ...f, days_of_week: f.days_of_week.includes(d) ? f.days_of_week.filter((x) => x !== d) : [...f.days_of_week, d] }));

  return (
    <div data-testid="checklists-tab">
      {group.length > 1 && (
        <div className="flex items-center gap-2 mb-3 text-xs">
          <span className="text-slate-500">Viewing:</span>
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)} className="iu-input !h-8 !w-auto text-xs" data-testid="checklist-owner">
            <option value={user.id}>My checklist</option>
            {group.filter((m) => m.id !== user.id).map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
          </select>
        </div>
      )}
      {mine && (
        <form onSubmit={add} className="iu-card p-3 md:p-4 mb-4 space-y-2" data-testid="checklist-add-form">
          <div className="grid gap-2 md:grid-cols-[1fr_auto_auto]">
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Must-do item, e.g. Reconcile petty cash" className="iu-input !h-10 text-sm" data-testid="checklist-title" required />
            <select value={form.recurrence} onChange={(e) => setForm({ ...form, recurrence: e.target.value })} className="iu-input !h-10 !w-auto text-sm" data-testid="checklist-recurrence">
              <option value="daily">Daily</option><option value="dow">Days of week</option><option value="monthly">Monthly</option>
            </select>
            <button className="iu-btn-primary !h-10" disabled={busy} data-testid="checklist-add">{busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Add</button>
          </div>
          {form.recurrence === "dow" && (
            <div className="flex flex-wrap gap-1.5" data-testid="checklist-dow">
              {DOW.map(([v, l]) => (
                <button type="button" key={v} onClick={() => toggleDow(v)} data-testid={`checklist-dow-${v}`}
                        className={`px-3 h-8 rounded-full text-xs font-semibold ${form.days_of_week.includes(v) ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-700"}`}>{l}</button>
              ))}
            </div>
          )}
          {form.recurrence === "monthly" && (
            <div className="flex items-center gap-2 text-xs text-slate-600">
              On
              <select value={form.day_of_month} onChange={(e) => setForm({ ...form, day_of_month: e.target.value })} className="iu-input !h-8 !w-auto text-xs" data-testid="checklist-dom">
                {Array.from({ length: 31 }, (_, i) => String(i + 1)).map((d) => <option key={d} value={d}>{`day ${d}`}</option>)}
                <option value="last_working">last working day</option>
              </select>
              of every month
            </div>
          )}
        </form>
      )}
      {rows === null ? <div className="text-center py-8"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
        : rows.length === 0 ? <div className="iu-card p-8 text-center text-sm text-slate-400 italic" data-testid="checklists-empty">No checklist items yet.</div>
        : (
          <ul className="iu-card divide-y divide-slate-100" data-testid="checklist-list">
            {rows.map((c) => (
              <li key={c.id} className={`flex items-center gap-3 p-3 ${c.active === false ? "opacity-50" : ""}`} data-testid={`checklist-${c.id}`}>
                <Repeat size={15} className="text-indigo-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-slate-900">{c.title}</div>
                  <div className="text-[11px] text-slate-500">{recurrenceLabel(c)}{c.active === false ? " · paused" : ""}</div>
                </div>
                {(mine || user.role === "admin") && (
                  <>
                    <button onClick={() => toggleActive(c)} className="text-[11px] text-slate-500 hover:text-slate-900" data-testid={`checklist-pause-${c.id}`}>{c.active === false ? "Resume" : "Pause"}</button>
                    <button onClick={() => remove(c)} className="text-slate-300 hover:text-rose-600" title="Delete" data-testid={`checklist-delete-${c.id}`}><Trash2 size={15} /></button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}
