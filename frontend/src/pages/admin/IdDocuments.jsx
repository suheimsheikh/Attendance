import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { IdCard, ArrowLeft } from "lucide-react";
import { api } from "../../api";
import IdReport from "./id-docs/IdReport";
import BulkIdUpload from "./id-docs/BulkIdUpload";
import TravelCheck from "./id-docs/TravelCheck";
import NameMismatch from "./id-docs/NameMismatch";

const TABS = [
  ["report", "Missing ID report", "Members and parents still missing PAN, Aadhaar, passport or scans — and passports expiring soon"],
  ["names", "Name mismatch", "People whose name on Aadhaar, PAN, passport or birth certificate isn't exactly the app name"],
  ["bulk", "Bulk upload", "Drop many scans at once — each is read and matched to the right person"],
  ["travel", "Travel check", "Athletes & coaches whose passport is missing or not valid 6 months after an overseas regatta"],
];

export default function IdDocuments() {
  const [tab, setTab] = useState("report");
  const [slots, setSlots] = useState([]);
  const [reload, setReload] = useState(0);
  useEffect(() => { api.get("/id-docs/report").then((r) => setSlots(r.rows)).catch(() => {}); }, [tab, reload]);
  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto" data-testid="id-documents-page">
      <Link to="/admin/members" className="text-xs text-slate-500 hover:text-slate-800 inline-flex items-center gap-1" title="Back to Members" data-testid="id-docs-back">
        <ArrowLeft size={13} /> Members
      </Link>
      <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight flex items-center gap-2 mt-1">
        <IdCard className="text-emerald-600" size={28} /> ID Documents
      </h1>
      <p className="text-slate-500 text-sm mt-1 mb-5">PAN, Aadhaar, passports &amp; birth certificates for members and (for athletes) their father, mother and guardian.</p>
      <div className="flex flex-wrap gap-2 mb-5">
        {TABS.map(([k, label, tip]) => (
          <button key={k} type="button" onClick={() => setTab(k)} title={tip} data-testid={`id-docs-tab-${k}`}
            className={`px-4 h-9 rounded-full text-sm font-semibold ${tab === k ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === "report" ? <IdReport /> : tab === "names" ? <NameMismatch />
        : tab === "bulk" ? <BulkIdUpload slots={slots} onNamesChanged={() => setReload((n) => n + 1)} /> : <TravelCheck />}
    </div>
  );
}
