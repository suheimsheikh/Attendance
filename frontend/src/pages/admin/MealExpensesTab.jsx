/**
 * MealExpensesTab — accountant-style meals expense report.
 * Per-day meal counts (Athletes vs Staff), purchase spend per category,
 * totals + avg cost per meal. Month or custom date-range, CSV + print.
 */
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Download, Printer, IndianRupee, Utensils, Divide, Wallet, Save } from "lucide-react";
import { api, showApiError } from "../../api";
import { toast } from "sonner";
import { fmtQty as uQty, todayIso, money } from "../../utils";

const MEAL_ORDER = ["breakfast", "midmorning", "lunch", "snacks", "dinner"];
const MEAL_HDR = { breakfast: "B/F", midmorning: "MM", lunch: "L", snacks: "AS", dinner: "D" };

const currentMonth = () => todayIso().slice(0, 7);
function monthRange(month) {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(y, m, 0).getDate();
  return [`${month}-01`, `${month}-${String(last).padStart(2, "0")}`];
}
const inr = (n) => money(n, 2, "");
const ddmy = (iso) => {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const [y, m, d] = iso.split("-");
  const dow = new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short" });
  return `${dow} ${Number(d)}/${Number(m)}/${y}`;
};

function SummaryCards({ totals }) {
  const cards = [
    { id: "expenses", label: "Food Expenses", value: `₹${inr(totals?.expenses || 0)}`, icon: IndianRupee, tint: "bg-emerald-50 text-emerald-700" },
    { id: "overhead", label: "Kitchen Wage Bill (apportioned)", value: `₹${inr(totals?.overhead_total || 0)}`, icon: Wallet, tint: "bg-violet-50 text-violet-700" },
    { id: "meals", label: "Total Meals Count", value: inr(totals?.meal_count || 0), icon: Utensils, tint: "bg-sky-50 text-sky-700" },
    { id: "avg", label: "Food Cost / Meal", value: totals?.food_cost_per_meal != null ? `₹${inr(totals.food_cost_per_meal)}` : "—", icon: Divide, tint: "bg-amber-50 text-amber-700" },
    { id: "loaded", label: "Fully-loaded Cost / Meal", value: totals?.total_cost_per_meal != null ? `₹${inr(totals.total_cost_per_meal)}` : "—", icon: Divide, tint: "bg-rose-50 text-rose-700" },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4" data-testid="meal-expense-summary">
      {cards.map((c) => (
        <div key={c.id} className="iu-card p-4 flex items-center gap-3" data-testid={`meal-expense-card-${c.id}`}>
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${c.tint}`}>
            <c.icon size={18} />
          </div>
          <div>
            <div className="text-xs text-slate-500 font-semibold">{c.label}</div>
            <div className="text-xl font-extrabold tabular-nums" data-testid={`meal-expense-card-${c.id}-value`}>{c.value}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function OverheadEditor({ month, onSaved }) {
  const [row, setRow] = useState(null);
  const [wages, setWages] = useState("");
  const [incidentals, setIncidentals] = useState("");
  const [saving, setSaving] = useState(false);
  const monthLabel = React.useMemo(() => {
    if (!/^\d{4}-\d{2}$/.test(month || "")) return month;
    return new Date(`${month}-01T00:00:00`).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  }, [month]);

  useEffect(() => {
    if (!month) return;
    api.get(`/meals/overheads/${month}`)
      .then((d) => { setRow(d); setWages(String(d.staff_wages || 0)); setIncidentals(String(d.incidentals || 0)); })
      .catch(() => setRow(null));
  }, [month]);

  const save = async () => {
    const w = Number(wages);
    if (!Number.isFinite(w) || w <= 0) {
      toast.error("Enter a staff wage bill greater than ₹0");
      return;
    }
    if (w > 10000000) { toast.error("Wage bill looks too large — please re-check"); return; }
    const inc = Number(incidentals) || 0;
    if (inc < 0 || inc > 10000000) { toast.error("Incidentals must be between ₹0 and ₹1,00,00,000"); return; }
    setSaving(true);
    try {
      await api.put(`/meals/overheads/${month}`, {
        staff_wages: w,
        incidentals: inc,
      });
      onSaved && onSaved();
      const d = await api.get(`/meals/overheads/${month}`);
      setRow(d);
    } catch (err) { showApiError(err, "Couldn't save the wage bill"); }
    finally { setSaving(false); }
  };

  const backfill = async () => {
    if (!window.confirm("Set ₹75,000 as the wage bill for every month that has meal data but no entry yet? Existing entries are kept.")) return;
    setSaving(true);
    try {
      const r = await api.post(`/meals/overheads/backfill`, { default_wages: 75000 });
      onSaved && onSaved();
      const d = await api.get(`/meals/overheads/${month}`);
      setRow(d);
      window.alert(`Seeded ${r.filled_months.length} month(s): ${r.filled_months.join(", ") || "none (all present)"}`);
    } catch (err) { showApiError(err, "Backfill failed"); }
    finally { setSaving(false); }
  };

  if (!row) return null;
  const carriedNote = !row.saved && row.carried_from
    ? `Carried forward from ${new Date(`${row.carried_from}-01T00:00:00`).toLocaleDateString("en-GB", { month: "short", year: "numeric" })} — Save to lock it for ${monthLabel}.`
    : null;
  if (!row.can_edit) {
    return (
      <div className="iu-card p-3 mb-4 flex items-center gap-2 text-sm" data-testid="meal-overhead-readonly">
        <Wallet size={16} className="text-violet-600" />
        <span className="text-slate-600">Kitchen wage bill for <b>{monthLabel}</b>:</span>
        <span className="font-extrabold tabular-nums">₹{inr(row.total || 0)}</span>
        {carriedNote
          ? <span className="text-[11px] text-amber-600 ml-1" data-testid="meal-overhead-carried-ro">(carried forward from {row.carried_from})</span>
          : <span className="text-[11px] text-slate-400 ml-1">(Super Admin edits this)</span>}
      </div>
    );
  }
  const wagesInvalid = !(Number(wages) > 0);
  return (
    <div className="iu-card p-4 mb-4" data-testid="meal-overhead-editor">
      <div className="flex items-center gap-2 mb-3">
        <Wallet size={16} className="text-violet-600" />
        <h3 className="font-extrabold text-sm">Kitchen Overheads — {monthLabel}</h3>
        <span className="text-[11px] text-slate-400">Wage bill is spread equally per day and blended into cost/meal</span>
      </div>
      {carriedNote && (
        <div className="mb-3 text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5" data-testid="meal-overhead-carried">
          {carriedNote}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="text-xs font-semibold text-slate-500 block mb-0.5">Staff wage bill (₹/month)</label>
          <input type="number" min="0" value={wages} onChange={(e) => setWages(e.target.value)}
                 className={`iu-input !h-9 !w-44 text-sm ${wagesInvalid ? "!ring-2 !ring-rose-400 !border-rose-400" : ""}`}
                 title={wagesInvalid ? "Wage bill must be greater than ₹0" : undefined}
                 data-testid="meal-overhead-wages" />
        </div>
        <div>
          <label className="text-xs font-semibold text-slate-500 block mb-0.5">Incidentals (₹/month, optional)</label>
          <input type="number" min="0" value={incidentals} onChange={(e) => setIncidentals(e.target.value)}
                 className="iu-input !h-9 !w-44 text-sm" data-testid="meal-overhead-incidentals" />
        </div>
        <button onClick={save} disabled={saving || wagesInvalid} className="iu-btn-primary !h-9 !px-4 text-sm disabled:opacity-50" title={wagesInvalid ? "Enter a wage bill greater than ₹0" : undefined} data-testid="meal-overhead-save">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
        </button>
        <button onClick={backfill} disabled={saving} title="Seed ₹75,000 for every month that has meal data but no wage bill yet"
                className="iu-btn-secondary !h-9 !px-3 text-sm ml-auto" data-testid="meal-overhead-backfill">
          Backfill ₹75,000 to all months
        </button>
      </div>
      {row.updated_by && (
        <p className="text-[11px] text-slate-400 mt-2">Last saved by {row.updated_by}</p>
      )}
    </div>
  );
}

function ReportTable({ data, printable }) {
  const cats = data.categories || [];
  const days = data.days || [];
  const t = data.totals || {};
  const cell = "px-1.5 py-1 text-right tabular-nums border-b border-slate-100";
  const groupHdr = "px-1.5 py-1 text-center text-[10px] font-bold uppercase tracking-wide";
  return (
    <table className={`w-full text-xs border-collapse ${printable ? "" : "min-w-[1050px]"}`}>
      <thead className={printable ? "" : "bg-slate-50 sticky top-0 z-10"}>
        <tr className="border-b border-slate-300">
          <th rowSpan={2} className="px-2 py-1 text-left align-bottom">Date</th>
          <th colSpan={5} className={`${groupHdr} bg-sky-50 text-sky-800`}>Athletes</th>
          <th colSpan={5} className={`${groupHdr} bg-violet-50 text-violet-800`}>Staff</th>
          <th rowSpan={2} className="px-1.5 py-1 text-right align-bottom bg-slate-100">Daily<br/>Meals</th>
          {cats.map((c) => (
            <th key={c.key} rowSpan={2} className="px-1.5 py-1 text-right align-bottom bg-amber-50 text-amber-900">{c.label}</th>
          ))}
          <th rowSpan={2} className="px-1.5 py-1 text-right align-bottom bg-emerald-50 text-emerald-900">Day ₹</th>
        </tr>
        <tr className="border-b border-slate-300 text-[10px] text-slate-500">
          {["athletes", "staff"].flatMap((g) => [
            ...MEAL_ORDER.map((k) => (
              <th key={`${g}-${k}`} className="px-1.5 py-0.5 text-right font-semibold">{MEAL_HDR[k]}</th>
            )),
            <th key={`${g}-tot`} className="px-1.5 py-0.5 text-right font-bold bg-slate-50">Tot</th>,
          ])}
        </tr>
      </thead>
      <tbody>
        {days.map((d) => (
          <tr key={d.date} className={printable ? "" : "hover:bg-slate-50/60"} data-testid={printable ? undefined : `meal-expense-row-${d.date}`}>
            <td className="px-2 py-1 font-semibold whitespace-nowrap border-b border-slate-100">{ddmy(d.date)}</td>
            {["athletes", "staff"].flatMap((g) => [
              ...MEAL_ORDER.map((k) => (
                <td key={`${g}-${k}`} className={`${cell} ${d[g][k] ? "" : "text-slate-300"}`}>{d[g][k] || 0}</td>
              )),
              <td key={`${g}-tot`} className={`${cell} font-bold bg-slate-50/60`}>{d[g].total}</td>,
            ])}
            <td className={`${cell} font-extrabold bg-slate-100/60`}>{d.meal_count}</td>
            {cats.map((c) => (
              <td key={c.key} className={`${cell} ${d.purchases?.[c.key] ? "" : "text-slate-300"}`}>
                {d.purchases?.[c.key] ? inr(d.purchases[c.key]) : "0"}
              </td>
            ))}
            <td className={`${cell} font-bold text-emerald-800`}>{d.expense_total ? inr(d.expense_total) : "0"}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-slate-400 font-extrabold bg-slate-50" data-testid={printable ? undefined : "meal-expense-totals-row"}>
          <td className="px-2 py-1.5">TOTAL</td>
          {["athletes", "staff"].flatMap((g) => [
            ...MEAL_ORDER.map((k) => (
              <td key={`${g}-${k}`} className="px-1.5 py-1.5 text-right tabular-nums">{t[g]?.[k] || 0}</td>
            )),
            <td key={`${g}-tot`} className="px-1.5 py-1.5 text-right tabular-nums bg-slate-100">{t[g]?.total || 0}</td>,
          ])}
          <td className="px-1.5 py-1.5 text-right tabular-nums bg-slate-200">{t.meal_count || 0}</td>
          {cats.map((c) => (
            <td key={c.key} className="px-1.5 py-1.5 text-right tabular-nums">{inr(t.purchases?.[c.key] || 0)}</td>
          ))}
          <td className="px-1.5 py-1.5 text-right tabular-nums text-emerald-800">{inr(t.expenses || 0)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

function ItemBreakdownTable({ rows, title, testid, footNote }) {
  if (!rows || rows.length === 0) return null;
  const total = rows.reduce((s, r) => s + (r.amount || 0), 0);
  const totalQty = rows.reduce((s, r) => s + (r.qty || 0), 0);
  return (
    <div className="iu-card mt-4" data-testid={testid}>
      <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between">
        <div className="font-bold text-sm">{title}</div>
        <div className="text-xs text-slate-500">{rows.length} items · ₹{inr(total)}</div>
      </div>
      {footNote && (
        <div className="px-3 py-1.5 bg-amber-50 border-b border-amber-200 text-[11px] text-amber-900" data-testid={`${testid}-foot-note`}>{footNote}</div>
      )}
      <div className="overflow-auto max-h-[420px]">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 sticky top-0">
            <tr className="text-slate-600 border-b border-slate-200">
              <th className="px-2 py-1.5 text-left">Item</th>
              <th className="px-2 py-1.5 text-right">Qty</th>
              <th className="px-2 py-1.5 text-left">Unit</th>
              <th className="px-2 py-1.5 text-right">Amount (₹)</th>
              <th className="px-2 py-1.5 text-right">Lines</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.item_id} className="border-b border-slate-100 hover:bg-slate-50" data-testid={`${testid}-row-${r.item_id}`}>
                <td className="px-2 py-1.5 font-semibold text-slate-800">{r.name}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{uQty(r.qty || 0, r.unit)}</td>
                <td className="px-2 py-1.5 text-slate-500">{r.unit || ""}</td>
                <td className="px-2 py-1.5 text-right tabular-nums font-semibold">{inr(r.amount)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums text-slate-500">{r.lines}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-slate-400 font-extrabold bg-slate-50">
              <td className="px-2 py-1.5">TOTAL</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{uQty(totalQty)}</td>
              <td></td>
              <td className="px-2 py-1.5 text-right tabular-nums text-emerald-800">{inr(total)}</td>
              <td></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function MealExpensesTab({ liveSig }) {
  const [mode, setMode] = useState("month");
  const [month, setMonth] = useState(currentMonth());
  const [from, setFrom] = useState(() => monthRange(currentMonth())[0]);
  const [to, setTo] = useState(todayIso());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const [start, end] = useMemo(
    () => (mode === "month" ? monthRange(month) : [from, to]),
    [mode, month, from, to],
  );

  useEffect(() => {
    if (!start || !end || start > end) return;
    setLoading(true);
    api.get(`/meals/expense-report?start=${start}&end=${end}`)
      .then(setData)
      .catch((err) => showApiError(err, "Couldn't load expense report"))
      .finally(() => setLoading(false));
  }, [start, end, liveSig]);

  // Hide trailing future days (they're all zeros) but keep past zeros.
  const trimmed = useMemo(() => {
    if (!data) return null;
    const today = todayIso();
    return { ...data, days: (data.days || []).filter((d) => d.date <= today) };
  }, [data]);

  const exportCSV = () => {
    if (!trimmed) return;
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const cats = trimmed.categories || [];
    const head = ["Date",
      ...MEAL_ORDER.map((k) => `Athletes ${MEAL_HDR[k]}`), "Athletes Total",
      ...MEAL_ORDER.map((k) => `Staff ${MEAL_HDR[k]}`), "Staff Total",
      "Daily Meal Count", ...cats.map((c) => q(c.label)), "Day Expense"];
    const lines = [head.join(",")];
    trimmed.days.forEach((d) => {
      lines.push([
        d.date,
        ...MEAL_ORDER.map((k) => d.athletes[k] || 0), d.athletes.total,
        ...MEAL_ORDER.map((k) => d.staff[k] || 0), d.staff.total,
        d.meal_count,
        ...cats.map((c) => d.purchases?.[c.key] || 0),
        d.expense_total || 0,
      ].join(","));
    });
    const t = trimmed.totals || {};
    lines.push([
      "TOTAL",
      ...MEAL_ORDER.map((k) => t.athletes?.[k] || 0), t.athletes?.total || 0,
      ...MEAL_ORDER.map((k) => t.staff?.[k] || 0), t.staff?.total || 0,
      t.meal_count || 0,
      ...cats.map((c) => t.purchases?.[c.key] || 0),
      t.expenses || 0,
    ].join(","));
    lines.push("");
    lines.push(`Total Food Expenses,${t.expenses || 0}`);
    lines.push(`Kitchen Wage Bill (apportioned),${t.overhead_total || 0}`);
    lines.push(`Total Expenses incl. Overhead,${t.expenses_with_overhead ?? ""}`);
    lines.push(`Total Meals Count,${t.meal_count || 0}`);
    lines.push(`Food Cost Per Meal,${t.food_cost_per_meal ?? ""}`);
    lines.push(`Overhead Cost Per Meal,${t.overhead_cost_per_meal ?? ""}`);
    lines.push(`Fully-loaded Cost Per Meal,${t.total_cost_per_meal ?? ""}`);
    if ((trimmed.item_purchases || []).length) {
      lines.push("");
      lines.push("ITEM-WISE PURCHASES");
      lines.push(["Item", "Unit", "Qty", "Amount", "Lines"].join(","));
      trimmed.item_purchases.forEach((r) => {
        lines.push([q(r.name), q(r.unit), r.qty, r.amount, r.lines].join(","));
      });
      if ((trimmed.unitemised_purchases_amount || 0) > 0) {
        lines.push([q("(bulk-uploaded / no item detail)"), "", "", trimmed.unitemised_purchases_amount, ""].join(","));
      }
    }
    if ((trimmed.item_issues || []).length) {
      lines.push("");
      lines.push("ITEM-WISE CONSUMPTION (valued at wtd-avg rate)");
      lines.push(["Item", "Unit", "Qty", "Amount", "Lines"].join(","));
      trimmed.item_issues.forEach((r) => {
        lines.push([q(r.name), q(r.unit), r.qty, r.amount, r.lines].join(","));
      });
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `meal_expenses_${start}_${end}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const handlePrint = () => {
    document.body.classList.add("expense-print-active");
    const cleanup = () => {
      document.body.classList.remove("expense-print-active");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.print();
  };

  return (
    <div data-testid="meal-expenses-tab">
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden">
          <button
            data-testid="meal-expense-mode-month"
            onClick={() => setMode("month")}
            title="Report for one calendar month"
            className={`px-3 h-9 text-xs font-bold ${mode === "month" ? "bg-slate-800 text-white" : "bg-white text-slate-600"}`}
          >Month</button>
          <button
            data-testid="meal-expense-mode-range"
            onClick={() => setMode("range")}
            title="Report for any start–end date range"
            className={`px-3 h-9 text-xs font-bold ${mode === "range" ? "bg-slate-800 text-white" : "bg-white text-slate-600"}`}
          >Date range</button>
        </div>
        {mode === "month" ? (
          <input
            type="month" value={month} max={currentMonth()}
            onChange={(e) => setMonth(e.target.value)}
            className="iu-input !h-9 !w-auto text-sm"
            data-testid="meal-expense-month"
          />
        ) : (
          <>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                   className="iu-input !h-9 !w-auto text-sm" data-testid="meal-expense-from" />
            <span className="text-slate-400 text-xs">to</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                   className="iu-input !h-9 !w-auto text-sm" data-testid="meal-expense-to" />
          </>
        )}
        <div className="ml-auto flex gap-2">
          <button onClick={exportCSV} disabled={!trimmed || loading} title="Download this report as a spreadsheet"
                  className="iu-btn-secondary !h-9 !px-3 text-sm" data-testid="meal-expense-csv">
            <Download size={14} /> CSV
          </button>
          <button onClick={handlePrint} disabled={!trimmed || loading} title="Open a print-ready view (save as PDF from the print dialog)"
                  className="iu-btn-secondary !h-9 !px-3 text-sm" data-testid="meal-expense-print">
            <Printer size={14} /> Print / PDF
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
      ) : !trimmed ? null : (
        <>
          <OverheadEditor
            month={start ? start.slice(0, 7) : month}
            onSaved={() => { if (start && end) api.get(`/meals/expense-report?start=${start}&end=${end}`).then(setData).catch(() => {}); }}
          />
          <SummaryCards totals={trimmed.totals} />
          <div className="iu-card overflow-auto" data-testid="meal-expense-table">
            <ReportTable data={trimmed} printable={false} />
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <ItemBreakdownTable
              rows={trimmed.item_purchases}
              title="Item-wise Purchases"
              testid="meal-expense-item-purchases"
              footNote={
                (trimmed.unitemised_purchases_amount || 0) > 0
                  ? `+ ₹${inr(trimmed.unitemised_purchases_amount)} of bulk-uploaded / legacy spend (no per-item detail)`
                  : null
              }
            />
            <ItemBreakdownTable
              rows={trimmed.item_issues}
              title="Item-wise Consumption (valued at wtd-avg rate)"
              testid="meal-expense-item-issues"
            />
          </div>
          <p className="text-[11px] text-slate-400 mt-2">
            Meal counts come from Meal Muster marks. Purchases are entered on the Purchases tab (or bulk-uploaded).
            Consumption amounts value each item at its weighted-avg purchase rate over this window.
          </p>
        </>
      )}

      {trimmed && typeof document !== "undefined" && createPortal(
        <div className="hidden print:block bg-white" data-testid="meal-expense-print-region">
          <div className="border-b-2 border-slate-800 pb-2 mb-3">
            <h1 className="text-xl font-extrabold">Meals Expense Report — {ddmy(start)} to {ddmy(end)}</h1>
            <p className="text-xs text-slate-600 mt-0.5">
              Food ₹{inr(trimmed.totals?.expenses || 0)} + Wage bill ₹{inr(trimmed.totals?.overhead_total || 0)} · {inr(trimmed.totals?.meal_count || 0)} meals ·
              Fully-loaded ₹{trimmed.totals?.total_cost_per_meal != null ? inr(trimmed.totals.total_cost_per_meal) : "—"}/meal (food ₹{trimmed.totals?.food_cost_per_meal != null ? inr(trimmed.totals.food_cost_per_meal) : "—"}) ·
              Printed {new Date().toLocaleString()}
            </p>
          </div>
          <ReportTable data={trimmed} printable />
          {(trimmed.item_purchases || []).length > 0 && (
            <div className="mt-4 print:break-inside-avoid">
              <h2 className="font-extrabold text-sm mb-1">Item-wise Purchases</h2>
              <table className="w-full text-[11px] border-collapse">
                <thead><tr className="border-b border-slate-400"><th className="text-left px-1">Item</th><th className="text-right px-1">Qty</th><th className="text-left px-1">Unit</th><th className="text-right px-1">Amount (₹)</th></tr></thead>
                <tbody>{trimmed.item_purchases.map((r) => (<tr key={r.item_id}><td className="px-1">{r.name}</td><td className="text-right px-1 tabular-nums">{uQty(r.qty, r.unit)}</td><td className="px-1">{r.unit || ""}</td><td className="text-right px-1 tabular-nums">{inr(r.amount)}</td></tr>))}</tbody>
              </table>
            </div>
          )}
          {(trimmed.item_issues || []).length > 0 && (
            <div className="mt-4 print:break-inside-avoid">
              <h2 className="font-extrabold text-sm mb-1">Item-wise Consumption (valued at wtd-avg rate)</h2>
              <table className="w-full text-[11px] border-collapse">
                <thead><tr className="border-b border-slate-400"><th className="text-left px-1">Item</th><th className="text-right px-1">Qty</th><th className="text-left px-1">Unit</th><th className="text-right px-1">Amount (₹)</th></tr></thead>
                <tbody>{trimmed.item_issues.map((r) => (<tr key={r.item_id}><td className="px-1">{r.name}</td><td className="text-right px-1 tabular-nums">{uQty(r.qty, r.unit)}</td><td className="px-1">{r.unit || ""}</td><td className="text-right px-1 tabular-nums">{inr(r.amount)}</td></tr>))}</tbody>
              </table>
            </div>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
