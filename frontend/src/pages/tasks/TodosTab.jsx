import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, Loader2, CheckSquare, Square, User, CalendarClock, Edit3, Save, X, Flame, Repeat, CalendarPlus, ChevronLeft, ChevronRight, UserMinus, History, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { recurrenceLabel } from "./ChecklistsTab";
import TaskDarPanel from "./TaskDarPanel";
import TodoComments from "./TodoComments";

const fmtDay = (iso) => iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : "";
const fmtStamp = (iso) => iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" }) : "";
const daysSince = (iso) => { if (!iso) return null; const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000); return diff < 0 ? 0 : diff; };
const elapsedLabel = (n) => n === null ? "" : n === 0 ? "today" : n === 1 ? "1 day ago" : `${n} days ago`;
const daysToDue = (due, today) => { if (!due || !today) return null; return Math.round((new Date(due + "T00:00:00") - new Date(today + "T00:00:00")) / 86400000); };
const todayISO = () => new Date().toLocaleDateString("en-CA");
const shiftISO = (iso, delta) => { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + delta); return d.toLocaleDateString("en-CA"); };
const fmtLong = (iso) => iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }) : "";
const fmtWeekday = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short" });
const fmtDayNum = (iso) => new Date(iso + "T00:00:00").getDate();
const heatIntensity = (total) => total === 0 ? "bg-slate-50 text-slate-400 hover:bg-slate-100"
  : total <= 2 ? "bg-indigo-100 text-indigo-800 hover:bg-indigo-200"
  : total <= 5 ? "bg-indigo-300 text-indigo-900 hover:bg-indigo-400"
  : "bg-indigo-600 text-white hover:bg-indigo-700";

export default function TodosTab({ user, group }) {
  const [scope, setScope] = useState("all");
  const [status, setStatus] = useState("open");
  const [viewDate, setViewDate] = useState(todayISO);
  const [rows, setRows] = useState(null);
  const [today, setToday] = useState("");
  const [heat, setHeat] = useState(null);
  const [openComments, setOpenComments] = useState("");
  const [form, setForm] = useState({ title: "", due_date: "", owner_id: "", notes: "", urgent: false });
  const [busy, setBusy] = useState("");
  const [editId, setEditId] = useState("");
  const [edit, setEdit] = useState({ title: "", due_date: "", owner_id: "", notes: "", urgent: false });
  const reqRef = useRef(0);
  const heatRef = useRef(0);

  const loadHeat = () => { const my = ++heatRef.current; return api.get("/tasks/heatmap", { scope, days: 7 }).then((r) => { if (my === heatRef.current) setHeat(r); }).catch(() => {}); };
  const load = () => { loadHeat(); const my = ++reqRef.current; return api.get("/todos", { scope, status, date: viewDate }).then((r) => { if (my !== reqRef.current) return; setRows(r.rows); setToday(r.today); }).catch((e) => toast.error(e?.message || "Failed")); };
  useEffect(() => { load(); }, [scope, status, viewDate]); // eslint-disable-line react-hooks/exhaustive-deps
  const updateCount = (id, n) => setRows((rs) => rs ? rs.map((r) => r.id === id ? { ...r, comment_count: n } : r) : rs);

  const grouped = useMemo(() => {
    const m = new Map();
    (rows || []).forEach((t) => { if (!m.has(t.owner_id)) m.set(t.owner_id, { name: t.owner_name, items: [] }); m.get(t.owner_id).items.push(t); });
    const mine = m.get(user.id);
    const rest = [...m.entries()].filter(([id]) => id !== user.id).sort((a, b) => (a[1].name || "").localeCompare(b[1].name || ""));
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
  const takeToMe = async (t) => {
    setBusy(t.id);
    try { await api.patch(`/todos/${t.id}`, { owner_id: user.id }); toast.success("Task is now yours"); load(); }
    catch (err) { toast.error(err?.message || "Couldn't reassign"); }
    finally { setBusy(""); }
  };
  const canTick = (t) => t.owner_id === user.id || user.role === "admin";
  const canEdit = (t) => t.source !== "checklist";
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

      {heat && (
        <div className="mb-3" data-testid="task-heatstrip">
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Your week at a glance {scope === "mine" ? "(mine)" : "(everyone)"}</div>
          <div className="grid grid-cols-7 gap-1">
            {heat.days.map((d) => {
              const total = d.due + d.overdue;
              const active = d.date === viewDate;
              return (
                <button key={d.date} onClick={() => setViewDate(d.date)} data-testid={`heat-day-${d.date}`}
                        aria-label={`${fmtLong(d.date)}: ${d.due} due${d.overdue ? `, ${d.overdue} overdue` : ""}${d.urgent ? `, ${d.urgent} urgent` : ""}`}
                        title={`${d.due} due${d.overdue ? ` · ${d.overdue} overdue` : ""}${d.urgent ? ` · ${d.urgent} urgent` : ""}`}
                        className={`relative rounded-lg py-1.5 text-center transition-colors ${heatIntensity(total)} ${active ? "ring-2 ring-indigo-500" : ""}`}>
                  {d.urgent > 0 && <Flame size={9} className="absolute top-1 right-1 text-rose-500" />}
                  <div className="text-[9px] font-bold uppercase opacity-70">{fmtWeekday(d.date)}</div>
                  <div className="text-sm font-extrabold leading-tight">{fmtDayNum(d.date)}</div>
                  <div className="text-[10px] font-semibold h-3 leading-3">{total > 0 ? total : ""}</div>
                  {d.overdue > 0 && <div className="text-[8px] font-bold text-rose-600 leading-none">{d.overdue} od</div>}
                </button>
              );
            })}
          </div>
        </div>
      )}

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
                  <li key={t.id} className={`py-2 ${t.urgent && t.status !== "done" ? "-mx-3 md:-mx-4 px-3 md:px-4 bg-rose-50/60" : ""}`} data-testid={`todo-${t.id}`}>
                    <div className="flex items-start gap-2">
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
                        {t.carried && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-amber-100 text-amber-700" data-testid={`todo-carried-pill-${t.id}`}><History size={10} /> Missed yesterday</span>
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
                    {t.source !== "checklist" && (
                      <button onClick={() => setOpenComments((o) => o === t.id ? "" : t.id)} className={`relative ${openComments === t.id ? "text-indigo-600" : "text-slate-300 hover:text-indigo-600"}`} title="Progress notes & blockers" data-testid={`todo-comments-btn-${t.id}`}>
                        <MessageSquare size={15} />
                        {t.comment_count > 0 && <span className="absolute -top-1.5 -right-1.5 min-w-[15px] h-[15px] px-0.5 rounded-full bg-indigo-600 text-white text-[9px] font-bold flex items-center justify-center" data-testid={`todo-comment-count-${t.id}`}>{t.comment_count}</span>}
                      </button>
                    )}
                    {t.source !== "checklist" && t.owner_id !== user.id && (
                      <button onClick={() => takeToMe(t)} disabled={busy === t.id} className="text-slate-300 hover:text-emerald-600 disabled:opacity-40" title="De-assign — bring this task to me" data-testid={`todo-take-${t.id}`}><UserMinus size={15} /></button>
                    )}
                    {t.source !== "checklist" && (t.owner_id === user.id || t.created_by_id === user.id || user.role === "admin") && (
                      <button onClick={() => remove(t)} className="text-slate-300 hover:text-rose-600" title="Delete" data-testid={`todo-delete-${t.id}`}><Trash2 size={15} /></button>
                    )}
                    </div>
                    {openComments === t.id && t.source !== "checklist" && (
                      <TodoComments todo={t} user={user} onCountChange={updateCount} />
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
