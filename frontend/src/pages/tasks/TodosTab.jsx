import React, { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Loader2, CheckSquare, Square, User, CalendarClock } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";

const fmtDay = (iso) => iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : "";

export default function TodosTab({ user, group }) {
  const [scope, setScope] = useState("all");
  const [status, setStatus] = useState("open");
  const [rows, setRows] = useState(null);
  const [today, setToday] = useState("");
  const [form, setForm] = useState({ title: "", due_date: "", owner_id: "", notes: "" });
  const [busy, setBusy] = useState("");

  const load = () => api.get("/todos", { scope, status }).then((r) => { setRows(r.rows); setToday(r.today); }).catch((e) => toast.error(e?.message || "Failed"));
  useEffect(() => { load(); }, [scope, status]); // eslint-disable-line react-hooks/exhaustive-deps

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
      await api.post("/todos", { title: form.title, due_date: form.due_date || null, owner_id: form.owner_id || null, notes: form.notes || null });
      setForm({ title: "", due_date: "", owner_id: "", notes: "" });
      toast.success("To-do added"); load();
    } catch (err) { toast.error(err?.message || "Couldn't add"); }
    finally { setBusy(""); }
  };
  const toggle = async (t) => {
    setBusy(t.id);
    try { await api.patch(`/todos/${t.id}`, { status: t.status === "done" ? "open" : "done" }); load(); }
    catch (err) { toast.error(err?.message || "Not allowed"); }
    finally { setBusy(""); }
  };
  const remove = async (t) => {
    if (!window.confirm(`Delete "${t.title}"?`)) return;
    try { await api.del(`/todos/${t.id}`); load(); }
    catch (err) { toast.error(err?.message || "Not allowed"); }
  };
  const canTick = (t) => t.owner_id === user.id || user.role === "admin";

  return (
    <div data-testid="todos-tab">
      <form onSubmit={add} className="iu-card p-3 md:p-4 mb-4 grid gap-2 md:grid-cols-[1fr_auto_auto_auto]" data-testid="todo-add-form">
        <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="New to-do…" className="iu-input !h-10 text-sm" data-testid="todo-title" required />
        <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} className="iu-input !h-10 !w-auto text-sm" data-testid="todo-due" title="Deadline" />
        <select value={form.owner_id} onChange={(e) => setForm({ ...form, owner_id: e.target.value })} className="iu-input !h-10 !w-auto text-sm" data-testid="todo-owner" title="Assign to">
          <option value="">Me</option>
          {group.filter((m) => m.id !== user.id).map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}
        </select>
        <button className="iu-btn-primary !h-10" disabled={busy === "add"} data-testid="todo-add">{busy === "add" ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Add</button>
      </form>

      <div className="flex flex-wrap gap-2 mb-3 text-xs">
        {[["all", "Everyone"], ["mine", "Mine"]].map(([v, l]) => (
          <button key={v} onClick={() => setScope(v)} data-testid={`todo-scope-${v}`} className={`px-3 h-8 rounded-full font-semibold ${scope === v ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"}`}>{l}</button>
        ))}
        <span className="w-px bg-slate-200 mx-1" />
        {[["open", "Pending"], ["done", "Done"], ["all", "All"]].map(([v, l]) => (
          <button key={v} onClick={() => setStatus(v)} data-testid={`todo-status-${v}`} className={`px-3 h-8 rounded-full font-semibold ${status === v ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-700"}`}>{l}</button>
        ))}
      </div>

      {rows === null ? <div className="text-center py-8"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
        : grouped.length === 0 ? <div className="iu-card p-8 text-center text-sm text-slate-400 italic" data-testid="todos-empty">No to-dos here.</div>
        : grouped.map(([oid, g]) => (
          <section key={oid} className="iu-card p-3 md:p-4 mb-3" data-testid={`todo-group-${oid}`}>
            <h3 className="text-xs font-black uppercase tracking-wider text-slate-500 flex items-center gap-1.5 mb-2"><User size={12} /> {oid === user.id ? "My to-dos" : g.name}</h3>
            <ul className="divide-y divide-slate-100">
              {g.items.map((t) => {
                const overdue = t.status === "open" && t.due_date && t.due_date < today;
                return (
                  <li key={t.id} className="flex items-start gap-2 py-2" data-testid={`todo-${t.id}`}>
                    <button onClick={() => canTick(t) && toggle(t)} disabled={!canTick(t) || busy === t.id} title={canTick(t) ? "Toggle done" : "Only the owner or an admin can tick this"} className="mt-0.5 disabled:opacity-40" data-testid={`todo-toggle-${t.id}`}>
                      {busy === t.id ? <Loader2 size={18} className="animate-spin" /> : t.status === "done" ? <CheckSquare size={18} className="text-emerald-600" /> : <Square size={18} className="text-slate-400" />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className={`text-sm ${t.status === "done" ? "line-through text-slate-400" : "text-slate-900"}`}>{t.title}</div>
                      <div className="text-[11px] text-slate-500 flex flex-wrap gap-2 mt-0.5">
                        {t.due_date && <span className={`inline-flex items-center gap-1 font-semibold ${overdue ? "text-rose-600" : t.due_date === today ? "text-amber-700" : ""}`}><CalendarClock size={11} /> {overdue ? "Overdue " : "Due "}{fmtDay(t.due_date)}</span>}
                        {t.created_by_id !== t.owner_id && <span>assigned by {t.created_by_name}</span>}
                        {t.status === "done" && t.done_by_name && <span>done by {t.done_by_name}</span>}
                        {t.notes && <span className="text-slate-400">· {t.notes}</span>}
                      </div>
                    </div>
                    {(t.owner_id === user.id || t.created_by_id === user.id || user.role === "admin") && (
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
