import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Save, Search, RefreshCw, Bed, Plane } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { categoryLabel } from "../../utils";
import FormErrorBanner from "../../components/FormErrorBanner";
import { useFormError } from "../../hooks/useFormError";

export default function LeaveBalances() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [edits, setEdits] = useState({}); // member_id -> opening value
  const [saving, setSaving] = useState(false);
  const formErr = useFormError();

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

  // Totals strip across the top — fast at-a-glance audit. We sum on the
  // filtered rows so the search box also narrows the headline numbers
  // (e.g. show me totals for just "coach").
  const totals = useMemo(() => {
    return filtered.reduce((acc, r) => {
      acc.opening += Number(r.opening || 0);
      acc.taken += Number(r.taken_this_year || 0);
      acc.balance += Number(r.balance || 0);
      acc.co_accrued += Number(r.comp_off_accrued || 0);
      acc.co_used += Number(r.comp_off_used || 0);
      acc.co_avail += Number(r.comp_off_available || 0);
      acc.tour += Number(r.tour_days || 0);
      return acc;
    }, { opening: 0, taken: 0, balance: 0, co_accrued: 0, co_used: 0, co_avail: 0, tour: 0 });
  }, [filtered]);

  const saveAll = async () => {
    const rows = Object.entries(edits).map(([member_id, opening]) => ({
      member_id,
      opening: Number(opening) || 0,
    }));
    if (rows.length === 0) { toast.info("Nothing to save"); return; }
    setSaving(true);
    formErr.clear();
    try {
      const r = await api.post("/leave-balances/bulk", { rows });
      toast.success(`Saved ${r.updated} ${r.updated === 1 ? "row" : "rows"}`);
      setEdits({});
      load();
    } catch (err) {
      formErr.setFromApi(err, "Failed to save");
    } finally { setSaving(false); }
  };

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto">
      <header className="mb-5 flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Leave Balances</h1>
          <p className="text-slate-500 text-sm mt-1">
            Coaches, staff &amp; executives — opening Paid Leave plus live Comp-Off accrual and Tour usage for {data?.year || "this year"}.
            Edit the Opening column then Save. Athletes don&apos;t consume a numeric quota and aren&apos;t listed.
          </p>
        </div>
        <button onClick={load} className="iu-btn-secondary !h-9 !px-3" data-testid="lb-reload" title="Refresh">
          <RefreshCw size={14}/> Refresh
        </button>
      </header>

      {/* Totals header strip — three coloured cards: Paid Leave, Comp-Off, Tour.
          Sums respect the active search filter so admins can audit slices. */}
      {!loading && data && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4" data-testid="lb-totals">
          <div className="iu-card !p-3 border-l-4 border-amber-400" data-testid="lb-total-paid">
            <div className="flex items-center gap-2 mb-1">
              <Bed size={14} className="text-amber-600"/>
              <span className="text-[11px] uppercase tracking-wider font-bold text-slate-500">Paid Leave</span>
            </div>
            <div className="text-xs text-slate-600">
              Opening <span className="font-extrabold text-slate-900">{round1(totals.opening)}</span> ·
              Used <span className="font-extrabold text-slate-900">{round1(totals.taken)}</span> ·
              Balance <span className={`font-extrabold ${totals.balance < 0 ? "text-red-600" : "text-emerald-700"}`}>{round1(totals.balance)}</span>
            </div>
          </div>
          <div className="iu-card !p-3 border-l-4 border-violet-400" data-testid="lb-total-comp">
            <div className="flex items-center gap-2 mb-1">
              <RefreshCw size={14} className="text-violet-600"/>
              <span className="text-[11px] uppercase tracking-wider font-bold text-slate-500">Comp-Off (YTD)</span>
            </div>
            <div className="text-xs text-slate-600">
              Accrued <span className="font-extrabold text-slate-900">{totals.co_accrued}</span> ·
              Used <span className="font-extrabold text-slate-900">{totals.co_used}</span> ·
              Available <span className="font-extrabold text-violet-700">{totals.co_avail}</span>
            </div>
          </div>
          <div className="iu-card !p-3 border-l-4 border-orange-400" data-testid="lb-total-tour">
            <div className="flex items-center gap-2 mb-1">
              <Plane size={14} className="text-orange-600"/>
              <span className="text-[11px] uppercase tracking-wider font-bold text-slate-500">Tour Days (YTD)</span>
            </div>
            <div className="text-xs text-slate-600">
              Total <span className="font-extrabold text-orange-700">{totals.tour}</span>
              <span className="text-slate-400 ml-2 text-[11px]">(does not consume balance)</span>
            </div>
          </div>
        </div>
      )}

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
          className="iu-btn-primary !h-9 !px-3"
        >
          {saving ? <Loader2 className="animate-spin" size={14}/> : <Save size={14}/>} Save
        </button>
      </div>

      <FormErrorBanner
        error={formErr.error}
        requestId={formErr.requestId}
        onDismiss={formErr.clear}
        testId="lb-save-error"
      />

      {loading ? (
        <div className="text-center py-10"><Loader2 className="mx-auto animate-spin text-slate-400" /></div>
      ) : (
        <div className="iu-card overflow-hidden">
          <div className="overflow-auto max-h-[70vh]">
            <table className="w-full text-sm min-w-[1080px]">
              <thead className="bg-slate-50 sticky top-0 z-10">
                <tr>
                  <th className="iu-table-th !text-left" rowSpan={2}>Member</th>
                  <th className="iu-table-th !text-left hidden md:table-cell" rowSpan={2}>Category</th>
                  <th className="iu-table-th !text-left hidden lg:table-cell" rowSpan={2}>Institution</th>
                  <th className="iu-table-th !text-right bg-amber-50/60 border-l border-amber-100" colSpan={3}>
                    <span className="inline-flex items-center gap-1 text-amber-700"><Bed size={12}/> Paid Leave</span>
                  </th>
                  <th className="iu-table-th !text-right bg-violet-50/60 border-l border-violet-100" colSpan={3}>
                    <span className="inline-flex items-center gap-1 text-violet-700"><RefreshCw size={12}/> Comp-Off</span>
                  </th>
                  <th className="iu-table-th !text-right bg-orange-50/60 border-l border-orange-100" rowSpan={2}>
                    <span className="inline-flex items-center gap-1 text-orange-700"><Plane size={12}/> Tour</span>
                  </th>
                </tr>
                <tr className="text-[10px] uppercase tracking-wider">
                  <th className="iu-table-th !text-right bg-amber-50/40 !py-1">Opening</th>
                  <th className="iu-table-th !text-right bg-amber-50/40 !py-1">Used</th>
                  <th className="iu-table-th !text-right bg-amber-50/40 !py-1">Balance</th>
                  <th className="iu-table-th !text-right bg-violet-50/40 !py-1 border-l border-violet-100">Accrued</th>
                  <th className="iu-table-th !text-right bg-violet-50/40 !py-1">Used</th>
                  <th className="iu-table-th !text-right bg-violet-50/40 !py-1">Available</th>
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
                      <td className="iu-table-td text-right text-slate-600" data-testid={`lb-paid-used-${r.id}`}>{round1(r.taken_this_year)}</td>
                      <td className={`iu-table-td text-right font-bold ${balance < 0 ? "text-red-600" : "text-emerald-700"}`} data-testid={`lb-paid-balance-${r.id}`}>{round1(balance)}</td>
                      <td className="iu-table-td text-right text-slate-700 border-l border-violet-100" data-testid={`lb-co-accrued-${r.id}`}>{r.comp_off_accrued || 0}</td>
                      <td className="iu-table-td text-right text-slate-600" data-testid={`lb-co-used-${r.id}`}>{r.comp_off_used || 0}</td>
                      <td className="iu-table-td text-right font-bold text-violet-700" data-testid={`lb-co-avail-${r.id}`}>{r.comp_off_available || 0}</td>
                      <td className="iu-table-td text-right text-orange-700 font-semibold border-l border-orange-100" data-testid={`lb-tour-${r.id}`}>{r.tour_days || 0}</td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr><td colSpan={10} className="text-center py-10 text-slate-500">No members match.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function round1(v) {
  if (v == null) return 0;
  const n = Number(v);
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 10) / 10;
}
