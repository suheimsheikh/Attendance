import React from "react";
import { Link } from "react-router-dom";
import { MessageSquare, FileClock, Settings, ArrowRight, Info } from "lucide-react";
import AbsentShareBanner from "./muster/AbsentShareBanner";
import LateArrivalsBanner from "./muster/LateArrivalsBanner";
import { useAuth } from "../auth";

/**
 * Parent Notifications — a dedicated home for the one-tap WhatsApp parent
 * alerts (absent-without-info + late arrivals). Same data + ✓ tracking as
 * the banners on the Muster page, gathered in one place for coaches/admins.
 */
export default function ParentNotifications() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto" data-testid="parent-notifications-page">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight flex items-center gap-2">
            <MessageSquare size={24} className="text-emerald-600" /> Parent Notifications
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Message parents / guardians on WhatsApp about today's absent and late athletes — one tap each,
            in Telugu + English. Every send is logged.
          </p>
        </div>
        <Link to="/admin/notify-log" className="iu-btn-secondary" data-testid="parent-notifications-log-link">
          <FileClock size={15} /> View log <ArrowRight size={14} />
        </Link>
      </header>

      <AbsentShareBanner defaultExpanded />
      <LateArrivalsBanner defaultExpanded />

      <div className="iu-card p-4 flex gap-3 text-sm text-slate-600 mt-2" data-testid="parent-notifications-help">
        <Info size={18} className="text-slate-400 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p><b>Absent</b> alerts appear once the day's reporting time (plus grace) has passed — so athletes who simply haven't arrived yet aren't flagged.</p>
          <p><b>Late</b> alerts appear as soon as an athlete checks in after their reporting time.</p>
          <p>A parent button (F / M / G) shows only when that number is on file. Tapping opens WhatsApp with the message ready; it turns to a ✓ once sent (shared across everyone).</p>
          {isAdmin && (
            <p className="pt-1">
              <Link to="/admin/office" className="text-sky-600 font-semibold inline-flex items-center gap-1">
                <Settings size={13} /> Edit the message wording
              </Link>{" "}in Office Settings → "WhatsApp Parent Messages".
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
