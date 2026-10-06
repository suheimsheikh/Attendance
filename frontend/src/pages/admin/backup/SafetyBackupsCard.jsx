import React from "react";
import { Download, Loader2, ShieldCheck } from "lucide-react";

const fmtBytes = (n) => {
  if (!n) return "—";
  const mb = n / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
};
const fmtWhen = (iso) => {
  try { return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }); }
  catch { return iso; }
};

// Snapshots taken automatically right before each restore — restore one (Replace) to undo.
export const SafetyBackupsCard = ({ items, busy, onDownload }) => (
  <div className="iu-card p-5 mb-4 border-2 border-amber-200" style={{ background: "#FFFBEB" }} data-testid="pre-restore-backups-card">
    <div className="flex items-start gap-3">
      <div className="w-11 h-11 rounded-xl flex items-center justify-center bg-amber-500 text-white shrink-0 shadow-sm">
        <ShieldCheck size={20} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-bold text-slate-900 mb-1">Before-restore safety backups</div>
        <p className="text-sm text-slate-600 mb-3">
          Every restore first saves a full copy of the data as it was. To undo a restore, download
          the matching copy and restore it with <b>Replace</b>. The last <b>5</b> are kept.
        </p>
        {!items?.length ? (
          <div className="text-sm text-slate-500 italic" data-testid="pre-restore-empty">No restores yet — a safety copy appears here after the first one.</div>
        ) : (
          <ul className="divide-y divide-amber-100 rounded-lg border border-amber-100 bg-white/70">
            {items.map((b) => (
              <li key={b.slot} className="flex items-center justify-between gap-3 px-3 py-2" data-testid={`pre-restore-${b.slot}`}>
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-800 truncate">{b.filename}</div>
                  <div className="text-[11px] text-slate-500">
                    {fmtWhen(b.created_at)} · {fmtBytes(b.size)} · before <b>{b.mode}</b> restore of “{b.source_file}” by {b.by}
                  </div>
                </div>
                <button
                  onClick={() => onDownload(b.slot)}
                  disabled={busy === b.slot}
                  data-testid={`pre-restore-download-${b.slot}`}
                  className="iu-btn !bg-amber-600 hover:!bg-amber-700 !text-white shrink-0 !py-1.5 !px-3 text-xs"
                >
                  {busy === b.slot ? <Loader2 className="animate-spin" size={14} /> : <Download size={14} />}
                  Download
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  </div>
);
