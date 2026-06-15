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
                {result.created.map((c, i) => (
                  <li key={i} className="px-5 py-2">
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
                {result.errors.map((e, i) => (
                  <li key={i} className="px-5 py-2"><span className="text-xs text-slate-400">Row {e.row}: </span>{e.reason}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
