import React, { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

/**
 * Robust QR scanner.
 *
 * Uses raw getUserMedia + canvas + jsQR rather than html5-qrcode, which had
 * detection issues on Android Chrome (camera turned on but never decoded).
 * If the platform exposes a native BarcodeDetector (modern Chromium), we use
 * that for higher accuracy + lower CPU; otherwise we fall back to jsQR.
 *
 * Props:
 *   onScan(text)   — fired once with the decoded string (unless `continuous`)
 *   onError(err)   — fired if the camera can't start at all
 *   continuous     — keep scanning after first hit (default false)
 */
export default function QrScanner({ onScan, onError, continuous = false }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const scannedRef = useRef(false);
  const detectorRef = useRef(null);
  const [status, setStatus] = useState("Requesting camera…");
  const [framesScanned, setFramesScanned] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const stop = () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      const s = streamRef.current;
      if (s) {
        try { s.getTracks().forEach((t) => t.stop()); } catch (e) { console.debug("stop tracks failed:", e?.message); }
        streamRef.current = null;
      }
    };

    const fire = (text) => {
      if (scannedRef.current && !continuous) return;
      scannedRef.current = true;
      try { onScan?.(text); }
      catch (e) { console.debug("onScan handler threw:", e?.message); }
      if (!continuous) stop();
    };

    const scanLoop = async () => {
      if (cancelled || (scannedRef.current && !continuous)) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < 2 || !video.videoWidth) {
        rafRef.current = requestAnimationFrame(scanLoop);
        return;
      }
      const w = video.videoWidth;
      const h = video.videoHeight;
      // Native BarcodeDetector path (Chromium, very fast & accurate).
      if (detectorRef.current) {
        try {
          const codes = await detectorRef.current.detect(video);
          if (codes && codes.length && codes[0].rawValue) {
            fire(codes[0].rawValue);
            return;
          }
        } catch (e) {
          // Fall through to jsQR if the detector throws on this frame.
        }
      } else {
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        try {
          ctx.drawImage(video, 0, 0, w, h);
          const imageData = ctx.getImageData(0, 0, w, h);
          const code = jsQR(imageData.data, w, h, { inversionAttempts: "attemptBoth" });
          if (code && code.data) {
            fire(code.data);
            return;
          }
        } catch (e) {
          // Frame draw can transiently fail (e.g. between page-visibility
          // toggles); just try the next animation tick.
          console.debug("scan frame failed:", e?.message);
        }
      }
      // Update diagnostic counter every ~10 frames (cheap, helps verify the
      // loop is actually running).
      if (Math.random() < 0.1) setFramesScanned((n) => n + 1);
      rafRef.current = requestAnimationFrame(scanLoop);
    };

    const start = async () => {
      // Prepare BarcodeDetector if the browser supports it.
      try {
        if (typeof window !== "undefined" && "BarcodeDetector" in window) {
          const supported = await window.BarcodeDetector.getSupportedFormats?.();
          if (!supported || supported.includes("qr_code")) {
            detectorRef.current = new window.BarcodeDetector({ formats: ["qr_code"] });
          }
        }
      } catch (e) {
        detectorRef.current = null;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        // iOS Safari requires both these attributes inline (not just JS prop).
        video.setAttribute("playsinline", "true");
        video.setAttribute("muted", "true");
        await video.play();
        if (!cancelled) {
          setStatus("");
          rafRef.current = requestAnimationFrame(scanLoop);
        }
      } catch (err) {
        const msg = err?.message || String(err) || "Unknown camera error";
        const userMsg = /Permission|NotAllowed/i.test(msg)
          ? "Camera blocked — allow camera access for this site in your browser settings."
          : /NotFound|Requested device not found/i.test(msg)
          ? "No camera detected on this device — switch to GPS only."
          : /NotReadable|in use|AbortError/i.test(msg)
          ? "Camera is busy (another app may be using it). Close other apps and try again."
          : "Could not start camera. " + msg;
        setStatus(userMsg);
        try { onError?.(err); } catch (e) { console.debug("onError handler threw:", e?.message); }
      }
    };

    start();
    return () => {
      cancelled = true;
      scannedRef.current = true;
      stop();
    };
     
  }, []);

  return (
    <div className="w-full">
      <div
        data-testid="qr-scanner-region"
        style={{
          position: "relative",
          width: "100%",
          maxWidth: 360,
          margin: "0 auto",
          aspectRatio: "1 / 1",
          background: "#0F172A",
          borderRadius: 12,
          overflow: "hidden",
        }}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
        {/* Visual reticle so users know where to aim — the actual scan covers
            the full video frame so even a QR outside the box still decodes. */}
        <div
          style={{
            position: "absolute",
            inset: "16%",
            border: "3px solid rgba(255,255,255,0.65)",
            borderRadius: 16,
            boxShadow: "0 0 0 9999px rgba(15,23,42,0.35) inset",
            pointerEvents: "none",
          }}
        />
        <canvas ref={canvasRef} style={{ display: "none" }} />
      </div>
      <p className="mt-2 text-xs text-slate-500 text-center" data-testid="qr-scanner-status">
        {status || (detectorRef.current ? "Scanning (native)…" : `Scanning… frames seen: ${framesScanned * 10}`)}
      </p>
      <SnapshotFallback onDecoded={(text) => { scannedRef.current = true; try { onScan?.(text); } catch (e) { console.debug(e); } }} />
    </div>
  );
}

/**
 * Fallback "take a photo" button. Opens the OS-native camera (much more capable
 * than the browser's live <video> pipeline), then decodes the resulting still
 * with jsQR off-camera. Works when live scanning fails for any reason.
 */
function SnapshotFallback({ onDecoded }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const onFile = async (e) => {
    setErr("");
    const file = e.target.files?.[0];
    e.target.value = "";  // reset so the same file can be picked again
    if (!file) return;
    setBusy(true);
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      const imgData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      const code = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: "attemptBoth" });
      if (code && code.data) {
        onDecoded(code.data);
      } else {
        setErr("Couldn't read a QR in that photo. Try again, holding closer / steadier.");
      }
    } catch (ex) {
      setErr("Couldn't decode that image: " + (ex?.message || ""));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 text-center">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={onFile}
        data-testid="snapshot-input"
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="text-xs font-semibold text-slate-700 underline hover:text-slate-900"
        data-testid="snapshot-button"
      >
        {busy ? "Decoding…" : "📷 Or: take a photo of the QR instead"}
      </button>
      {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
    </div>
  );
}
