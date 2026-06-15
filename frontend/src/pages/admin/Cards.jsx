import React, { useEffect, useState } from "react";
import { Loader2, Printer, Anchor } from "lucide-react";
import QRCode from "react-qr-code";
import { api } from "../../api";
import { categoryLabel } from "../../utils";

export default function Cards() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { api.get("/admin/cards").then((r) => { setData(r); setLoading(false); }); }, []);

  if (loading || !data) return <div className="p-8 text-center text-slate-400"><Loader2 className="animate-spin mx-auto"/></div>;

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto">
      <header className="flex flex-wrap items-end justify-between gap-3 mb-6 no-print">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Member Cards</h1>
          <p className="text-slate-500 text-sm mt-1">Print personal QR cards. Each card lets a gate operator scan that member in/out.</p>
        </div>
        <button data-testid="print-cards" onClick={() => window.print()} className="iu-btn-primary"><Printer size={14}/> Print all</button>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4" data-testid="cards-grid">
        {/* Office master card */}
        {data.office_qr && (
          <div className="iu-card p-5 flex flex-col items-center text-center border-slate-900 border-2">
            <div className="text-[10px] uppercase tracking-widest font-bold text-slate-500">Office master</div>
            <div className="flex items-center gap-1.5 mt-1">
              <Anchor size={14} /> <span className="font-extrabold">{data.office_name}</span>
            </div>
            <div className="mt-3 p-2 bg-white rounded-xl">
              <QRCode value={data.office_qr} size={140} fgColor="#0F172A" />
            </div>
            <code className="text-[10px] mt-2 text-slate-500">{data.office_qr}</code>
          </div>
        )}
        {data.members.map((m) => (
          <div key={m.id} className="iu-card p-5 flex flex-col items-center text-center" data-testid={`card-${m.id}`}>
            <div className="text-[10px] uppercase tracking-widest font-bold text-slate-500">Member</div>
            <div className="font-extrabold mt-1 truncate w-full">{m.full_name}</div>
            <div className="text-xs text-slate-500">{m.rank ? `${m.rank} · ` : ""}{categoryLabel(m.category)}</div>
            <div className="mt-3 p-2 bg-white rounded-xl">
              <QRCode value={m.personal_qr} size={140} fgColor="#0F172A" />
            </div>
            <code className="text-[10px] mt-2 text-slate-500">{m.personal_qr}</code>
          </div>
        ))}
      </div>

      <style>{`
        @media print {
          aside, header.no-print, [data-testid="open-sidebar-button"] { display: none !important; }
          @page { margin: 8mm; }
          .iu-card { break-inside: avoid; }
        }
      `}</style>
    </div>
  );
}
