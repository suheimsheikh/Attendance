import React, { useEffect, useState } from "react";
import { Loader2, Save, MessageSquare, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";

function label(inst) {
  return inst === "__default__" ? "Default (fallback)" : inst;
}

function SenderRow({ row, onSaved }) {
  const [sid, setSid] = useState(row.account_sid || "");
  const [token, setToken] = useState("");
  const [from, setFrom] = useState(row.from_number || "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const payload = { account_sid: sid.trim(), from_number: from.trim() };
      if (token.trim()) payload.auth_token = token.trim();  // blank = keep existing
      const res = await api.put(`/admin/sms-senders/${encodeURIComponent(row.institution)}`, payload);
      setToken("");
      toast.success(`Saved ${label(row.institution)}`);
      onSaved && onSaved(res);
    } catch (err) {
      toast.error(err?.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-slate-200 p-3" data-testid={`sms-sender-${row.institution}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="font-bold text-slate-800 text-sm">{label(row.institution)}</span>
        {row.configured ? (
          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-600"><CheckCircle2 size={12} /> Active</span>
        ) : (
          <span className="text-[11px] text-slate-400">Not configured</span>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <input data-testid={`sms-sid-${row.institution}`} value={sid} onChange={(e) => setSid(e.target.value)} placeholder="Account SID (AC…)" className="iu-input !text-xs" />
        <input data-testid={`sms-token-${row.institution}`} type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={row.auth_token_set ? "•••••••• (set — leave blank to keep)" : "Auth Token"} className="iu-input !text-xs" />
        <input data-testid={`sms-from-${row.institution}`} value={from} onChange={(e) => setFrom(e.target.value)} placeholder="From number (+1…)" className="iu-input !text-xs" />
      </div>
      <div className="flex justify-end mt-2">
        <button data-testid={`sms-save-${row.institution}`} onClick={save} disabled={saving} className="iu-btn-secondary !text-xs !h-8">
          {saving ? <Loader2 className="animate-spin" size={13} /> : <><Save size={13} /> Save</>}
        </button>
      </div>
    </div>
  );
}

export default function SmsSenders() {
  const [rows, setRows] = useState(null);

  const load = async () => {
    try { setRows(await api.get("/admin/sms-senders")); }
    catch { setRows([]); }
  };
  useEffect(() => { load(); }, []);

  return (
    <div className="bg-white rounded-2xl shadow-sm p-5 mt-6" data-testid="sms-senders-card">
      <div className="flex items-center gap-2 mb-1">
        <MessageSquare size={18} className="text-violet-500" />
        <h2 className="text-lg font-extrabold">Parent SMS (Twilio)</h2>
      </div>
      <p className="text-[12px] text-slate-500 mb-4">
        Each institution can use its own Twilio account. When a child is marked late/absent, the SMS is sent from that institution&apos;s number. Institutions without a sender fall back to the <b>Default</b>.
      </p>
      {!rows ? (
        <div className="flex justify-center py-6"><Loader2 className="animate-spin text-slate-400" /></div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => <SenderRow key={r.institution} row={r} onSaved={load} />)}
        </div>
      )}
    </div>
  );
}
