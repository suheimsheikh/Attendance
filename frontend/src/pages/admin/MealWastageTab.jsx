/**
 * MealWastageTab — event log for wasted, spoilt, rotten, lost or
 * damaged pantry items. Same rhythm as MealIssuesTab (pick date, tick
 * items with qty), plus a Reason dropdown and free-text Notes so a
 * month later the chef remembers why.
 */
import React, { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Save, Boxes, Trash2 } from "lucide-react";
import { api, showApiError } from "../../api";
import { formatDate } from "../../utils";

const REASONS = [
  { key: "wasted",   label: "Wasted" },
  { key: "spoilt",   label: "Spoilt" },
  { key: "rotten",   label: "Rotten" },
  { key: "lost",     label: "Lost" },
  { key: "damaged",  label: "Damaged" },
  { key: "other",    label: "Other" },
];
const REASON_LABEL = Object.fromEntries(REASONS.map((r) => [r.key, r.label]));

function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const num = (v) => (v === "" || v == null ? 0 : Number(v) || 0);
const fmtQty = (n) => (n == null ? "0" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 3 }));

// A single wastage line row in the entry form.
function blankLine() {
  return { id: crypto.randomUUID?.() || String(Math.random()), item_id: "", qty: "", reason: "wasted", notes: "" };
}

