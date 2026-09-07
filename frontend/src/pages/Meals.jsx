/**
 * Meals — bulk paper-trail of who took each meal (Breakfast / Lunch /
 * Snacks / Dinner). Mirrors the Muster surface intentionally so the
 * kitchen team can tick members from the same familiar interface, but:
 *
 *   • no photo capture / GPS (meals are stationary)
 *   • no check-in / check-out modes — the "mode" here is which meal
 *   • already-marked rows are pre-ticked and tapping them again
 *     un-marks (idempotent toggle, per user spec 23 Feb 2026)
 *
 * Access: admins, chefs, coaches (server-enforced via
 * require_chef_or_admin).
 */
import React, { useEffect, useState, useMemo, useCallback } from "react";
import { Loader2, Search, RefreshCw, CheckSquare, Square, Utensils, Users, Copy } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../api";
import { useAuth } from "../auth";
import { formatDate } from "../utils";
import MusterRow from "./muster/MusterRow";
import { MusterScopeChips, MusterInstitutionChips } from "./muster/MusterFilters";
import ExMemberToggle, { useExMemberToggle } from "../components/ExMemberToggle";
import { isExMember } from "../utils/exMember";

const CATEGORY_CHIP_STYLE = {
  athlete:   "bg-sky-100 text-sky-700",
  elite:     "bg-rose-100 text-rose-700",
  staff:     "bg-emerald-100 text-emerald-700",
  coach:     "bg-amber-100 text-amber-700",
  executive: "bg-violet-100 text-violet-700",
};

// Tint per meal — matches the Muster mode-button aesthetic so the
// switcher feels the same as check-in / check-out toggle.
const MEAL_COLOR = {
  breakfast: "#F59E0B",  // amber
  lunch:     "#10B981",  // emerald
  snacks:    "#8B5CF6",  // violet
  dinner:    "#2563EB",  // blue
};

