import React, { useState } from "react";
import { ClipboardList, Loader2, Wrench } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";
import { formatDate, todayIso, monthStartIso } from "../utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";

const lt = (late, m) => (late ? `LT ${m}m` : "on-time");
const eo = (m) => (m >= 15 ? `EO ${m}m` : "—");

/** After a member's start/end time changes: preview + re-apply late & early-out to past days. */
export default function RecalcTimingsDialog({ member, onClose }) {
  const [start, setStart] = useState(monthStartIso());
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);

  const call = (dry_run) => api.post("/attendance/recalc-late", { user_id: member.id, start, end: todayIso(), dry_run });
  const err = (e) => toast.error(/403|Super/.test(e?.message || "") ? "Super Admin only — ask the Super Admin to apply this from Data Quality." : (e?.message || "Failed"));

  const runPreview = async () => {
    setBusy(true);
    try { setPreview(await call(true)); } catch (e) { err(e); } finally { setBusy(false); }
  };
  const runApply = async () => {
    setBusy(true);
    try {
      const r = await call(false);
      toast.success(`Re-applied new timings — ${r.applied} day(s) updated. The Grid now reflects them.`);
      onClose();
    } catch (e) { err(e); } finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-xl" data-testid="recalc-timings-dialog">
        <DialogHeader>
          <DialogTitle>Re-apply new timings to past days?</DialogTitle>
          <DialogDescription>
            {member.name}'s start/end time changed. Late and early-out are stamped at check-in/out, so past days still use the old timings until re-applied.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-[10px] font-bold uppercase tracking-wide text-slate-500">From
            <input type="date" value={start} max={todayIso()} onChange={(e) => { setStart(e.target.value); setPreview(null); }}
              className="iu-input !h-9 text-sm block mt-1" data-testid="recalc-timings-start" />
          </label>
          <span className="text-sm text-slate-500 mb-2">→ today</span>
          <button type="button" onClick={runPreview} disabled={busy} data-testid="recalc-timings-preview"
            className="iu-btn-secondary !h-9 text-sm">{busy && !preview ? <Loader2 size={14} className="animate-spin" /> : <ClipboardList size={14} />} Preview</button>
        </div>
        {preview && (
          <div className="mt-2" data-testid="recalc-timings-summary">
            <p className="text-sm text-slate-600 mb-2"><b className="text-sky-700">{preview.changed}</b> of {preview.scanned} day(s) would change.</p>
            {preview.changed > 0 && (
              <div className="max-h-56 overflow-auto rounded-xl border border-slate-200">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-slate-500 sticky top-0"><tr className="text-left">
                    <th className="px-3 py-1.5">Date</th><th className="px-3 py-1.5">Was</th><th className="px-3 py-1.5">Now</th>
                  </tr></thead>
                  <tbody>{preview.changes.map((c) => (
                    <tr key={c.attendance_id} className="border-t border-slate-100" data-testid="recalc-timings-row">
                      <td className="px-3 py-1 tabular-nums">{formatDate(c.date)}</td>
                      <td className="px-3 py-1 text-slate-500">{lt(c.was_late, c.was_minutes)} · {eo(c.was_early_out)}</td>
                      <td className="px-3 py-1 font-semibold text-sky-700">{lt(c.now_late, c.now_minutes)} · {eo(c.now_early_out)}</td>
                    </tr>))}</tbody>
                </table>
              </div>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="iu-btn-secondary !h-9 text-sm" data-testid="recalc-timings-skip">Only from today</button>
          {preview?.changed > 0 && (
            <button type="button" onClick={runApply} disabled={busy} className="iu-btn-primary !h-9 !px-4 text-sm" data-testid="recalc-timings-apply">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Wrench size={14} />} Apply to {preview.changed} day(s)
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
