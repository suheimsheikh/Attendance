import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { api } from "../api";

/**
 * Two action banners admins see when overtime or comp-off entries are
 * waiting for review. Renders nothing when both queues are empty so it
 * stays out of the way on a normal day. Visible only to admins — the
 * caller is responsible for gating by role.
 */
export default function AdminOvertimeBanners() {
  const [data, setData] = useState(null);
  useEffect(() => {
    api.get("/admin/overtime/needs-review").then(setData).catch(() => {});
  }, []);
  if (!data) return null;
  const otPending = data.total_pending || 0;
  const coPending = data.comp_off_pending || 0;
  if (!otPending && !coPending) return null;
  return (
    <div className="space-y-3 mb-4" data-testid="ot-banners">
      {otPending > 0 && (
        <Link
          to={`/admin/approvals?tab=overtime&status=pending${data.yesterday ? `&from=${data.yesterday}&to=${data.yesterday}` : ""}`}
          className="block iu-card p-4 border-2 border-amber-300 bg-amber-50 hover:bg-amber-100 transition"
          data-testid="overtime-banner"
        >
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-full bg-amber-200 text-amber-800 flex items-center justify-center shrink-0">
              <AlertTriangle size={20} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-extrabold text-amber-900">
                {data.yesterday_count > 0
                  ? `${data.yesterday_count} overtime ${data.yesterday_count === 1 ? "entry" : "entries"} from yesterday need your review`
                  : `${otPending} pending overtime ${otPending === 1 ? "entry" : "entries"} to review`}
              </div>
              <div className="text-xs text-amber-800 mt-0.5">Tap to approve or reject with a note.</div>
            </div>
            <ChevronRight size={20} className="text-amber-700 shrink-0" />
          </div>
        </Link>
      )}
      {coPending > 0 && (
        <Link
          to="/admin/approvals?tab=leaves&type=comp_off"
          className="block iu-card p-4 border-2 border-violet-300 bg-violet-50 hover:bg-violet-100 transition"
          data-testid="comp-off-banner"
        >
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-full bg-violet-200 text-violet-800 flex items-center justify-center shrink-0">
              <AlertTriangle size={20} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-extrabold text-violet-900">
                {coPending} comp-off {coPending === 1 ? "request" : "requests"} awaiting decision
              </div>
              <div className="text-xs text-violet-800 mt-0.5">Tap to review and approve / reject.</div>
            </div>
            <ChevronRight size={20} className="text-violet-700 shrink-0" />
          </div>
        </Link>
      )}
    </div>
  );
}
