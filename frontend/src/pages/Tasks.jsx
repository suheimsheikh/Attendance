import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ListTodo, Loader2 } from "lucide-react";
import { useAuth } from "../auth";
import { api } from "../api";
import TodayTasksCard from "../components/TodayTasksCard";
import TodosTab from "./tasks/TodosTab";
import ChecklistsTab from "./tasks/ChecklistsTab";

const TABS = [["today", "Today"], ["todos", "To-dos"], ["checklists", "Checklists"]];

export default function Tasks() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") || "today";
  const [group, setGroup] = useState(null);
  const [key, setKey] = useState(0);

  useEffect(() => {
    api.get("/tasks/group").then((g) => setGroup(g.members || [])).catch(() => setGroup([]));
  }, []);

  if (!group) return <div className="p-8 text-center"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>;

  return (
    <div className="max-w-4xl mx-auto p-4 md:p-6" data-testid="tasks-page">
      <header className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight flex items-center gap-2"><ListTodo size={22} className="text-indigo-600" /> Tasks</h1>
          <p className="text-slate-500 text-sm mt-1">Executive to-dos with deadlines, plus your daily / weekly / monthly must-do checklist. Ticked items flow into your DAR.</p>
        </div>
        <div className="flex gap-2">
          {TABS.map(([v, l]) => (
            <button key={v} onClick={() => setParams({ tab: v })} data-testid={`tasks-tab-${v}`}
                    className={`px-4 h-9 rounded-full text-sm font-semibold ${tab === v ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700"}`}>{l}</button>
          ))}
        </div>
      </header>
      {tab === "today" && <TodayTasksCard key={key} userName={user?.full_name} compact onChanged={() => setKey((k) => k + 1)} />}
      {tab === "todos" && <TodosTab user={user} group={group} />}
      {tab === "checklists" && <ChecklistsTab user={user} group={group} />}
    </div>
  );
}
