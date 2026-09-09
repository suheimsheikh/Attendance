import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CheckSquare, Square, ListTodo, Loader2, Share2, Bell, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";
import { shareToWhatsApp } from "../utils/shareWhatsApp";

const fmtDay = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" });

export function buildMyDayText({ name, date, checklist, todosDue, todosDoneToday }) {
  const lines = [`🗓️ *My day — ${name}* · ${fmtDay(date)}`];
  if (checklist.length) {
    lines.push("", "*Checklist*");
    checklist.forEach((c) => lines.push(`${c.done ? "✅" : "⬜"} ${c.title}`));
  }
  if (todosDue.length) {
    lines.push("", "*Due / overdue*");
    todosDue.forEach((t) => lines.push(`⏰ ${t.title}${t.due_date && t.due_date < date ? ` (overdue ${fmtDay(t.due_date)})` : ""}`));
  }
  if (todosDoneToday.length) {
    lines.push("", "*Completed today*");
    todosDoneToday.forEach((t) => lines.push(`✅ ${t.title}`));
  }
  return lines.join("\n");
}

export function maybeNotify(pending, date) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted" || !pending) return;
  const key = `ishowedup_tasks_notified_${date}`;
  if (sessionStorage.getItem(key)) return;
  sessionStorage.setItem(key, "1");
  try { new Notification("I showed up — today's tasks", { body: `${pending} item${pending === 1 ? "" : "s"} waiting for you`, icon: "/icon-192.png" }); } catch { /* ignore */ }
}

/** "Today" card: checklist ticks + due to-dos. Used on /check-in and /tasks. */
export default function TodayTasksCard({ userName, compact = false, onChanged }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState("");

  const load = useCallback(() => api.get("/tasks/today").then((d) => {
    setData(d);
    if (d?.enabled) maybeNotify(d.pending, d.date);
  }).catch(() => setData({ enabled: false })), []);
  useEffect(() => { load(); }, [load]);

  if (!data || !data.enabled) return null;

  const tick = async (c) => {
    setBusy(c.id);
    try {
      await api.post(`/checklists/${c.id}/tick`, { done: !c.done });
      await load(); onChanged?.();
    } catch (e) { toast.error(e?.message || "Couldn't update"); }
    finally { setBusy(""); }
  };
  const doneTodo = async (t) => {
    setBusy(t.id);
    try {
      await api.patch(`/todos/${t.id}`, { status: "done" });
      toast.success("To-do done");
      await load(); onChanged?.();
    } catch (e) { toast.error(e?.message || "Couldn't update"); }
    finally { setBusy(""); }
  };
  const share = () => shareToWhatsApp({ text: buildMyDayText({
    name: userName, date: data.date, checklist: data.checklist, todosDue: data.todos_due, todosDoneToday: data.todos_done_today,
  }) });
  const askPermission = () => Notification.requestPermission().then((p) => p === "granted" && toast.success("Reminders enabled"));

  const empty = !data.checklist.length && !data.todos_due.length;

  return (
    <div className="iu-card p-4 md:p-5 mb-4 text-left" data-testid="today-tasks-card">
      <div className="flex items-center gap-2 mb-3">
        <ListTodo size={16} className="text-indigo-600" />
        <h3 className="font-extrabold tracking-tight text-sm">Today&apos;s tasks</h3>
        <span className={`ml-1 text-[11px] font-bold px-2 py-0.5 rounded-full ${data.pending ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}`} data-testid="today-pending-count">
          {data.pending ? `${data.pending} pending` : "all clear"}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {typeof Notification !== "undefined" && Notification.permission === "default" && (
            <button onClick={askPermission} className="text-[11px] text-slate-500 hover:text-slate-800 inline-flex items-center gap-1" data-testid="enable-reminders" title="Allow browser reminders">
              <Bell size={12} /> Enable reminders
            </button>
          )}
          <button onClick={share} className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold" data-testid="share-my-day" title="Share today's checklist and to-dos to WhatsApp">
            <Share2 size={12} /> Share my day
          </button>
        </div>
      </div>
      {empty ? (
        <p className="text-sm text-slate-400 italic" data-testid="today-empty">Nothing scheduled for today. <Link to="/tasks" className="underline">Manage checklists & to-dos</Link></p>
      ) : (
        <ul className="space-y-1.5" data-testid="today-items">
          {data.checklist.map((c) => (
            <li key={c.id}>
              <button onClick={() => tick(c)} disabled={busy === c.id} data-testid={`today-check-${c.id}`}
                      className={`w-full flex items-center gap-2 text-left text-sm px-2 py-1.5 rounded-lg hover:bg-slate-50 ${c.done ? "text-slate-400 line-through" : "text-slate-800"}`}>
                {busy === c.id ? <Loader2 size={16} className="animate-spin" /> : c.done ? <CheckSquare size={16} className="text-emerald-600" /> : <Square size={16} className="text-slate-400" />}
                <span className="flex-1">{c.title}</span>
                <span className="text-[10px] uppercase text-slate-400">{c.recurrence === "dow" ? "weekly" : c.recurrence}</span>
              </button>
            </li>
          ))}
          {data.todos_due.map((t) => (
            <li key={t.id}>
              <button onClick={() => doneTodo(t)} disabled={busy === t.id} data-testid={`today-todo-${t.id}`}
                      className="w-full flex items-center gap-2 text-left text-sm px-2 py-1.5 rounded-lg hover:bg-slate-50 text-slate-800">
                {busy === t.id ? <Loader2 size={16} className="animate-spin" /> : <Square size={16} className="text-slate-400" />}
                <span className="flex-1">{t.title}</span>
                <span className={`text-[10px] font-semibold inline-flex items-center gap-1 ${t.due_date < data.date ? "text-rose-600" : "text-amber-700"}`}>
                  {t.due_date < data.date && <AlertTriangle size={10} />}{t.due_date < data.date ? "overdue" : "due today"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!compact && <Link to="/tasks" className="block text-xs text-indigo-600 hover:underline mt-3" data-testid="today-open-tasks">Open Tasks →</Link>}
    </div>
  );
}
