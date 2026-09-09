import React from "react";
import { Link } from "react-router-dom";
import { ListTodo, AlertTriangle } from "lucide-react";
import { useApiQuery } from "../../../hooks/useApiQuery";
import { SectionCard } from "./widgets";

/** Team task progress (executives + coaches): checklist done/total + overdue to-dos per person. */
export default function TaskProgressCard() {
  const q = useApiQuery("/admin/tasks/overview", undefined, { staleTime: 30_000, refetchInterval: 60_000 });
  const rows = q.data?.rows || [];
  return (
    <SectionCard title="Team tasks today" testid="task-progress-card"
                 action={<Link to="/tasks?tab=todos" className="text-xs text-indigo-600 hover:underline">Open Tasks</Link>}>
      {q.isLoading ? (
        <p className="text-xs text-slate-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-slate-400 italic">No executives or coaches on the roster.</p>
      ) : (
        <ul className="divide-y divide-slate-100" data-testid="task-progress-list">
          {rows.map((r) => {
            const pct = r.checklist_total ? Math.round((r.checklist_done / r.checklist_total) * 100) : null;
            return (
              <li key={r.member_id} className="py-2 flex items-center gap-3" data-testid={`task-progress-${r.member_id}`}>
                <ListTodo size={14} className="text-indigo-500 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <Link to={`/profile?member=${r.member_id}`} className="text-sm font-semibold text-slate-800 truncate hover:underline">{r.member_name}</Link>
                    <span className="text-[11px] tabular-nums text-slate-500 shrink-0">
                      {r.checklist_total ? `${r.checklist_done}/${r.checklist_total} checklist` : "no checklist"}
                    </span>
                  </div>
                  <div className="h-1.5 mt-1 rounded-full bg-slate-100 overflow-hidden">
                    <div className={`h-full ${pct === 100 ? "bg-emerald-500" : "bg-indigo-500"}`} style={{ width: `${pct ?? 0}%` }} />
                  </div>
                </div>
                <span className={`shrink-0 inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full ${r.todos_due > 0 ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}`}
                      title="To-dos due today or overdue" data-testid={`task-overdue-${r.member_id}`}>
                  {r.todos_due > 0 && <AlertTriangle size={10} />}{r.todos_due} due
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