function todayISO() {
  // Office-local date is the source of truth on the backend, but for
  // the picker default we use the browser's local date — same TZ in
  // practice (IST) and avoids a round-trip.
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function Meals() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [meals, setMeals] = useState([]);       // [{key,label,short}]
  const [meal, setMeal] = useState("breakfast");
  const [dateStr, setDateStr] = useState(todayISO());
  const [scope, setScope] = useState("all");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const [institutionFilter, setInstitutionFilter] = useState("all");
  const [showEx, setShowEx] = useExMemberToggle("meals");

  // Fetch the (static, for now) meal list once.
  useEffect(() => {
    api.getCached("/meals/config")
      .then((r) => setMeals(r?.meals || []))
      .catch(() => setMeals([
        { key: "breakfast",  label: "Breakfast",         short: "BF" },
        { key: "midmorning", label: "Midmorning Snack",  short: "MM" },
        { key: "lunch",      label: "Lunch",             short: "L" },
        { key: "snacks",     label: "Afternoon Snack",   short: "AS" },
        { key: "dinner",     label: "Dinner",            short: "D" },
      ]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`/meals/roster?meal=${meal}&date=${dateStr}&scope=${scope}`);
      setData(res);
      setPicked(new Set());
    } catch (err) {
      showApiError(err, "Couldn't load roster");
    } finally {
      setLoading(false);
    }
  }, [meal, dateStr, scope]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setInstitutionFilter("all"); }, [meal, dateStr, scope]);

  const members = data?.members || [];

  const institutions = useMemo(() => {
    const named = new Map();
    let unaffiliated = 0;
    members.forEach((s) => {
      const inst = (s.institution || "").trim();
      if (inst) named.set(inst, (named.get(inst) || 0) + 1);
      else unaffiliated += 1;
    });
    const arr = Array.from(named.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (arr.length > 0 && unaffiliated > 0) {
      arr.push({ name: "(no institution)", count: unaffiliated });
    }
    return arr;
  }, [members]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return members.filter((s) => {
      if (!showEx && isExMember(s)) return false;
      if (institutionFilter !== "all") {
        const sInst = s.institution || "(no institution)";
        if (sInst !== institutionFilter) return false;
      }
      if (!q) return true;
      return (
        (s.full_name || "").toLowerCase().includes(q) ||
        (s.rank || "").toLowerCase().includes(q) ||
        (s.institution || "").toLowerCase().includes(q)
      );
    });
  }, [members, showEx, search, institutionFilter]);

  const exCount = useMemo(() => members.filter((s) => isExMember(s)).length, [members]);
  const markedCount = data?.marked_count ?? 0;

  const toggle = (id) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id); else next.add(id);
    setPicked(next);
  };

  const toggleAllVisible = () => {
    const next = new Set(picked);
    const allPicked = filtered.length > 0 && filtered.every((s) => next.has(s.id));
    if (allPicked) filtered.forEach((s) => next.delete(s.id));
    else filtered.forEach((s) => next.add(s.id));
    setPicked(next);
  };

  // Toggle semantics — if ALL currently-picked rows are already-marked,
  // the submit fires unmark-bulk. Otherwise it marks (dupes are
  // silently skipped server-side). Keeps a single visible action so
  // the chef doesn't hunt for a "Remove" button.
  const pickedList = Array.from(picked);
  const pickedRows = useMemo(
    () => members.filter((m) => picked.has(m.id)),
    [members, picked],
  );
  const allPickedAreMarked = pickedRows.length > 0 && pickedRows.every((m) => m.already_marked);
  const submitVerb = allPickedAreMarked ? "Un-mark" : "Mark";
  const activeMealDef = meals.find((m) => m.key === meal) || { label: meal, key: meal };

  const submit = async () => {
    if (picked.size === 0) {
      toast.error("Tick at least one member first");
      return;
    }
    setSaving(true);
    try {
      const endpoint = allPickedAreMarked ? "/meals/unmark-bulk" : "/meals/mark-bulk";
      const res = await api.post(endpoint, {
        meal, date: dateStr, user_ids: pickedList,
      });
      const done = allPickedAreMarked ? (res.unmarked_count || 0) : (res.marked_count || 0);
      const skip = res.skipped_count || 0;
      const skipNote = skip > 0 ? ` · ${skip} skipped` : "";
      const noun = done === 1 ? "member" : "members";
      toast.success(
        allPickedAreMarked
          ? `${done} ${noun} un-marked for ${activeMealDef.label}${skipNote}`
          : `${done} ${noun} marked for ${activeMealDef.label}${skipNote}`,
      );
      setPicked(new Set());
      load();
    } catch (err) {
      showApiError(err, "Save failed");
    } finally {
      setSaving(false);
    }
  };

  // Copy the same meal's marks from the previous day. Handy for morning
  // stand-ups when the mess roster barely changes day-to-day. Duplicates
  // (already marked for today) are silently skipped server-side.
  const [copying, setCopying] = useState(false);
  const copyFromYesterday = async () => {
    setCopying(true);
    try {
      const res = await api.post(
        `/meals/copy-previous?meal=${encodeURIComponent(meal)}&date=${encodeURIComponent(dateStr)}`,
      );
      const copied = res.copied_count || 0;
      const src = res.from_date;
      if (res.source_count === 0) {
        toast.error(`No ${activeMealDef.label} marks found for ${src}`);
      } else if (copied === 0) {
        toast.success(`${activeMealDef.label} is already up to date (nothing new to copy)`);
      } else {
        const noun = copied === 1 ? "member" : "members";
        toast.success(`Copied ${copied} ${noun} from ${src}`);
      }
      load();
    } catch (err) {
      showApiError(err, "Copy failed");
    } finally {
      setCopying(false);
    }
  };

  const color = MEAL_COLOR[meal] || "#2563EB";
  const allVisiblePicked = filtered.length > 0 && filtered.every((s) => picked.has(s.id));

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto pb-32" data-testid="meals-page">
      <header className="mb-6">
        <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Meals</h1>
        <p className="text-slate-500 text-sm mt-1">
          Tick the members who took this meal. Marks are logged with your name.
          Tap a pre-ticked member and press <b>Un-mark</b> to remove a mistake.
        </p>
      </header>

      {/* Meal switcher — 5 slots. Mobile: 3-col grid (Breakfast/Mid/Lunch
          on row 1, Afternoon/Dinner on row 2) with short labels so
          "Midmorning Snack" doesn't overflow narrow phones. Desktop:
          single row of 5 with the full label. */}
      <div className="grid grid-cols-3 sm:grid-cols-5 gap-2 mb-3" data-testid="meals-meal-switcher">
        {meals.map((m) => {
          const active = m.key === meal;
          return (
            <button
              key={m.key}
              data-testid={`meals-meal-${m.key}`}
              onClick={() => setMeal(m.key)}
              // `title` shows on desktop hover AND on many mobile
              // browsers when a user long-presses the button, so
              // first-time users can figure out what "MM" or "AS"
              // stands for without a separate hint UI.
              // aria-label picks up the same text for screen readers.
              title={m.label}
              aria-label={m.label}
              className={`iu-btn ${active ? "iu-btn-primary" : "iu-btn-secondary"} !px-2 !text-xs sm:!text-sm !min-w-0 truncate justify-center`}
              style={active ? { background: MEAL_COLOR[m.key] } : undefined}
            >
              <Utensils size={13} className="shrink-0" />
              <span className="sm:hidden truncate">{m.short || (m.label || "").split(" ")[0]}</span>
              <span className="hidden sm:inline truncate">{m.label}</span>
            </button>
          );
        })}
      </div>

      {/* Date picker */}
      <div className="iu-card p-3 mb-4 flex items-center gap-3 flex-wrap">
        <label className="text-xs font-semibold text-slate-600" htmlFor="meals-date">Date</label>
        <input
          id="meals-date"
          data-testid="meals-date"
          type="date"
          value={dateStr}
          onChange={(e) => setDateStr(e.target.value)}
          max={todayISO()}
          className="iu-input !h-9 !w-auto text-sm"
        />
        <div className="text-xs text-slate-500">
          {formatDate(dateStr)}
          {markedCount > 0 && (
            <> · <span className="font-semibold text-emerald-700">{markedCount}</span> already marked</>
          )}
        </div>
      </div>

      {/* Scope filter — admin only. Chef/coach see everyone the server allows. */}
      {isAdmin && <MusterScopeChips scope={scope} onChange={setScope} />}

      {(scope === "athletes" || scope === "all") && (
        <MusterInstitutionChips
          institutions={institutions}
          institutionFilter={institutionFilter}
          onChange={setInstitutionFilter}
          totalCount={members.length}
        />
      )}

      {/* Search + bulk-tick */}
      <div className="iu-card p-3 mb-4 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-[180px]">
          <Search size={18} className="text-slate-400" />
          <input
            data-testid="meals-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by name, rank, category…"
            className="flex-1 outline-none bg-transparent text-sm"
          />
        </div>
        {exCount > 0 && (
          <ExMemberToggle showEx={showEx} onChange={setShowEx} exCount={exCount} />
        )}
        <button
          data-testid="meals-toggle-all"
          onClick={toggleAllVisible}
          disabled={filtered.length === 0}
          title="Tick or untick everyone currently shown"
          className="iu-btn-ghost !h-9 !px-3 text-xs"
        >
          {allVisiblePicked ? <CheckSquare size={14}/> : <Square size={14}/>}
          {allVisiblePicked ? "Untick visible" : "Tick all visible"}
        </button>
        <button
          data-testid="meals-copy-yesterday"
          onClick={copyFromYesterday}
          disabled={copying || saving}
          className="iu-btn-secondary !h-9 !px-3 text-xs"
          title={`Copy ${activeMealDef.label} marks from yesterday to ${dateStr}`}
        >
          {copying ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />}
          <span className="hidden sm:inline">Copy yesterday</span>
        </button>
        <button onClick={load} className="iu-btn-secondary !h-9 !px-3" data-testid="meals-refresh" title="Reload the list from the server">
          <RefreshCw size={14} />
        </button>
      </div>

      {/* Summary line */}
      <div className="flex items-baseline justify-between mb-2 px-1">
        <p className="text-sm text-slate-600" data-testid="meals-summary">
          <span className="font-bold text-slate-900">{filtered.length}</span> in view
          {picked.size > 0 && (
            <> · <span className="font-bold text-emerald-700">{picked.size}</span> ticked</>
          )}
        </p>
        <p className="text-xs text-slate-400">
          {activeMealDef.label}
        </p>
      </div>

      {loading ? (
        <div className="text-center py-12"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
      ) : filtered.length === 0 ? (
        <div className="iu-card p-10 text-center" data-testid="meals-empty">
          <Users className="mx-auto text-slate-300 mb-2" size={36} />
          <p className="font-semibold text-slate-700">No members in scope</p>
          <p className="text-sm text-slate-500 mt-1">
            Try widening the scope filter above.
          </p>
        </div>
      ) : (
        <ul className="iu-card divide-y divide-slate-100 overflow-hidden" data-testid="meals-list">
          {filtered.map((s) => {
            const isPicked = picked.has(s.id);
            return (
              <MusterRow
                key={s.id}
                member={s}
                isPicked={isPicked}
                isLocked={false}
                isAdmin={isAdmin}
                singleCheckoutBusy={false}
                onToggle={toggle}
                onAddPhoto={() => {}}
                onInlineCheckout={() => {}}
                categoryChipStyle={CATEGORY_CHIP_STYLE}
                markedChip={s.already_marked
                  ? { label: `Marked · ${activeMealDef.label}` }
                  : undefined}
                rowTint={s.already_marked ? "bg-emerald-50/40" : ""}
              />
            );
          })}
        </ul>
      )}

      {/* Sticky save bar */}
      <div className="fixed bottom-0 left-0 right-0 md:left-64 bg-white border-t border-slate-200 p-3 md:p-4 z-40">
        <div className="max-w-3xl mx-auto flex items-center gap-3">
          <div className="flex-1 text-sm">
            {picked.size === 0
              ? <span className="text-slate-400">Tick members above to mark {activeMealDef.label}</span>
              : <span className="font-semibold text-slate-900">{picked.size} ticked · {allPickedAreMarked ? "will un-mark" : "will mark"}</span>}
            {user?.full_name && (
              <span className="text-xs text-slate-400 block">Verified by {user.full_name}</span>
            )}
          </div>
          <button
            data-testid="meals-submit"
            onClick={submit}
            disabled={saving || picked.size === 0}
            title="Save the meal list for the kitchen"
            className="iu-btn-primary"
            style={{ background: picked.size > 0 ? color : undefined }}
          >
            {saving ? <Loader2 className="animate-spin" size={16}/> : <Utensils size={16}/>}
            {submitVerb} {picked.size > 0 ? picked.size : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
