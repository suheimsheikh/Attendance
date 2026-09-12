import React, { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Loader2, User, Flame, ChevronLeft, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import TaskDarPanel from "./TaskDarPanel";
import HeatStrip from "./HeatStrip";
import TodoRow from "./TodoRow";

const todayISO = () => new Date().toLocaleDateString("en-CA");
const shiftISO = (iso, delta) => { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + delta); return d.toLocaleDateString("en-CA"); };
const fmtLong = (iso) => iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }) : "";

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
      if (t.source === "checklist") await api.post(`/checklists/${t.checklist_id}/tick`, { date: t.due_date, done: t.status !== "done" });
      else await api.patch(`/todos/${t.id}`, { status: t.status === "done" ? "open" : "done" });
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
  const canTick = (t) => t.owner_id === user.id || user.role === "admin";

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

      <HeatStrip heat={heat} viewDate={viewDate} scope={scope} onPick={setViewDate} />

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
          <button key={v} onClick={() => setScope(v)} data-testid={`todo-scope-${v}`} title={v === "mine" ? "Show only to-dos assigned to me" : "Show to-dos for the whole team"} className={`px-3 h-8 rounded-full font-semibold transition-colors ${scope === v ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}>{l}</button>
        ))}
        <span className="w-px bg-slate-200 mx-1" />
        {[["open", "Pending"], ["done", "Done"], ["all", "All"]].map(([v, l]) => (
          <button key={v} onClick={() => setStatus(v)} data-testid={`todo-status-${v}`} title={v === "open" ? "Show only unfinished to-dos" : v === "done" ? "Show only completed to-dos" : "Show every to-do regardless of status"} className={`px-3 h-8 rounded-full font-semibold transition-colors ${status === v ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}>{l}</button>
        ))}
      </div>

      {scope === "mine" && <TaskDarPanel user={user} date={viewDate} serverToday={today} />}

      {rows === null ? <div className="text-center py-8"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
        : grouped.length === 0 ? <div className="iu-card p-8 text-center text-sm text-slate-400 italic" data-testid="todos-empty">No to-dos here.</div>
        : grouped.map(([oid, g]) => (
          <section key={oid} className="iu-card p-3 md:p-4 mb-3 border-l-4 border-l-indigo-400" data-testid={`todo-group-${oid}`}>
            <h3 className="text-xs font-black uppercase tracking-wider text-indigo-600 flex items-center gap-1.5 mb-2"><User size={12} /> {oid === user.id ? "My to-dos" : g.name}</h3>
            <ul className="divide-y divide-slate-100">
              {g.items.map((t) => (
                <TodoRow
                  key={t.id} t={t} user={user} group={group} today={today} busy={busy}
                  isEditing={editId === t.id} edit={edit} setEdit={setEdit}
                  commentsOpen={openComments === t.id}
                  canTick={canTick(t)} canEditRow={t.source !== "checklist"}
                  onToggle={toggle} onRemove={remove} onTake={takeToMe}
                  onStartEdit={startEdit} onSaveEdit={saveEdit} onCancelEdit={() => setEditId("")}
                  onToggleComments={() => setOpenComments((o) => o === t.id ? "" : t.id)}
                  onCommentCount={updateCount}
                />
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}
