/**
 * ChurnRisk — no-show / churn early-warning report.
 *
 * Surfaces members whose miss-rate on *scheduled* days crosses a
 * threshold (default 40%) OR who've had a trailing consecutive-absent
 * streak of >= 3 scheduled days. Sorted worst-first so admins can
 * scan for the highest-priority parent calls at a glance.
 *
 * Backing endpoint: GET /api/reports/churn-risk?window_days&threshold
 * (see routes/reports.py). Everything on this page is admin-only.
 *
 * Design (Feb 2026): kept intentionally lightweight — this is a
 * *report* surface, not an outreach tool. A follow-up will wire the
 * "Notify parents" button into the WhatsApp Cloud integration once
 * those creds land (currently a `mailto:` fallback so the admin can
 * eyeball the contact block before dispatch).
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, AlertTriangle, TrendingDown, PhoneCall, Users, FileDown } from "lucide-react";
import { toast } from "sonner";
import { showApiError } from "../../api";
import { useApiQuery } from "../../hooks/useApiQuery";
import { categoryLabel, formatDate } from "../../utils";

const BAND_META = {
  critical: { label: "Critical", cls: "bg-red-100 text-red-700 border-red-200" },
  high:     { label: "High",     cls: "bg-orange-100 text-orange-700 border-orange-200" },
  watch:    { label: "Watch",    cls: "bg-amber-100 text-amber-700 border-amber-200" },
};

const CATEGORY_FILTERS = [
  { key: "",        label: "All" },
  { key: "athlete", label: "Athletes" },
  { key: "elite",   label: "Elite" },
  { key: "rest",    label: "Staff & Coaches" },
];

const WINDOW_OPTIONS = [
  { key: 14, label: "14 days" },
  { key: 30, label: "30 days" },
  { key: 60, label: "60 days" },
  { key: 90, label: "90 days" },
];

const THRESHOLD_OPTIONS = [
  { key: 0.25, label: "25%" },
  { key: 0.40, label: "40%" },
  { key: 0.50, label: "50%" },
  { key: 0.75, label: "75%" },
];

function csvEscape(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(rows, filename) {
  const headers = [
    "Member", "Category", "Institution", "Fleet",
    "Scheduled", "Present", "Missed", "Miss %", "Attendance %",
    "Streak", "Last seen", "Contact relation", "Contact name", "Contact mobile", "Risk band",
  ];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push([
      r.member_name, r.category, r.institution || "", r.fleet || "",
      r.scheduled, r.present, r.missed,
      (r.miss_pct * 100).toFixed(1),
      (r.attendance_pct * 100).toFixed(1),
      r.streak, r.last_seen || "",
      r.contact?.relation || "", r.contact?.name || "", r.contact?.mobile || "",
      r.risk_band,
    ].map(csvEscape).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

export default function ChurnRisk() {
  const [windowDays, setWindowDays] = useState(30);
  const [threshold, setThreshold] = useState(0.40);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [bandFilter, setBandFilter] = useState("");

  // React Query wraps the fetch — cached per {window, threshold, category}
  // tuple, so flipping category chips instantly restores prior data while
  // the new payload is quietly refetched in the background.
  const params = useMemo(() => {
    const p = { window_days: windowDays, threshold };
    if (categoryFilter) p.category = categoryFilter;
    return p;
  }, [windowDays, threshold, categoryFilter]);

  const query = useApiQuery("/reports/churn-risk", params, {
    staleTime: 30_000,  // 30s freshness — churn is a coarse metric
  });
  const { data, isFetching, refetch, error } = query;
  const loading = isFetching;

  useEffect(() => {
    if (error) showApiError(error, "Couldn't load churn risk");
  }, [error]);

  const load = useCallback(() => { refetch(); }, [refetch]);

  const rows = useMemo(() => data?.rows || [], [data]);
  const displayedRows = useMemo(() => {
    if (!bandFilter) return rows;
    return rows.filter((r) => r.risk_band === bandFilter);
  }, [rows, bandFilter]);

  const bandCounts = useMemo(() => {
    const c = { critical: 0, high: 0, watch: 0 };
    for (const r of rows) c[r.risk_band] = (c[r.risk_band] || 0) + 1;
    return c;
  }, [rows]);

  const onExport = () => {
    if (!displayedRows.length) { toast.info("Nothing to export"); return; }
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(displayedRows, `churn_risk_${stamp}.csv`);
  };

  return (
    <div className="p-4 md:p-8 max-w-7xl mx-auto" data-testid="churn-risk-page">
      <header className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight flex items-center gap-2">
            <TrendingDown className="text-red-600" size={26}/>
            No-show / Churn Risk
          </h1>
          <p className="text-slate-500 text-sm mt-1 max-w-2xl">
            Members whose attendance is falling off. Filter by risk band or category, then export the
            call-sheet CSV or dispatch parent alerts once WhatsApp is wired.
          </p>
        </div>
        <button
          onClick={load}
          className="iu-btn-secondary"
          disabled={loading}
          data-testid="churn-risk-refresh"
        >
          {loading ? <Loader2 className="animate-spin" size={14}/> : <RefreshCw size={14}/>} Refresh
        </button>
      </header>

      <div className="iu-card p-3 mb-4 flex flex-wrap items-center gap-3" data-testid="churn-risk-controls">
        <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Window</label>
        <select
          value={windowDays}
          onChange={(e) => setWindowDays(Number(e.target.value))}
          className="iu-input !w-28 !py-1 !h-8 text-xs"
          data-testid="churn-risk-window"
        >
          {WINDOW_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Miss threshold</label>
        <select
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))}
          className="iu-input !w-24 !py-1 !h-8 text-xs"
          data-testid="churn-risk-threshold"
        >
          {THRESHOLD_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <div className="flex-1" />
        <button
          onClick={onExport}
          className="iu-btn-secondary"
          disabled={loading || !displayedRows.length}
          data-testid="churn-risk-export"
        >
          <FileDown size={14}/> CSV
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4" data-testid="churn-risk-filter-chips">
        {CATEGORY_FILTERS.map((f) => {
          const active = categoryFilter === f.key;
          return (
            <button
              key={f.key || "all"}
              data-testid={`churn-cat-${f.key || "all"}`}
              onClick={() => setCategoryFilter(f.key)}
              className={`iu-chip ${active ? "iu-chip-active" : ""}`}
            >
              {f.label}
            </button>
          );
        })}
        <div className="w-full sm:w-auto sm:ml-4 flex flex-wrap gap-2">
          {["", "critical", "high", "watch"].map((b) => {
            const active = bandFilter === b;
            const meta = BAND_META[b];
            const count = b ? bandCounts[b] : rows.length;
            return (
              <button
                key={b || "all-bands"}
                data-testid={`churn-band-${b || "all"}`}
                onClick={() => setBandFilter(b)}
                className={`iu-chip ${active ? "iu-chip-active" : ""}`}
              >
                {b ? meta.label : "All bands"}
                <span className={`min-w-[22px] h-5 px-1.5 rounded-full text-[10px] flex items-center justify-center ${
                  active ? "bg-white/20 text-white" : "bg-white border border-slate-200 text-slate-600"
                }`}>{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {data && (
        <div className="text-[11px] text-slate-500 mb-3 flex flex-wrap items-center gap-3" data-testid="churn-risk-range">
          <span>Window: <b>{formatDate(data.start)}</b> → <b>{formatDate(data.end)}</b></span>
          <span>·</span>
          <span>Threshold: miss <b>&ge; {Math.round((data.threshold || 0) * 100)}%</b></span>
          <span>·</span>
          <span>Flagged: <b>{data.count}</b> member{data.count === 1 ? "" : "s"}</span>
        </div>
      )}

      <div className="iu-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="churn-risk-table">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 text-[11px] uppercase tracking-wider">
              <tr>
                <th className="py-2 px-3 text-left">Member</th>
                <th className="py-2 px-3 text-left">Category</th>
                <th className="py-2 px-3 text-center">Attendance</th>
                <th className="py-2 px-3 text-center">Missed</th>
                <th className="py-2 px-3 text-center" title="Current consecutive-absent streak on scheduled days">Streak</th>
                <th className="py-2 px-3 text-left">Last seen</th>
                <th className="py-2 px-3 text-left">Contact</th>
                <th className="py-2 px-3 text-center">Risk</th>
              </tr>
            </thead>
            <tbody>
              {loading && displayedRows.length === 0 && (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={`churn-skel-${i}`} className="border-b border-slate-100" data-testid="churn-skeleton-row">
                    <td className="py-2 px-3" colSpan={8}>
                      <div className="h-4 rounded bg-slate-200/70 animate-pulse w-full" />
                    </td>
                  </tr>
                ))
              )}
              {!loading && displayedRows.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-slate-400" data-testid="churn-risk-empty">
                    Nobody at risk in this window. <Users className="inline" size={16}/>
                  </td>
                </tr>
              )}
              {displayedRows.map((r) => {
                const band = BAND_META[r.risk_band] || BAND_META.watch;
                const attnPct = Math.round((r.attendance_pct || 0) * 100);
                const missPct = Math.round((r.miss_pct || 0) * 100);
                const contact = r.contact;
                return (
                  <tr key={r.member_id} className="border-b border-slate-100 hover:bg-slate-50 transition-colors" data-testid={`churn-row-${r.member_id}`}>
                    <td className="py-2 px-3">
                      <div className="font-semibold text-slate-800">{r.member_name}</div>
                      {r.rank && <div className="text-[10px] text-slate-400 leading-tight">{r.rank}</div>}
                      {r.institution && <div className="text-[10px] text-slate-500">{r.institution}{r.fleet ? ` · ${r.fleet}` : ""}</div>}
                    </td>
                    <td className="py-2 px-3 text-slate-600 text-xs">{categoryLabel(r.category)}</td>
                    <td className="py-2 px-3 text-center tabular-nums">
                      <div className="font-bold text-slate-800">{attnPct}%</div>
                      <div className="text-[10px] text-slate-400">{r.present}/{r.scheduled} days</div>
                    </td>
                    <td className="py-2 px-3 text-center tabular-nums font-bold text-red-600">
                      {r.missed}
                      <div className="text-[10px] text-red-400 font-normal">({missPct}%)</div>
                    </td>
                    <td className="py-2 px-3 text-center">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold ${r.streak >= 5 ? "bg-red-100 text-red-700" : r.streak >= 3 ? "bg-orange-100 text-orange-700" : "bg-slate-100 text-slate-600"}`}>
                        {r.streak >= 3 && <AlertTriangle size={11}/>}
                        {r.streak}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-slate-500 text-xs whitespace-nowrap">
                      {r.last_seen ? formatDate(r.last_seen) : <span className="text-red-500 font-semibold">Never</span>}
                    </td>
                    <td className="py-2 px-3 text-xs">
                      {contact ? (
                        <div>
                          <div className="font-semibold text-slate-700 flex items-center gap-1">
                            <PhoneCall size={11}/> {contact.relation}
                            {contact.name ? <span className="text-slate-500 font-normal">· {contact.name}</span> : null}
                          </div>
                          <a href={`tel:${contact.mobile}`} className="text-sky-600 hover:underline tabular-nums" data-testid={`churn-contact-${r.member_id}`}>
                            {contact.mobile}
                          </a>
                        </div>
                      ) : <span className="text-slate-400">No contact</span>}
                    </td>
                    <td className="py-2 px-3 text-center">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${band.cls}`}>
                        {band.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
