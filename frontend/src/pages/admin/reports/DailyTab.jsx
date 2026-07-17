import React, { useCallback, useEffect, useState } from "react";
import { Loader2, FileDown, FileText, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { todayIso } from "../../../utils";
import { api, downloadBlob } from "../../../api";
import SectionList from "./SectionList";

/**
 * Daily leave/tour list — 3rd tab on the Reports page. Picks a date,
 * lists everyone on leave and everyone on tour that day. Owns its own
 * fetch state; parent just mounts it.
 */
export default function DailyTab() {
  const [day, setDay] = useState(todayIso());
  const [daily, setDaily] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadDaily = useCallback(async () => {
    setLoading(true);
    try { setDaily(await api.get("/reports/daily", { on: day })); }
    catch (err) { toast.error(err?.message || "Failed"); }
    finally { setLoading(false); }
  }, [day]);

  useEffect(() => { loadDaily(); }, [loadDaily]);

  const exportDaily = (fmt) =>
    downloadBlob("/reports/daily/export", `daily_${day}.${fmt}`, { on: day, fmt });

  return (
    <>
      <div className="iu-card p-4 mb-4 flex flex-wrap items-end gap-3">
        <div>
          <label className="iu-label">Date</label>
          <input data-testid="rep-day" type="date" value={day} onChange={(e) => setDay(e.target.value)} className="iu-input !w-44" />
        </div>
        <button data-testid="rep-day-run" onClick={loadDaily} disabled={loading} className="iu-btn-primary">
          {loading ? <Loader2 className="animate-spin" size={14}/> : <RefreshCw size={14}/>} Run report
        </button>
        <div className="flex-1" />
        <button data-testid="export-daily-csv" onClick={() => exportDaily("csv")} className="iu-btn-secondary"><FileDown size={14}/> CSV</button>
        <button data-testid="export-daily-pdf" onClick={() => exportDaily("pdf")} className="iu-btn-secondary"><FileText size={14}/> PDF</button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <SectionList title="On leave" items={daily?.on_leave || []} />
        <SectionList title="On tour" items={daily?.on_tour || []} />
      </div>
    </>
  );
}
