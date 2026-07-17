/**
 * GridRowTotals — the right-sticky totals strip (P · AB · LV · TR ·
 * OT h · EO · LT) for a single member row on the calendar grid.
 * Renders 7 <td>s in a fragment so the parent can put them at the end
 * of the appropriate <tr>. In two-row mode (rowsMode === "double"),
 * every cell uses rowSpan=2 so the totals visually align with the
 * member's paired in/out rows.
 *
 * Double-click behaviour:
 *   • P / AB / LV / TR / EO / LT cells → open Attendance ledger
 *   • OT h cell                        → open OT ledger
 *   • LV cell shows an LOP pill when totals.lop > 0
 *
 * Extracted 14 Feb 2026 (item I of the low-risk refactor pass).
 */
import React from "react";
import { fmtOt } from "./gridHelpers";

export default function GridRowTotals({
  totals,
  memberId,
  rowBg,
  rowSpan = 1,
  onOpenAttn,
  onOpenOt,
}) {
  const t = totals || {};
  const attnTitle = "Double-click for daily ledger";
  const otTitle = "Double-click for OT ledger";
  const base = "z-20 group-hover:bg-sky-50 text-center font-bold tabular-nums text-[11px] border-b border-slate-100 cursor-pointer select-none";
  return (
    <>
      <td
        rowSpan={rowSpan}
        className={`sticky right-[262px] ${base} border-l-2 border-slate-300 text-emerald-700 ${rowBg} w-[42px] min-w-[42px] max-w-[42px]`}
        data-testid={`cal-total-p-${memberId}`}
        title={`Present · ${attnTitle}`}
        onDoubleClick={onOpenAttn}
      >{t.present || ""}</td>
      <td
        rowSpan={rowSpan}
        className={`sticky right-[220px] ${base} text-red-600 ${rowBg} w-[42px] min-w-[42px] max-w-[42px]`}
        data-testid={`cal-total-ab-${memberId}`}
        title={`Absent · ${attnTitle}`}
        onDoubleClick={onOpenAttn}
      >{t.absent || ""}</td>
      <td
        rowSpan={rowSpan}
        className={`sticky right-[178px] ${base} text-amber-700 ${rowBg} w-[42px] min-w-[42px] max-w-[42px] relative`}
        data-testid={`cal-total-lv-${memberId}`}
        title={t.lop ? `Leave (${t.lop} LOP) · ${attnTitle}` : `Leave · ${attnTitle}`}
        onDoubleClick={onOpenAttn}
      >
        {t.leave || ""}
        {/* LOP badge — absolutely positioned so it doesn't inflate the
            LV column width and spill over its sticky-right neighbours.
            Sits as a small pill on the top-right corner. */}
        {t.lop ? (
          <span
            className="absolute top-0 right-0 translate-x-1/3 -translate-y-1/2 inline-flex items-center px-1 rounded-full bg-rose-600 text-white text-[8px] font-bold leading-tight shadow-sm pointer-events-none"
            title={`${t.lop} day${t.lop === 1 ? "" : "s"} without pay`}
            data-testid={`cal-total-lop-${memberId}`}
          >
            {t.lop}L
          </span>
        ) : null}
      </td>
      <td
        rowSpan={rowSpan}
        className={`sticky right-[136px] ${base} text-orange-700 ${rowBg} w-[42px] min-w-[42px] max-w-[42px]`}
        data-testid={`cal-total-tr-${memberId}`}
        title={`Tour · ${attnTitle}`}
        onDoubleClick={onOpenAttn}
      >{t.tour || ""}</td>
      <td
        rowSpan={rowSpan}
        className={`sticky right-[84px] ${base} text-violet-800 ${rowBg} w-[52px] min-w-[52px] max-w-[52px]`}
        data-testid={`cal-total-ot-${memberId}`}
        title={`OT hours · ${otTitle}`}
        onDoubleClick={onOpenOt}
      >{fmtOt(t.ot_minutes)}</td>
      <td
        rowSpan={rowSpan}
        className={`sticky right-[42px] ${base} text-rose-700 ${rowBg} w-[42px] min-w-[42px] max-w-[42px]`}
        data-testid={`cal-total-eo-${memberId}`}
        title={`Early-out days · ${attnTitle}`}
        onDoubleClick={onOpenAttn}
      >{t.early_out || ""}</td>
      <td
        rowSpan={rowSpan}
        className={`sticky right-0 ${base} text-orange-700 ${rowBg} w-[42px] min-w-[42px] max-w-[42px]`}
        data-testid={`cal-total-lt-${memberId}`}
        title={`Late days · ${attnTitle}`}
        onDoubleClick={onOpenAttn}
      >{t.late || ""}</td>
    </>
  );
}
