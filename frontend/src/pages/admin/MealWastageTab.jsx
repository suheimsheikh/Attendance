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

export default function MealWastageTab({ liveSig }) {
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

  // Live refresh — reload the read-only bits (masters, recent list,
  // stock) when another machine changes pantry data. The editable
  // `lines` grid is left alone so an in-progress entry is never lost.
  useEffect(() => {
    if (!liveSig) return;
    if (["items", "categories"].includes(liveSig.scope)) loadMasters();
    loadRecent();
    api.get(`/meals/stock?as_of=${dateStr}`)
      .then((r) => setStock(Object.fromEntries((r.rows || []).map((x) => [x.item_id, x]))))
      .catch(() => {});
  }, [liveSig]);

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
      {/* Entry retired Feb 2026 — wastage now lives inside Daily Entry
          (three colour bands: Purchases / Issues / Wastage). This tab
          keeps a read-only history so old data is still auditable. */}
      <div className="iu-card p-4 mb-4 bg-rose-50/40 border-rose-200" data-testid="wastage-moved-notice">
        <div className="flex items-start gap-3">
          <Boxes size={20} className="text-rose-500 mt-0.5"/>
          <div className="text-sm text-slate-700">
            <div className="font-bold text-rose-800">Wastage entry has moved.</div>
            <div className="mt-1">
              Log wastage directly on the <span className="font-semibold">Daily entry</span> tab — every item row now has a <span className="font-semibold text-rose-700">Wastage</span> column with quantity and reason, right next to Issues.
            </div>
            <div className="mt-1 text-xs text-slate-500">This tab is now a read-only 30-day history for audit purposes.</div>
          </div>
        </div>
      </div>

      <div className="iu-card overflow-auto" data-testid="wastage-recent">
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
                  <tr key={r.date} className="border-t border-slate-100 hover:bg-slate-50/70" data-testid={`wastage-recent-row-${r.date}`}>
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
