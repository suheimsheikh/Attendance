import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, X, ArrowRight } from "lucide-react";
import { api } from "../api";

// Session-dismiss so it doesn't nag on every dashboard visit once acknowledged.
let DISMISSED = false;

/**
 * BackupReminderBanner — amber nudge on the admin dashboard when the last
 * full backup (manual or the nightly auto-backup) is older than 7 days.
 */
export default function BackupReminderBanner() {
  const [info, setInfo] = useState(null);
  const [hidden, setHidden] = useState(DISMISSED);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await api.get("/admin/backup-status");
        if (alive) setInfo(s);
      } catch { /* non-blocking */ }
    })();
    return () => { alive = false; };
  }, []);

  if (hidden || !info?.stale) return null;

  const when = info.last_backup_at
    ? new Date(info.last_backup_at).toLocaleDateString("en-GB", { dateStyle: "medium" })
    : null;
  const ago = info.days_since != null ? `${info.days_since} days ago` : "a while ago";

  return (
    <div
      className="mb-4 flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3"
      data-testid="backup-reminder-banner"
    >
      <AlertTriangle size={18} className="text-amber-600 mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0 text-sm text-amber-900">
        <span className="font-bold">Backup is overdue.</span>{" "}
        {when ? `Last full backup was ${when} (${ago}).` : "No full backup has been taken yet."}{" "}
        Nightly auto-backups run at 2 AM IST, but you can grab one now.
        <Link
          to="/admin/backup"
          data-testid="backup-reminder-link"
          className="ml-2 inline-flex items-center gap-1 font-semibold text-amber-800 underline hover:text-amber-900"
        >
          Go to Backup <ArrowRight size={13} />
        </Link>
      </div>
      <button
        type="button"
        data-testid="backup-reminder-dismiss"
        onClick={() => { DISMISSED = true; setHidden(true); }}
        className="p-1 -mr-1 rounded-lg text-amber-500 hover:bg-amber-100 hover:text-amber-700"
        title="Dismiss"
      >
        <X size={16} />
      </button>
    </div>
  );
}
