import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, ClipboardCheck, X, CheckCircle2, ArrowRight } from "lucide-react";
import { api } from "../api";

// Daily readiness checklist shown to admins. Appears on every login until the
// admin marks it "Done for today" (dismissed per admin per day).
export default function AdminChecklist() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get("/admin/checklist")
      .then((res) => {
        if (cancelled) return;
        setData(res);
        if (!res.dismissed) setOpen(true);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!open || !data) return null;

  const toggle = (key) => setTicked((t) => ({ ...t, [key]: !t[key] }));

  const dismiss = async () => {
    setBusy(true);
    try { await api.post("/admin/checklist/dismiss"); } catch { /* ignore */ }
    setBusy(false);
    setOpen(false);
  };

  const go = (link) => { setOpen(false); navigate(link); };

  const badge = (it) => {
    if (it.status !== undefined) {
      const muted = it.status === "None" || it.status === "No";
      return (
        <span data-testid={`checklist-badge-${it.key}`} className={`text-xs font-bold px-2 py-0.5 rounded-full ${muted ? "bg-slate-100 text-slate-500" : "bg-amber-100 text-amber-700"}`}>
          {it.status}
        </span>
      );
    }
    const n = it.count || 0;
    const tone = n > 0 ? "bg-violet-100 text-violet-700" : "bg-emerald-100 text-emerald-700";
    return (
      <span data-testid={`checklist-badge-${it.key}`} className={`text-xs font-bold px-2 py-0.5 rounded-full ${tone}`}>
        {n}
      </span>
    );
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end md:items-center justify-center bg-black/50 p-0 md:p-4" data-testid="admin-checklist-modal">
      <div className="bg-white w-full md:max-w-lg rounded-t-2xl md:rounded-2xl max-h-[92vh] overflow-hidden flex flex-col shadow-2xl">
        <header className="px-6 pt-6 pb-4 border-b border-slate-100 flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-violet-100 text-violet-600 flex items-center justify-center shrink-0">
              <ClipboardCheck size={20} />
            </div>
            <div>
              <h2 className="text-lg font-extrabold leading-tight">Daily readiness check</h2>
              <p className="text-xs text-slate-500 mt-0.5">Confirm today&apos;s setup before the day kicks off.</p>
            </div>
          </div>
          <button onClick={() => setOpen(false)} data-testid="checklist-close" className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400" title="Remind me on next login">
            <X size={18} />
          </button>
        </header>

        <div className="px-4 py-3 overflow-y-auto divide-y divide-slate-100">
          {data.items.map((it) => {
            const on = !!ticked[it.key];
            return (
              <div key={it.key} data-testid={`checklist-item-${it.key}`} className="flex items-center gap-3 py-2.5">
                <button
                  type="button"
                  onClick={() => toggle(it.key)}
                  data-testid={`checklist-tick-${it.key}`}
                  className={`w-6 h-6 rounded-md border-2 flex items-center justify-center shrink-0 transition ${on ? "bg-emerald-500 border-emerald-500 text-white" : "border-slate-300 text-transparent hover:border-emerald-400"}`}
                >
                  <CheckCircle2 size={14} />
                </button>
                <div className="flex-1 min-w-0">
                  <div className={`text-sm font-semibold ${on ? "text-slate-400 line-through" : "text-slate-800"}`}>{it.label}</div>
                  <div className="text-[11px] text-slate-400">{it.hint}</div>
                </div>
                {badge(it)}
                <button
                  type="button"
                  onClick={() => go(it.link)}
                  data-testid={`checklist-go-${it.key}`}
                  className="p-1.5 rounded-lg hover:bg-violet-50 text-violet-500"
                  title="Open"
                >
                  <ArrowRight size={15} />
                </button>
              </div>
            );
          })}
        </div>

        <footer className="px-6 py-4 border-t border-slate-100 flex items-center justify-between gap-3">
          <button onClick={() => setOpen(false)} data-testid="checklist-later" className="iu-btn-secondary !h-10">
            Remind me later
          </button>
          <button onClick={dismiss} disabled={busy} data-testid="checklist-done" className="iu-btn-primary !h-10">
            {busy ? <Loader2 className="animate-spin" size={16} /> : <CheckCircle2 size={16} />} Done for today
          </button>
        </footer>
      </div>
    </div>
  );
}
