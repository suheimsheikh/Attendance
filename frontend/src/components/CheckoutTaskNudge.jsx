import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlarmClock, Flame, Share2, ListTodo } from "lucide-react";
import { api } from "../api";
import { shareToWhatsApp } from "../utils/shareWhatsApp";

const fmtDay = (iso) => iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : "";

const statusLabel = (t, today) => {
  if (t.due_date && t.due_date < today) return `overdue ${fmtDay(t.due_date)}`;
  if (t.due_date === today) return "due today";
  if (t.due_date) return `due ${fmtDay(t.due_date)}`;
  return "no deadline";
};

function buildText(name, items, today) {
  const lines = [`⏰ *Before I leave — open tasks* · ${name}`, ""];
  items.forEach((t) => lines.push(`${t.urgent ? "🔴 " : "• "}${t.urgent ? "[URGENT] " : ""}${t.title} (${statusLabel(t, today)})`));
  return lines.join("\n");
}

/** Pre-checkout nudge: urgent or due-today/overdue to-dos, with one-tap
 *  WhatsApp share. Only renders for task-manager users who have such items. */
export default function CheckoutTaskNudge({ userName }) {
  const [data, setData] = useState(null);
  useEffect(() => { api.get("/tasks/today").then(setData).catch(() => setData({ enabled: false })); }, []);
  if (!data?.enabled) return null;

  const byId = new Map();
  (data.todos_due || []).forEach((t) => byId.set(t.id, t));               // overdue / due today
  [...(data.todos_due || []), ...(data.todos_upcoming || [])]
    .filter((t) => t.urgent).forEach((t) => byId.set(t.id, t));            // any urgent
  const items = [...byId.values()].sort((a, b) => (b.urgent ? 1 : 0) - (a.urgent ? 1 : 0));
  if (!items.length) return null;

  const share = () => shareToWhatsApp({ text: buildText(userName, items, data.date) });

  return (
    <div className="rounded-2xl mb-4 p-4 bg-amber-50 ring-1 ring-amber-200" data-testid="checkout-task-nudge">
      <div className="flex items-center gap-2 mb-2">
        <AlarmClock size={16} className="text-amber-600" />
        <h3 className="font-bold text-sm text-amber-900">Before you leave — {items.length} open task{items.length === 1 ? "" : "s"}</h3>
        <button onClick={share} className="ml-auto inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold transition-colors" data-testid="nudge-share-whatsapp" title="Share these tasks to WhatsApp">
          <Share2 size={12} /> Share to WhatsApp
        </button>
      </div>
      <ul className="space-y-1" data-testid="nudge-items">
        {items.map((t) => (
          <li key={t.id} className="flex items-center gap-2 text-sm text-amber-900" data-testid={`nudge-item-${t.id}`}>
            {t.urgent ? <Flame size={13} className="text-rose-600 shrink-0" /> : <span className="w-[13px] shrink-0 text-amber-500 text-center">•</span>}
            <span className="flex-1 min-w-0 truncate">{t.title}</span>
            <span className={`text-[10px] font-bold uppercase tracking-wide shrink-0 ${t.due_date && t.due_date < data.date ? "text-rose-600" : "text-amber-700"}`}>
              {t.urgent && "urgent · "}{statusLabel(t, data.date)}
            </span>
          </li>
        ))}
      </ul>
      <Link to="/tasks?tab=todos" className="inline-flex items-center gap-1 text-xs text-amber-800 hover:underline mt-2" data-testid="nudge-open-tasks"><ListTodo size={12} /> Open Task Manager</Link>
    </div>
  );
}
