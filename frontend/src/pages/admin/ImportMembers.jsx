import React, { useState } from "react";
import { Loader2, Upload, FileDown, CheckCircle2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { uploadFile, downloadBlob } from "../../api";

export default function ImportMembers() {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!file) { toast.error("Pick an .xlsx file first"); return; }
    setBusy(true);
    try {
      const res = await uploadFile("/members/import", file);
      setResult(res);
      toast.success(`Imported ${res.created_count} · Skipped/errors: ${res.error_count}`);
    } catch (err) {
      toast.error(err?.message || err?.response?.data?.detail || "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const downloadTemplate = () => downloadBlob("/members/import-template", "members_template.xlsx");

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto">
      <header className="mb-6">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Import Members</h1>
        <p className="text-slate-500 text-sm mt-1">Bulk-create members from an Excel file. Existing emails are skipped.</p>
      </header>

      <form onSubmit={submit} className="iu-card p-5 md:p-6 space-y-4" data-testid="import-form">
        <div>
          <label className="iu-label">Excel file (.xlsx)</label>
          <input
            data-testid="import-file"
            type="file"
            accept=".xlsx"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="block w-full text-sm text-slate-700 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-slate-900 file:text-white hover:file:bg-slate-800"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <button data-testid="import-submit" type="submit" disabled={busy || !file} title="Upload the filled-in spreadsheet and create/update members" className="iu-btn-primary">
            {busy ? <Loader2 className="animate-spin" size={14}/> : <Upload size={14}/>} Upload
          </button>
          <button data-testid="import-template" type="button" onClick={downloadTemplate} title="Download a blank spreadsheet with the expected columns" className="iu-btn-secondary">
            <FileDown size={14}/> Download template
          </button>
        </div>
      </form>

      {result && (
        <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="import-result">
          <div className="iu-card">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
              <CheckCircle2 className="text-emerald-600" size={18}/>
              <h3 className="font-extrabold">Created · {result.created_count}</h3>
            </div>
            {result.created.length === 0 ? <div className="p-6 text-center text-sm text-slate-500">Nothing new.</div> : (
              <ul className="divide-y divide-slate-100 max-h-80 overflow-y-auto text-sm">
                {result.created.map((c) => (
                  <li key={c.email} className="px-5 py-2">
                    <div className="font-semibold">{c.full_name}</div>
                    <div className="text-xs text-slate-500">{c.email} · pwd: {c.password}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="iu-card">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
              <AlertTriangle className="text-amber-600" size={18}/>
              <h3 className="font-extrabold">Issues · {result.error_count}</h3>
            </div>
            {result.errors.length === 0 ? <div className="p-6 text-center text-sm text-slate-500">No issues.</div> : (
              <ul className="divide-y divide-slate-100 max-h-80 overflow-y-auto text-sm">
                {result.errors.map((e) => (
                  <li key={`${e.row}-${e.reason}`} className="px-5 py-2"><span className="text-xs text-slate-400">Row {e.row}: </span>{e.reason}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <ParentImport />
    </div>
  );
}


/**
 * Import parents & guardians (names + mobile numbers) for EXISTING members.
 *
 * Match key: sailor name (case-insensitive, whitespace-normalized) against
 * the live `users` collection. Unmatched rows are surfaced so the admin can
 * fix the source file and re-run.
 *
 * Expected layout (header at row 2): S/No | Inst | SAILOR NAME | G | DOB | DOJ |
 *   Father Name | Father Contact | Mother Name | Mother Contact | Guardian Name | Guardian Contact
 *
 * Idempotent — re-running overwrites parent fields with the latest values.
 */
function ParentImport() {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(null); // "preview" | "apply" | null
  const [preview, setPreview] = useState(null);
  // Per-row decisions keyed by row number:
  //   { member_id, use_name: "spreadsheet" | "member" }   ← match a candidate
  //   { skip: true }                                       ← explicitly skip
  const [decisions, setDecisions] = useState({});
  const [final, setFinal] = useState(null);

  const reset = () => { setPreview(null); setDecisions({}); setFinal(null); };

  const runPreview = async (e) => {
    e?.preventDefault?.();
    if (!file) { toast.error("Pick the parents .xlsx first"); return; }
    setBusy("preview"); setFinal(null);
    try {
      const res = await uploadFile("/members/import-parents?mode=preview", file);
      setPreview(res); setDecisions({});
      toast.success(`Preview ready — ${res.matched_count} exact, ${res.suggestion_count} need review, ${res.unmatched_count} unmatched`);
    } catch (err) {
      toast.error(err?.message || err?.response?.data?.detail || "Preview failed");
    } finally { setBusy(null); }
  };

  const applyAll = async () => {
    if (!file || !preview) return;
    const mappings = Object.entries(decisions)
      .filter(([, v]) => v?.member_id && !v?.skip)
      .map(([row, v]) => ({ row: Number(row), member_id: v.member_id, use_name: v.use_name || "member" }));
    setBusy("apply");
    try {
      const res = await uploadFile("/members/import-parents", file, { mode: "apply", mappings: JSON.stringify(mappings) });
      setFinal(res);
      toast.success(`Imported — ${res.matched_count} updated (${mappings.length} via your spelling resolutions)`);
    } catch (err) {
      toast.error(err?.message || err?.response?.data?.detail || "Apply failed");
    } finally { setBusy(null); }
  };

  return (
    <div className="mt-8" data-testid="parent-import">
      <header className="mb-3">
        <h2 className="text-xl font-extrabold tracking-tight">Import Parents &amp; Guardians</h2>
        <p className="text-slate-500 text-sm mt-1">
          Bulk-update existing members with father / mother / guardian names &amp; contact numbers. The import is fuzzy — close spellings show up for you to confirm.
        </p>
      </header>

      <form onSubmit={runPreview} className="iu-card p-5 md:p-6 space-y-4">
        <div>
          <label className="iu-label">Parents .xlsx</label>
          <input
            data-testid="parents-file"
            type="file"
            accept=".xlsx"
            onChange={(e) => { setFile(e.target.files?.[0] || null); reset(); }}
            className="block w-full text-sm text-slate-700 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-emerald-700 file:text-white hover:file:bg-emerald-800"
          />
          <p className="text-[11px] text-slate-500 mt-1.5">Expected columns at row 2: S/No · Institution · Sailor Name · G · DOB · DOJ · Father Name · Father Contact · Mother Name · Mother Contact · Guardian Name · Guardian Contact.</p>
        </div>
        <button data-testid="parents-preview" type="submit" disabled={busy !== null || !file} title="Check the file first — nothing is saved until you apply" className="iu-btn-primary">
          {busy === "preview" ? <Loader2 className="animate-spin" size={14}/> : <Upload size={14}/>} Preview
        </button>
      </form>

      {preview && (
        <div className="mt-5 space-y-4" data-testid="parents-preview-result">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <SummaryTile color="emerald" value={preview.matched_count}     label="Exact matches" />
            <SummaryTile color="amber"   value={preview.suggestion_count}  label="Need spelling review" />
            <SummaryTile color="rose"    value={preview.unmatched_count}   label="No candidate found" />
            <SummaryTile color="slate"   value={preview.skipped_count}     label="Skipped (blank)" />
          </div>

          {preview.suggestions.length > 0 && (
            <div className="iu-card">
              <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
                <AlertTriangle className="text-amber-600" size={16}/>
                <h3 className="font-bold text-sm">Spelling review — {preview.suggestions.length} {preview.suggestions.length === 1 ? "row" : "rows"}</h3>
                <span className="ml-auto text-[11px] text-slate-500">Pick the best match. Choose whose spelling to keep.</span>
              </div>
              <div className="divide-y divide-slate-100 max-h-[60vh] overflow-y-auto">
                {preview.suggestions.map((s) => {
                  const d = decisions[s.row] || {};
                  return (
                    <div key={`sugg-${s.row}-${s.sailor_name}`} className="p-4 space-y-2" data-testid={`sugg-row-${s.row}`}>
                      <div className="text-sm">
                        <span className="text-slate-400 text-xs mr-2">row {s.row}</span>
                        <span className="font-semibold">From file:</span>{" "}
                        <span className="font-mono text-slate-700">{s.sailor_name}</span>
                      </div>
                      <div className="flex flex-col gap-1 ml-1">
                        {s.candidates.map((c) => {
                          const picked = d.member_id === c.member_id && !d.skip;
                          return (
                            <label key={c.member_id} className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer border ${picked ? "bg-emerald-50 border-emerald-300" : "bg-white border-slate-200 hover:bg-slate-50"}`}>
                              <input
                                type="radio"
                                name={`row-${s.row}`}
                                checked={picked}
                                onChange={() => setDecisions((p) => ({ ...p, [s.row]: { member_id: c.member_id, use_name: d.use_name || "member" } }))}
                                data-testid={`sugg-pick-${s.row}-${c.member_id}`}
                              />
                              <span className="font-mono text-sm flex-1">{c.member_name}</span>
                              <span className="text-[11px] font-bold text-slate-500">{Math.round(c.score * 100)}% similar</span>
                            </label>
                          );
                        })}
                        <label className={`flex items-center gap-2 p-2 rounded-lg cursor-pointer border ${d.skip ? "bg-slate-100 border-slate-300" : "bg-white border-slate-200 hover:bg-slate-50"}`}>
                          <input
                            type="radio"
                            name={`row-${s.row}`}
                            checked={!!d.skip}
                            onChange={() => setDecisions((p) => ({ ...p, [s.row]: { skip: true } }))}
                            data-testid={`sugg-skip-${s.row}`}
                          />
                          <span className="text-sm text-slate-600 italic">Skip this row</span>
                        </label>
                      </div>
                      {/* Which spelling to keep — only relevant once a candidate is picked. */}
                      {d.member_id && !d.skip && (
                        <div className="ml-1 mt-2 flex flex-wrap items-center gap-2 text-xs">
                          <span className="text-slate-500">Keep spelling:</span>
                          <button
                            type="button"
                            onClick={() => setDecisions((p) => ({ ...p, [s.row]: { ...p[s.row], use_name: "member" } }))}
                            className={`px-2 h-7 rounded-md border text-xs font-semibold ${(d.use_name || "member") === "member" ? "bg-slate-900 text-white border-transparent" : "bg-white border-slate-200 text-slate-700"}`}
                          >Existing (DB): {(s.candidates.find((c) => c.member_id === d.member_id) || {}).member_name}</button>
                          <button
                            type="button"
                            onClick={() => setDecisions((p) => ({ ...p, [s.row]: { ...p[s.row], use_name: "spreadsheet" } }))}
                            className={`px-2 h-7 rounded-md border text-xs font-semibold ${d.use_name === "spreadsheet" ? "bg-slate-900 text-white border-transparent" : "bg-white border-slate-200 text-slate-700"}`}
                          >From file: {s.sailor_name}</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {preview.unmatched.length > 0 && (
            <div className="iu-card">
              <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
                <AlertTriangle className="text-rose-600" size={16}/>
                <h3 className="font-bold text-sm">No similar member found ({preview.unmatched.length}) — these will be skipped</h3>
              </div>
              <ul className="px-5 py-3 text-sm space-y-1 max-h-60 overflow-y-auto">
                {preview.unmatched.map((u) => (
                  <li key={`unm-${u.row}-${u.sailor_name}`} className="flex justify-between gap-3">
                    <span className="text-slate-700">{u.sailor_name}</span>
                    <span className="text-slate-400 text-xs">row {u.row}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-2">
            <button data-testid="parents-apply" onClick={applyAll} disabled={busy !== null} title="Save the matched rows into the database" className="iu-btn-primary">
              {busy === "apply" ? <Loader2 className="animate-spin" size={14}/> : <CheckCircle2 size={14}/>}
              Apply import ({preview.matched_count + Object.values(decisions).filter((d) => d.member_id && !d.skip).length} rows)
            </button>
            <button onClick={runPreview} disabled={busy !== null} className="iu-btn-secondary">
              <Upload size={14}/> Re-preview
            </button>
          </div>

          {final && (
            <div className="iu-card p-4 bg-emerald-50 border border-emerald-200" data-testid="parents-applied">
              <div className="font-bold text-emerald-800 mb-1">Imported {final.matched_count} rows</div>
              <div className="text-sm text-emerald-700">Skipped: {final.skipped_count}. You can re-upload the file anytime to refresh.</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SummaryTile({ color, value, label }) {
  const tints = {
    emerald: "text-emerald-700",
    amber:   "text-amber-600",
    rose:    "text-rose-600",
    slate:   "text-slate-400",
  };
  return (
    <div className="iu-card p-4 text-center">
      <div className={`text-2xl font-extrabold ${tints[color] || "text-slate-700"}`}>{value}</div>
      <div className="text-xs uppercase tracking-wide text-slate-500 mt-1">{label}</div>
    </div>
  );
}
