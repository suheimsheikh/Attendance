import React, { useEffect, useState } from "react";
import { api, showApiError } from "../../api";
import { Printer, Loader2, X } from "lucide-react";
import { todayIso, monthStartIso, money } from "../../utils";


const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// dd/mm/yy to match the rest of the app.
const ddmmyy = (iso) => {
  if (!iso) return "";
  const [y, m, d] = String(iso).split("-");
  return d && m && y ? `${d}/${m}/${String(y)}` : String(iso);
};
const nq = (x) => (x === null || x === undefined ? "" : Number(x).toLocaleString("en-IN", { maximumFractionDigits: 3 }));
const rs = (x) => money(x, 2, "");

function buildHtml(data) {
  const byCat = {};
  (data.ledgers || []).forEach((l) => { (byCat[l.category] = byCat[l.category] || []).push(l); });

  const stCell = (r) => {
    if (!r.is_stock_take) return "";
    const phys = r.st_physical === null || r.st_physical === undefined ? "" : `counted ${nq(r.st_physical)}`;
    const varTxt = r.adj_qty ? ` (var ${r.adj_qty > 0 ? "+" : ""}${nq(r.adj_qty)})` : " (no change)";
    const tag = r.st_kind === "opening" ? "OPENING COUNT" : "STOCK TAKE";
    return `<span class="sttag">${tag}</span> ${phys}${varTxt}`;
  };

  const ledgerBlock = (l) => {
    const movement = (l.rows || []).map((r) => `
      <tr class="${r.pre_opening ? "pre" : ""}${r.is_stock_take ? " st" : ""}">
        <td>${ddmmyy(r.date)}</td>
        <td class="num">${r.purch_qty ? nq(r.purch_qty) : ""}</td>
        <td class="num val">${r.purch_amt ? rs(r.purch_amt) : ""}</td>
        <td class="num">${r.issue_qty ? nq(r.issue_qty) : ""}</td>
        <td class="num val">${r.issue_val ? rs(r.issue_val) : ""}</td>
        <td class="num">${r.waste_qty ? nq(r.waste_qty) : ""}</td>
        <td class="st">${stCell(r)}</td>
        <td class="num bal">${r.balance === null ? "—" : nq(r.balance)}</td>
        <td class="num bal val">${r.balance_val === null ? "" : rs(r.balance_val)}</td>
      </tr>`).join("");
    const t = l.totals || {};
    return `
    <div class="ledger">
      <div class="lh">
        <div class="lname">${esc(l.name)} <span class="unit">(${esc(l.unit || "")})</span></div>
        <div class="lmeta">
          ${l.avg_rate ? `avg rate ₹${rs(l.avg_rate)}/${esc(l.unit || "unit")}` : `<span class="norate">no cost rate set</span>`}
        </div>
      </div>
      <table>
        <thead><tr>
          <th>Date</th><th class="num">Purch</th><th class="num">₹</th>
          <th class="num">Issue</th><th class="num">₹</th>
          <th class="num">Waste</th><th>Stock take</th>
          <th class="num">Balance</th><th class="num">₹ Value</th>
        </tr></thead>
        <tbody>
          <tr class="ob">
            <td>${ddmmyy(l.opening_date)}</td>
            <td colspan="5" class="lbl">Opening balance</td>
            <td></td>
            <td class="num bal">${nq(l.opening_balance)}</td>
            <td class="num bal val">${rs(l.opening_value)}</td>
          </tr>
          ${movement}
        </tbody>
        <tfoot>
          <tr class="tot">
            <td>Totals</td>
            <td class="num">${t.purch_qty ? nq(t.purch_qty) : ""}</td>
            <td class="num val">${t.purch_amt ? rs(t.purch_amt) : ""}</td>
            <td class="num">${t.issue_qty ? nq(t.issue_qty) : ""}</td>
            <td class="num val">${t.issue_val ? rs(t.issue_val) : ""}</td>
            <td class="num">${t.waste_qty ? nq(t.waste_qty) : ""}</td>
            <td></td><td></td><td></td>
          </tr>
          <tr class="cb">
            <td>${ddmmyy(l.closing_date)}</td>
            <td colspan="5" class="lbl">Closing balance</td>
            <td></td>
            <td class="num bal">${nq(l.closing_balance)}</td>
            <td class="num bal val">${rs(l.value)}</td>
          </tr>
        </tfoot>
      </table>
    </div>`;
  };

  const cats = Object.keys(byCat).map((cat) => `
    <div class="cat">
      <h2>${esc(cat)}</h2>
      ${byCat[cat].map(ledgerBlock).join("")}
    </div>`).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Kitchen Stock Ledgers ${ddmmyy(data.start)} to ${ddmmyy(data.end)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; color: #1e293b; margin: 24px; font-size: 12px; }
    h1 { font-size: 18px; margin: 0 0 2px; }
    .sub { color: #64748b; font-size: 12px; margin-bottom: 16px; }
    .sub b { color: #0f172a; }
    h2 { font-size: 13px; background: #f1f5f9; padding: 6px 8px; border-radius: 4px; margin: 18px 0 8px; break-after: avoid; }
    .ledger { border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px 10px; margin-bottom: 10px; break-inside: avoid; }
    .lh { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 4px; flex-wrap: wrap; }
    .lname { font-weight: 700; font-size: 13px; }
    .unit { color: #94a3b8; font-weight: 400; }
    .lmeta { font-size: 11px; color: #475569; }
    .norate { color: #e11d48; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; }
    th, td { border-bottom: 1px solid #eef2f7; padding: 3px 6px; text-align: left; }
    th { color: #64748b; font-size: 10px; text-transform: uppercase; border-bottom: 1px solid #cbd5e1; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .val { color: #0369a1; }
    .bal { font-weight: 700; }
    .lbl { font-weight: 700; color: #334155; }
    tr.pre td { color: #94a3b8; font-style: italic; }
    tr.ob td { background: #f0f9ff; }
    tr.cb td { background: #ecfdf5; font-weight: 700; border-top: 2px solid #94a3b8; }
    tr.tot td { background: #f8fafc; font-weight: 700; border-top: 2px solid #cbd5e1; }
    tr.st td { background: #fffbeb; }
    td.st { color: #92400e; font-size: 10px; }
    .sttag { background: #f59e0b; color: #fff; font-weight: 700; padding: 0 4px; border-radius: 3px; font-size: 9px; }
    .empty { font-size: 11px; color: #94a3b8; padding: 2px; }
    .legend { font-size: 11px; color: #475569; margin: 6px 0 14px; }
    .legend span { margin-right: 14px; }
    .print-btn { position: fixed; top: 12px; right: 12px; padding: 8px 16px; background: #2563eb; color: #fff; border: 0; border-radius: 6px; font-weight: 700; cursor: pointer; }
    @media print { .print-btn { display: none; } body { margin: 10px; } .cat { break-inside: auto; } }
  </style></head><body>
    <button class="print-btn" onclick="window.print()">Print / Save PDF</button>
    <h1>Kitchen Stock Ledgers</h1>
    <div class="sub"><b>${ddmmyy(data.start)}</b> to <b>${ddmmyy(data.end)}</b>${data.category_label ? ` · ${esc(data.category_label)}` : " · All categories"} · ${data.total_items} items · total stock value <b>₹${rs(data.total_value)}</b> · generated ${new Date(data.generated_at).toLocaleString("en-GB", { timeZone: "Asia/Kolkata" })}</div>
    <div class="legend">
      <span><b style="color:#0369a1">Opening balance</b> = stock on ${ddmmyy(data.start)}</span>
      <span><b style="color:#047857">Closing balance</b> = stock on ${ddmmyy(data.end)}</span>
      <span><span class="sttag">STOCK TAKE</span> = a physical count on that date</span>
    </div>
    ${cats}
  </body></html>`;
}

export default function StockLedgersPrintButton() {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState(monthStartIso());
  const [end, setEnd] = useState(todayIso());
  const [cats, setCats] = useState([]);
  const [categoryKey, setCategoryKey] = useState("all");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.get("/meals/purchase-categories")
      .then((r) => setCats(r.categories || []))
      .catch(() => {});
  }, [open]);

  const generate = async () => {
    setLoading(true);
    const w = window.open("", "_blank");
    if (w) w.document.write("<p style='font-family:sans-serif;padding:20px'>Building stock ledgers…</p>");
    try {
      const data = await api.get(`/meals/stock-ledgers/print?start=${start}&end=${end}&category=${encodeURIComponent(categoryKey)}`);
      if (categoryKey !== "all") {
        data.category_label = (cats.find((c) => c.key === categoryKey) || {}).label || "";
      }
      const html = buildHtml(data);
      if (w) {
        w.document.open();
        w.document.write(html);
        w.document.close();
        w.focus();
      }
      setOpen(false);
    } catch (e) {
      if (w) w.close();
      showApiError(e, "Couldn't build stock ledgers");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <button onClick={() => setOpen(true)}
              className="iu-btn-secondary !h-7 !px-2 text-xs inline-flex items-center gap-1"
              title="Print or save a PDF of every active item's stock ledger"
              data-testid="print-all-ledgers-btn">
        <Printer size={12} /> Print all ledgers
      </button>
      {open && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" data-testid="ledgers-print-modal"
             onClick={() => !loading && setOpen(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-slate-900 inline-flex items-center gap-2"><Printer size={16} /> Print stock ledgers</h3>
              <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600" data-testid="ledgers-print-close"><X size={18} /></button>
            </div>
            <p className="text-xs text-slate-500 mb-3">Each item's passbook (purchases, issues, wastage, stock-takes) with running quantity &amp; value. Opening &amp; closing balances are clearly dated.</p>
            <div className="mb-3">
              <label className="block text-[10px] font-bold uppercase tracking-wide text-slate-500 mb-1">Category</label>
              <select value={categoryKey} onChange={(e) => setCategoryKey(e.target.value)}
                      className="iu-input !h-8 text-sm w-full" data-testid="ledgers-print-category">
                <option value="all">All categories</option>
                {cats.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            </div>
            <div className="flex items-end gap-3 mb-4">
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wide text-slate-500 mb-1">From</label>
                <input type="date" value={start} max={end} onChange={(e) => setStart(e.target.value)}
                       className="iu-input !h-8 text-sm" data-testid="ledgers-print-start" />
              </div>
              <div>
                <label className="block text-[10px] font-bold uppercase tracking-wide text-slate-500 mb-1">To</label>
                <input type="date" value={end} min={start} max={todayIso()} onChange={(e) => setEnd(e.target.value)}
                       className="iu-input !h-8 text-sm" data-testid="ledgers-print-end" />
              </div>
            </div>
            <button onClick={generate} disabled={loading}
                    className="iu-btn-primary w-full !h-9 text-sm inline-flex items-center justify-center gap-2 disabled:opacity-50"
                    data-testid="ledgers-print-generate">
              {loading ? <><Loader2 size={15} className="animate-spin" /> Building…</> : <><Printer size={15} /> Generate &amp; Print</>}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
