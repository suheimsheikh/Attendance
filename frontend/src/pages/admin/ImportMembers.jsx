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
          <button data-testid="import-submit" type="submit" disabled={busy || !file} className="iu-btn-primary">
            {busy ? <Loader2 className="animate-spin" size={14}/> : <Upload size={14}/>} Upload
          </button>
          <button data-testid="import-template" type="button" onClick={downloadTemplate} className="iu-btn-secondary">
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
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!file) { toast.error("Pick the parents .xlsx first"); return; }
    setBusy(true);
    try {
      const res = await uploadFile("/members/import-parents", file);
      setResult(res);
      toast.success(`Parents imported — ${res.updated_count} matched, ${res.unmatched_count} unmatched`);
    } catch (err) {
      toast.error(err?.message || err?.response?.data?.detail || "Upload failed");
    } finally { setBusy(false); }
  };

  return (
    <div className="mt-8" data-testid="parent-import">
      <header className="mb-3">
        <h2 className="text-xl font-extrabold tracking-tight">Import Parents &amp; Guardians</h2>
        <p className="text-slate-500 text-sm mt-1">
          Bulk-update existing members with father / mother / guardian names &amp; contact numbers. Match key is the <strong>sailor name</strong>. Idempotent — safe to re-run after fixing unmatched rows.
        </p>
      </header>
      <form onSubmit={submit} className="iu-card p-5 md:p-6 space-y-4">
        <div>
          <label className="iu-label">Parents .xlsx</label>
          <input
            data-testid="parents-file"
            type="file"
            accept=".xlsx"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="block w-full text-sm text-slate-700 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-emerald-700 file:text-white hover:file:bg-emerald-800"
          />
          <p className="text-[11px] text-slate-500 mt-1.5">Expected columns: S/No · Institution · Sailor Name · G · DOB · DOJ · Father Name · Father Contact · Mother Name · Mother Contact · Guardian Name · Guardian Contact (header row at row 2).</p>
        </div>
        <button data-testid="parents-submit" type="submit" disabled={busy || !file} className="iu-btn-primary">
          {busy ? <Loader2 className="animate-spin" size={14}/> : <Upload size={14}/>} Import parents
        </button>
      </form>

      {result && (
        <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="iu-card p-4 text-center">
            <div className="text-2xl font-extrabold text-emerald-700">{result.updated_count}</div>
            <div className="text-xs uppercase tracking-wide text-slate-500 mt-1">Matched &amp; updated</div>
          </div>
          <div className="iu-card p-4 text-center">
            <div className="text-2xl font-extrabold text-amber-600">{result.unmatched_count}</div>
            <div className="text-xs uppercase tracking-wide text-slate-500 mt-1">Unmatched names</div>
          </div>
          <div className="iu-card p-4 text-center">
            <div className="text-2xl font-extrabold text-slate-400">{result.skipped_count}</div>
            <div className="text-xs uppercase tracking-wide text-slate-500 mt-1">Skipped (blank)</div>
          </div>

          {result.unmatched?.length > 0 && (
            <div className="iu-card md:col-span-3">
              <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
                <AlertTriangle className="text-amber-600" size={16}/>
                <h3 className="font-bold text-sm">Unmatched names — fix the source file &amp; re-run</h3>
              </div>
              <ul className="px-5 py-3 text-sm space-y-1 max-h-72 overflow-y-auto">
                {result.unmatched.map((u, i) => (
                  <li key={i} className="flex justify-between gap-3">
                    <span className="text-slate-700">{u.sailor_name}</span>
                    <span className="text-slate-400 text-xs">row {u.row}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
