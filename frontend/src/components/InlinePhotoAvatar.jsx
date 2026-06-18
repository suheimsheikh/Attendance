import React, { useRef, useState } from "react";
import { Loader2, Camera, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";
import { fileToResizedDataUrl } from "../utils";
import Avatar from "./Avatar";

/**
 * Avatar that doubles as a click-to-upload control. Hovering reveals a small
 * "Camera" badge (replace) plus, when the member already has a photo on file,
 * a small "Trash" badge to clear it — deleting the photo brings back the
 * initials avatar AND ensures the next bulk muster check-in re-prompts the
 * coach for a fresh capture (useful when a wrong photo got uploaded).
 *
 * Renders inline in the Members table.
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

  const onDelete = async (e) => {
    e.stopPropagation();
    if (!window.confirm(`Delete the photo for ${member.full_name}? The next muster check-in will ask for a new one.`)) return;
    setBusy(true);
    try {
      const updated = await api.patch(`/members/${member.id}`, { photo: "" });
      onUpdated && onUpdated(updated);
      toast.success("Photo removed");
    } catch (err) {
      toast.error(err?.message || "Couldn't remove photo");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="relative group cursor-pointer"
      onClick={(e) => { e.stopPropagation(); fileRef.current?.click(); }}
      title={member.photo ? "Tap to replace photo (hover for delete)" : "Tap to upload photo"}
      data-testid={`inline-photo-${member.id}`}
      style={{ width: size, height: size, flexShrink: 0 }}
    >
      <Avatar name={member.full_name} photo={member.photo} size={size} />
      {/* Camera (replace / upload) badge */}
      <span
        className="absolute -bottom-0.5 -right-0.5 w-5 h-5 rounded-full bg-slate-900 text-white flex items-center justify-center border-2 border-white shadow opacity-0 group-hover:opacity-100 transition"
        style={{ opacity: busy ? 1 : undefined }}
      >
        {busy ? <Loader2 size={10} className="animate-spin" /> : <Camera size={10} />}
      </span>
      {/* Delete badge — only when the member already has a photo. */}
      {member.photo && !busy && (
        <button
          type="button"
          onClick={onDelete}
          data-testid={`inline-photo-delete-${member.id}`}
          aria-label="Delete photo"
          title="Delete photo"
          className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-rose-600 text-white flex items-center justify-center border-2 border-white shadow opacity-0 group-hover:opacity-100 hover:bg-rose-700 transition"
        >
          <Trash2 size={10} />
        </button>
      )}
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
