import React, { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";

/**
 * QR scanner via the user's webcam. Calls onScan(text) once per detection.
 * Stops after first successful scan unless `continuous` is set.
 */
export default function QrScanner({ onScan, onError, height = 320, continuous = false }) {
  const ref = useRef(null);
  const instanceRef = useRef(null);
  const stoppedRef = useRef(false);
  const [status, setStatus] = useState("Requesting camera…");
  const elementId = "qr-scanner-region";

  useEffect(() => {
    let cancelled = false;
    const start = async () => {
      const el = document.getElementById(elementId);
      if (!el) return;
      try {
        const qr = new Html5Qrcode(elementId, { verbose: false });
        instanceRef.current = qr;
        const config = { fps: 10, qrbox: { width: 220, height: 220 } };

        const handleSuccess = async (decoded) => {
          if (stoppedRef.current) return;
          if (!continuous) {
            stoppedRef.current = true;
            try { await qr.stop(); } catch {}
          }
          onScan?.(decoded);
        };
        try {
          await qr.start({ facingMode: "environment" }, config, handleSuccess, () => {});
        } catch (e) {
          // Fallback to user-facing camera (laptops)
          await qr.start({ facingMode: "user" }, config, handleSuccess, () => {});
        }
        if (!cancelled) setStatus("");
      } catch (err) {
        const msg = err?.message || String(err);
        setStatus(msg.includes("Permission") ? "Camera blocked — allow camera access for this site." : "Could not start camera. " + msg);
        onError?.(err);
      }
    };
    start();
    return () => {
      cancelled = true;
      stoppedRef.current = true;
      const inst = instanceRef.current;
      if (inst) {
        inst.stop().catch(() => {}).finally(() => { try { inst.clear(); } catch {} });
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="w-full">
      <div
        id={elementId}
        ref={ref}
        data-testid="qr-scanner-region"
        style={{ width: "100%", minHeight: height, background: "#0F172A", borderRadius: 12, overflow: "hidden" }}
      />
      {status && (
        <p className="mt-2 text-sm text-slate-600" data-testid="qr-scanner-status">{status}</p>
      )}
    </div>
  );
}
