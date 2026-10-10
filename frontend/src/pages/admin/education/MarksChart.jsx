import React, { useMemo } from "react";
import { TrendingDown, TrendingUp, Minus } from "lucide-react";
import { MONTHS } from "./MarksheetModal";

// Pull an overall % (0-100) out of a free-text result like "86%",
// "Overall 86.5%" or "88 / 100". Grades like "A1" return null and are
// skipped — they can't be plotted on a % axis.
export function parsePct(result) {
  if (result == null) return null;
  const s = String(result);
  const outOf = s.match(/(\d{1,3}(?:\.\d+)?)\s*\/\s*100\b/);
  const pctMark = s.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
  const bare = s.match(/\b(\d{1,3}(?:\.\d+)?)\b/);
  const m = pctMark || outOf || bare;
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (Number.isNaN(n) || n < 0 || n > 100) return null;
  return n;
}

// Build oldest→newest chartable points from a member's marksheets.
export function chartPoints(marksheets) {
  return (marksheets || [])
    .map((s) => ({ pct: parsePct(s.result), month: s.month, year: s.year, exam: s.exam_name }))
    .filter((p) => p.pct != null)
    .sort((a, b) => a.year - b.year || a.month - b.month)
    .map((p) => ({ ...p, label: `${MONTHS[p.month - 1]} ${p.year}` }));
}

/**
 * Compact inline-SVG sparkline of a member's overall % across exams
 * (oldest → newest). Scaled to the data range so dips stand out at a
 * glance. Dots turn rose on a drop, emerald on a rise. Pure SVG (no
 * chart lib) so it stays fast even with many members expanded.
 */
export default function MarksChart({ marksheets }) {
  const pts = useMemo(() => chartPoints(marksheets), [marksheets]);
  if (pts.length < 2) return null;

  const W = Math.max(200, pts.length * 46);
  const H = 72;
  const padX = 22, padTop = 14, padBot = 20;
  const vals = pts.map((p) => p.pct);
  const lo = Math.max(0, Math.min(...vals) - 5);
  const hi = Math.min(100, Math.max(...vals) + 5);
  const span = hi - lo || 1;
  const x = (i) => padX + (i * (W - 2 * padX)) / (pts.length - 1);
  const y = (v) => padTop + (1 - (v - lo) / span) * (H - padTop - padBot);
  const line = pts.map((p, i) => `${x(i)},${y(p.pct)}`).join(" ");

  const first = pts[0].pct, last = pts[pts.length - 1].pct;
  const delta = Math.round((last - first) * 10) / 10;
  const Trend = delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
  const trendCls = delta > 0 ? "text-emerald-600" : delta < 0 ? "text-rose-600" : "text-slate-400";

  return (
    <div className="mb-2 rounded-lg bg-slate-50 border border-slate-200 p-2" data-testid="marks-chart">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Overall % trend</span>
        <span className={`inline-flex items-center gap-0.5 text-[11px] font-bold ${trendCls}`} data-testid="marks-chart-trend">
          <Trend size={12} />{delta > 0 ? "+" : ""}{delta}%
        </span>
        <span className="ml-auto text-[11px] text-slate-500">Latest <b className="text-slate-800">{last}%</b></span>
      </div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block max-w-full" preserveAspectRatio="xMinYMid meet">
        <polyline points={line} fill="none" stroke="#0ea5e9" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {pts.map((p, i) => {
          const dropped = i > 0 && p.pct < pts[i - 1].pct;
          const rose = i > 0 && p.pct > pts[i - 1].pct;
          const fill = dropped ? "#e11d48" : rose ? "#059669" : "#64748b";
          return (
            <g key={i} data-testid={`marks-point-${i}`}>
              <circle cx={x(i)} cy={y(p.pct)} r="3.5" fill={fill} stroke="#fff" strokeWidth="1.5">
                <title>{`${p.exam} · ${p.label} · ${p.pct}%`}</title>
              </circle>
              <text x={x(i)} y={y(p.pct) - 7} textAnchor="middle" className="fill-slate-700 font-bold" fontSize="9">{p.pct}</text>
              <text x={x(i)} y={H - 6} textAnchor="middle" className="fill-slate-400" fontSize="8">{MONTHS[p.month - 1]} '{String(p.year).slice(2)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
