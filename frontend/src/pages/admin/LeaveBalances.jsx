import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Save, Search, RefreshCw, Bed, Plane } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { categoryLabel } from "../../utils";
import FormErrorBanner from "../../components/FormErrorBanner";
import { useFormError } from "../../hooks/useFormError";
import { round1 } from "../leaves/utils";

export default function LeaveBalances() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  // member_id -> { opening?, comp_off_opening? }  — only the keys the user
  // touched land in the payload, so editing one column never clobbers the
  // other on save.
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);
  // Row the user is hovering / focused on. The header strip mirrors this
  // row's balances rather than showing org-wide totals — summing leave
  // across employees was misleading (leave is per-person, not a pool).
  const [activeId, setActiveId] = useState(null);
  const formErr = useFormError();

  const load = async () => {
    setLoading(true);
    try { setData(await api.get("/leave-balances")); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const setVal = (id, field, v) =>
    setEdits((e) => ({ ...e, [id]: { ...(e[id] || {}), [field]: v } }));

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

  // The active member is the one the cursor is on (or last focused via
  // keyboard). Falls back to the first visible row so the header is
  // populated immediately on first paint — gives admins a useful preview
  // before they even hover.
  const activeRow = useMemo(() => {
    if (!filtered.length) return null;
    return filtered.find((r) => r.id === activeId) || filtered[0];
  }, [filtered, activeId]);

  // Reflect any unsaved edit in the header so what the admin sees in the
  // strip matches what they just typed (live opening → live balance).
  const activeDisplay = useMemo(() => {
    if (!activeRow) return null;
    const ed = edits[activeRow.id] || {};
    const opening = Number(ed.opening !== undefined ? ed.opening : activeRow.opening) || 0;
    const balance = opening - Number(activeRow.taken_this_year || 0);
    // Comp-off side — if admin is editing the Comp-Off Opening column,
    // recompute accrued (= attendance + tours + new_opening) and available
    // live so the strip card reflects what's pending.
    const editedCoOpening = ed.comp_off_opening !== undefined ? Number(ed.comp_off_opening) || 0 : null;
    const dirty = Object.keys(ed).length > 0;
    if (editedCoOpening !== null) {
      const fromAttn = Number(activeRow.comp_off_accrued_from_attendance || 0);
      const fromTours = Number(activeRow.comp_off_accrued_from_tours || 0);
      const newAccrued = fromAttn + fromTours + editedCoOpening;
      const newAvail = Math.max(0, newAccrued - Number(activeRow.comp_off_used || 0));
      return {
        ...activeRow,
        opening,
        balance,
        comp_off_accrued: newAccrued,
        comp_off_available: newAvail,
        comp_off_accrued_from_opening: editedCoOpening,
        _dirty: dirty,
      };
    }
    return { ...activeRow, opening, balance, _dirty: dirty };
  }, [activeRow, edits]);

  const saveAll = async () => {
    const rows = Object.entries(edits).map(([member_id, fields]) => {
      const row = { member_id };
      if (fields.opening !== undefined) row.opening = Number(fields.opening) || 0;
      if (fields.comp_off_opening !== undefined)
        row.comp_off_opening = Math.max(0, parseInt(fields.comp_off_opening, 10) || 0);
      return row;
    }).filter((r) => "opening" in r || "comp_off_opening" in r);
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
            Coaches, staff &amp; executives — opening Paid Leave &amp; Comp-Off balances
            plus live accrual and Tour usage for {data?.year || "this year"}.
            Edit the two Opening columns then Save. Athletes don&apos;t consume
            a numeric quota and aren&apos;t listed.
          </p>
        </div>
        <button onClick={load} className="iu-btn-secondary !h-9 !px-3" data-testid="lb-reload" title="Refresh">
          <RefreshCw size={14}/> Refresh
        </button>
      </header>

      {/* Header strip — mirrors the MEMBER under the cursor (or the first
          visible row on first paint). Hovering / focusing a different row
          updates this preview live; editing the opening cell also reflects
          immediately so admins can scrub adjustments without committing. */}
      {!loading && data && activeDisplay && (
        <div data-testid="lb-active-strip" className="mb-4">
          <div className="flex items-center gap-2 mb-2 text-xs text-slate-500">
            <span className="uppercase tracking-wider font-bold text-slate-600" data-testid="lb-active-name">
              {activeDisplay.full_name}
            </span>
            {activeDisplay.rank && <span className="text-slate-400">· {activeDisplay.rank}</span>}
            {activeDisplay.institution && <span className="text-slate-400 hidden sm:inline">· {activeDisplay.institution}</span>}
            {activeDisplay._dirty && (
              <span className="ml-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-extrabold uppercase tracking-wide">Unsaved edit</span>
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="iu-card !p-3 border-l-4 border-amber-400" data-testid="lb-active-paid">
              <div className="flex items-center gap-2 mb-1">
                <Bed size={14} className="text-amber-600"/>
                <span className="text-[11px] uppercase tracking-wider font-bold text-slate-500">Paid Leave</span>
              </div>
              <div className="text-xs text-slate-600">
                Opening <span className="font-extrabold text-slate-900">{round1(activeDisplay.opening)}</span> ·
                Used <span className="font-extrabold text-slate-900">{round1(activeDisplay.taken_this_year)}</span> ·
                Balance <span className={`font-extrabold ${activeDisplay.balance < 0 ? "text-red-600" : "text-emerald-700"}`}>{round1(activeDisplay.balance)}</span>
              </div>
            </div>
            <div className="iu-card !p-3 border-l-4 border-violet-400" data-testid="lb-active-comp">
              <div className="flex items-center gap-2 mb-1">
                <RefreshCw size={14} className="text-violet-600"/>
                <span className="text-[11px] uppercase tracking-wider font-bold text-slate-500">Comp-Off (YTD)</span>
              </div>
              <div className="text-xs text-slate-600">
                Accrued <span className="font-extrabold text-slate-900">{activeDisplay.comp_off_accrued || 0}</span> ·
                Used <span className="font-extrabold text-slate-900">{activeDisplay.comp_off_used || 0}</span> ·
                Available <span className="font-extrabold text-violet-700">{activeDisplay.comp_off_available || 0}</span>
              </div>
              {((activeDisplay.comp_off_accrued_from_tours || 0) > 0
                || (activeDisplay.comp_off_accrued_from_opening || 0) > 0) && (
                <div className="text-[11px] mt-0.5 flex flex-wrap items-center gap-x-2" data-testid="lb-active-comp-sources">
                  {(activeDisplay.comp_off_accrued_from_tours || 0) > 0 && (
                    <span
                      className="text-orange-700 flex items-center gap-1"
                      data-testid="lb-active-comp-from-tours"
                      title="Comp-off accrued because an approved tour spanned this member's weekly off"
                    >
                      <Plane size={10}/>
                      {activeDisplay.comp_off_accrued_from_tours} from tours
                    </span>
                  )}
                  {(activeDisplay.comp_off_accrued_from_opening || 0) > 0 && (
                    <span
                      className="text-violet-700 flex items-center gap-1"
                      data-testid="lb-active-comp-from-opening"
                      title="Comp-off carried forward / seeded by admin"
                    >
                      <RefreshCw size={10}/>
                      {activeDisplay.comp_off_accrued_from_opening} opening
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="iu-card !p-3 border-l-4 border-orange-400" data-testid="lb-active-tour">
              <div className="flex items-center gap-2 mb-1">
                <Plane size={14} className="text-orange-600"/>
                <span className="text-[11px] uppercase tracking-wider font-bold text-slate-500">Tour Days (YTD)</span>
              </div>
              <div className="text-xs text-slate-600">
                Total <span className="font-extrabold text-orange-700">{activeDisplay.tour_days || 0}</span>
                <span className="text-slate-400 ml-2 text-[11px]">(does not consume balance)</span>
              </div>
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
                  <th className="iu-table-th !text-right bg-violet-50/60 border-l border-violet-100" colSpan={4}>
                    <span className="inline-flex items-center gap-1 text-violet-700"><RefreshCw size={12}/> Comp-Off</span>
                  </th>
                  <th className="iu-table-th !text-right bg-orange-50/60 border-l border-orange-100" rowSpan={2}>
                    <span className="inline-flex items-center gap-1 text-orange-700"><Plane size={12}/> Tour</span>
                  </th>
                </tr>
                <tr className="text-[10px] uppercase tracking-wider">
                  <th className="iu-table-th !text-right bg-amber-100/70 !py-1 text-amber-800">Opening</th>
                  <th className="iu-table-th !text-right bg-amber-50/40 !py-1">Used</th>
                  <th className="iu-table-th !text-right bg-amber-50/40 !py-1">Balance</th>
                  <th className="iu-table-th !text-right bg-violet-100/70 !py-1 border-l border-violet-100 text-violet-800">Opening</th>
                  <th className="iu-table-th !text-right bg-violet-50/40 !py-1">Accrued</th>
                  <th className="iu-table-th !text-right bg-violet-50/40 !py-1">Used</th>
                  <th className="iu-table-th !text-right bg-violet-50/40 !py-1">Available</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const ed = edits[r.id] || {};
                  const openingDirty = ed.opening !== undefined;
                  const opening = openingDirty ? ed.opening : r.opening;
                  const balance = (Number(opening) || 0) - r.taken_this_year;
                  const coOpeningDirty = ed.comp_off_opening !== undefined;
                  const coOpening = coOpeningDirty
                    ? ed.comp_off_opening
                    : (r.comp_off_opening || 0);
                  const dirty = openingDirty || coOpeningDirty;
                  return (
                    <tr
                      key={r.id}
                      className={`${dirty ? "bg-amber-50" : activeId === r.id ? "bg-sky-50" : "hover:bg-slate-50"} cursor-pointer transition-colors`}
                      data-testid={`lb-row-${r.id}`}
                      onMouseEnter={() => setActiveId(r.id)}
                      onFocus={() => setActiveId(r.id)}
                    >
                      <td className="iu-table-td font-semibold">{r.full_name}<div className="text-xs text-slate-400">{r.rank || ""}</div></td>
                      <td className="iu-table-td hidden md:table-cell">{categoryLabel(r.category)}</td>
                      <td className="iu-table-td hidden lg:table-cell text-xs text-slate-500">{r.institution || "—"}</td>
                      <td className="iu-table-td text-right bg-amber-50/40">
                        <input
                          data-testid={`lb-input-${r.id}`}
                          type="number"
                          step="0.5"
                          min="0"
                          value={opening}
                          onChange={(e) => setVal(r.id, "opening", e.target.value)}
                          className="w-20 text-right px-2 py-1 rounded-md border border-amber-200 focus:border-amber-500 outline-none bg-white"
                        />
                      </td>
                      <td className="iu-table-td text-right text-slate-600" data-testid={`lb-paid-used-${r.id}`}>{round1(r.taken_this_year)}</td>
                      <td className={`iu-table-td text-right font-bold ${balance < 0 ? "text-red-600" : "text-emerald-700"}`} data-testid={`lb-paid-balance-${r.id}`}>{round1(balance)}</td>
                      <td className="iu-table-td text-right bg-violet-50/40 border-l border-violet-100">
                        <input
                          data-testid={`lb-co-opening-input-${r.id}`}
                          type="number"
                          step="1"
                          min="0"
                          value={coOpening}
                          onChange={(e) => setVal(r.id, "comp_off_opening", e.target.value)}
                          className="w-16 text-right px-2 py-1 rounded-md border border-violet-200 focus:border-violet-500 outline-none bg-white"
                          title="Comp-Off carried forward / seeded by admin"
                        />
                      </td>
                      <td className="iu-table-td text-right text-slate-700" data-testid={`lb-co-accrued-${r.id}`}>
                        {r.comp_off_accrued || 0}
                        {(r.comp_off_accrued_from_tours || 0) > 0 && (
                          <div
                            className="text-[10px] text-orange-700 font-semibold leading-tight"
                            data-testid={`lb-co-tour-pill-${r.id}`}
                            title={`${r.comp_off_accrued_from_tours} accrued from approved tour day(s) that landed on the weekly off`}
                          >
                            +{r.comp_off_accrued_from_tours} tour
                          </div>
                        )}
                      </td>
                      <td className="iu-table-td text-right text-slate-600" data-testid={`lb-co-used-${r.id}`}>{r.comp_off_used || 0}</td>
                      <td className="iu-table-td text-right font-bold text-violet-700" data-testid={`lb-co-avail-${r.id}`}>{r.comp_off_available || 0}</td>
                      <td className="iu-table-td text-right text-orange-700 font-semibold border-l border-orange-100" data-testid={`lb-tour-${r.id}`}>{r.tour_days || 0}</td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr><td colSpan={11} className="text-center py-10 text-slate-500">No members match.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

