import React from "react";
import { Trash2, Loader2, CheckSquare, Square, CalendarClock, Edit3, Save, X, Flame, Repeat, CalendarPlus, UserMinus, History, MessageSquare } from "lucide-react";
import { recurrenceLabel } from "./ChecklistsTab";
import TodoComments from "./TodoComments";

const fmtDay = (iso) => iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) : "";
const fmtStamp = (iso) => iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" }) : "";
const daysSince = (iso) => { if (!iso) return null; const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000); return diff < 0 ? 0 : diff; };
const elapsedLabel = (n) => n === null ? "" : n === 0 ? "today" : n === 1 ? "1 day ago" : `${n} days ago`;
const daysToDue = (due, today) => { if (!due || !today) return null; return Math.round((new Date(due + "T00:00:00") - new Date(today + "T00:00:00")) / 86400000); };

/** A single to-do row — display mode, inline-edit mode and its comments panel. */
export default function TodoRow({
  t, user, group, today, busy,
  isEditing, edit, setEdit, commentsOpen,
  canTick, canEditRow,
  onToggle, onRemove, onTake, onStartEdit, onSaveEdit, onCancelEdit, onToggleComments, onCommentCount,
}) {
  if (isEditing) {
    return (
      <li className="py-2" data-testid={`todo-edit-${t.id}`}>
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
            <button onClick={onCancelEdit} className="iu-btn-secondary !h-8 text-xs" data-testid={`todo-edit-cancel-${t.id}`}><X size={13} /> Cancel</button>
            <button onClick={onSaveEdit} disabled={busy === t.id} className="iu-btn-primary !h-8 text-xs" data-testid={`todo-edit-save-${t.id}`}>{busy === t.id ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save</button>
          </div>
        </div>
      </li>
    );
  }

  const overdue = t.status === "open" && t.due_date && t.due_date < today;
  const dd = daysToDue(t.due_date, today);
  const isChecklist = t.source === "checklist";
  return (
    <li className={`py-2 ${t.urgent && t.status !== "done" ? "-mx-3 md:-mx-4 px-3 md:px-4 bg-rose-50/60" : ""}`} data-testid={`todo-${t.id}`}>
      <div className="flex items-start gap-2">
        <button onClick={() => canTick && onToggle(t)} disabled={!canTick || busy === t.id} title={canTick ? "Toggle done" : "Only the owner or an admin can tick this"} className="mt-0.5 disabled:opacity-40" data-testid={`todo-toggle-${t.id}`}>
          {busy === t.id ? <Loader2 size={18} className="animate-spin" /> : t.status === "done" ? <CheckSquare size={18} className="text-emerald-600" /> : <Square size={18} className="text-slate-400" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-sm ${t.status === "done" ? "line-through text-slate-400" : "text-slate-900"}`}>{t.title}</span>
            {t.urgent && t.status !== "done" && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wide bg-rose-600 text-white" data-testid={`todo-urgent-pill-${t.id}`}><Flame size={10} /> Urgent</span>
            )}
            {isChecklist && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-violet-100 text-violet-700" data-testid={`todo-checklist-pill-${t.id}`}><Repeat size={10} /> Checklist</span>
            )}
            {t.carried && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-amber-100 text-amber-700" data-testid={`todo-carried-pill-${t.id}`}><History size={10} /> Missed yesterday</span>
            )}
          </div>
          <div className="text-[11px] text-slate-500 flex flex-wrap gap-x-2 gap-y-0.5 mt-0.5">
            {t.due_date && <span className={`inline-flex items-center gap-1 font-semibold ${overdue ? "text-rose-600" : t.due_date === today ? "text-amber-700" : "text-slate-600"}`}><CalendarClock size={11} /> {overdue ? `Overdue ${fmtDay(t.due_date)} (${Math.abs(dd)}d ago)` : t.due_date === today ? "Due today" : `Due ${fmtDay(t.due_date)}${dd != null ? ` (in ${dd}d)` : ""}`}</span>}
            {!isChecklist && t.created_at && <span className="inline-flex items-center gap-1 text-slate-500" data-testid={`todo-added-${t.id}`}><CalendarPlus size={11} /> Added {fmtStamp(t.created_at)} · {elapsedLabel(daysSince(t.created_at))}</span>}
            {isChecklist && <span className="text-violet-600">{recurrenceLabel(t)}</span>}
            {t.created_by_id !== t.owner_id && <span>assigned by {t.created_by_name}</span>}
            {t.status === "done" && t.done_by_name && <span>done by {t.done_by_name}</span>}
            {t.notes && <span className="text-slate-400">· {t.notes}</span>}
          </div>
        </div>
        {canEditRow && (
          <button onClick={() => onStartEdit(t)} className="text-slate-300 hover:text-indigo-600" title="Edit" data-testid={`todo-edit-btn-${t.id}`}><Edit3 size={15} /></button>
        )}
        {!isChecklist && (
          <button onClick={onToggleComments} className={`relative ${commentsOpen ? "text-indigo-600" : "text-slate-300 hover:text-indigo-600"}`} title="Progress notes & blockers" data-testid={`todo-comments-btn-${t.id}`}>
            <MessageSquare size={15} />
            {t.comment_count > 0 && <span className="absolute -top-1.5 -right-1.5 min-w-[15px] h-[15px] px-0.5 rounded-full bg-indigo-600 text-white text-[9px] font-bold flex items-center justify-center" data-testid={`todo-comment-count-${t.id}`}>{t.comment_count}</span>}
          </button>
        )}
        {!isChecklist && t.owner_id !== user.id && (
          <button onClick={() => onTake(t)} disabled={busy === t.id} className="text-slate-300 hover:text-emerald-600 disabled:opacity-40" title="De-assign — bring this task to me" data-testid={`todo-take-${t.id}`}><UserMinus size={15} /></button>
        )}
        {!isChecklist && (t.owner_id === user.id || t.created_by_id === user.id || user.role === "admin") && (
          <button onClick={() => onRemove(t)} className="text-slate-300 hover:text-rose-600" title="Delete" data-testid={`todo-delete-${t.id}`}><Trash2 size={15} /></button>
        )}
      </div>
      {commentsOpen && !isChecklist && (
        <TodoComments todo={t} user={user} onCountChange={onCommentCount} />
      )}
    </li>
  );
}
