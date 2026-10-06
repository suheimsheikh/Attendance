/**
 * KitchenAnalyticsTab — pantry graphics panel.
 *
 * Renders four chart clusters for both PURCHASES and ISSUES over a
 * selectable date window — a single month (prev / next / this-month) or a
 * custom date range:
 *   • Spend trend: weekly ₹ bars + monthly ₹ total line (dual axis)
 *   • Top items by ₹ (bar)
 *   • Top items by qty (bar)
 *   • Category share (pie)
 * followed by a searchable item-wise table.
 *
 * All numbers come from GET /api/meals/kitchen-analytics.
 */
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { api, showApiError } from "../../api";
import { formatDate } from "../../utils";
import { Section } from "./kitchen-analytics/Section";
import { todayIso } from "./kitchen-analytics/helpers";


function firstOfMonthIso(iso) {
  const d = new Date(iso + "T00:00:00");
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function addMonthsIso(iso, delta) {
  const d = new Date(iso + "T00:00:00");
  const nd = new Date(d.getFullYear(), d.getMonth() + delta, 1);
  return `${nd.getFullYear()}-${String(nd.getMonth() + 1).padStart(2, "0")}-01`;
}
function monthRange(anchorIso) {
  const d = new Date(anchorIso + "T00:00:00");
  const y = d.getFullYear(), m = d.getMonth();
  const fmt = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  return {
    from: fmt(new Date(y, m, 1)),
    to: fmt(new Date(y, m + 1, 0)),
    label: new Date(y, m, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
  };
}

export default function KitchenAnalyticsTab({ liveSig }) {
  // Date scope: a single MONTH (prev / next / this-month nav) or a custom
  // DATE RANGE. (Older All / 7d / 30d / 90d presets were dropped — the
  // pantry is run month-to-month, so a month view + range is what's used.)
  const [mode, setMode] = useState("month");            // "month" | "custom"
  const [monthAnchor, setMonthAnchor] = useState(() => firstOfMonthIso(todayIso()));
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(todayIso());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  // In month mode, from/to track the selected month's first/last day.
  useEffect(() => {
    if (mode !== "month") return;
    const r = monthRange(monthAnchor);
    setFrom(r.from);
    setTo(r.to);
  }, [mode, monthAnchor]);

  useEffect(() => {
    if (!from || !to || from > to) return;
    let ignore = false;
    setLoading(true);
    api.get(`/meals/kitchen-analytics?start=${from}&end=${to}`)
      .then((res) => { if (!ignore) setData(res); })
      .catch((err) => { if (!ignore) showApiError(err, "Couldn't load kitchen analytics"); })
      .finally(() => { if (!ignore) setLoading(false); });
    return () => { ignore = true; };
  }, [from, to, liveSig]);

  return (
    <div data-testid="kitchen-analytics-tab">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden">
          {[["month", "Month"], ["custom", "Date range"]].map(([v, l]) => (
            <button
              key={v}
              onClick={() => setMode(v)}
              className={`px-3 h-9 text-xs font-bold ${mode === v ? "bg-slate-800 text-white" : "bg-white text-slate-600 hover:bg-slate-50"}`}
              data-testid={`kitchen-analytics-mode-${v}`}
              title={v === "month" ? "View one month at a time" : "Pick a custom start and end date"}
            >{l}</button>
          ))}
        </div>
        {mode === "month" && (
          <div className="inline-flex items-center gap-1">
            <button
              onClick={() => setMonthAnchor((a) => addMonthsIso(a, -1))}
              title="Previous month"
              data-testid="kitchen-analytics-prev-month"
              className="h-9 w-9 flex items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
            ><ChevronLeft size={16} /></button>
            <div className="min-w-[150px] text-center text-sm font-bold text-slate-700" data-testid="kitchen-analytics-month-label">
              {monthRange(monthAnchor).label}
            </div>
            <button
              onClick={() => setMonthAnchor((a) => addMonthsIso(a, 1))}
              title="Next month"
              data-testid="kitchen-analytics-next-month"
              className="h-9 w-9 flex items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
            ><ChevronRight size={16} /></button>
            <button
              onClick={() => setMonthAnchor(firstOfMonthIso(todayIso()))}
              title="Jump to the current month"
              data-testid="kitchen-analytics-this-month"
              className="h-9 px-3 text-xs font-semibold rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
            >This month</button>
          </div>
        )}
        {mode === "custom" && (
          <>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                   className="iu-input !h-9 !w-auto text-sm" data-testid="kitchen-analytics-from" />
            <span className="text-slate-400 text-xs">to</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                   className="iu-input !h-9 !w-auto text-sm" data-testid="kitchen-analytics-to" />
          </>
        )}
        <div className="ml-auto text-xs text-slate-500">
          {from && to ? <>Window: <b>{formatDate(from)}</b> — <b>{formatDate(to)}</b></> : null}
        </div>
      </div>

      {loading && !data ? (
        <div className="text-center py-12"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
      ) : !data ? (
        <div className="text-center text-slate-400 py-12">No data yet.</div>
      ) : (
        <>
          {/* Keep the charts on screen during background refreshes (a live
              pantry edit or a date change) so the panel no longer blanks to
              a spinner and "flashes" while staff are entering data. */}
          {loading && (
            <div className="flex items-center gap-1.5 text-[11px] text-slate-400 mb-1" data-testid="kitchen-analytics-updating">
              <Loader2 className="animate-spin" size={11} /> Updating…
            </div>
          )}
          <Section
            title="Purchases"
            subtitle="What came into the pantry"
            accent="purchases"
            data={data.purchases}
            testKind="purchases"
            from={from} to={to}
            first
          />
          <Section
            title="Issues"
            subtitle="What was issued to the kitchen (valued at weighted-avg purchase rate)"
            accent="issues"
            data={data.issues}
            from={from} to={to}
            testKind="issues"
          />
        </>
      )}
    </div>
  );
}