export default function MealWastageTab() {
  const [dateStr, setDateStr] = useState(todayISO());
  const [cats, setCats] = useState([]);
  const [items, setItems] = useState([]);
  const [stock, setStock] = useState({});
  const [lines, setLines] = useState([blankLine()]);
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

  // Stock as-of the wastage date (this is discovery-loss, not
  // consumption — we want what was in hand THAT day).
  useEffect(() => {
    api.get(`/meals/stock?as_of=${dateStr}`)
      .then((r) => setStock(Object.fromEntries((r.rows || []).map((x) => [x.item_id, x]))))
      .catch(() => setStock({}));
  }, [dateStr]);

  // Load existing wastage for the date and hydrate into editable rows.
  useEffect(() => {
    api.get(`/meals/wastage?start=${dateStr}&end=${dateStr}`)
      .then((r) => {
        const rows = r.wastage?.[0]?.lines || [];
        setLines(rows.length ? rows.map((l) => ({
          id: l.id || crypto.randomUUID?.() || String(Math.random()),
          item_id: l.item_id,
          qty: l.qty,
          reason: l.reason || "wasted",
          notes: l.notes || "",
        })) : [blankLine()]);
      })
      .catch(() => setLines([blankLine()]));
  }, [dateStr]);

  const loadRecent = () => {
    const end = todayISO();
    const startD = new Date();
    startD.setDate(startD.getDate() - 30);
    const p = (n) => String(n).padStart(2, "0");
    const start = `${startD.getFullYear()}-${p(startD.getMonth() + 1)}-${p(startD.getDate())}`;
    api.get(`/meals/wastage?start=${start}&end=${end}`)
      .then((r) => setRecent((r.wastage || []).slice().reverse()))
      .catch(() => {});
  };
  useEffect(loadRecent, []);

  const itemOptions = useMemo(() => {
    // Group items by category label for the option groups.
    const map = new Map();
    cats.forEach((c) => map.set(c.key, { label: c.label, rows: [] }));
    items.forEach((it) => map.get(it.category_key)?.rows.push(it));
    return Array.from(map.values()).filter((g) => g.rows.length > 0);
  }, [items, cats]);

  const updateLine = (id, patch) =>
    setLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const addLine = () => setLines((prev) => [...prev, blankLine()]);
  const removeLine = (id) => setLines((prev) => prev.filter((l) => l.id !== id));

  const save = async () => {
    const payload = lines
      .filter((l) => l.item_id && num(l.qty) > 0)
      .map((l) => ({
        item_id: l.item_id,
        qty: num(l.qty),
        reason: l.reason || "wasted",
        notes: (l.notes || "").trim(),
      }));
    setSaving(true);
    try {
      await api.put(`/meals/wastage/${dateStr}`, { lines: payload });
      toast.success(`Wastage saved for ${formatDate(dateStr)}`);
      loadRecent();
    } catch (err) {
      showApiError(err, "Couldn't save wastage");
    } finally { setSaving(false); }
  };

  return (
    <div data-testid="meal-wastage-tab">
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <input type="date" value={dateStr} max={todayISO()} onChange={(e) => setDateStr(e.target.value)} className="iu-input !h-9 !w-auto text-sm" data-testid="wastage-date" />
        <span className="text-xs text-slate-500">{formatDate(dateStr)}</span>
        <span className="ml-auto text-xs text-slate-500">Reduces stock but is logged separately from Daily Issues</span>
      </div>

      {itemOptions.length === 0 ? (
        <div className="iu-card p-8 text-center" data-testid="wastage-no-items">
          <Boxes size={30} className="mx-auto text-slate-300 mb-2" />
          <p className="font-semibold text-slate-700">No items configured yet.</p>
          <p className="text-sm text-slate-500 mt-1">Ask an admin to set up items in the Purchases tab.</p>
        </div>
      ) : (
        <div className="iu-card overflow-hidden" data-testid="wastage-entry-card">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase text-slate-500">
              <tr>
                <th className="text-left p-2 w-1/4">Item</th>
                <th className="text-right p-2 w-24">On-hand</th>
                <th className="text-right p-2 w-24">Qty lost</th>
                <th className="text-left p-2 w-16">Unit</th>
                <th className="text-left p-2 w-28">Reason</th>
                <th className="text-left p-2">Notes</th>
                <th className="p-2 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const it = items.find((x) => x.id === l.item_id);
                const oh = stock[l.item_id]?.on_hand;
                const qty = num(l.qty);
                const over = oh != null && qty > oh + 1e-6;
                return (
                  <tr key={l.id} className={`border-t border-slate-100 ${over ? "bg-rose-50/60" : ""}`} data-testid={`wastage-row-${l.id}`}>
                    <td className="p-2">
                      <select value={l.item_id} onChange={(e) => updateLine(l.id, { item_id: e.target.value })} className="iu-input !h-8 text-sm w-full" data-testid={`wastage-item-${l.id}`}>
                        <option value="">— Select —</option>
                        {itemOptions.map((g) => (
                          <optgroup key={g.label} label={g.label}>
                            {g.rows.map((it2) => <option key={it2.id} value={it2.id}>{it2.name}</option>)}
                          </optgroup>
                        ))}
                      </select>
                    </td>
                    <td className="p-2 text-right tabular-nums text-slate-600">{oh != null ? fmtQty(oh) : "—"}</td>
                    <td className="p-2">
                      <input type="number" min="0" step="0.01" value={l.qty} onChange={(e) => updateLine(l.id, { qty: e.target.value })} className={`iu-input !h-8 text-sm w-full text-right tabular-nums ${over ? "border-rose-400" : ""}`} placeholder="0" data-testid={`wastage-qty-${l.id}`} />
                    </td>
                    <td className="p-2 text-slate-500 text-xs">{it?.unit || "—"}</td>
                    <td className="p-2">
                      <select value={l.reason} onChange={(e) => updateLine(l.id, { reason: e.target.value })} className="iu-input !h-8 text-sm w-full" data-testid={`wastage-reason-${l.id}`}>
                        {REASONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                      </select>
                    </td>
                    <td className="p-2">
                      <input value={l.notes} onChange={(e) => updateLine(l.id, { notes: e.target.value })} className="iu-input !h-8 text-sm w-full" placeholder="Optional — e.g. left in sun" data-testid={`wastage-notes-${l.id}`} />
                    </td>
                    <td className="p-2 text-right">
                      <button onClick={() => removeLine(l.id)} className="p-1.5 rounded text-rose-500 hover:bg-rose-50" title="Remove line" data-testid={`wastage-remove-${l.id}`}>
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="p-3 border-t border-slate-100 flex justify-between items-center">
            <button onClick={addLine} className="iu-btn-secondary !h-9 !px-3 text-sm" data-testid="wastage-add-line">
              + Add line
            </button>
            <button onClick={save} disabled={saving} className="iu-btn-primary !h-9 !px-4 text-sm" data-testid="wastage-save">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
            </button>
          </div>
        </div>
      )}

      <div className="iu-card mt-4 overflow-auto" data-testid="wastage-recent">
        <div className="px-4 py-3 border-b border-slate-100 font-bold text-sm">Last 30 days of wastage</div>
        {recent.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500" data-testid="wastage-recent-empty">Nothing logged yet — good going.</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Items</th>
                <th className="px-3 py-2 text-left">Reasons</th>
                <th className="px-3 py-2 text-left">By</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r) => {
                const lineList = r.lines || [];
                const reasonTags = Array.from(new Set(lineList.map((l) => l.reason))).map((k) => REASON_LABEL[k] || k);
                const preview = lineList.slice(0, 3).map((l) => `${l.item_name} (${fmtQty(l.qty)} ${l.unit})`).join(", ");
                return (
                  <tr key={r.date} className="border-t border-slate-100 hover:bg-slate-50/70 cursor-pointer" onClick={() => setDateStr(r.date)} data-testid={`wastage-recent-row-${r.date}`}>
                    <td className="px-3 py-1.5 font-semibold whitespace-nowrap">{formatDate(r.date)}</td>
                    <td className="px-3 py-1.5 text-slate-700">
                      {preview}{lineList.length > 3 ? ` +${lineList.length - 3}` : ""}
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex flex-wrap gap-1">
                        {reasonTags.map((rt) => (
                          <span key={rt} className="inline-flex items-center px-1.5 h-4 rounded bg-rose-100 text-rose-700 text-[10px] font-bold uppercase">{rt}</span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-1.5 text-slate-500">{r.updated_by_name || ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
