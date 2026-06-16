import React, { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";

/**
 * QR scanner via the user's webcam. Calls onScan(text) once per detection.
 * Stops after first successful scan unless `continuous` is set.
 *
 * NOTE on error handling: html5-qrcode's lifecycle methods (start/stop/clear)
 * can throw synchronously OR return rejecting promises depending on the device
 * (notably Android Chrome). We wrap every call defensively so a failed teardown
 * never crashes the React tree.
 */
export default function QrScanner({ onScan, onError, height = 320, continuous = false }) {
  const ref = useRef(null);
  const instanceRef = useRef(null);
  const stoppedRef = useRef(false);
  const [status, setStatus] = useState("Requesting camera…");
  const elementId = "qr-scanner-region";

  // Defensive teardown — swallow ALL errors (sync + async).
  const safeStop = async (inst) => {
    if (!inst) return;
    try {
      const p = inst.stop();
      if (p && typeof p.then === "function") {
        await p.catch((e) => console.debug("qr.stop async failed:", e?.message || e));
      }
    } catch (e) {
      console.debug("qr.stop sync failed:", e?.message || e);
    }
    try { inst.clear(); }
    catch (e) { console.debug("qr.clear failed:", e?.message || e); }
  };

  useEffect(() => {
    let cancelled = false;
    const start = async () => {
      const el = document.getElementById(elementId);
      if (!el) return;
      try {
        const qr = new Html5Qrcode(elementId, { verbose: false });
        instanceRef.current = qr;
        const config = { fps: 10, qrbox: { width: 220, height: 220 } };

        const handleSuccess = (decoded) => {
          // Guard: only fire onScan once. Don't call qr.stop() here —
          // the parent will unmount us via state change, and our cleanup
          // useEffect will tear the camera down safely.
          if (stoppedRef.current) return;
          stoppedRef.current = true;
          try { onScan?.(decoded); }
          catch (e) { console.debug("onScan handler threw:", e?.message || e); }
        };

        try {
          await qr.start({ facingMode: "environment" }, config, handleSuccess, () => {});
        } catch (e) {
          // Fallback to user-facing camera (laptops / front-cam-only devices).
          try {
            await qr.start({ facingMode: "user" }, config, handleSuccess, () => {});
          } catch (e2) {
            throw e2;
          }
        }
        if (!cancelled) setStatus("");
      } catch (err) {
        const msg = err?.message || String(err) || "Unknown camera error";
        const userMsg = /Permission|NotAllowed/i.test(msg)
          ? "Camera blocked — allow camera access for this site in your browser settings."
          : /NotFound|Requested device not found/i.test(msg)
          ? "No camera detected on this device — switch to GPS only."
          : /NotReadable|in use/i.test(msg)
          ? "Camera is busy (another app may be using it). Close other apps and try again."
          : "Could not start camera. " + msg;
        setStatus(userMsg);
        try { onError?.(err); } catch (e) { console.debug("onError handler threw:", e?.message); }
      }
    };
    start();
    return () => {
      cancelled = true;
      stoppedRef.current = true;
      const inst = instanceRef.current;
      instanceRef.current = null;
      // Fire & forget — never await in a cleanup. Promise + sync errors swallowed.
      safeStop(inst);
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
