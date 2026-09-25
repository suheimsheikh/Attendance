/**
 * Masters — single home for every "master" data screen (Jun 2026
 * consolidation). Manage Members, Institutions, Fleets, Categories and
 * Roles are now tabs here instead of five separate sidebar entries.
 *
 * Each tab renders the existing page component as-is (they keep their
 * own layout + data fetching). ?tab= deep-links stay stable on refresh.
 */
import React, { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Users, Building2, Sailboat, ShieldAlert, KeyRound } from "lucide-react";
import Members from "./Members";
import Institutions from "./Institutions";
import Fleets from "./Fleets";
import Categories from "./Categories";
import Roles from "./Roles";

const TABS = [
  { key: "members",      label: "Manage Members", Icon: Users,       Comp: Members },
  { key: "institutions", label: "Institutions",   Icon: Building2,   Comp: Institutions },
  { key: "fleets",       label: "Fleets",         Icon: Sailboat,    Comp: Fleets },
  { key: "categories",   label: "Categories",     Icon: ShieldAlert, Comp: Categories },
  { key: "roles",        label: "Roles",          Icon: KeyRound,    Comp: Roles },
];

export default function Masters() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlTab = searchParams.get("tab");
  const active = TABS.find((t) => t.key === urlTab) ? urlTab : "members";

  useEffect(() => {
    if (!urlTab || !TABS.find((t) => t.key === urlTab)) {
      const next = new URLSearchParams(searchParams);
      next.set("tab", "members");
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeTab = (key) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", key);
    setSearchParams(next, { replace: false });
  };

  const ActiveComp = (TABS.find((t) => t.key === active) || TABS[0]).Comp;

  return (
    <div data-testid="masters-page">
      <div className="px-4 md:px-8 pt-4 md:pt-6">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight mb-3">Masters</h1>
        <div className="flex flex-wrap gap-2 border-b border-slate-200 pb-3" data-testid="masters-tabs">
          {TABS.map(({ key, label, Icon }) => (
            <button
              key={key}
              onClick={() => changeTab(key)}
              className={`inline-flex items-center gap-2 h-9 px-3.5 rounded-lg text-sm font-semibold transition-colors ${
                active === key ? "bg-blue-600 text-white shadow-sm" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
              data-testid={`masters-tab-${key}`}
            >
              <Icon size={15} />{label}
            </button>
          ))}
        </div>
      </div>
      <div data-testid={`masters-panel-${active}`}>
        <ActiveComp />
      </div>
    </div>
  );
}
