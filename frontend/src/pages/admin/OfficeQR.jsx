import React, { useEffect, useState } from "react";
import { Loader2, RefreshCw, Printer, AlertTriangle, X } from "lucide-react";
import QRCode from "react-qr-code";
import { toast } from "sonner";
import { api } from "../../api";

export default function OfficeQR() {
  const [office, setOffice] = useState(null);
  const [regen, setRegen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => { api.get("/office").then(setOffice); }, []);

  const regenerate = async () => {
    setRegen(true);
    setConfirmOpen(false);
    try {
      const res = await api.post("/office/regenerate-qr");
      if (!res?.qr_token) throw new Error("Server didn't return a new token");
      setOffice((o) => ({ ...o, qr_token: res.qr_token }));
      toast.success(`New Office QR generated: ${res.qr_token}`);
    } catch (err) {
      console.error("regenerate-qr failed:", err);
      toast.error(err?.message || "Failed to regenerate QR");
    } finally {
      setRegen(false);
    }
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
          <button data-testid="regenerate-office-qr" onClick={() => setConfirmOpen(true)} disabled={regen} className="iu-btn-danger">
            {regen ? <Loader2 className="animate-spin" size={14}/> : <RefreshCw size={14}/>} Regenerate
          </button>
        </div>
      </header>

      {confirmOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => !regen && setConfirmOpen(false)}
          data-testid="regenerate-confirm-overlay"
        >
          <div className="bg-white rounded-2xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-lg bg-red-100 text-red-700 flex items-center justify-center shrink-0">
                <AlertTriangle size={18} />
              </div>
              <div className="flex-1">
                <h2 className="text-lg font-extrabold text-slate-900">Generate a new Office QR?</h2>
                <p className="text-sm text-slate-600 mt-1">
                  The current QR <code className="text-xs bg-slate-100 px-1 rounded">{office.qr_token}</code> will stop
                  working immediately. Any printed copies will become invalid. You'll need to reprint and replace them.
                </p>
              </div>
              <button
                onClick={() => setConfirmOpen(false)}
                disabled={regen}
                className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-500"
                data-testid="regenerate-cancel-x"
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex gap-2 mt-5">
              <button
                onClick={() => setConfirmOpen(false)}
                disabled={regen}
                className="iu-btn-secondary flex-1"
                data-testid="regenerate-cancel-button"
              >
                Cancel
              </button>
              <button
                onClick={regenerate}
                disabled={regen}
                className="iu-btn-danger flex-1"
                data-testid="regenerate-confirm-button"
              >
                {regen ? <Loader2 className="animate-spin" size={14}/> : <RefreshCw size={14}/>} Regenerate
              </button>
            </div>
          </div>
        </div>
      )}

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
