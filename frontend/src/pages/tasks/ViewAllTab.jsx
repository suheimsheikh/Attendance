import React, { useEffect, useState } from "react";
import { Loader2, ChevronRight } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { api } from "../../api";

function Stat({ label, v, tone = "slate" }) {
  return (
    <div className="text-center px-2 shrink-0">
      <div className={`text-sm font-bold ${tone === "amber" ? "text-amber-600" : "text-slate-800"}`}>{v}</div>
      <div className="text-[10px] text-slate-400">{label}</div>
    </div>
  );
}

/** View all — everyone's day at a glance. Click a person to open their
 *  checklist (where you can also add items to their list). */
export default function ViewAllTab() {
  const [data, setData] = useState(null);
  const [, setParams] = useSearchParams();

  useEffect(() => { api.get("/tasks/overview").then(setData).catch(() => setData({ rows: [] })); }, []);
  if (!data) return <div className="text-center py-8"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>;

  const open = (id) => setParams({ tab: "checklists", owner: id });

  return (
    <div data-testid="viewall-tab" className="iu-card overflow-hidden">
      <div className="px-4 py-2 border-b border-slate-100 text-xs text-slate-500">Everyone&apos;s day at a glance · {data.date}</div>
      {data.rows.length === 0 ? (
        <div className="p-8 text-center text-sm text-slate-400 italic">No team members yet.</div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {data.rows.map((r) => (
            <li key={r.member_id} className="flex items-center gap-3 p-3 hover:bg-slate-50 cursor-pointer"
                onClick={() => open(r.member_id)} data-testid={`viewall-row-${r.member_id}`}>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-slate-900 truncate">
                  {r.member_name}
                  {r.member_id === data.me && <span className="ml-2 text-[10px] bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded">you</span>}
                </div>
                {r.rank && <div className="text-[11px] text-slate-500 truncate">{r.rank}</div>}
              </div>
              <Stat label="Plan" v={`${r.plan_done}/${r.plan_total}`} />
              <Stat label="Checklist" v={`${r.checklist_done}/${r.checklist_total}`} />
              <Stat label="Due" v={r.todos_due} tone={r.todos_due > 0 ? "amber" : "slate"} />
              <ChevronRight size={16} className="text-slate-300 shrink-0" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
