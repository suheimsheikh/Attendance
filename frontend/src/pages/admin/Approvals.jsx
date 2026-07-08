import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plane, ClipboardCheck, Camera } from "lucide-react";
import { api } from "../../api";
import AdminLeaves from "./Leaves";
import Overtime from "./Overtime";
import CheckinApprovals from "./CheckinApprovals";

/**
 * Single landing page for ALL pending approvals — leaves/tours/comp-off,
 * overtime, AND check-ins (late or off-geofence) since 8 Jul 2026 —
 * surfaced as three tabs so admins have one place to clear their queue
 * instead of jumping between sidebar items. The tab state lives in the
 * URL (`?tab=leaves|overtime|checkins`) so direct links from the
 * dashboard / alert banners can deep-link straight into the right tab.
 */
export default function Approvals() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab = raw === "overtime" ? "overtime"
             : raw === "checkins" ? "checkins"
             : "leaves";
  const setTab = (t) => {
    const next = new URLSearchParams(params);
    next.set("tab", t);
    setParams(next, { replace: true });
  };

  // Badge counts on each tab — one round-trip to the consolidated
  // /approvals-summary endpoint, refreshed every 60 s so admins see new
  // requests without manually refreshing.
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const s = await api.get("/admin/approvals-summary");
        if (!cancelled) setSummary(s);
      } catch (err) {
        console.debug("Approvals summary fetch failed:", err);
      }
    };
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const tabs = [
    { key: "leaves",   label: "Leave / Tour / Comp Off", Icon: Plane,           badge: summary?.leaves },
    { key: "overtime", label: "Overtime",                Icon: ClipboardCheck,  badge: summary?.overtime },
    { key: "checkins", label: "Check-ins",               Icon: Camera,          badge: summary?.checkins },
  ];

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto" data-testid="approvals-page">
      <header className="mb-5">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Approvals</h1>
        <p className="text-slate-500 text-sm mt-1">One queue for every pending request — leaves, tours, comp-offs and overtime.</p>
      </header>

      <div className="iu-card p-1.5 mb-5 inline-flex gap-1" data-testid="approvals-tabs">
        {tabs.map((t) => {
          const active = tab === t.key;
          const showBadge = typeof t.badge === "number" && t.badge > 0;
          return (
            <button
              key={t.key}
              data-testid={`approvals-tab-${t.key}`}
              onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-2 px-4 h-10 rounded-lg text-sm font-semibold transition ${
                active
                  ? "bg-slate-900 text-white shadow-sm"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              <t.Icon size={16} />
              {t.label}
              {showBadge && (
                <span
                  className={`min-w-[22px] h-5 px-1.5 rounded-full text-[11px] font-bold flex items-center justify-center ${
                    active ? "bg-white/20 text-white" : "bg-amber-100 text-amber-800"
                  }`}
                >
                  {t.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Each child still owns its own filters / table. Wrapper container keeps
          spacing consistent and gives them a clean canvas without duplicate
          page-level chrome. */}
      <div data-testid={`approvals-tab-content-${tab}`}>
        {tab === "leaves" && <AdminLeaves embedded />}
        {tab === "overtime" && <Overtime embedded />}
        {tab === "checkins" && <CheckinApprovals />}
      </div>
    </div>
  );
}
