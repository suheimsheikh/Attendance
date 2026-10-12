import React, { useEffect, useRef, useState } from "react";
import { useEscape } from "../../../hooks/useEscape";
import { Loader2, X, CalendarRange, Printer } from "lucide-react";
import { api, showApiError } from "../../../api";
import { formatDate, todayIso, addDaysIso } from "../../../utils";
import { inr } from "./helpers";

/**
 * DailyTotalsHistoryModal — date-wise drill-down (Aug 2026 user
 * request). Opened by double-clicking either the Purchases or Issues
 * totals card. Defaults to a 7-day window ending on the currently
 * selected date; user can pick any start/end. `Print PDF` triggers
 * window.print() against a purpose-styled #meal-totals-print-region so
 * the rest of the app UI is stripped from the printout via @media
 * print rules already living in index.css.
 *
 * Extracted from MealEntryTab.jsx on 25 Jun 2026 (pure move).
 */
export default function DailyTotalsHistoryModal({ kind, selectedDate, onClose }) {
  useEscape(onClose);
  // Sensible default: 7-day trailing window ending on the selected day.
  const [start, setStart] = useState(() => addDaysIso(selectedDate, -6));
  const [end, setEnd] = useState(selectedDate);
  const [rows, setRows] = useState([]);
  const [totals, setTotals] = useState({ grand_purchase_amt: 0, grand_issue_amt: 0 });
  const [loading, setLoading] = useState(false);
  const printRef = useRef(null);

  useEffect(() => {
    let alive = true;
    if (start > end) return;
    setLoading(true);
    api.get("/meals/daily-totals", { start, end })
      .then((r) => {
        if (!alive) return;
        setRows(r.days || []);
        setTotals({
          grand_purchase_amt: r.grand_purchase_amt || 0,
          grand_issue_amt:    r.grand_issue_amt    || 0,
        });
      })
      .catch(showApiError)
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [start, end]);

  const isPurch = kind === "purchase";
  const title = isPurch ? "Purchases · Date-wise totals" : "Issues · Date-wise totals";
  const accent = isPurch ? "emerald" : "amber";

  const doPrint = () => {
    // Apply the body-class-portal pattern used by the other Meals
    // print flows (see index.css). CSS hides every sibling except the
    // `#meal-totals-print-region` while this class is active.
    const cls = "meal-totals-print-active";
    document.body.classList.add(cls);
    setTimeout(() => {
      window.print();
      document.body.classList.remove(cls);
    }, 50);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm p-4 print:static print:bg-transparent print:p-0" data-testid="daily-totals-modal">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col print:shadow-none print:rounded-none print:max-h-none print:w-full">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 print:hidden">
          <div>
            <h2 className="text-lg font-extrabold text-slate-900">{title}</h2>
            <p className="text-xs text-slate-500">Double-clicked from the Daily entry card</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-slate-100"
            data-testid="daily-totals-modal-close"
            title="Close"
          ><X size={18}/></button>
        </div>

        <div className="px-5 py-3 flex items-end gap-3 flex-wrap border-b border-slate-100 print:hidden">
          <label className="text-xs font-semibold text-slate-600">
            <div className="mb-1 inline-flex items-center gap-1"><CalendarRange size={12}/> From</div>
            <input
              type="date"
              value={start}
              max={end}
              onChange={(e) => setStart(e.target.value)}
              className="iu-input !h-9 !w-auto text-sm"
              data-testid="daily-totals-start"
            />
          </label>
          <label className="text-xs font-semibold text-slate-600">
            <div className="mb-1">To</div>
            <input
              type="date"
              value={end}
              min={start}
              max={todayIso()}
              onChange={(e) => setEnd(e.target.value)}
              className="iu-input !h-9 !w-auto text-sm"
              data-testid="daily-totals-end"
            />
          </label>
          <div className="flex-1"/>
          <button
            type="button"
            onClick={doPrint}
            className="iu-btn-primary !h-9"
            data-testid="daily-totals-print-btn"
            title="Open the browser print dialog — pick 'Save as PDF' to download"
          ><Printer size={14}/> Print / Save PDF</button>
        </div>

        <div id="meal-totals-print-region" ref={printRef} className="flex-1 overflow-y-auto p-5 print:overflow-visible print:p-6">
          <div className="hidden print:block mb-4">
            <h1 className="text-2xl font-extrabold text-slate-900">{title}</h1>
            <p className="text-sm text-slate-600">
              {formatDate(start)} — {formatDate(end)}
            </p>
          </div>

          {loading ? (
            <div className="py-10 text-center text-slate-500 inline-flex items-center gap-2 w-full justify-center">
              <Loader2 size={16} className="animate-spin"/> Loading…
            </div>
          ) : rows.length === 0 ? (
            <div className="py-10 text-center text-slate-500" data-testid="daily-totals-empty">
              No purchases or issues recorded in this window.
            </div>
          ) : (
            <table className="w-full text-sm" data-testid="daily-totals-table">
              <thead>
                <tr className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                  <th className="text-left p-2">Date</th>
                  <th className={`text-right p-2 ${isPurch ? "bg-emerald-50 text-emerald-800" : ""}`}>Purchases ₹</th>
                  <th className="text-right p-2 hidden sm:table-cell">Purch. lines</th>
                  <th className={`text-right p-2 ${!isPurch ? "bg-amber-50 text-amber-800" : ""}`}>Issues ₹</th>
                  <th className="text-right p-2 hidden sm:table-cell">Cons. lines</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.date} className="border-t border-slate-100 hover:bg-slate-50/70" data-testid={`daily-totals-row-${r.date}`}>
                    <td className="p-2 font-semibold text-slate-800 whitespace-nowrap">{formatDate(r.date)}</td>
                    <td className={`p-2 text-right tabular-nums font-semibold ${isPurch ? "text-emerald-800" : "text-slate-700"}`}>
                      {inr(r.purchase_amt)}
                    </td>
                    <td className="p-2 text-right text-slate-500 hidden sm:table-cell tabular-nums">{r.purchase_lines}</td>
                    <td className={`p-2 text-right tabular-nums font-semibold ${!isPurch ? "text-amber-800" : "text-slate-700"}`}>
                      {inr(r.issue_amt)}
                    </td>
                    <td className="p-2 text-right text-slate-500 hidden sm:table-cell tabular-nums">{r.issue_lines}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-300 bg-slate-100">
                  <td className="p-2 font-extrabold text-slate-900">Grand Total</td>
                  <td className={`p-2 text-right tabular-nums font-extrabold ${isPurch ? `text-${accent}-900` : "text-slate-900"}`} data-testid="daily-totals-grand-purch">
                    {inr(totals.grand_purchase_amt)}
                  </td>
                  <td className="p-2 hidden sm:table-cell"/>
                  <td className={`p-2 text-right tabular-nums font-extrabold ${!isPurch ? `text-${accent}-900` : "text-slate-900"}`} data-testid="daily-totals-grand-issue">
                    {inr(totals.grand_issue_amt)}
                  </td>
                  <td className="p-2 hidden sm:table-cell"/>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
