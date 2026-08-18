/**
 * MealIssuesTab — chef enters qty issued (consumed) per item, per day.
 * Shows current on-hand for reference so the chef spots impossible issues.
 */
import React, { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Save, Boxes } from "lucide-react";
import { api, showApiError } from "../../api";
import { formatDate } from "../../utils";

function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const num = (v) => (v === "" || v == null ? 0 : Number(v) || 0);
const fmtQty = (n) => (n == null ? "0" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 3 }));

export default function MealIssuesTab() {
  const [dateStr, setDateStr] = useState(todayISO());
  const [cats, setCats] = useState([]);
  const [items, setItems] = useState([]);
  const [stock, setStock] = useState({});      // item_id → on_hand
  const [entries, setEntries] = useState({});  // item_id → qty
  const [saving, setSaving] = useState(false);
  const [recent, setRecent] = useState([]);

  const loadMasters = async () => {
    try {
      const [c, i] = await Promise.all([
        api.get("/meals/purchase-categories"),
        api.get("/meals/items?include_inactive=false"),
      ]);
      setCats((c.categories || []).filter((x) => x.active !== false));
      setItems(i.items || []);
    } catch (err) { showApiError(err, "Couldn't load masters"); }
  };
  useEffect(() => { loadMasters(); }, []);

  const loadStock = () => {
    // Stock as of the day BEFORE the selected date — that's what the chef
    // physically has when starting the day's cooking. Falls back to today.
    const [y, m, d] = dateStr.split("-").map(Number);
    const prev = new Date(Date.UTC(y, m - 1, d - 1));
    const asOf = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}-${String(prev.getUTCDate()).padStart(2, "0")}`;
    api.get(`/meals/stock?as_of=${asOf}`)
      .then((r) => setStock(Object.fromEntries((r.rows || []).map((x) => [x.item_id, x.on_hand]))))
      .catch(() => setStock({}));
  };
  useEffect(loadStock, [dateStr]);

  // Load existing issues for the date.
  useEffect(() => {
    api.get(`/meals/issues?start=${dateStr}&end=${dateStr}`)
      .then((r) => {
        const lines = r.issues?.[0]?.lines || [];
        const next = {};
        lines.forEach((l) => { next[l.item_id] = l.qty; });
        setEntries(next);
      })
      .catch(() => setEntries({}));
  }, [dateStr]);

  const loadRecent = () => {
    const end = todayISO();
    const startD = new Date();
    startD.setDate(startD.getDate() - 14);
    const p = (n) => String(n).padStart(2, "0");
    const start = `${startD.getFullYear()}-${p(startD.getMonth() + 1)}-${p(startD.getDate())}`;
    api.get(`/meals/issues?start=${start}&end=${end}`)
      .then((r) => setRecent((r.issues || []).slice().reverse()))
      .catch(() => {});
  };
  useEffect(loadRecent, []);

  const grouped = useMemo(() => {
    const m = new Map(cats.map((c) => [c.key, { cat: c, rows: [] }]));
    items.forEach((it) => m.get(it.category_key)?.rows.push(it));
    return Array.from(m.values()).filter((g) => g.rows.length > 0);
  }, [items, cats]);

  const save = async () => {
    const lines = items
      .filter((it) => num(entries[it.id]) > 0)
      .map((it) => ({ item_id: it.id, qty: num(entries[it.id]) }));
    setSaving(true);
    try {
      await api.put(`/meals/issues/${dateStr}`, { lines });
      toast.success(`Issues saved for ${formatDate(dateStr)}`);
      loadRecent();
      loadStock();
    } catch (err) {
      showApiError(err, "Couldn't save issues");
    } finally { setSaving(false); }
  };

  return (
    <div data-testid="meal-issues-tab">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <input type="date" value={dateStr} max={todayISO()} onChange={(e) => setDateStr(e.target.value)} className="iu-input !h-9 !w-auto text-sm" data-testid="issues-date" />
        <span className="text-xs text-slate-500">{formatDate(dateStr)}</span>
        <span className="ml-auto text-xs text-slate-500">On-hand shown = end of previous day</span>
      </div>

      {grouped.length === 0 ? (
        <div className="iu-card p-8 text-center" data-testid="issues-no-items">
          <Boxes size={30} className="mx-auto text-slate-300 mb-2" />
          <p className="font-semibold text-slate-700">No items configured yet.</p>
          <p className="text-sm text-slate-500 mt-1">Ask an admin to set up items in the Purchases tab.</p>
        </div>
      ) : (
        <div className="iu-card overflow-hidden" data-testid="issues-entry-card">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
              <tr>
                <th className="text-left p-2 w-1/2">Item</th>
                <th className="text-right p-2 w-32">On-hand</th>
                <th className="text-right p-2 w-32">Qty issued</th>
                <th className="text-left p-2 w-20">Unit</th>
              </tr>
            </thead>
            <tbody>
              {grouped.map(({ cat, rows }) => (
                <React.Fragment key={cat.key}>
                  <tr className="bg-slate-100/60"><td colSpan={4} className="px-2 py-1 text-[11px] font-bold text-slate-600 uppercase tracking-wider">{cat.label}</td></tr>
                  {rows.map((it) => {
                    const oh = stock[it.id];
                    const qty = num(entries[it.id]);
                    const over = oh != null && qty > oh + 1e-6;
                    return (
                      <tr key={it.id} className={`border-t border-slate-100 ${over ? "bg-rose-50/60" : ""}`} data-testid={`issues-row-${it.id}`}>
                        <td className="p-2 font-semibold text-slate-900">{it.name}</td>
                        <td className="p-2 text-right tabular-nums text-slate-600" data-testid={`issues-onhand-${it.id}`}>{oh != null ? fmtQty(oh) : "—"}</td>
                        <td className="p-2">
                          <input type="number" min="0" step="0.01" value={entries[it.id] ?? ""} onChange={(e) => setEntries({ ...entries, [it.id]: e.target.value })} className={`iu-input !h-8 text-sm w-full text-right tabular-nums ${over ? "border-rose-400" : ""}`} placeholder="0" data-testid={`issues-qty-${it.id}`} />
                        </td>
                        <td className="p-2 text-slate-500 text-xs">{it.unit}</td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              ))}
            </tbody>
          </table>
          <div className="p-3 border-t border-slate-100 flex justify-end">
            <button onClick={save} disabled={saving} className="iu-btn-primary !h-9 !px-4 text-sm" data-testid="issues-save">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
            </button>
          </div>
        </div>
      )}

      <div className="iu-card mt-4 overflow-auto" data-testid="issues-recent">
        <div className="px-4 py-3 border-b border-slate-100 font-bold text-sm">Last 14 days of issues</div>
        {recent.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500" data-testid="issues-recent-empty">No issues recorded yet.</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-right">Items issued</th>
                <th className="px-3 py-2 text-left">By</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.date} className="border-t border-slate-100 hover:bg-slate-50/70 cursor-pointer"
                    onClick={() => setDateStr(r.date)}
                    data-testid={`issues-recent-row-${r.date}`}>
                  <td className="px-3 py-1.5 font-semibold">{formatDate(r.date)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{(r.lines || []).length}</td>
                  <td className="px-3 py-1.5 text-slate-500">{r.updated_by_name || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
