import React, { useEffect, useState } from "react";
import { Plus, Loader2, Trash2, CheckCircle2, Circle, ListChecks, FileText } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";

/** Plan for the day — pick from your open to-dos + add fresh one-off items.
 *  Ticked items flow into the DAR (when "DAR" is checked); unfinished items
 *  carry over to tomorrow automatically. */
export default function PlanTab() {
  const [plan, setPlan] = useState(null);
  const [openTodos, setOpenTodos] = useState([]);
  const [picks, setPicks] = useState({});
  const [fresh, setFresh] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => api.get("/tasks/plan").then(setPlan).catch((e) => toast.error(e?.message || "Failed"));
  const loadTodos = () =>
    api.get("/todos", { scope: "mine", status: "open" })
      .then((r) => setOpenTodos((r.rows || []).filter((t) => t.source !== "checklist")))
      .catch(() => {});
  useEffect(() => { load(); loadTodos(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const items = plan?.items || [];
  const inPlan = new Set(items.map((i) => i.todo_id).filter(Boolean));
  const available = openTodos.filter((t) => !inPlan.has(t.id));
  const doneN = items.filter((i) => i.done).length;

  const toggleDone = async (it) => { try { await api.patch(`/tasks/plan/items/${it.id}`, { done: !it.done }); load(); loadTodos(); } catch (e) { toast.error(e?.message); } };
  const toggleDar = async (it) => { try { await api.patch(`/tasks/plan/items/${it.id}`, { include_in_dar: it.include_in_dar === false }); load(); } catch (e) { toast.error(e?.message); } };
  const del = async (it) => { try { await api.del(`/tasks/plan/items/${it.id}`); load(); } catch (e) { toast.error(e?.message); } };
  const addFresh = async (e) => {
    e.preventDefault();
    if (!fresh.trim()) return;
    setBusy(true);
    try { await api.post("/tasks/plan/items", { title: fresh.trim() }); setFresh(""); load(); }
    catch (e) { toast.error(e?.message); } finally { setBusy(false); }
  };
  const addPicks = async () => {
    const ids = Object.keys(picks).filter((k) => picks[k]);
    if (!ids.length) return;
    setBusy(true);
    try { await api.post("/tasks/plan/pick", { todo_ids: ids }); setPicks({}); load(); loadTodos(); toast.success("Added to today's plan"); }
    catch (e) { toast.error(e?.message); } finally { setBusy(false); }
  };

  if (!plan) return <div className="text-center py-8"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>;

  return (
    <div data-testid="plan-tab" className="space-y-4">
      <form onSubmit={addFresh} className="iu-card p-3 flex gap-2" data-testid="plan-add-form">
        <input value={fresh} onChange={(e) => setFresh(e.target.value)} placeholder="Add a fresh task for today…"
               className="iu-input !h-10 text-sm flex-1" data-testid="plan-fresh-input" />
        <button className="iu-btn-primary !h-10" disabled={busy} data-testid="plan-fresh-add">
          {busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />} Add
        </button>
      </form>

      {available.length > 0 && (
        <div className="iu-card p-3" data-testid="plan-pick">
          <div className="text-xs font-bold text-slate-600 mb-2 flex items-center gap-1"><ListChecks size={14} /> Pick from your to-dos</div>
          <div className="space-y-1 max-h-48 overflow-auto">
            {available.map((t) => (
              <label key={t.id} className="flex items-center gap-2 text-sm py-1 cursor-pointer">
                <input type="checkbox" checked={!!picks[t.id]} onChange={(e) => setPicks((p) => ({ ...p, [t.id]: e.target.checked }))} data-testid={`plan-pick-${t.id}`} />
                <span className="flex-1">{t.title}</span>
                {t.due_date && <span className="text-[11px] text-slate-400">due {t.due_date}</span>}
              </label>
            ))}
          </div>
          <button onClick={addPicks} disabled={busy} className="iu-btn-secondary !h-9 mt-2" data-testid="plan-pick-add">Add selected to plan</button>
        </div>
      )}

      <div className="iu-card" data-testid="plan-list">
        <div className="flex items-center justify-between px-4 py-2 border-b border-slate-100">
          <div className="font-bold text-sm">Today's plan</div>
          <div className="text-xs text-slate-500" data-testid="plan-count">{doneN}/{items.length} done</div>
        </div>
        {items.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-400 italic" data-testid="plan-empty">Nothing planned yet. Add fresh items or pick from your to-dos.</div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {items.map((it) => (
              <li key={it.id} className="flex items-center gap-3 p-3" data-testid={`plan-item-${it.id}`}>
                <button onClick={() => toggleDone(it)} data-testid={`plan-toggle-${it.id}`}
                        className={it.done ? "text-emerald-600" : "text-slate-300 hover:text-emerald-600"}>
                  {it.done ? <CheckCircle2 size={20} /> : <Circle size={20} />}
                </button>
                <div className="flex-1 min-w-0">
                  <div className={`text-sm ${it.done ? "line-through text-slate-400" : "text-slate-900"}`}>
                    {it.title}
                    {it.carried && <span className="ml-2 text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">carried over</span>}
                  </div>
                </div>
                <label className="flex items-center gap-1 text-[11px] text-slate-500 cursor-pointer shrink-0" title="Include this item in today's DAR">
                  <input type="checkbox" checked={it.include_in_dar !== false} onChange={() => toggleDar(it)} data-testid={`plan-dar-${it.id}`} />
                  <FileText size={12} /> DAR
                </label>
                <button onClick={() => del(it)} className="text-slate-300 hover:text-rose-600 shrink-0" data-testid={`plan-del-${it.id}`}><Trash2 size={15} /></button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="text-[11px] text-slate-400 px-1">
        Completed items marked <FileText size={11} className="inline" /> DAR flow into your Daily Activity Report automatically at check-out. Unfinished items carry over to tomorrow.
      </p>
    </div>
  );
}
