/**
 * GridRowTotals — the right-sticky totals strip (DAR ✗ · P · AB · LP ·
 * LV · TR · OT h · EO · LT) for a single member row on the calendar grid.
 * Renders 9 <td>s in a fragment so the parent can put them at the end
 * of the appropriate <tr>. In two-row mode (rowsMode === "double"),
 * every cell uses rowSpan=2 so the totals visually align with the
 * member's paired in/out rows.
 *
 * Double-click behaviour:
 *   • DAR ✗ cell → open the DAR report (missed tab)
 *   • P / AB / LP / LV / TR / EO / LT cells → open Attendance ledger
 *   • OT h cell                             → open OT ledger
 *
 * Extracted 14 Feb 2026 (item I of the low-risk refactor pass).
 * DAR ✗ column added Sep 2026. LP (loss-of-pay) column added Sep 2026.
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
  onOpenDar,
}) {
  const t = totals || {};
  const attnTitle = "Double-click for daily ledger";
  const otTitle = "Double-click for OT ledger";
  const base = "z-20 group-hover:bg-sky-50 text-center font-bold tabular-nums text-[11px] border-b border-slate-100 border-l border-slate-200 cursor-pointer select-none";
  return (
    <>
      <td
        rowSpan={rowSpan}
        className={`sticky right-[278px] ${base} !border-l-2 !border-slate-300 text-rose-700 ${rowBg} w-[34px] min-w-[34px] max-w-[34px]`}
        data-testid={`cal-total-dar-${memberId}`}
        title={t.dar_missed ? `${t.dar_missed} missed DAR${t.dar_missed === 1 ? "" : "s"} · Double-click to open the DAR report` : "No missed DARs"}
        onDoubleClick={onOpenDar}
      >{t.dar_missed ? `✗${t.dar_missed}` : ""}</td>
      <td
        rowSpan={rowSpan}
        className={`sticky right-[244px] ${base} text-emerald-700 ${rowBg} w-[34px] min-w-[34px] max-w-[34px]`}
        data-testid={`cal-total-p-${memberId}`}
        title={`Present · ${attnTitle}`}
        onDoubleClick={onOpenAttn}
      >{t.present || ""}</td>
      <td
        rowSpan={rowSpan}
        className={`sticky right-[210px] ${base} text-red-600 ${rowBg} w-[34px] min-w-[34px] max-w-[34px]`}
        data-testid={`cal-total-ab-${memberId}`}
        title={`Absent · ${attnTitle}`}
        onDoubleClick={onOpenAttn}
      >{t.absent || ""}</td>
      <td
        rowSpan={rowSpan}
        className={`sticky right-[176px] ${base} text-pink-700 ${rowBg} w-[34px] min-w-[34px] max-w-[34px]`}
        data-testid={`cal-total-lop-${memberId}`}
        title={t.lop ? `${t.lop} loss-of-pay day${t.lop === 1 ? "" : "s"} (leave beyond paid balance) · ${attnTitle}` : `Loss of pay · ${attnTitle}`}
        onDoubleClick={onOpenAttn}
      >{t.lop || ""}</td>
      <td
        rowSpan={rowSpan}
        className={`sticky right-[142px] ${base} text-amber-700 ${rowBg} w-[34px] min-w-[34px] max-w-[34px]`}
        data-testid={`cal-total-lv-${memberId}`}
        title={`Leave + Comp-off · ${attnTitle}`}
        onDoubleClick={onOpenAttn}
      >{t.leave || ""}</td>
      <td
        rowSpan={rowSpan}
        className={`sticky right-[108px] ${base} text-orange-700 ${rowBg} w-[34px] min-w-[34px] max-w-[34px]`}
        data-testid={`cal-total-tr-${memberId}`}
        title={`Tour · ${attnTitle}`}
        onDoubleClick={onOpenAttn}
      >{t.tour || ""}</td>
      <td
        rowSpan={rowSpan}
        className={`sticky right-[68px] ${base} text-violet-800 ${rowBg} w-[40px] min-w-[40px] max-w-[40px]`}
        data-testid={`cal-total-ot-${memberId}`}
        title={`OT hours · ${otTitle}`}
        onDoubleClick={onOpenOt}
      >{fmtOt(t.ot_minutes)}</td>
      <td
        rowSpan={rowSpan}
        className={`sticky right-[34px] ${base} text-rose-700 ${rowBg} w-[34px] min-w-[34px] max-w-[34px]`}
        data-testid={`cal-total-eo-${memberId}`}
        title={`Early-out days · ${attnTitle}`}
        onDoubleClick={onOpenAttn}
      >{t.early_out || ""}</td>
      <td
        rowSpan={rowSpan}
        className={`sticky right-0 ${base} text-orange-700 ${rowBg} w-[34px] min-w-[34px] max-w-[34px]`}
        data-testid={`cal-total-lt-${memberId}`}
        title={`Late days · ${attnTitle}`}
        onDoubleClick={onOpenAttn}
      >{t.late || ""}</td>
    </>
  );
}
