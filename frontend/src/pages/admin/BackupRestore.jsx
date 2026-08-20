import React, { useState } from "react";
import { Download, Upload, Loader2, AlertTriangle, CheckCircle2, Database } from "lucide-react";
import { toast } from "sonner";
import { getToken } from "../../api";

/**
 * Full-database backup & restore. Downloads / uploads a tar.gz containing
 * EVERY collection (users, attendance, leaves, institutions, config, devices,
 * parent_notifications, camps, regattas, guests, daily_content, sms_log).
 * Designed for moving data back and forth between prod ↔ preview deployments.
 */
export default function BackupRestore() {
  const [downloading, setDownloading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [mode, setMode] = useState("merge");
  const [file, setFile] = useState(null);
  const [report, setReport] = useState(null);

  // Safety guard: forbid Replace mode on the production host. Replace wipes
  // every collection before loading — a slip of the click here would erase
  // live data. Preview/dev hosts keep the option available.
  const isProduction = typeof window !== "undefined" &&
    /(^|\.)i-showed-up\.ychyderabad\.com$/i.test(window.location.hostname);

  const downloadBackup = async () => {
    setDownloading(true);
    try {
      const token = getToken();
      const url = `${process.env.REACT_APP_BACKEND_URL}/api/admin/backup`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const disp = res.headers.get("Content-Disposition") || "";
      const m = disp.match(/filename="?([^"]+)"?/);
      const fname = m ? m[1] : `ych-full-${new Date().toISOString().slice(0,10)}.tar.gz`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      toast.success("Full backup downloaded");
    } catch (err) {
      toast.error(err?.message || "Backup failed");
    } finally {
      setDownloading(false);
    }
  };

  const upload = async () => {
    if (!file) { toast.error("Choose a backup file first"); return; }
    if (mode === "replace" && isProduction) {
      toast.error("Replace mode is disabled on production. Use Merge, or run Replace on the preview environment.");
      return;
    }
    if (mode === "replace" && !window.confirm("REPLACE mode wipes EVERY collection (users, attendance, leaves, devices, settings, …) before loading the backup. This includes admin accounts. Are you absolutely sure?")) return;
    setUploading(true);
    setReport(null);
    try {
      const token = getToken();
      const fd = new FormData();
      fd.append("file", file);
      const url = `${process.env.REACT_APP_BACKEND_URL}/api/admin/restore?mode=${mode}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      // Read the body as text first, then try JSON — so a 500 that
      // returns HTML "Internal Server Error" (or a proxy timeout page)
      // shows a readable message instead of crashing with "Unexpected
      // token 'I', Internal S... is not valid JSON".
      const raw = await res.text();
      let json;
      try { json = raw ? JSON.parse(raw) : {}; }
      catch { json = null; }
      if (!res.ok) {
        const detail = json?.detail || (raw && raw.slice(0, 200)) || `HTTP ${res.status}`;
        throw new Error(detail);
      }
      if (!json) throw new Error("Server returned an unreadable response.");
      setReport(json);
      const total = Object.values(json.inserted || {}).reduce((s, n) => s + n, 0);
      toast.success(`Restored ${total} document${total === 1 ? "" : "s"} (${mode} mode)`);
    } catch (err) {
      toast.error(err?.message || "Restore failed");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto p-4">
      <div className="flex items-center gap-3 mb-6">
        <Database className="text-indigo-600" size={28} />
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Full Data Backup &amp; Restore</h1>
          <p className="text-sm text-slate-500">Move the entire database between production and preview.</p>
        </div>
      </div>

      <div className="iu-card p-5 mb-4 border-2 border-emerald-200" style={{ background: "#ECFDF5" }}>
        <div className="flex items-start gap-3">
          <div className="w-11 h-11 rounded-xl flex items-center justify-center bg-emerald-600 text-white shrink-0 shadow-sm">
            <Download size={20} />
          </div>
          <div className="flex-1">
            <div className="font-bold text-slate-900 mb-1">Download full backup</div>
            <p className="text-sm text-slate-600 mb-3">
              Saves a single <code className="text-xs bg-white px-1.5 py-0.5 rounded border">.tar.gz</code>
              containing every collection &mdash; members (with photos &amp; parent contacts), institutions,
              office settings, sites, roles, categories, devices, attendance, leaves, corrections,
              camps, regattas, guests, holidays, escorts, daily content, SMS log, parent notifications,
              audit log, and the full pantry &mdash; masters, purchases, issues, wastage, and daily meal counts.
              Suitable for cloning the entire deployment to another environment.
            </p>
            <button
              onClick={downloadBackup}
              disabled={downloading}
              data-testid="br-download"
              className="iu-btn-primary !bg-emerald-600 hover:!bg-emerald-700"
            >
              {downloading ? <Loader2 className="animate-spin" size={16} /> : <Download size={16} />}
              {downloading ? "Preparing…" : "Download full backup"}
            </button>
          </div>
        </div>
      </div>

      <div className="iu-card p-5 mb-4 border-2 border-sky-200" style={{ background: "#F0F9FF" }}>
        <div className="flex items-start gap-3">
          <div className="w-11 h-11 rounded-xl flex items-center justify-center bg-sky-600 text-white shrink-0 shadow-sm">
            <Upload size={20} />
          </div>
          <div className="flex-1">
            <div className="font-bold text-slate-900 mb-1">Restore from full backup</div>
            <p className="text-sm text-slate-600 mb-3">
              Upload a <code className="text-xs bg-white px-1.5 py-0.5 rounded border">.tar.gz</code> created by this page.
              Use <b>Merge</b> on a live deployment (safest &mdash; only new docs are added).
              Use <b>Replace</b> to make this environment an exact mirror of the source (wipes every collection first).
            </p>
            <div className="space-y-3">
              <input
                type="file"
                accept=".tar.gz,.tgz,application/gzip"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
                data-testid="br-file"
                className="block text-sm w-full file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-sky-600 file:text-white file:font-semibold hover:file:bg-sky-700"
              />
              <div className="flex gap-3">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name="mode" value="merge" checked={mode === "merge"} onChange={() => setMode("merge")} data-testid="br-mode-merge" />
                  <span className="font-semibold">Merge</span>
                  <span className="text-slate-500">(insert only new docs)</span>
                </label>
                <label className={`flex items-center gap-2 text-sm ${isProduction ? "cursor-not-allowed opacity-50" : "cursor-pointer text-rose-700"}`}>
                  <input
                    type="radio"
                    name="mode"
                    value="replace"
                    checked={mode === "replace"}
                    onChange={() => setMode("replace")}
                    disabled={isProduction}
                    data-testid="br-mode-replace"
                  />
                  <span className="font-semibold">Replace</span>
                  <span className="opacity-80">(wipe + reload everything)</span>
                </label>
              </div>
              {isProduction && (
                <div className="flex gap-2 items-start p-3 rounded-lg bg-amber-50 border border-amber-300 text-sm text-amber-900" data-testid="br-prod-guard">
                  <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                  <span><b>Production safety guard:</b> Replace mode is disabled on this host (<code>i-showed-up.ychyderabad.com</code>) to prevent an accidental wipe. To use Replace, run it on the preview environment.</span>
                </div>
              )}
              {mode === "replace" && (
                <div className="flex gap-2 items-start p-3 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-900">
                  <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                  <span>Replace mode <b>deletes every collection in this database</b> (users, attendance, leaves, devices, settings, &hellip;) before loading the backup. Make absolutely sure the file you&apos;re uploading is the source of truth.</span>
                </div>
              )}
              <button
                onClick={upload}
                disabled={uploading || !file}
                data-testid="br-restore"
                className="iu-btn-primary !bg-sky-600 hover:!bg-sky-700"
              >
                {uploading ? <Loader2 className="animate-spin" size={16} /> : <Upload size={16} />}
                {uploading ? "Restoring…" : "Restore now"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {report && (
        <div className="iu-card p-4 border-2 border-emerald-300" data-testid="br-report">
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle2 size={18} className="text-emerald-600" />
            <span className="font-bold">Restore complete · {report.mode} mode</span>
          </div>
          <ul className="text-sm space-y-1">
            {Object.entries(report.inserted || {}).map(([name, n]) => (
              <li key={name} className="flex justify-between border-b border-slate-100 pb-1">
                <span className="font-mono text-slate-600">{name}</span>
                <span className="font-bold text-emerald-700">+{n}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
