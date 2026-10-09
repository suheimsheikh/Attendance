import { useEffect, useState } from "react";
import { BarChart3, Boxes, X as CloseIcon, IndianRupee, Loader2, Maximize2, PieChart as PieIcon, ShoppingCart, TrendingUp } from "lucide-react";
import { api, showApiError } from "../../../api";
import { CategoryPie, DailyTrendChart, ItemsTable, TopItemsChart, TopVendorsChart } from "./charts";
import { BannerStat, colorForItem, inr } from "./helpers";
import { Caption, NutritionBlock, PantryDayModal } from "./nutrition";

export function Section({ title, subtitle, accent, data, testKind, first, from, to }) {
  const colorAmt = accent === "purchases" ? "#2563EB" : "#F97316";
  const bandBg = accent === "purchases" ? "bg-blue-600" : "bg-orange-600";
  const bandFg = "text-white";
  const kind = accent === "purchases" ? "purchases" : "issues";
  const [fullscreen, setFullscreen] = useState(false);
  const [selectedDay, setSelectedDay] = useState(null);
  const [focusedIds, setFocusedIds] = useState(() => new Set());
  const [focusSeries, setFocusSeries] = useState(null);
  const [focusLoading, setFocusLoading] = useState(false);
  useEffect(() => {
    if (!fullscreen && !selectedDay) return;
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      if (selectedDay) setSelectedDay(null);
      else if (fullscreen) setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, selectedDay]);
  // Whenever the focused set changes, refetch per-item daily data.
  // Empty set → no fetch; the daily chart falls back to aggregate.
  useEffect(() => {
    if (focusedIds.size === 0 || !from || !to) { setFocusSeries(null); return; }
    let ignore = false;
    setFocusLoading(true);
    const ids = Array.from(focusedIds).join(",");
    api.get(`/meals/kitchen-analytics/item-daily?start=${from}&end=${to}&item_ids=${ids}&kind=${kind}`)
      .then((r) => { if (!ignore) setFocusSeries(r); })
      .catch((err) => { if (!ignore) showApiError(err, "Couldn't load item series"); })
      .finally(() => { if (!ignore) setFocusLoading(false); });
    return () => { ignore = true; };
  }, [focusedIds, from, to, kind]);
  const openDay = (d) => setSelectedDay(d);
  const toggleItem = (iid) => setFocusedIds((prev) => {
    const nxt = new Set(prev);
    if (nxt.has(iid)) nxt.delete(iid); else nxt.add(iid);
    return nxt;
  });
  const clearFocus = () => setFocusedIds(new Set());
  return (
    <section className={`mb-10 ${first ? "" : "pt-8 mt-8 border-t-[6px] border-slate-900/80"}`} data-testid={`kitchen-analytics-${testKind}`}>
      {/* Banner: title + three inline stat chips + rupee total.  The
          three chips (Total / Items / Lines) used to sit below the
          banner as separate cards; folding them in reclaims a full
          strip of vertical space above the charts. */}
      <div className={`rounded-xl px-6 py-4 shadow-lg ${bandBg} ${bandFg} mb-4`} data-testid={`kitchen-${testKind}-band`}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="text-4xl sm:text-5xl font-black uppercase tracking-widest leading-none" data-testid={`kitchen-${testKind}-title`}>{title}</div>
            <div className="text-sm opacity-90 mt-2">{subtitle}</div>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase tracking-wider font-bold opacity-80">Total</div>
            <div className="text-3xl sm:text-4xl font-black tabular-nums">₹{inr(data?.total_amount || 0)}</div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3 mt-4">
          <BannerStat icon={IndianRupee} label={`${title} Total`} value={`₹${inr(data?.total_amount || 0)}`} hint={kind === "purchases" ? "Total purchase spend (₹) in the selected window." : "Total value (₹) of items issued to the kitchen, priced at each item's weighted-average purchase rate."} />
          <BannerStat icon={Boxes} label="Distinct Items" value={data?.item_count || 0} hint="Number of unique pantry items involved in this window." />
          <BannerStat icon={ShoppingCart} label="Line Entries" value={data?.total_lines || 0} hint="Number of individual line rows entered (each item on each purchase/issue counts once)." />
        </div>
      </div>
      {accent === "purchases" && (data?.unitemised_amount || 0) > 0 && (
        <div className="mb-3 rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900" data-testid={`kitchen-${testKind}-unitemised-note`}>
          <b>₹{inr(data.unitemised_amount)}</b> of this window&apos;s purchase spend came from bulk-uploaded / legacy days that only carry category totals (no per-item detail). Those rupees appear in <b>Category share</b> but not in <b>Top items</b> or the item-wise table.
        </div>
      )}

      {/* Full-width Daily trend so the whole time series is visible
          at a glance. The three narrower charts live in the row
          below at 3-across. */}
      <div className="iu-card p-3 mb-3">
        <div className="flex items-center gap-2 mb-1 flex-wrap">
          <TrendingUp size={14} className="text-slate-500" />
          <div className="font-bold text-sm">Spend trend</div>
          {focusedIds.size > 0 ? (
            <>
              <span className="text-[10px] text-slate-400 ml-1">· focused on:</span>
              {(focusSeries?.items || []).map((it) => (
                <span
                  key={it.item_id}
                  className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-white rounded px-1.5 py-0.5"
                  style={{ background: colorForItem(it.item_id) }}
                >
                  {it.name}
                  <button type="button" onClick={() => toggleItem(it.item_id)} className="opacity-80 hover:opacity-100" title="Remove">
                    <CloseIcon size={10} />
                  </button>
                </span>
              ))}
              <button
                type="button" onClick={clearFocus}
                className="text-[10px] font-bold text-slate-500 hover:text-slate-800 underline"
                data-testid={`kitchen-${testKind}-focus-clear`}
              >Clear</button>
              {focusLoading && <Loader2 size={12} className="animate-spin text-slate-400" />}
            </>
          ) : (
            <span className="hidden sm:inline text-[10px] text-slate-400 ml-1">· weekly spend stacked by category + month total · tap a bar below to focus one item</span>
          )}
          <button
            type="button"
            onClick={() => setFullscreen(true)}
            className="ml-auto p-1.5 rounded-md text-slate-500 hover:bg-slate-100"
            title="Expand to full screen"
            data-testid={`kitchen-${testKind}-daily-fullscreen`}
          >
            <Maximize2 size={14} />
          </button>
        </div>
        <Caption>
          {kind === "purchases"
            ? "Weekly purchase spend (₹), stacked by pantry category, with a line for each month's running total. Tap any item bar in the charts below to focus its spend here."
            : "Weekly consumption value (₹) of items issued to the kitchen, stacked by category, with a monthly-total line. Values use each item's weighted-average purchase rate. Tap an item bar below to focus it here."}
        </Caption>
        <DailyTrendChart
          data={data?.daily} colorAmt={colorAmt}
          categoryTotals={data?.category_totals}
          testid={`kitchen-${testKind}-daily`}
          onDayClick={openDay} height={280}
          focusSeries={focusSeries} from={from} to={to}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-3">
        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1"><PieIcon size={14} className="text-slate-500" /><div className="font-bold text-sm">Category share</div></div>
          <Caption>Share of total {kind === "purchases" ? "purchase spend" : "consumption value"} (₹) by pantry category in this window.</Caption>
          <CategoryPie rows={data?.category_totals} testid={`kitchen-${testKind}-pie`} />
        </div>
        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1"><BarChart3 size={14} className="text-slate-500" /><div className="font-bold text-sm">Top items by ₹</div><span className="text-[10px] text-slate-400">· tap to focus</span></div>
          <Caption>Items with the highest {kind === "purchases" ? "purchase spend" : "consumption value"} (₹). Tap a bar to focus it in the Spend trend.</Caption>
          <TopItemsChart items={data?.top_by_amount} dataKey="amount" label="Amount" testid={`kitchen-${testKind}-top-amt`} onToggleItem={toggleItem} focusedIds={focusedIds} />
        </div>
        <div className="iu-card p-3">
          <div className="flex items-center gap-2 mb-1"><BarChart3 size={14} className="text-slate-500" /><div className="font-bold text-sm">Top items by qty</div><span className="text-[10px] text-slate-400">(kg items only · tap to focus)</span></div>
          <Caption>Items {kind === "purchases" ? "bought" : "consumed"} in the largest quantities (weight-based items only).</Caption>
          <TopItemsChart items={data?.top_by_qty} dataKey="qty" label="Qty (kg)" testid={`kitchen-${testKind}-top-qty`} onToggleItem={toggleItem} focusedIds={focusedIds} />
        </div>
      </div>

      {accent === "purchases" && (
        <div className="iu-card p-3 mb-3" data-testid={`kitchen-${testKind}-top-vendors-card`}>
          <div className="flex items-center gap-2 mb-1">
            <BarChart3 size={14} className="text-slate-500" />
            <div className="font-bold text-sm">Top vendors by ₹</div>
            <span className="text-[10px] text-slate-400">· who you lean on most in this window</span>
          </div>
          <TopVendorsChart vendors={data?.top_vendors} testid={`kitchen-${testKind}-top-vendors`} />
        </div>
      )}

      <ItemsTable items={data?.items} kind={title.toLowerCase()} testid={`kitchen-${testKind}-items`} />

      {/* Nutrition is only meaningful for what was actually CONSUMED
          (Issues), not what was purchased/stockpiled — so it's shown
          on the Consumption panel only. */}
      {accent !== "purchases" && data?.nutrition && <NutritionBlock nutrition={data.nutrition} testKind={testKind} accent={accent} />}

      {fullscreen && (
        <div
          className="fixed inset-0 z-50 bg-white p-4 sm:p-6 flex flex-col"
          role="dialog"
          onClick={(e) => { if (e.target === e.currentTarget) setFullscreen(false); }}
          data-testid={`kitchen-${testKind}-daily-fs-modal`}
        >
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp size={18} className={accent === "purchases" ? "text-blue-600" : "text-orange-600"} />
            <h2 className="font-black text-xl">{title} · Spend trend</h2>
            <span className="text-xs text-slate-400 ml-2">Tap any day to see the line-level detail</span>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => setFullscreen(false)}
              className="p-2 rounded-md text-slate-500 hover:bg-slate-100 !min-h-[44px] !min-w-[44px]"
              title="Close (Esc)"
              data-testid={`kitchen-${testKind}-daily-fs-close`}
            >
              <CloseIcon size={18} />
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <DailyTrendChart
              data={data?.daily}
              colorAmt={colorAmt}
              categoryTotals={data?.category_totals}
              testid={`kitchen-${testKind}-daily-fs`}
              onDayClick={openDay}
              height={Math.max(320, window.innerHeight - 160)}
              fullscreen
              focusSeries={focusSeries} from={from} to={to}
            />
          </div>
        </div>
      )}

      {selectedDay && (
        <PantryDayModal
          date={selectedDay}
          kind={kind}
          accent={accent}
          onClose={() => setSelectedDay(null)}
        />
      )}
    </section>
  );
}
