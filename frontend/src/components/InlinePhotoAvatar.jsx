import React, { useRef, useState } from "react";
import { Loader2, Maximize2, Camera } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";
import { fileToResizedDataUrl } from "../utils";
import Avatar from "./Avatar";
import PhotoZoom from "./PhotoZoom";

/**
 * Avatar with a click-to-zoom modal that carries Replace / Remove
 * actions. Rewired 7 Jul 2026 — the previous hover-to-reveal
 * camera + trash badges felt like "download and delete" chips to
 * users and were easy to click by accident.
 *
 * New flow:
 *   • Click the avatar → PhotoZoom modal opens.
 *     - Photo present → shows the photo at full quality with
 *       Replace + Remove footer buttons.
 *     - No photo yet → shows the initials-only avatar with a single
 *       "Add photo" button.
 *   • Hover shows a subtle "expand" glyph so the affordance is
 *     obvious without exposing raw action badges.
 *   • The parent's `onUpdated(updated_member)` callback fires after
 *     both Replace and Remove.
 */
export default function InlinePhotoAvatar({ member, size = 40, onUpdated }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);

  const savePhoto = async (file) => {
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast.error("Please pick an image file"); return; }
    setBusy(true);
    try {
      const dataUrl = await fileToResizedDataUrl(file);
      const updated = await api.patch(`/members/${member.id}`, { photo: dataUrl });
      onUpdated && onUpdated(updated);
      toast.success("Photo updated");
      setZoomOpen(false);
    } catch (err) {
      toast.error(err?.message || "Couldn't save photo");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removePhoto = async () => {
    if (!window.confirm(`Remove the photo for ${member.full_name}? The next muster check-in will re-prompt for a new one.`)) return;
    setBusy(true);
    try {
      const updated = await api.patch(`/members/${member.id}`, { photo: "" });
      onUpdated && onUpdated(updated);
      toast.success("Photo removed");
      setZoomOpen(false);
    } catch (err) {
      toast.error(err?.message || "Couldn't remove photo");
    } finally {
      setBusy(false);
    }
  };

  const openPicker = () => fileRef.current?.click();

  return (
    <>
      <button
        type="button"
        className="relative group cursor-pointer bg-transparent border-0 p-0"
        onClick={(e) => { e.stopPropagation(); setZoomOpen(true); }}
        title="Click to view / edit photo"
        data-testid={`inline-photo-${member.id}`}
        style={{ width: size, height: size, flexShrink: 0 }}
      >
        <Avatar name={member.full_name} photo={member.photo} size={size} />
        {/* Single subtle "expand" affordance on hover. No hover-only
            action chips — actions live in the zoom modal instead. */}
        <span
          className="absolute inset-0 rounded-full flex items-center justify-center bg-slate-900/40 text-white opacity-0 group-hover:opacity-100 transition"
          aria-hidden="true"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Maximize2 size={12} />}
        </span>
      </button>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => savePhoto(e.target.files?.[0])}
        data-testid={`inline-photo-input-${member.id}`}
      />

      {zoomOpen && (
        <PhotoZoom
          name={member.full_name}
          photo={member.photo}
          subtitle={member.photo
            ? "Click Replace to upload a new photo."
            : "No photo yet — click Add photo to upload one."}
          onClose={() => setZoomOpen(false)}
          onReplace={openPicker}
          onRemove={removePhoto}
        />
      )}
    </>
  );
}
