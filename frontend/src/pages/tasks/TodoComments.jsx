import React, { useEffect, useState } from "react";
import { Loader2, Send, Trash2, AlertTriangle, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";

const fmt = (iso) => iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "";

export default function TodoComments({ todo, user, onCountChange }) {
  const [rows, setRows] = useState(null);
  const [text, setText] = useState("");
  const [kind, setKind] = useState("note");
  const [busy, setBusy] = useState(false);

  const load = () => api.get(`/todos/${todo.id}/comments`)
    .then((r) => { setRows(r.rows); onCountChange?.(todo.id, r.rows.length); })
    .catch((e) => toast.error(e?.message || "Failed to load comments"));
  useEffect(() => { load(); }, [todo.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try { await api.post(`/todos/${todo.id}/comments`, { text: text.trim(), kind }); setText(""); setKind("note"); load(); }
    catch (err) { toast.error(err?.message || "Couldn't add"); }
    finally { setBusy(false); }
  };
  const remove = async (c) => {
    if (!window.confirm("Delete this comment?")) return;
    try { await api.del(`/todos/${todo.id}/comments/${c.id}`); load(); }
    catch (err) { toast.error(err?.message || "Not allowed"); }
  };

  return (
    <div className="mt-2 ml-7 rounded-xl bg-slate-50 ring-1 ring-slate-100 p-2.5" data-testid={`todo-comments-${todo.id}`}>
      {rows === null ? <div className="text-center py-2"><Loader2 size={16} className="animate-spin mx-auto text-slate-400" /></div>
        : rows.length === 0 ? <p className="text-[11px] text-slate-400 italic mb-2">No progress notes yet.</p>
        : (
          <ul className="space-y-1.5 mb-2">
            {rows.map((c) => (
              <li key={c.id} className="flex items-start gap-2 text-xs" data-testid={`comment-${c.id}`}>
                {c.kind === "blocker"
                  ? <span className="mt-0.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-black uppercase bg-rose-100 text-rose-700 shrink-0"><AlertTriangle size={9} /> Blocker</span>
                  : <span className="mt-0.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[9px] font-bold uppercase bg-slate-200 text-slate-600 shrink-0"><MessageSquare size={9} /> Note</span>}
                <div className="flex-1 min-w-0">
                  <div className="text-slate-800 whitespace-pre-wrap break-words">{c.text}</div>
                  <div className="text-[10px] text-slate-400">{c.author_name} · {fmt(c.created_at)}</div>
                </div>
                {(c.author_id === user.id || user.role === "admin") && (
                  <button onClick={() => remove(c)} className="text-slate-300 hover:text-rose-600 shrink-0" title="Delete comment" data-testid={`comment-delete-${c.id}`}><Trash2 size={13} /></button>
                )}
              </li>
            ))}
          </ul>
        )}
      <form onSubmit={add} className="flex items-center gap-1.5">
        <div className="flex rounded-full bg-white ring-1 ring-slate-200 overflow-hidden shrink-0">
          <button type="button" onClick={() => setKind("note")} data-testid={`comment-kind-note-${todo.id}`} className={`px-2 h-8 text-[10px] font-bold uppercase ${kind === "note" ? "bg-slate-800 text-white" : "text-slate-500"}`}>Note</button>
          <button type="button" onClick={() => setKind("blocker")} data-testid={`comment-kind-blocker-${todo.id}`} className={`px-2 h-8 text-[10px] font-bold uppercase ${kind === "blocker" ? "bg-rose-600 text-white" : "text-slate-500"}`}>Blocker</button>
        </div>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a progress note or blocker…" className="iu-input !h-8 text-xs flex-1" data-testid={`comment-input-${todo.id}`} />
        <button className="iu-btn-primary !h-8 !px-3" disabled={busy || !text.trim()} data-testid={`comment-send-${todo.id}`}>{busy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}</button>
      </form>
    </div>
  );
}
