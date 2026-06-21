import React, { useState } from "react";
import { Download, Upload, Loader2, AlertTriangle, CheckCircle2, Database, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { getToken } from "../../api";

/**
 * Master-only backup & restore. Downloads / uploads a tar.gz containing
 * users + institutions + office config — the bare minimum to bootstrap
 * a fresh deployment on Day 1 of a new term. Attendance, leaves and
 * device tokens are intentionally NOT included so each new term starts
 * with clean transactional history.
 */
export default function BackupRestore() {
  const [downloading, setDownloading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [mode, setMode] = useState("merge");
  const [file, setFile] = useState(null);
  const [report, setReport] = useState(null);
  const [wiping, setWiping] = useState(false);

  const wipeAttendance = async () => {
    if (!window.confirm("This will delete ALL attendance records (every check-in, check-out, and temp-exit history). Members, leaves, institutions and settings stay intact. Proceed?")) return;
    if (!window.confirm("Last check — are you sure you want to wipe every attendance record?")) return;
    setWiping(true);
    try {
      const token = getToken();
      const res = await fetch(`${process.env.REACT_APP_BACKEND_URL}/api/admin/attendance/wipe`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.detail || `HTTP ${res.status}`);
      toast.success(`Deleted ${json.deleted} attendance records`);
    } catch (err) {
      toast.error(err?.message || "Wipe failed");
    } finally {
      setWiping(false);
    }
  };

  const downloadBackup = async () => {
    setDownloading(true);
    try {
      const token = getToken();
      const url = `${process.env.REACT_APP_BACKEND_URL}/api/admin/backup`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      // Pull filename from server header if present
      const disp = res.headers.get("Content-Disposition") || "";
      const m = disp.match(/filename="?([^"]+)"?/);
      const fname = m ? m[1] : `ych-master-${new Date().toISOString().slice(0,10)}.tar.gz`;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(a.href);
      toast.success("Backup downloaded");
    } catch (err) {
      toast.error(err?.message || "Backup failed");
    } finally {
      setDownloading(false);
    }
  };

  const upload = async () => {
    if (!file) { toast.error("Choose a backup file first"); return; }
    if (mode === "replace" && !window.confirm("REPLACE mode wipes ALL current users, institutions, and office settings before loading the backup. This includes admin accounts. Are you absolutely sure?")) return;
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
      const json = await res.json();
      if (!res.ok) throw new Error(json.detail || `HTTP ${res.status}`);
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
          <h1 className="text-2xl font-extrabold tracking-tight">Backup & Restore</h1>
          <p className="text-sm text-slate-500">Master data only — users, institutions, office settings.</p>
        </div>
      </div>

      <div className="iu-card p-5 mb-4 border-2 border-emerald-200" style={{ background: "#ECFDF5" }}>
        <div className="flex items-start gap-3">
          <div className="w-11 h-11 rounded-xl flex items-center justify-center bg-emerald-600 text-white shrink-0 shadow-sm">
            <Download size={20} />
          </div>
          <div className="flex-1">
            <div className="font-bold text-slate-900 mb-1">Download backup</div>
            <p className="text-sm text-slate-600 mb-3">
              Saves a single <code className="text-xs bg-white px-1.5 py-0.5 rounded border">.tar.gz</code> with every member (with their photos &amp; parent contacts),
              every institution, and the office settings. Attendance / leaves are NOT included &mdash; this is
              meant to bootstrap a fresh term with a clean slate of transactional data.
            </p>
            <button
              onClick={downloadBackup}
              disabled={downloading}
              data-testid="br-download"
              title="Download a master-data backup (.tar.gz)"
              className="iu-btn-primary !bg-emerald-600 hover:!bg-emerald-700"
            >
              {downloading ? <Loader2 className="animate-spin" size={16} /> : <Download size={16} />}
              {downloading ? "Preparing…" : "Download backup"}
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
            <div className="font-bold text-slate-900 mb-1">Restore from backup</div>
            <p className="text-sm text-slate-600 mb-3">
              Upload a <code className="text-xs bg-white px-1.5 py-0.5 rounded border">.tar.gz</code> created by this page.
              Use <b>Merge</b> on a live deployment (safest); use <b>Replace</b> only when you really mean to wipe everything first.
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
                <label className="flex items-center gap-2 text-sm cursor-pointer text-rose-700">
                  <input type="radio" name="mode" value="replace" checked={mode === "replace"} onChange={() => setMode("replace")} data-testid="br-mode-replace" />
                  <span className="font-semibold">Replace</span>
                  <span className="opacity-80">(wipe + reload)</span>
                </label>
              </div>
              {mode === "replace" && (
                <div className="flex gap-2 items-start p-3 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-900">
                  <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                  <span>Replace mode <b>deletes all current users, institutions and office settings</b> before loading the backup. Make sure the file you&apos;re uploading really is the source of truth.</span>
                </div>
              )}
              <button
                onClick={upload}
                disabled={uploading || !file}
                data-testid="br-restore"
                title="Restore master data from the selected backup file"
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

      {/* Danger zone — wipe every attendance record for a clean slate. */}
      <div className="iu-card p-5 mt-6 border-2 border-rose-300" style={{ background: "#FFF1F2" }}>
        <div className="flex items-start gap-3">
          <div className="w-11 h-11 rounded-xl flex items-center justify-center bg-rose-600 text-white shrink-0 shadow-sm">
            <Trash2 size={20} />
          </div>
          <div className="flex-1">
            <div className="font-bold text-rose-900 mb-1">Danger zone — wipe attendance</div>
            <p className="text-sm text-rose-800 mb-3">
              Deletes <b>every</b> attendance record (check-ins, check-outs, temp-exits). Members, leaves, institutions and settings are NOT touched.
              Useful when starting a fresh term or after restoring master data on a new deployment.
            </p>
            <button
              onClick={wipeAttendance}
              disabled={wiping}
              data-testid="br-wipe-attendance"
              title="Permanently delete every attendance record"
              className="iu-btn-primary !bg-rose-600 hover:!bg-rose-700"
            >
              {wiping ? <Loader2 className="animate-spin" size={16} /> : <Trash2 size={16} />}
              {wiping ? "Wiping…" : "Wipe all attendance"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
