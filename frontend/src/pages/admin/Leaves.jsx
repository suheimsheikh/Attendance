import React, { useEffect, useState } from "react";
import { Loader2, Check, X, Bed, Plane, AlertTriangle, Plus } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { shortDate } from "../../utils";
import { ApplyForm } from "../MyLeaves";

const FILTERS = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "late", label: "Late applications" },
  { key: "all", label: "All" },
];

export default function AdminLeaves() {
  const [filter, setFilter] = useState("pending");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showOnBehalf, setShowOnBehalf] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const params = filter === "all" ? undefined : { status_filter: filter };
      setItems(await api.get("/leaves", params));
    } finally { setLoading(false); }
  };
  useEffect(() => { load();   }, [filter]);

  const decide = async (id, status) => {
    try {
      await api.patch(`/leaves/${id}`, { status });
      toast.success(`Request ${status}`);
      load();
    } catch (err) { toast.error(err?.message || "Failed"); }
  };

  return (
    <div className="p-4 md:p-8 max-w-5xl mx-auto">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Leave Approvals</h1>
          <p className="text-slate-500 text-sm mt-1">Review and decide on leave & tour requests.</p>
        </div>
        <button data-testid="apply-on-behalf" onClick={() => setShowOnBehalf(true)} title="File a leave or tour on behalf of a member who forgot" className="iu-btn-primary">
          <Plus size={16}/> Apply on behalf
        </button>
      </header>

      <div className="flex gap-2 overflow-x-auto pb-3 mb-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            data-testid={`leaves-filter-${f.key}`}
            onClick={() => setFilter(f.key)}
            className={`iu-chip whitespace-nowrap shrink-0 ${filter === f.key ? "iu-chip-active" : ""}`}
          >{f.label}</button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-10"><Loader2 className="animate-spin mx-auto text-slate-400" /></div>
      ) : items.length === 0 ? (
        <div className="iu-card p-10 text-center text-slate-500">No {filter === "all" ? "" : filter} requests.</div>
      ) : (
        <div className="space-y-3" data-testid="admin-leaves-list">
          {items.map((l) => (
            <div key={l.id} className={`iu-card p-4 flex flex-wrap items-center gap-4 ${l.late_application ? "ring-2 ring-red-200 bg-red-50/50" : ""}`} data-testid={`leave-row-${l.id}`}>
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${l.type === "tour" ? "bg-orange-100 text-orange-700" : "bg-amber-100 text-amber-700"}`}>
                {l.type === "tour" ? <Plane size={18}/> : <Bed size={18}/>}
              </div>
              <div className="flex-1 min-w-[200px]">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="font-semibold">{l.member_name}</div>
                  {l.late_application && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-extrabold uppercase tracking-wide" data-testid={`late-chip-${l.id}`}>
                      <AlertTriangle size={10} /> Late application
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-500">{l.member_rank ? `${l.member_rank} · ` : ""}{l.member_category}</div>
                <div className="text-xs text-slate-600 mt-1">
                  {shortDate(l.start_date)} – {shortDate(l.end_date)}{l.location ? ` · ${l.location}` : ""}
                </div>
                <div className="text-sm text-slate-700 mt-1">{l.reason}</div>
              </div>
              <div className="flex items-center gap-2">
                {l.status === "pending" ? (
                  <>
                    <button data-testid={`approve-${l.id}`} onClick={() => decide(l.id, "approved")} title="Approve this request" className="iu-btn-primary !h-9 !px-3"><Check size={14}/> Approve</button>
                    <button data-testid={`reject-${l.id}`} onClick={() => decide(l.id, "rejected")} title="Reject this request" className="iu-btn-secondary !h-9 !px-3"><X size={14}/> Reject</button>
                  </>
                ) : (
                  <span className="iu-chip capitalize">{l.status}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {showOnBehalf && (
        <ApplyForm
          asAdmin
          onClose={() => setShowOnBehalf(false)}
          onCreated={() => { setShowOnBehalf(false); load(); }}
        />
      )}
    </div>
  );
}
