/**
 * Chef's View — one-glance meal-planning page.
 *
 * Big bold colored tickets show counts per category (Elite / Athletes /
 * Coaches / Staff / Executives / Total) for members who checked in
 * before the meal cut-off (default 07:00 office-local). A search-able
 * drill-down below lists every eligible member with photo + name +
 * check-in time, so the chef can print the list.
 *
 * Backend: GET /api/admin/meals-today?date=YYYY-MM-DD&cutoff=HH:MM
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Printer, Search, ChefHat, CalendarDays, Clock } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import Avatar from "../../components/Avatar";

// Tailwind can't compile arbitrary class names built via string concat, so
// we map the color key (from the categories master) to fully-spelled-out
// class strings up front. Keep this list in sync with the seed in
// server._seed_database's _CATEGORY_SEED block.
const TICKET_STYLE = {
  sky:     { card: "bg-sky-500 text-white",     accent: "bg-sky-600",     ring: "ring-sky-300" },
  rose:    { card: "bg-rose-500 text-white",    accent: "bg-rose-600",    ring: "ring-rose-300" },
  emerald: { card: "bg-emerald-500 text-white", accent: "bg-emerald-600", ring: "ring-emerald-300" },
  amber:   { card: "bg-amber-500 text-white",   accent: "bg-amber-600",   ring: "ring-amber-300" },
  violet:  { card: "bg-violet-500 text-white",  accent: "bg-violet-600",  ring: "ring-violet-300" },
  slate:   { card: "bg-slate-800 text-white",   accent: "bg-slate-900",   ring: "ring-slate-400" },
};

const CATEGORY_BADGE = {
  sky:     "bg-sky-100 text-sky-800 border-sky-200",
  rose:    "bg-rose-100 text-rose-800 border-rose-200",
  emerald: "bg-emerald-100 text-emerald-800 border-emerald-200",
  amber:   "bg-amber-100 text-amber-800 border-amber-200",
  violet:  "bg-violet-100 text-violet-800 border-violet-200",
  slate:   "bg-slate-100 text-slate-800 border-slate-200",
};

function todayIso() {
  return new Date().toLocaleDateString("sv-SE");   // YYYY-MM-DD, local
}

function fmtCheckIn(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export default function ChefsView() {
  const [date, setDate] = useState(todayIso());
  const [cutoff, setCutoff] = useState("07:00");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get(`/admin/meals-today?date=${date}&cutoff=${cutoff}`);
      setData(r);
    } catch (err) {
      toast.error(err?.message || "Failed to load meals data");
    } finally {
      setLoading(false);
    }
  }, [date, cutoff]);

  useEffect(() => { load(); }, [load]);

  const cats = data?.categories || [];
  const counts = data?.counts || {};
  const membersRaw = data?.members || [];

  const filteredMembers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return membersRaw;
    return membersRaw.filter((m) =>
      (m.full_name || "").toLowerCase().includes(q) ||
      (m.institution || "").toLowerCase().includes(q) ||
      (m.fleet || "").toLowerCase().includes(q)
    );
  }, [membersRaw, search]);

  // Group filtered members by category for the drill-down.
  const groupedMembers = useMemo(() => {
    const groups = new Map();
    for (const c of cats) groups.set(c.key, []);
    for (const m of filteredMembers) {
      if (!groups.has(m.category)) groups.set(m.category, []);
      groups.get(m.category).push(m);
    }
    return groups;
  }, [filteredMembers, cats]);

  const total = data?.total ?? 0;
  const filteredTotal = filteredMembers.length;

  return (
    <div className="p-4 md:p-6 max-w-[1400px] mx-auto" data-testid="chefs-view-page">
      {/* Header + controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-xl bg-orange-100">
            <ChefHat size={22} className="text-orange-700" />
          </div>
          <div>
            <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight text-slate-900" data-testid="chefs-heading">
              Chef&apos;s View
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Meal count for members who checked in on or before the cut-off.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-1.5 h-9 px-2 rounded-lg border border-slate-200 bg-white text-sm">
            <CalendarDays size={14} className="text-slate-400" />
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="outline-none bg-transparent"
              data-testid="chefs-date-input"
            />
          </label>
          <label className="inline-flex items-center gap-1.5 h-9 px-2 rounded-lg border border-slate-200 bg-white text-sm">
            <Clock size={14} className="text-slate-400" />
            <input
              type="time"
              value={cutoff}
              onChange={(e) => setCutoff(e.target.value)}
              className="outline-none bg-transparent w-20"
              data-testid="chefs-cutoff-input"
            />
          </label>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-2 px-3 h-9 rounded-lg text-xs font-semibold bg-white border border-slate-200 hover:bg-slate-50"
            data-testid="chefs-refresh"
          >
            {loading
              ? <Loader2 size={14} className="animate-spin" />
              : <RefreshCw size={14} />}
            Refresh
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 px-3 h-9 rounded-lg text-xs font-semibold bg-orange-600 text-white hover:bg-orange-700"
            data-testid="chefs-print"
          >
            <Printer size={14} /> Print
          </button>
        </div>
      </div>

      {/* Colored count tickets */}
      {loading && !data ? (
        <div className="p-8 flex justify-center" data-testid="chefs-loading">
          <Loader2 className="animate-spin text-slate-400" size={28} />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-6" data-testid="chefs-tickets">
            {cats.map((c) => {
              const style = TICKET_STYLE[c.color] || TICKET_STYLE.slate;
              return (
                <div
                  key={c.key}
                  className={`relative rounded-2xl p-4 shadow-md ${style.card} min-h-[128px] flex flex-col justify-between overflow-hidden`}
                  data-testid={`chefs-ticket-${c.key}`}
                >
                  <div className={`absolute -right-4 -top-4 w-16 h-16 rounded-full ${style.accent} opacity-70`} />
                  <div className="relative">
                    <div className="text-[11px] font-bold uppercase tracking-widest opacity-90">{c.label}</div>
                  </div>
                  <div className="relative">
                    <div className="text-5xl font-black leading-none tabular-nums drop-shadow-sm" data-testid={`chefs-count-${c.key}`}>
                      {counts[c.key] ?? 0}
                    </div>
                    <div className="text-[11px] font-semibold opacity-90 mt-1">
                      meals
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Total ticket */}
            <div
              className={`relative rounded-2xl p-4 shadow-md ${TICKET_STYLE.slate.card} min-h-[128px] flex flex-col justify-between overflow-hidden ring-4 ring-slate-300`}
              data-testid="chefs-ticket-total"
            >
              <div className={`absolute -right-4 -top-4 w-16 h-16 rounded-full ${TICKET_STYLE.slate.accent} opacity-70`} />
              <div className="relative">
                <div className="text-[11px] font-bold uppercase tracking-widest opacity-90">Total</div>
              </div>
              <div className="relative">
                <div className="text-5xl font-black leading-none tabular-nums drop-shadow-sm" data-testid="chefs-count-total">
                  {total}
                </div>
                <div className="text-[11px] font-semibold opacity-90 mt-1">meals · cut-off {data?.cutoff}</div>
              </div>
            </div>
          </div>

          {/* Drill-down */}
          <div className="bg-white rounded-2xl border border-slate-200 p-4" data-testid="chefs-drilldown">
            <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
              <h3 className="text-sm font-bold uppercase tracking-widest text-slate-700">
                Eligible members ({filteredTotal}
                {filteredTotal !== total ? ` of ${total}` : ""})
              </h3>
              <label className="inline-flex items-center gap-1.5 h-9 px-2 rounded-lg border border-slate-200 bg-white text-sm w-full md:w-64">
                <Search size={14} className="text-slate-400" />
                <input
                  type="text"
                  placeholder="Name / institution / fleet"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="outline-none bg-transparent flex-1"
                  data-testid="chefs-search"
                />
              </label>
            </div>

            {filteredTotal === 0 ? (
              <div className="text-sm text-slate-400 italic py-8 text-center" data-testid="chefs-empty">
                {total === 0
                  ? `No one checked in before ${data?.cutoff} on ${data?.today}.`
                  : "No matches for your search."}
              </div>
            ) : (
              <div className="space-y-5">
                {cats.map((c) => {
                  const rows = groupedMembers.get(c.key) || [];
                  if (rows.length === 0) return null;
                  const badge = CATEGORY_BADGE[c.color] || CATEGORY_BADGE.slate;
                  return (
                    <div key={c.key} data-testid={`chefs-group-${c.key}`}>
                      <div className="flex items-center gap-2 mb-2">
                        <span className={`inline-flex items-center px-2 h-6 rounded-full text-[11px] font-bold border ${badge}`}>
                          {c.label} · {rows.length}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                        {rows.map((m) => (
                          <div
                            key={m.id}
                            className="flex items-center gap-3 px-3 py-2 rounded-lg border border-slate-200 hover:bg-slate-50 transition"
                            data-testid={`chefs-row-${m.id}`}
                          >
                            <Avatar name={m.full_name} photo={m.photo_thumb} size={40} />
                            <div className="flex-1 min-w-0">
                              <div className="font-semibold text-slate-800 truncate">{m.full_name}</div>
                              <div className="text-[11px] text-slate-500 truncate">
                                {[m.institution, m.fleet].filter(Boolean).join(" · ") || "—"}
                              </div>
                            </div>
                            <div className="text-[11px] font-mono text-slate-600 tabular-nums">
                              {fmtCheckIn(m.check_in_at)}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* Print stylesheet — hide the controls when printing. */}
      <style>{`
        @media print {
          [data-testid="chefs-print"],
          [data-testid="chefs-refresh"],
          [data-testid="chefs-date-input"],
          [data-testid="chefs-cutoff-input"],
          [data-testid="chefs-search"] { display: none !important; }
          body { background: white !important; }
        }
      `}</style>
    </div>
  );
}
