import React, { useEffect, useState } from "react";
import { Loader2, FileText, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { DarTextarea, DarShareButton } from "../../components/Dar";

const fmtDay = (iso) => iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" }) : "";

/** My DAR for the selected day, shown in the Task Manager when scope = "Mine".
 *  Editable/fileable inline. Future dates are read-only (no future DARs). */
export default function TaskDarPanel({ user, date, serverToday }) {
  const [policy, setPolicy] = useState(null);
  const [existing, setExisting] = useState(null);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const isFuture = !!(date && serverToday && date > serverToday);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([
      api.get("/config/dar-policy").catch(() => null),
      api.get("/dar/mine", { from_: date, to: date }).catch(() => ({ rows: [] })),
    ]).then(([pol, mine]) => {
      if (!alive) return;
      setPolicy(pol);
      const row = (mine?.rows || [])[0] || null;
      setExisting(row);
      setText(row?.text || "");
      setLoading(false);
    });
    return () => { alive = false; };
  }, [date]);

  const minChars = policy?.min_chars || 20;
  const save = async () => {
    setBusy(true);
    try {
      const res = await api.post("/dar", { text, date });
      setExisting(res); setText(res.text || "");
      toast.success(existing ? "DAR updated" : "DAR filed");
    } catch (err) { toast.error(err?.message || "Couldn't save DAR"); }
    finally { setBusy(false); }
  };

  if (loading) return <div className="iu-card p-4 mb-4 text-center" data-testid="task-dar-loading"><Loader2 className="animate-spin mx-auto text-slate-400" size={18} /></div>;

  return (
    <div className="rounded-2xl mb-4 p-4 bg-gradient-to-br from-sky-50 to-cyan-50 ring-1 ring-sky-100" data-testid="task-dar-panel">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 text-sky-800 font-bold text-sm">
          {existing ? <CheckCircle2 size={16} className="text-emerald-600" /> : <FileText size={16} />}
          My DAR · {fmtDay(date)}
        </div>
        {existing && <DarShareButton dar={existing} name={user?.full_name} groupName={policy?.group_name} className="!h-8 !px-3 text-xs" />}
      </div>
      {isFuture ? (
        <p className="text-sm text-slate-500 italic" data-testid="task-dar-future">You can't file a DAR for a future date.</p>
      ) : (
        <>
          <DarTextarea value={text} onChange={setText} minChars={minChars} headline={existing ? "Edit your DAR" : "File your DAR for this day"} testId="task-dar-text" />
          <button
            data-testid="task-dar-save"
            disabled={busy || text.trim().length < minChars}
            onClick={save}
            className="iu-btn-primary w-full !h-10"
          >
            {busy ? <Loader2 className="animate-spin" size={16} /> : <FileText size={16} />} {existing ? "Update DAR" : "File DAR"}
          </button>
        </>
      )}
    </div>
  );
}
