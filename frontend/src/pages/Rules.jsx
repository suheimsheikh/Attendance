import React, { useEffect, useState } from "react";
import { ScrollText, CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";
import { useAuth } from "../auth";

const fmt = (iso) => iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "";

export default function Rules() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [accs, setAccs] = useState(null);

  const load = () => api.get("/rules").then(setData).catch((e) => toast.error(e?.message || "Couldn't load rules"));
  useEffect(() => { load(); }, []);
  useEffect(() => { if (user?.role === "admin") api.get("/admin/rules/acceptances").then(setAccs).catch(() => {}); }, [user?.role]);

  const accept = async () => {
    setBusy(true);
    try {
      await api.post("/rules/accept");
      toast.success("Thank you — rules accepted");
      await load();
      window.dispatchEvent(new Event("rules-accepted"));
    } catch (e) { toast.error(e?.message || "Couldn't record acceptance"); }
    finally { setBusy(false); }
  };

  if (!data) return <div className="p-8 text-center"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>;
  let n = 0;
  const mustAccept = data.required && !data.accepted;

  return (
    <div className="max-w-3xl mx-auto p-4 md:p-8" data-testid="rules-page">
      <header className="mb-6">
        <h1 className="text-3xl font-extrabold tracking-tight flex items-center gap-2"><ScrollText size={24} className="text-sky-600" /> Attendance Rules</h1>
        <p className="text-slate-500 text-sm mt-1">Yacht Club of Hyderabad — version {data.version}. Applies to Staff, Coaches and Executives; recorded and enforced through this app.</p>
      </header>

      {mustAccept && (
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4 mb-6 text-sm text-amber-900 font-semibold" data-testid="rules-must-accept">
          Please read the rules below and accept them to continue using the app.
        </div>
      )}
      {data.accepted && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 mb-6 text-sm text-emerald-800 flex items-center gap-2" data-testid="rules-accepted-banner">
          <CheckCircle2 size={16} /> You accepted version {data.accepted.version} on {fmt(data.accepted.accepted_at)}.
        </div>
      )}

      <div className="iu-card p-5 md:p-7 space-y-6">
        {data.sections.map((s) => (
          <section key={s.heading}>
            <h2 className="text-base md:text-lg font-extrabold tracking-tight text-slate-900 mb-2">{s.heading}</h2>
            <ol className="space-y-2">
              {s.rules.map((r) => { n += 1; return (
                <li key={n} className="flex gap-3 text-sm text-slate-700 leading-relaxed" data-testid={`rule-${n}`}>
                  <span className="shrink-0 w-7 h-7 rounded-full bg-slate-900 text-white text-xs font-bold flex items-center justify-center">{n}</span>
                  <span className="pt-1">{r}</span>
                </li>
              ); })}
            </ol>
          </section>
        ))}
      </div>

      {mustAccept && (
        <div className="iu-card p-5 mt-6" data-testid="rules-accept-card">
          <label className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="mt-1 h-4 w-4" data-testid="rules-agree" />
            <span className="text-sm text-slate-800">I, <b>{user?.full_name}</b>, have read and understood the Attendance Rules above and agree to abide by them.</span>
          </label>
          <button onClick={accept} disabled={!agree || busy} className="iu-btn-primary w-full mt-4" data-testid="rules-accept">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />} Accept the rules
          </button>
        </div>
      )}

      {accs && (
        <section className="iu-card p-5 mt-6" data-testid="rules-acceptances">
          <h3 className="font-extrabold tracking-tight text-sm text-slate-500 uppercase mb-2">Sign-off status · {accs.accepted} accepted · {accs.pending} pending</h3>
          <ul className="divide-y divide-slate-100 text-sm">
            {accs.rows.map((r) => (
              <li key={r.member_id} className="py-1.5 flex items-center gap-2" data-testid={`rules-acc-${r.member_id}`}>
                <span className="flex-1 truncate">{r.member_name} <span className="text-[10px] uppercase text-slate-400">{r.category}</span></span>
                {r.accepted_at ? <span className="text-emerald-700 text-xs font-semibold">{fmt(r.accepted_at)}</span> : <span className="text-rose-600 text-xs font-semibold">pending</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
