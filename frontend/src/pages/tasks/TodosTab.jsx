import React, { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Loader2, CheckSquare, Square, User, CalendarClock, Edit3, Save, X, Flame, Repeat, CalendarPlus, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { recurrenceLabel } from "./ChecklistsTab";
import TaskDarPanel from "./TaskDarPanel";

const fmtDay = (iso) => iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : "";
const fmtStamp = (iso) => iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" }) : "";
const daysSince = (iso) => { if (!iso) return null; const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000); return diff < 0 ? 0 : diff; };
const elapsedLabel = (n) => n === null ? "" : n === 0 ? "today" : n === 1 ? "1 day ago" : `${n} days ago`;
const daysToDue = (due, today) => { if (!due || !today) return null; return Math.round((new Date(due + "T00:00:00") - new Date(today + "T00:00:00")) / 86400000); };
const todayISO = () => new Date().toLocaleDateString("en-CA");
const shiftISO = (iso, delta) => { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + delta); return d.toLocaleDateString("en-CA"); };
const fmtLong = (iso) => iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }) : "";

export default function TodosTab({ user, group }) {
  const [scope, setScope] = useState("all");
  const [status, setStatus] = useState("open");
  const [viewDate, setViewDate] = useState(todayISO);
  const [rows, setRows] = useState(null);
  const [today, setToday] = useState("");
  const [form, setForm] = useState({ title: "", due_date: "", owner_id: "", notes: "", urgent: false });
  const [busy, setBusy] = useState("");
  const [editId, setEditId] = useState("");
  const [edit, setEdit] = useState({ title: "", due_date: "", owner_id: "", notes: "", urgent: false });

  const load = () => api.get("/todos", { scope, status, date: viewDate }).then((r) => { setRows(r.rows); setToday(r.today); }).catch((e) => toast.error(e?.message || "Failed"));
  useEffect(() => { load(); }, [scope, status, viewDate]); // eslint-disable-line react-hooks/exhaustive-deps

  const grouped = useMemo(() => {
    const m = new Map();
    (rows || []).forEach((t) => { if (!m.has(t.owner_id)) m.set(t.owner_id, { name: t.owner_name, items: [] }); m.get(t.owner_id).items.push(t); });
    const mine = m.get(user.id);
    const rest = [...m.entries()].filter(([id]) => id !== user.id).sort((a, b) => a[1].name.localeCompare(b[1].name));
    return mine ? [[user.id, mine], ...rest] : rest;
  }, [rows, user.id]);

  const add = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    setBusy("add");
    try {
      await api.post("/todos", { title: form.title, due_date: form.due_date || null, owner_id: form.owner_id || null, notes: form.notes || null, urgent: form.urgent });
      setForm({ title: "", due_date: "", owner_id: "", notes: "", urgent: false });
      toast.success("To-do added"); load();
    } catch (err) { toast.error(err?.message || "Couldn't add"); }
    finally { setBusy(""); }
  };
  const toggle = async (t) => {
    setBusy(t.id);
    try {
      if (t.source === "checklist") {
        await api.post(`/checklists/${t.checklist_id}/tick`, { date: t.due_date, done: t.status !== "done" });
      } else {
        await api.patch(`/todos/${t.id}`, { status: t.status === "done" ? "open" : "done" });
      }
      load();
    } catch (err) { toast.error(err?.message || "Not allowed"); }
    finally { setBusy(""); }
  };
  const remove = async (t) => {
    if (!window.confirm(`Delete "${t.title}"?`)) return;
    try { await api.del(`/todos/${t.id}`); load(); }
    catch (err) { toast.error(err?.message || "Not allowed"); }
  };
  const canTick = (t) => t.owner_id === user.id || user.role === "admin";
  const canEdit = (t) => t.source !== "checklist" && (t.owner_id === user.id || t.created_by_id === user.id || user.role === "admin");
  const startEdit = (t) => { setEditId(t.id); setEdit({ title: t.title, due_date: t.due_date || "", owner_id: t.owner_id || "", notes: t.notes || "", urgent: !!t.urgent }); };
  const saveEdit = async () => {
    if (!edit.title.trim()) { toast.error("Title can't be empty"); return; }
    setBusy(editId);
    try {
      await api.patch(`/todos/${editId}`, { title: edit.title.trim(), due_date: edit.due_date || null, owner_id: edit.owner_id || null, notes: edit.notes || null, urgent: edit.urgent });
      toast.success("To-do updated"); setEditId(""); load();
    } catch (err) { toast.error(err?.message || "Couldn't update"); }
    finally { setBusy(""); }
  };

  return (
    <div data-testid="todos-tab">
      <form onSubmit={add} className="rounded-2xl p-3 md:p-4 mb-4 bg-gradient-to-br from-indigo-50 to-violet-50 ring-1 ring-indigo-100" data-testid="todo-add-form">
        <div className="grid gap-2 md:grid-cols-[1fr_auto_auto_auto]">
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="New to-do…" className="iu-input !h-10 text-sm" data-testid="todo-title" required />
          <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} className="iu-input !h-10 !w-auto text-sm" data-testid="todo-due" title="Deadline" />
          <select value={form.owner_id} onChange={(e) => setForm({ ...form, owner_id: e.target.value })} className="iu-input !h-10 !w-auto text-sm" data-testid="todo-owner" title="Assign to">
            <option value="">Me</option>
            {group.filter((m) => m.id !== user.id).map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
          </select>
          <button className="iu-btn-primary !h-10" disabled={busy === "add"} data-testid="todo-add">{busy === "add" ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Add</button>
        </div>
        <label className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-rose-600 cursor-pointer select-none" data-testid="todo-urgent-label">
          <input type="checkbox" checked={form.urgent} onChange={(e) => setForm({ ...form, urgent: e.target.checked })} className="accent-rose-600" data-testid="todo-urgent" />
          <Flame size={13} /> Mark urgent
        </label>
      </form>

      <div className="flex items-center justify-between gap-2 mb-3 rounded-xl bg-slate-50 ring-1 ring-slate-100 px-2 py-1.5" data-testid="todo-date-bar">
        <button onClick={() => setViewDate((d) => shiftISO(d, -1))} className="h-8 w-8 grid place-items-center rounded-full hover:bg-slate-200 text-slate-600" title="Previous day" data-testid="todo-date-prev"><ChevronLeft size={18} /></button>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-800" data-testid="todo-date-label">{fmtLong(viewDate)}</span>
          {viewDate === today && <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-indigo-100 text-indigo-700">Today</span>}
          {viewDate !== today && today && <button onClick={() => setViewDate(today)} className="text-[11px] font-semibold text-indigo-600 hover:underline" data-testid="todo-date-today">Jump to today</button>}
          <input type="date" value={viewDate} onChange={(e) => e.target.value && setViewDate(e.target.value)} className="iu-input !h-7 !w-auto text-xs" data-testid="todo-date-input" title="Pick a day" />
        </div>
        <button onClick={() => setViewDate((d) => shiftISO(d, 1))} className="h-8 w-8 grid place-items-center rounded-full hover:bg-slate-200 text-slate-600" title="Next day" data-testid="todo-date-next"><ChevronRight size={18} /></button>
      </div>

      <div className="flex flex-wrap gap-2 mb-3 text-xs">
        {[["all", "Everyone"], ["mine", "Mine"]].map(([v, l]) => (
          <button key={v} onClick={() => setScope(v)} data-testid={`todo-scope-${v}`} className={`px-3 h-8 rounded-full font-semibold transition-colors ${scope === v ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}>{l}</button>
        ))}
        <span className="w-px bg-slate-200 mx-1" />
        {[["open", "Pending"], ["done", "Done"], ["all", "All"]].map(([v, l]) => (
          <button key={v} onClick={() => setStatus(v)} data-testid={`todo-status-${v}`} className={`px-3 h-8 rounded-full font-semibold transition-colors ${status === v ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}>{l}</button>
        ))}
      </div>

      {scope === "mine" && <TaskDarPanel user={user} date={viewDate} serverToday={today} />}

      {rows === null ? <div className="text-center py-8"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
        : grouped.length === 0 ? <div className="iu-card p-8 text-center text-sm text-slate-400 italic" data-testid="todos-empty">No to-dos here.</div>
        : grouped.map(([oid, g]) => (
          <section key={oid} className="iu-card p-3 md:p-4 mb-3 border-l-4 border-l-indigo-400" data-testid={`todo-group-${oid}`}>
            <h3 className="text-xs font-black uppercase tracking-wider text-indigo-600 flex items-center gap-1.5 mb-2"><User size={12} /> {oid === user.id ? "My to-dos" : g.name}</h3>
            <ul className="divide-y divide-slate-100">
              {g.items.map((t) => {
                const overdue = t.status === "open" && t.due_date && t.due_date < today;
                const dd = daysToDue(t.due_date, today);
                if (editId === t.id) {
                  return (
                    <li key={t.id} className="py-2" data-testid={`todo-edit-${t.id}`}>
                      <div className="grid gap-2 md:grid-cols-[1fr_auto_auto]">
                        <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} className="iu-input !h-9 text-sm" data-testid={`todo-edit-title-${t.id}`} placeholder="Title" />
                        <input type="date" value={edit.due_date} onChange={(e) => setEdit({ ...edit, due_date: e.target.value })} className="iu-input !h-9 !w-auto text-sm" data-testid={`todo-edit-due-${t.id}`} title="Deadline" />
                        <select value={edit.owner_id} onChange={(e) => setEdit({ ...edit, owner_id: e.target.value })} className="iu-input !h-9 !w-auto text-sm" data-testid={`todo-edit-owner-${t.id}`} title="Assign to">
                          <option value={user.id}>Me</option>
                          {group.filter((m) => m.id !== user.id).map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
                        </select>
                      </div>
                      <input value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} className="iu-input !h-9 text-sm mt-2" data-testid={`todo-edit-notes-${t.id}`} placeholder="Notes (optional)" />
                      <div className="flex items-center justify-between mt-2">
                        <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-rose-600 cursor-pointer select-none">
                          <input type="checkbox" checked={edit.urgent} onChange={(e) => setEdit({ ...edit, urgent: e.target.checked })} className="accent-rose-600" data-testid={`todo-edit-urgent-${t.id}`} />
                          <Flame size={13} /> Urgent
                        </label>
                        <div className="flex gap-2">
                          <button onClick={() => setEditId("")} className="iu-btn-secondary !h-8 text-xs" data-testid={`todo-edit-cancel-${t.id}`}><X size={13} /> Cancel</button>
                          <button onClick={saveEdit} disabled={busy === t.id} className="iu-btn-primary !h-8 text-xs" data-testid={`todo-edit-save-${t.id}`}>{busy === t.id ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save</button>
                        </div>
                      </div>
                    </li>
                  );
                }
                return (
                  <li key={t.id} className={`flex items-start gap-2 py-2 ${t.urgent && t.status !== "done" ? "-mx-3 md:-mx-4 px-3 md:px-4 bg-rose-50/60" : ""}`} data-testid={`todo-${t.id}`}>
                    <button onClick={() => canTick(t) && toggle(t)} disabled={!canTick(t) || busy === t.id} title={canTick(t) ? "Toggle done" : "Only the owner or an admin can tick this"} className="mt-0.5 disabled:opacity-40" data-testid={`todo-toggle-${t.id}`}>
                      {busy === t.id ? <Loader2 size={18} className="animate-spin" /> : t.status === "done" ? <CheckSquare size={18} className="text-emerald-600" /> : <Square size={18} className="text-slate-400" />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-sm ${t.status === "done" ? "line-through text-slate-400" : "text-slate-900"}`}>{t.title}</span>
                        {t.urgent && t.status !== "done" && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wide bg-rose-600 text-white" data-testid={`todo-urgent-pill-${t.id}`}><Flame size={10} /> Urgent</span>
                        )}
                        {t.source === "checklist" && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-violet-100 text-violet-700" data-testid={`todo-checklist-pill-${t.id}`}><Repeat size={10} /> Checklist</span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500 flex flex-wrap gap-x-2 gap-y-0.5 mt-0.5">
                        {t.due_date && <span className={`inline-flex items-center gap-1 font-semibold ${overdue ? "text-rose-600" : t.due_date === today ? "text-amber-700" : "text-slate-600"}`}><CalendarClock size={11} /> {overdue ? `Overdue ${fmtDay(t.due_date)} (${Math.abs(dd)}d ago)` : t.due_date === today ? "Due today" : `Due ${fmtDay(t.due_date)}${dd != null ? ` (in ${dd}d)` : ""}`}</span>}
                        {t.source !== "checklist" && t.created_at && <span className="inline-flex items-center gap-1 text-slate-500" data-testid={`todo-added-${t.id}`}><CalendarPlus size={11} /> Added {fmtStamp(t.created_at)} · {elapsedLabel(daysSince(t.created_at))}</span>}
                        {t.source === "checklist" && <span className="text-violet-600">{recurrenceLabel(t)}</span>}
                        {t.created_by_id !== t.owner_id && <span>assigned by {t.created_by_name}</span>}
                        {t.status === "done" && t.done_by_name && <span>done by {t.done_by_name}</span>}
                        {t.notes && <span className="text-slate-400">· {t.notes}</span>}
                      </div>
                    </div>
                    {canEdit(t) && (
                      <button onClick={() => startEdit(t)} className="text-slate-300 hover:text-indigo-600" title="Edit" data-testid={`todo-edit-btn-${t.id}`}><Edit3 size={15} /></button>
                    )}
                    {t.source !== "checklist" && (t.owner_id === user.id || t.created_by_id === user.id || user.role === "admin") && (
                      <button onClick={() => remove(t)} className="text-slate-300 hover:text-rose-600" title="Delete" data-testid={`todo-delete-${t.id}`}><Trash2 size={15} /></button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
    </div>
  );
}
