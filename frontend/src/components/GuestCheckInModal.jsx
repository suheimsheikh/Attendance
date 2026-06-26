import React, { useState } from "react";
import { X, UserPlus, Loader2, Camera, Check } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";
import { useEscape } from "../hooks/useEscape";
import SelfieCapture from "./SelfieCapture";
import FormErrorBanner from "./FormErrorBanner";
import { useFormError } from "../hooks/useFormError";

/**
 * GuestCheckInModal — coaches & admins use this to log a non-member visitor.
 * Captures a name and (mandatorily) a photo so the guest later appears on the
 * Presence Board with the same affordances as a regular member.
 */
export default function GuestCheckInModal({ onClose, onCheckedIn }) {
  useEscape(onClose);
  const [name, setName] = useState("");
  const [photo, setPhoto] = useState("");
  const [showCamera, setShowCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const formErr = useFormError();

  const submit = async (e) => {
    e?.preventDefault?.();
    formErr.clear();
    if (!name.trim()) { formErr.setMessage("Enter the guest's name"); return; }
    if (!photo) { formErr.setMessage("Capture a photo first"); return; }
    setBusy(true);
    try {
      await api.post("/guests/checkin", { name: name.trim(), photo });
      toast.success(`${name.trim()} checked in`);
      onCheckedIn?.();
      onClose?.();
    } catch (err) {
      formErr.setFromApi(err, "Failed to check in guest");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50 p-0 md:p-4" onClick={onClose}>
      <div
        className="bg-white w-full md:max-w-md rounded-t-2xl md:rounded-2xl p-6 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
        data-testid="guest-checkin-modal"
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-lg bg-violet-100 text-violet-700 flex items-center justify-center">
              <UserPlus size={18} />
            </div>
            <h2 className="text-xl font-extrabold">Check in a guest</h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg" data-testid="guest-close">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="iu-label">Guest&apos;s name</label>
            <input
              data-testid="guest-name-input"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. John Doe · parent · ambassador…"
              className="iu-input"
              maxLength={80}
            />
          </div>

          <div>
            <label className="iu-label">Photo</label>
            {photo ? (
              <div className="relative inline-block">
                <img
                  src={photo}
                  alt="Guest"
                  data-testid="guest-photo-preview"
                  className="w-32 h-32 rounded-2xl object-cover ring-2 ring-violet-200"
                />
                <button
                  type="button"
                  onClick={() => setShowCamera(true)}
                  data-testid="guest-retake"
                  className="absolute bottom-1 right-1 bg-white shadow rounded-full p-1.5 hover:bg-violet-50"
                  title="Retake"
                >
                  <Camera size={14} className="text-violet-700" />
                </button>
                <div className="absolute -top-1.5 -right-1.5 bg-emerald-500 text-white rounded-full p-1">
                  <Check size={12} />
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowCamera(true)}
                data-testid="guest-open-camera"
                className="w-full h-32 rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50 text-slate-500 hover:bg-violet-50 hover:border-violet-300 hover:text-violet-700 transition flex flex-col items-center justify-center gap-2"
              >
                <Camera size={28} />
                <span className="text-xs font-bold">Tap to take photo</span>
              </button>
            )}
            <p className="text-[11px] text-slate-500 mt-1.5">A photo is required — it helps the muster log match the visitor later.</p>
          </div>

          <FormErrorBanner
            error={formErr.error}
            requestId={formErr.requestId}
            onDismiss={formErr.clear}
            testId="guest-submit-error"
          />
          <button
            data-testid="guest-submit"
            type="submit"
            disabled={busy || !name.trim() || !photo}
            className="iu-btn-primary w-full"
          >
            {busy ? <Loader2 className="animate-spin" size={16} /> : <UserPlus size={16} />}
            Check in guest
          </button>
        </form>

        {showCamera && (
          <SelfieCapture
            title="Take guest photo"
            subtitle="Point the camera at the visitor. They can hold a card with their organisation name if useful."
            facingMode="environment"
            onCapture={(url) => { setPhoto(url); setShowCamera(false); }}
            onClose={() => setShowCamera(false)}
          />
        )}
      </div>
    </div>
  );
}
