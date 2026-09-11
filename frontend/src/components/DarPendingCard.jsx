import React, { useEffect, useState } from "react";
import { Loader2, FileText, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";
import { DarTextarea, DarShareButton } from "./Dar";

/** Post-checkout card: file today's DAR late (worked today, none filed). */
export default function DarPendingCard({ status, userName, onSaved }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(null);

  useEffect(() => {
    setSaved(null);
    setText("");
    // Pre-fill with today's completed to-dos / checklist ticks (executives & coaches).
    if (status?.required && status?.worked_today && !status?.today_dar) {
      api.get("/tasks/dar-prefill").then((r) => { if (r?.text) setText(r.text); }).catch(() => {});
    }
  }, [status?.today, status?.required, status?.worked_today, status?.today_dar]);

  if (!status?.required || !status?.worked_today) return null;
  const existing = saved || status.today_dar;

  if (existing) {
    return (
      <div className="iu-card p-5 mb-4 text-center" data-testid="dar-done-card">
        <div className="inline-flex items-center gap-2 text-emerald-700 font-bold text-sm">
          <CheckCircle2 size={16} /> Today&apos;s DAR is filed
        </div>
        <p className="text-xs text-slate-500 mt-1 whitespace-pre-wrap line-clamp-3 text-left">{existing.text}</p>
        <DarShareButton dar={existing} name={userName} groupName={status.group_name} className="mt-3" />
      </div>
    );
  }

  const submit = async () => {
    setBusy(true);
    try {
      const res = await api.post("/dar", { text });
      setSaved(res);
      toast.success("DAR saved — now share it to the group");
      onSaved?.(res);
    } catch (err) { toast.error(err?.message || "Couldn't save DAR"); }
    finally { setBusy(false); }
  };

  return (
    <div className="iu-card p-5 mb-4" data-testid="dar-pending-card">
      <div className="flex items-center gap-2 text-rose-700 font-bold text-sm mb-3">
        <FileText size={16} /> Today&apos;s DAR is pending — a missed DAR is counted for payroll
      </div>
      <DarTextarea value={text} onChange={setText} minChars={status.min_chars} headline="Daily Activity Report" />
      <button
        data-testid="dar-pending-save"
        disabled={busy || text.trim().length < (status.min_chars || 20)}
        onClick={submit}
        className="iu-btn-primary w-full"
      >
        {busy ? <Loader2 className="animate-spin" size={16} /> : <FileText size={16} />} Save DAR
      </button>
    </div>
  );
}
