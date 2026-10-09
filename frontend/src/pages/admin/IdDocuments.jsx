import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { IdCard, ArrowLeft } from "lucide-react";
import { api } from "../../api";
import IdReport from "./id-docs/IdReport";
import BulkIdUpload from "./id-docs/BulkIdUpload";

const TABS = [
  ["report", "Missing ID report", "Members and parents still missing PAN, Aadhaar or scans"],
  ["bulk", "Bulk upload", "Drop many scans at once — each is read and matched to the right person"],
];

export default function IdDocuments() {
  const [tab, setTab] = useState("report");
  const [slots, setSlots] = useState([]);
  useEffect(() => { api.get("/id-docs/report").then((r) => setSlots(r.rows)).catch(() => {}); }, [tab]);
  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto" data-testid="id-documents-page">
      <Link to="/admin/members" className="text-xs text-slate-500 hover:text-slate-800 inline-flex items-center gap-1" title="Back to Members" data-testid="id-docs-back">
        <ArrowLeft size={13} /> Members
      </Link>
      <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight flex items-center gap-2 mt-1">
        <IdCard className="text-emerald-600" size={28} /> ID Documents
      </h1>
      <p className="text-slate-500 text-sm mt-1 mb-5">PAN &amp; Aadhaar for members and (for athletes) their father, mother and guardian.</p>
      <div className="flex gap-2 mb-5">
        {TABS.map(([k, label, tip]) => (
          <button key={k} type="button" onClick={() => setTab(k)} title={tip} data-testid={`id-docs-tab-${k}`}
            className={`px-4 h-9 rounded-full text-sm font-semibold ${tab === k ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === "report" ? <IdReport /> : <BulkIdUpload slots={slots} />}
    </div>
  );
}
