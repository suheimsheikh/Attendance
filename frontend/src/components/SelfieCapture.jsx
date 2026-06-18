import React, { useEffect, useRef, useState } from "react";
import { Camera, X, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";

/**
 * SelfieCapture — full-screen modal that opens the device camera (front-facing)
 * and lets the user (or another person) take a still photo. Returns the JPEG
 * data URL via onCapture. Press ESC or × to close without saving.
 */
export default function SelfieCapture({ title = "Take a selfie", subtitle, facingMode = "user", onCapture, onClose }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode, width: { ideal: 720 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch (e) {
        setErr(e?.message || "Could not access camera");
      }
    })();
    return () => {
      cancelled = true;
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, [facingMode]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const snap = () => {
    const v = videoRef.current;
    if (!v) return;
    const w = v.videoWidth || 720;
    const h = v.videoHeight || 720;
    const side = Math.min(w, h);
    const sx = (w - side) / 2;
    const sy = (h - side) / 2;
    const c = document.createElement("canvas");
    c.width = 320; c.height = 320;
    c.getContext("2d").drawImage(v, sx, sy, side, side, 0, 0, 320, 320);
    setPreview(c.toDataURL("image/jpeg", 0.82));
  };

  const accept = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      await onCapture?.(preview);
    } catch (e) {
      toast.error(e?.message || "Could not save photo");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-3" data-testid="selfie-capture">
      <div className="bg-white rounded-2xl max-w-md w-full overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex items-center gap-3">
          <Camera size={18} className="text-slate-600" />
          <div className="flex-1 min-w-0">
            <div className="font-extrabold text-slate-900">{title}</div>
            {subtitle && <div className="text-xs text-slate-500 mt-0.5">{subtitle}</div>}
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg" data-testid="selfie-close">
            <X size={18} />
          </button>
        </div>

        <div className="bg-slate-900 aspect-square w-full overflow-hidden flex items-center justify-center">
          {err ? (
            <div className="text-center px-6 text-sm text-red-300">
              <Camera size={32} className="mx-auto mb-3 opacity-60" />
              <p className="font-semibold">Camera unavailable</p>
              <p className="text-xs mt-1 text-red-300/70">{err}</p>
            </div>
          ) : preview ? (
            <img src={preview} alt="preview" className="w-full h-full object-cover" />
          ) : (
            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" style={{ transform: facingMode === "user" ? "scaleX(-1)" : "none" }} />
          )}
        </div>

        <div className="p-4 flex gap-2 justify-center">
          {preview ? (
            <>
              <button onClick={() => setPreview(null)} className="iu-btn-secondary" data-testid="selfie-retake">
                <RotateCcw size={14} /> Retake
              </button>
              <button onClick={accept} disabled={busy} className="iu-btn-primary" data-testid="selfie-save">
                {busy ? <Loader2 className="animate-spin" size={14} /> : "Use this photo"}
              </button>
            </>
          ) : (
            <>
              <button onClick={onClose} className="iu-btn-secondary" data-testid="selfie-skip">Skip</button>
              <button onClick={snap} disabled={!!err} className="iu-btn-primary" data-testid="selfie-snap">
                <Camera size={14} /> Capture
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
