import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Save, Search } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { categoryLabel } from "../../utils";

export default function LeaveBalances() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [edits, setEdits] = useState({}); // member_id -> opening value
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try { setData(await api.get("/leave-balances")); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const setVal = (id, v) => setEdits((e) => ({ ...e, [id]: v }));

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!data) return [];
    if (!q) return data.rows;
    return data.rows.filter((r) =>
      (r.full_name || "").toLowerCase().includes(q) ||
      (r.rank || "").toLowerCase().includes(q) ||
      (r.institution || "").toLowerCase().includes(q)
    );
  }, [data, search]);

  const dirtyCount = Object.keys(edits).length;

  const saveAll = async () => {
    const rows = Object.entries(edits).map(([member_id, opening]) => ({
      member_id,
      opening: Number(opening) || 0,
    }));
    if (rows.length === 0) { toast.info("Nothing to save"); return; }
    setSaving(true);
    try {
      const r = await api.post("/leave-balances/bulk", { rows });
      toast.success(`Saved ${r.updated} ${r.updated === 1 ? "row" : "rows"}`);
      setEdits({});
      load();
    } catch (err) {
      toast.error(err?.message || "Failed");
    } finally { setSaving(false); }
  };

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      <header className="mb-5">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Leave Balances</h1>
        <p className="text-slate-500 text-sm mt-1">Set each member&apos;s opening leave balance for {data?.year || "this year"}. Edit any cell, then Save.</p>
      </header>

      <div className="iu-card p-3 mb-4 flex items-center gap-3 sticky top-0 z-10">
        <Search size={16} className="text-slate-400" />
        <input
          data-testid="lb-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, rank, institution…"
          className="flex-1 outline-none bg-transparent text-sm"
        />
        <span className="text-xs text-slate-500">{dirtyCount > 0 && `${dirtyCount} unsaved`}</span>
        <button
          data-testid="lb-save"
          onClick={saveAll}
          disabled={saving || dirtyCount === 0}
          title="Save all edited opening balances"
          className="iu-btn-primary !h-9 !px-3"
        >
          {saving ? <Loader2 className="animate-spin" size={14}/> : <Save size={14}/>} Save
        </button>
      </div>

      {loading ? (
        <div className="text-center py-10"><Loader2 className="mx-auto animate-spin text-slate-400" /></div>
      ) : (
        <div className="iu-card overflow-hidden">
          <div className="overflow-auto max-h-[70vh]">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="iu-table-th">Member</th>
                  <th className="iu-table-th hidden md:table-cell">Category</th>
                  <th className="iu-table-th hidden lg:table-cell">Institution</th>
                  <th className="iu-table-th text-right">Opening</th>
                  <th className="iu-table-th text-right">Taken YTD</th>
                  <th className="iu-table-th text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const dirty = edits[r.id] !== undefined;
                  const opening = dirty ? edits[r.id] : r.opening;
                  const balance = (Number(opening) || 0) - r.taken_this_year;
                  return (
                    <tr key={r.id} className={dirty ? "bg-amber-50" : "hover:bg-slate-50"} data-testid={`lb-row-${r.id}`}>
                      <td className="iu-table-td font-semibold">{r.full_name}<div className="text-xs text-slate-400">{r.rank || ""}</div></td>
                      <td className="iu-table-td hidden md:table-cell">{categoryLabel(r.category)}</td>
                      <td className="iu-table-td hidden lg:table-cell text-xs text-slate-500">{r.institution || "—"}</td>
                      <td className="iu-table-td text-right">
                        <input
                          data-testid={`lb-input-${r.id}`}
                          type="number"
                          step="0.5"
                          min="0"
                          value={opening}
                          onChange={(e) => setVal(r.id, e.target.value)}
                          className="w-20 text-right px-2 py-1 rounded-md border border-slate-200 focus:border-slate-400 outline-none bg-white"
                        />
                      </td>
                      <td className="iu-table-td text-right text-slate-600">{r.taken_this_year}</td>
                      <td className={`iu-table-td text-right font-bold ${balance < 0 ? "text-red-600" : "text-emerald-700"}`}>{balance}</td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr><td colSpan={6} className="text-center py-10 text-slate-500">No members match.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
