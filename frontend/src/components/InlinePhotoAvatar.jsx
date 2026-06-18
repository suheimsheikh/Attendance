import React, { useRef, useState } from "react";
import { Loader2, Camera } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";
import { fileToResizedDataUrl } from "../utils";
import Avatar from "./Avatar";

/**
 * Avatar that doubles as a click-to-upload control. Tapping the circle (or
 * the small "Camera" badge that appears on hover) opens the system file
 * picker; the image is shrunk client-side and PATCHed to /members/{id}.
 *
 * Renders inline in the Members table — the Avatar component already shows
 * the photo (or initials fallback), so we just decorate it with an upload
 * trigger and a busy spinner overlay.
 */
export default function InlinePhotoAvatar({ member, size = 40, onUpdated }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);

  const onPick = async (file) => {
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast.error("Please pick an image file"); return; }
    setBusy(true);
    try {
      const dataUrl = await fileToResizedDataUrl(file);
      const updated = await api.patch(`/members/${member.id}`, { photo: dataUrl });
      onUpdated && onUpdated(updated);
      toast.success("Photo updated");
    } catch (err) {
      toast.error(err?.message || "Couldn't save photo");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div
      className="relative group cursor-pointer"
      onClick={(e) => { e.stopPropagation(); fileRef.current?.click(); }}
      title="Tap to upload photo"
      data-testid={`inline-photo-${member.id}`}
      style={{ width: size, height: size, flexShrink: 0 }}
    >
      <Avatar name={member.full_name} photo={member.photo} size={size} />
      {/* Hover badge — replaces with spinner while uploading. */}
      <span
        className="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full bg-slate-900 text-white flex items-center justify-center border-2 border-white shadow opacity-0 group-hover:opacity-100 transition"
        style={{ opacity: busy ? 1 : undefined }}
      >
        {busy ? <Loader2 size={10} className="animate-spin" /> : <Camera size={10} />}
      </span>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => onPick(e.target.files?.[0])}
        data-testid={`inline-photo-input-${member.id}`}
      />
    </div>
  );
}
