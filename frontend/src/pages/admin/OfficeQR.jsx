import React, { useEffect, useState } from "react";
import { Loader2, RefreshCw, Printer } from "lucide-react";
import QRCode from "react-qr-code";
import { toast } from "sonner";
import { api } from "../../api";

export default function OfficeQR() {
  const [office, setOffice] = useState(null);
  const [regen, setRegen] = useState(false);

  useEffect(() => { api.get("/office").then(setOffice); }, []);

  const regenerate = async () => {
    if (!window.confirm("Generate a new Office QR? Old printed copies will stop working.")) return;
    setRegen(true);
    try {
      const res = await api.post("/office/regenerate-qr");
      setOffice((o) => ({ ...o, qr_token: res.qr_token }));
      toast.success("New Office QR generated");
    } catch (err) { toast.error(err?.message || "Failed"); }
    finally { setRegen(false); }
  };

  if (!office) return <div className="p-8 text-center text-slate-400"><Loader2 className="animate-spin mx-auto"/></div>;

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto">
      <header className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight">Office QR</h1>
          <p className="text-slate-500 text-sm mt-1">Print and post this at your check-in station.</p>
        </div>
        <div className="flex gap-2">
          <button data-testid="print-office-qr" onClick={() => window.print()} className="iu-btn-secondary"><Printer size={14}/> Print</button>
          <button data-testid="regenerate-office-qr" onClick={regenerate} disabled={regen} className="iu-btn-danger">
            {regen ? <Loader2 className="animate-spin" size={14}/> : <RefreshCw size={14}/>} Regenerate
          </button>
        </div>
      </header>

      <div className="iu-card p-6 md:p-10 flex flex-col items-center text-center" data-testid="office-qr-card">
        <div className="text-xs uppercase tracking-widest text-slate-500 font-semibold mb-2">Scan to check in / out</div>
        <h2 className="text-2xl md:text-3xl font-extrabold">{office.name}</h2>
        <p className="text-sm text-slate-500 mt-1">Geofence: {office.radius_m} m</p>
        <div className="my-6 p-4 bg-white border border-slate-200 rounded-2xl">
          <QRCode value={office.qr_token} size={256} bgColor="#FFFFFF" fgColor="#0F172A" />
        </div>
        <code data-testid="office-qr-token" className="text-xs px-3 py-1 rounded-full bg-slate-100 text-slate-700">{office.qr_token}</code>
      </div>

      <style>{`@media print { aside, header, nav, .iu-btn, [data-testid="open-sidebar-button"] { display: none !important; } }`}</style>
    </div>
  );
}
