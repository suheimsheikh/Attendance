import React, { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Loader2, Lock, ShieldAlert } from "lucide-react";
import { CELL_STYLE, GridCell, fmtOt } from "./admin/calendar-grid/gridHelpers";

/**
 * Read-only embeddable calendar grid — designed to be iframed by
 * PayCraft (or any trusted surface). Renders ONLY the grid: no sidebar,
 * no nav, no login prompt. It never touches the auth context, so it is
 * read-only regardless of any portal role/session in the same browser.
 *
 * Access is gated server-side: the page passes ?key=<EMBED_KEY> to the
 * read-only GET /api/grid endpoint, which matches it (constant-time)
 * against the EMBED_KEY env var. A bad/missing key yields a clean
 * "access denied" card — never a redirect to /login.
 *
 * Query params:
 *   month=YYYY-MM   (default: current month)
 *   key=<secret>    (required — the EMBED_KEY)
 *   theme=dark|light (optional, default light)
 *   category=payroll|rest|athlete|elite  (optional filter)
 */

const LEGEND = ["P", "LT", "AB", "LV", "LP", "TR", "CO", "WO", "HO"];

export default function EmbedGrid() {
  const [params] = useSearchParams();
  const month = params.get("month") || new Date().toISOString().slice(0, 7);
  const key = params.get("key") || "";
  const theme = (params.get("theme") || "light").toLowerCase();
  const category = params.get("category") || "";
  const dark = theme === "dark";

  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    if (!key) {
      setState({ loading: false, error: "missing", data: null });
      return;
    }
    const base = process.env.REACT_APP_BACKEND_URL;
    const qs = new URLSearchParams({ month, key });
    if (category) qs.set("category", category);
    let alive = true;
    setState({ loading: true, error: null, data: null });
    fetch(`${base}/api/grid?${qs.toString()}`)
      .then(async (r) => {
        if (!alive) return;
        if (r.status === 401) return setState({ loading: false, error: "denied", data: null });
        if (r.status === 503) return setState({ loading: false, error: "unconfigured", data: null });
        if (!r.ok) return setState({ loading: false, error: "generic", data: null });
        const data = await r.json();
        setState({ loading: false, error: null, data });
      })
      .catch(() => alive && setState({ loading: false, error: "network", data: null }));
    return () => { alive = false; };
  }, [month, key, category]);

  const shell = dark ? "bg-slate-900 text-slate-100" : "bg-white text-slate-800";

  if (state.loading) {
    return (
      <div className={`min-h-screen flex items-center justify-center ${shell}`} data-testid="embed-grid-loading">
        <Loader2 className="animate-spin opacity-60" size={26} />
      </div>
    );
  }

  if (state.error) {
    const msg = {
      missing: { icon: <Lock size={28} />, title: "Access key required", sub: "Add ?key=… to embed this grid." },
      denied: { icon: <ShieldAlert size={28} />, title: "Access denied", sub: "The embed key is invalid." },
      unconfigured: { icon: <ShieldAlert size={28} />, title: "Not configured", sub: "Embedding is not enabled on the server." },
      network: { icon: <ShieldAlert size={28} />, title: "Can't reach the portal", sub: "Please try again." },
      generic: { icon: <ShieldAlert size={28} />, title: "Something went wrong", sub: "Unable to load the grid." },
    }[state.error];
    return (
      <div className={`min-h-screen flex items-center justify-center ${shell}`} data-testid="embed-grid-error">
        <div className="text-center max-w-sm px-6">
          <div className="mx-auto mb-3 w-14 h-14 rounded-2xl flex items-center justify-center bg-red-100 text-red-600">{msg.icon}</div>
          <div className="text-lg font-bold">{msg.title}</div>
          <div className={`text-sm mt-1 ${dark ? "text-slate-400" : "text-slate-500"}`}>{msg.sub}</div>
        </div>
      </div>
    );
  }

  const { days = [], rows = [] } = state.data || {};
  const dayNums = days.map((d) => d.slice(8, 10));
  const headBg = dark ? "bg-slate-800" : "bg-slate-50";
  const stickyBg = dark ? "bg-slate-900" : "bg-white";
  const border = dark ? "border-slate-700" : "border-slate-200";

  return (
    <div className={`min-h-screen ${shell}`} data-testid="embed-grid-page">
      <div className={`flex items-center justify-between px-4 py-2.5 border-b ${border}`}>
        <div>
          <div className="text-sm font-bold tracking-tight">Attendance Grid · {month}</div>
          <div className={`text-[11px] ${dark ? "text-slate-400" : "text-slate-500"}`}>{rows.length} members · read-only</div>
        </div>
        <div className="flex flex-wrap gap-1.5 justify-end">
          {LEGEND.map((c) => {
            const s = CELL_STYLE[c];
            return (
              <span key={c} className={`inline-flex items-center gap-1 text-[10px] ${dark ? "text-slate-300" : "text-slate-600"}`}>
                <span className={`w-3.5 h-3.5 rounded-sm ${s.bg} ${s.text} text-[8px] font-bold flex items-center justify-center`}>{s.label}</span>
                {s.title}
              </span>
            );
          })}
        </div>
      </div>

      <div className="overflow-auto" style={{ maxHeight: "calc(100vh - 49px)" }}>
        <table className="text-xs border-collapse" data-testid="embed-grid-table">
          <thead className={`sticky top-0 z-30 ${headBg}`}>
            <tr>
              <th className={`py-1.5 px-1 text-center sticky left-0 z-40 ${headBg} w-7 min-w-[28px] max-w-[28px] border-b ${border} font-semibold text-[10px] uppercase`}>#</th>
              <th className={`py-1.5 px-2 text-left sticky left-[28px] z-40 ${headBg} w-[160px] min-w-[160px] max-w-[160px] border-b ${border} font-semibold`}>Member</th>
              {dayNums.map((d, i) => (
                <th key={i} className={`w-7 min-w-[28px] max-w-[28px] text-center border-b ${border} font-semibold text-[10px] text-slate-400`}>{d}</th>
              ))}
              <th className={`sticky right-[136px] z-30 bg-emerald-100 text-emerald-800 w-[34px] min-w-[34px] text-center border-b border-l-2 ${border} text-[10px] font-bold`} title="Present">P</th>
              <th className={`sticky right-[102px] z-30 bg-red-100 text-red-700 w-[34px] min-w-[34px] text-center border-b ${border} text-[10px] font-bold`} title="Absent">AB</th>
              <th className={`sticky right-[68px] z-30 bg-amber-100 text-amber-700 w-[34px] min-w-[34px] text-center border-b ${border} text-[10px] font-bold`} title="Leave">LV</th>
              <th className={`sticky right-[34px] z-30 bg-violet-100 text-violet-800 w-[34px] min-w-[34px] text-center border-b ${border} text-[10px] font-bold`} title="OT hours">OT</th>
              <th className={`sticky right-0 z-30 bg-orange-100 text-orange-700 w-[34px] min-w-[34px] text-center border-b ${border} text-[10px] font-bold`} title="Late days">LT</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const rowBg = dark ? (i % 2 ? "bg-slate-900" : "bg-slate-800/40") : (i % 2 ? "bg-white" : "bg-slate-50/60");
              const t = r.totals || {};
              return (
                <tr key={r.member_id || i} data-testid={`embed-row-${r.member_id || i}`}>
                  <td className={`py-1 px-1 text-center text-[11px] tabular-nums sticky left-0 z-20 w-7 min-w-[28px] max-w-[28px] ${stickyBg} border-b ${border}`}>{i + 1}</td>
                  <td className={`py-1 px-2 font-semibold sticky left-[28px] z-20 w-[160px] min-w-[160px] max-w-[160px] ${stickyBg} border-b ${border} truncate`} title={`${r.member_name}${r.rank ? " · " + r.rank : ""}`}>
                    {r.member_name}
                    {r.rank ? <span className={`ml-1 text-[10px] font-normal ${dark ? "text-slate-400" : "text-slate-400"}`}>{r.rank}</span> : null}
                  </td>
                  {(r.cells || []).map((code, di) => (
                    <GridCell key={di} code={code} iso={days[di]} />
                  ))}
                  <td className={`sticky right-[136px] z-10 text-center font-bold tabular-nums ${stickyBg} text-emerald-600 border-b border-l-2 ${border} w-[34px]`}>{t.present || ""}</td>
                  <td className={`sticky right-[102px] z-10 text-center font-bold tabular-nums ${stickyBg} text-red-600 border-b ${border} w-[34px]`}>{t.absent || ""}</td>
                  <td className={`sticky right-[68px] z-10 text-center font-bold tabular-nums ${stickyBg} text-amber-700 border-b ${border} w-[34px]`}>{(t.leave || 0) + (t.lop || 0) || ""}</td>
                  <td className={`sticky right-[34px] z-10 text-center font-bold tabular-nums ${stickyBg} text-violet-700 border-b ${border} w-[34px] text-[10px]`}>{fmtOt(t.ot_minutes)}</td>
                  <td className={`sticky right-0 z-10 text-center font-bold tabular-nums ${stickyBg} text-orange-700 border-b ${border} w-[34px]`}>{t.late || ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
