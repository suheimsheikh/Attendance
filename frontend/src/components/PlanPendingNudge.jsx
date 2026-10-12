import React, { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { api } from "../api";

/** Day-end nudge shown at check-out: if the user's Plan for the day still
 *  has unfinished items, list them so they can tick what they finished
 *  (which flows into the DAR) before heading out. Unfinished items carry
 *  over to tomorrow automatically. Silent (renders nothing) when there's
 *  no plan or nothing pending. */
export default function PlanPendingNudge({ onItemDone }) {
  const [items, setItems] = useState(null);

  const load = () =>
    api.get("/tasks/plan")
      .then((p) => setItems((p.items || []).filter((i) => !i.done)))
      .catch(() => setItems([]));
  useEffect(() => { load(); }, []);

  if (!items || items.length === 0) return null;

  const markDone = async (it) => {
    try {
      await api.patch(`/tasks/plan/items/${it.id}`, { done: true });
      if (onItemDone) onItemDone(it.title);
      load();
    } catch { /* ignore */ }
  };

  return (
    <div data-testid="plan-pending-nudge" className="mb-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
      <div className="flex items-center gap-2 text-amber-800 font-bold text-sm">
        <AlertTriangle size={16} /> {items.length} planned {items.length === 1 ? "task" : "tasks"} still open
      </div>
      <p className="text-[11px] text-amber-700 mt-0.5 mb-2">
        Tick anything you finished — it flows into your DAR. Unfinished items carry over to tomorrow.
      </p>
      <ul className="space-y-1">
        {items.map((it) => (
          <li key={it.id} className="flex items-center gap-2 text-sm" data-testid={`nudge-item-${it.id}`}>
            <button onClick={() => markDone(it)} title="Mark done"
                    className="text-amber-500 hover:text-emerald-600 shrink-0" data-testid={`nudge-done-${it.id}`}>
              <CheckCircle2 size={16} />
            </button>
            <span className="text-slate-700">{it.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
