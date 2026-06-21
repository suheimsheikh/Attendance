import React, { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ClipboardList, ClipboardCheck, CalendarCheck2 } from "lucide-react";
import AdminLeaves from "./Leaves";
import Overtime from "./Overtime";
import LeaveBalances from "./LeaveBalances";

const TABS = [
  { key: "requests", label: "Requests", icon: ClipboardList, tip: "Approve leave/tour/comp-off requests & apply on behalf" },
  { key: "overtime", label: "Overtime", icon: ClipboardCheck, tip: "Review and approve overtime hours" },
  { key: "balances", label: "Balances", icon: CalendarCheck2, tip: "Leave & comp-off balances per member" },
];

export default function LeaveManagement() {
  // Seed the active tab from the URL once (so deep-link redirects like
  // ?tab=balances land correctly). Kept in local state afterwards because some
  // child screens (Overtime) rewrite the URL search params for their own
  // filters, which would otherwise reset the tab.
  const [params] = useSearchParams();
  const initial = TABS.some((t) => t.key === params.get("tab")) ? params.get("tab") : "requests";
  const [active, setActive] = useState(initial);

  return (
    <div data-testid="leave-management">
      <div className="px-4 md:px-8 pt-4 md:pt-8 max-w-6xl mx-auto">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Leave &amp; Overtime</h1>
        <p className="text-slate-500 text-sm mt-1">Requests, overtime and balances — all in one place.</p>
        <div className="flex gap-2 overflow-x-auto mt-4">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                data-testid={`lm-tab-${t.key}`}
                onClick={() => setActive(t.key)}
                title={t.tip}
                className={`iu-chip whitespace-nowrap shrink-0 flex items-center gap-1.5 ${active === t.key ? "iu-chip-active" : ""}`}
              >
                <Icon size={14} /> {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="-mt-2" data-testid={`lm-panel-${active}`}>
        {active === "requests" && <AdminLeaves />}
        {active === "overtime" && <Overtime />}
        {active === "balances" && <LeaveBalances />}
      </div>
    </div>
  );
}
