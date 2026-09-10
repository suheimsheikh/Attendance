import React, { useEffect, useState } from "react";
import { Lightbulb, Loader2, Send, Sparkles, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";
import { useAuth } from "../auth";

const fmt = (iso) => iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "";

const STATUS_META = {
  new:         { label: "New", cls: "bg-sky-100 text-sky-700" },
  planned:     { label: "Planned", cls: "bg-violet-100 text-violet-700" },
  in_progress: { label: "In progress", cls: "bg-amber-100 text-amber-800" },
  done:        { label: "Done", cls: "bg-emerald-100 text-emerald-700" },
  declined:    { label: "Not planned", cls: "bg-slate-200 text-slate-600" },
};

const StatusBadge = ({ status }) => {
  const m = STATUS_META[status] || STATUS_META.new;
  return <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full ${m.cls}`} data-testid={`suggestion-status-${status}`}>{m.label}</span>;
};

export default function Suggestions() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [text, setText] = useState("");
  const [category, setCategory] = useState("");
  const [busy, setBusy] = useState(false);
  const [mine, setMine] = useState(null);
  const [tab, setTab] = useState("mine"); // mine | all (admin)
  const [all, setAll] = useState(null);

  const loadMine = () => api.get("/suggestions/mine").then((d) => setMine(d.rows || [])).catch(() => setMine([]));
  const loadAll = () => api.get("/admin/suggestions").then(setAll).catch(() => {});
  useEffect(() => { loadMine(); }, []);
  useEffect(() => { if (isAdmin && tab === "all") loadAll(); }, [isAdmin, tab]);

  const submit = async (e) => {
    e.preventDefault();
    if (text.trim().length < 3) { toast.error("Please write your suggestion first"); return; }
    setBusy(true);
    try {
      await api.post("/suggestions", { text: text.trim(), category: category.trim() || undefined });
      toast.success("Thanks! Your suggestion has been sent.");
      setText(""); setCategory("");
      loadMine();
      if (isAdmin && tab === "all") loadAll();
    } catch (err) { toast.error(err?.message || "Couldn't send suggestion"); }
    finally { setBusy(false); }
  };

  const setStatus = async (sid, status) => {
    try { await api.patch(`/admin/suggestions/${sid}`, { status }); toast.success("Updated"); loadAll(); }
    catch (err) { toast.error(err?.message || "Update failed"); }
  };

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-8" data-testid="suggestions-page">
      <header className="mb-6">
        <h1 className="text-3xl font-extrabold tracking-tight flex items-center gap-2"><Lightbulb size={24} className="text-amber-500" /> Suggestions</h1>
        <p className="text-slate-500 text-sm mt-1">Have an idea to make the app better? Tell us — every suggestion reaches the admins.</p>
      </header>

      {/* Submit form */}
      <form onSubmit={submit} className="iu-card p-5 space-y-3" data-testid="suggestion-form">
        <div>
          <label className="iu-label">Your suggestion</label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            maxLength={4000}
            className="iu-input"
            placeholder="e.g. It would help if the Muster Roll remembered the last fleet I used…"
            data-testid="suggestion-text"
          />
          <div className="text-[11px] text-slate-400 text-right mt-0.5">{text.length}/4000</div>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
          <div className="flex-1">
            <label className="iu-label">Area (optional)</label>
            <input value={category} onChange={(e) => setCategory(e.target.value)} className="iu-input" placeholder="e.g. Grid, Meals, Check-in" data-testid="suggestion-category" />
          </div>
          <button type="submit" disabled={busy} className="iu-btn-primary" data-testid="suggestion-submit">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />} Send suggestion
          </button>
        </div>
      </form>

      {/* Admin tab switch */}
      {isAdmin && (
        <div className="flex gap-2 mt-6" data-testid="suggestion-tabs">
          <button onClick={() => setTab("mine")} className={`px-3 py-1.5 rounded-lg text-sm font-semibold ${tab === "mine" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`} data-testid="suggestion-tab-mine">My suggestions</button>
          <button onClick={() => setTab("all")} className={`px-3 py-1.5 rounded-lg text-sm font-semibold ${tab === "all" ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600"}`} data-testid="suggestion-tab-all">
            All suggestions{all?.total ? ` · ${all.total}` : ""}
          </button>
        </div>
      )}

      {/* My suggestions */}
      {(!isAdmin || tab === "mine") && (
        <section className="mt-6" data-testid="suggestion-mine">
          <h2 className="text-sm font-extrabold uppercase tracking-wider text-slate-500 mb-3">Your suggestions</h2>
          {mine === null ? (
            <div className="p-6 text-center"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
          ) : mine.length === 0 ? (
            <div className="iu-card p-6 text-center text-slate-400 text-sm" data-testid="suggestion-mine-empty">
              <Sparkles size={20} className="mx-auto mb-2 text-amber-400" />
              You haven't sent any suggestions yet. Your ideas help shape the app!
            </div>
          ) : (
            <ul className="space-y-3">
              {mine.map((s) => (
                <li key={s.id} className="iu-card p-4" data-testid={`suggestion-mine-${s.id}`}>
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm text-slate-800 whitespace-pre-wrap flex-1">{s.text}</p>
                    <StatusBadge status={s.status} />
                  </div>
                  <div className="text-[11px] text-slate-400 mt-2 flex items-center gap-2">
                    {s.category && <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{s.category}</span>}
                    <span>{fmt(s.created_at)}</span>
                  </div>
                  {s.admin_note && (
                    <div className="mt-2 text-xs bg-amber-50 border border-amber-100 rounded-lg p-2 text-amber-800">
                      <span className="font-semibold">Admin: </span>{s.admin_note}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Admin: all suggestions */}
      {isAdmin && tab === "all" && (
        <section className="mt-6" data-testid="suggestion-all">
          <h2 className="text-sm font-extrabold uppercase tracking-wider text-slate-500 mb-3 flex items-center gap-2"><ShieldCheck size={15} /> All suggestions</h2>
          {!all ? (
            <div className="p-6 text-center"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
          ) : all.rows.length === 0 ? (
            <div className="iu-card p-6 text-center text-slate-400 text-sm">No suggestions yet.</div>
          ) : (
            <ul className="space-y-3">
              {all.rows.map((s) => (
                <li key={s.id} className="iu-card p-4" data-testid={`suggestion-all-${s.id}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <p className="text-sm text-slate-800 whitespace-pre-wrap">{s.text}</p>
                      <div className="text-[11px] text-slate-400 mt-2 flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-slate-600">{s.user_name}</span>
                        {s.user_category && <span className="uppercase">{s.user_category}</span>}
                        {s.category && <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{s.category}</span>}
                        <span>{fmt(s.created_at)}</span>
                      </div>
                    </div>
                    <select
                      value={s.status}
                      onChange={(e) => setStatus(s.id, e.target.value)}
                      className="iu-input !w-auto text-xs py-1"
                      data-testid={`suggestion-status-select-${s.id}`}
                    >
                      {Object.entries(STATUS_META).map(([k, m]) => (
                        <option key={k} value={k}>{m.label}</option>
                      ))}
                    </select>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
