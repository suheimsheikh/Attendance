import React, { useState } from "react";
import SmsLog from "./SmsLog";
import NotifyLog from "./NotifyLog";
import AuditLog from "./AuditLog";

// Combined Logs surface — the three separate log screens (Audit / SMS /
// Parent Notify) now live behind one tabbed page to keep the sidebar tidy.
const TABS = [
  { key: "audit", label: "Audit Log", Comp: AuditLog },
  { key: "sms", label: "SMS Log", Comp: SmsLog },
  { key: "notify", label: "Parent Notify Log", Comp: NotifyLog },
];

export default function Logs() {
  const [tab, setTab] = useState("audit");
  const Active = (TABS.find((t) => t.key === tab) || TABS[0]).Comp;
  return (
    <div data-testid="logs-page">
      <div className="px-4 md:px-8 pt-4 md:pt-6">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight mb-3">Logs</h1>
        <div className="flex items-center gap-1 border-b border-slate-200">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              data-testid={`logs-tab-${t.key}`}
              onClick={() => setTab(t.key)}
              className={`px-4 py-2 text-sm font-semibold -mb-px border-b-2 transition ${
                tab === t.key
                  ? "border-slate-900 text-slate-900"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <Active />
    </div>
  );
}
