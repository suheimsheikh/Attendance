import React, { useState } from "react";
import { Users, Share2, Loader2 } from "lucide-react";
import { api } from "../../api";
import { shareToWhatsApp } from "../../utils/shareWhatsApp";
import { toast } from "sonner";

const fmtDay = (iso) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
  });

/**
 * PresentShareButton — post-muster batch share of "who's here today"
 * as a single WhatsApp message with a **photo mosaic** of every
 * currently-checked-in athlete plus a text caption.
 *
 * Data source: `/muster/athletes?mode=checkout` returns the current
 * open-session roster (i.e. the people the coach just ticked in).
 *
 * Mosaic: drawn on an off-screen canvas — 5 photos per row, 108×108
 * each, name label under each thumb. Rendered on-demand at click
 * time (heavy work) so we don't block the initial Muster paint.
 * Same-origin photo URLs (`/api/members/{id}/photo?v=...`) mean the
 * canvas can be exported to a Blob without tainting.
 */

const COLS = 5;
const CELL_W = 130;
const CELL_H = 156;   // 108 photo + 8 gap + ~30 name
const PHOTO_SIZE = 108;
const PADDING = 24;
const HEADER_H = 84;

// Load an image element and resolve when it's ready. Falls back
// silently on error so a missing photo doesn't kill the whole share.
const loadImage = (src) => new Promise((resolve) => {
  if (!src) return resolve(null);
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => resolve(null);
  // Same-origin path — no crossOrigin attr needed. Anonymous crossOrigin
  // is fine as a defensive default for cases where a CDN wraps the API.
  img.crossOrigin = "anonymous";
  img.src = src;
});

// Draw a rounded initials tile as the fallback avatar.
const drawInitialsTile = (ctx, x, y, size, name) => {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = "#e2e8f0"; // slate-200
  ctx.fill();
  const initials = (name || "?").split(/\s+/).slice(0, 2).map((s) => s[0] || "").join("").toUpperCase();
  ctx.fillStyle = "#334155"; // slate-700
  ctx.font = "bold 34px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initials, x + size / 2, y + size / 2);
  ctx.restore();
};

// Draw a circular clipped photo inside the given box.
const drawCircularPhoto = (ctx, img, x, y, size) => {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  // Cover crop — scale so the shortest side fills the circle.
  const scale = Math.max(size / img.width, size / img.height);
  const drawW = img.width * scale;
  const drawH = img.height * scale;
  ctx.drawImage(img, x + (size - drawW) / 2, y + (size - drawH) / 2, drawW, drawH);
  ctx.restore();
  // Subtle ring so the photo doesn't blend into the card.
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.strokeStyle = "#10b981"; // emerald-500
  ctx.lineWidth = 3;
  ctx.stroke();
};

// Ellipsise a name so long names don't overflow their cell.
const ellipsise = (ctx, txt, maxW) => {
  if (!txt) return "";
  if (ctx.measureText(txt).width <= maxW) return txt;
  let s = txt;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
};

/**
 * Build the mosaic image as a Blob. Returns null if there are no
 * present members (nothing to share) or the canvas fails.
 */
async function buildMosaicBlob(present, dateISO, officeName) {
  if (!present.length) return null;
  const rows = Math.ceil(present.length / COLS);
  const width = COLS * CELL_W + PADDING * 2;
  const height = HEADER_H + rows * CELL_H + PADDING;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // Background
  ctx.fillStyle = "#f8fafc"; // slate-50
  ctx.fillRect(0, 0, width, height);
  // Header
  ctx.fillStyle = "#065f46"; // emerald-800
  ctx.font = "bold 28px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(`✅ Present today · ${fmtDay(dateISO)}`, PADDING, PADDING);
  ctx.fillStyle = "#475569"; // slate-600
  ctx.font = "18px system-ui, sans-serif";
  ctx.fillText(`${present.length} checked-in${officeName ? " · " + officeName : ""}`, PADDING, PADDING + 36);
  // Preload all photos in parallel.
  const imgs = await Promise.all(present.map((m) => loadImage(m.photo)));
  // Draw cells
  present.forEach((m, i) => {
    const row = Math.floor(i / COLS);
    const col = i % COLS;
    const cx = PADDING + col * CELL_W + (CELL_W - PHOTO_SIZE) / 2;
    const cy = HEADER_H + row * CELL_H;
    if (imgs[i]) drawCircularPhoto(ctx, imgs[i], cx, cy, PHOTO_SIZE);
    else drawInitialsTile(ctx, cx, cy, PHOTO_SIZE, m.full_name);
    // Name label
    ctx.fillStyle = "#0f172a"; // slate-900
    ctx.font = "600 14px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const name = ellipsise(ctx, m.full_name || "—", CELL_W - 8);
    ctx.fillText(name, PADDING + col * CELL_W + CELL_W / 2, cy + PHOTO_SIZE + 8);
  });
  return await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.9));
}

function buildCaption(present, dateISO, officeName) {
  const head = `✅ Present today · ${fmtDay(dateISO)}`;
  if (!present.length) return `${head}\n\n(no one has checked in yet)`;
  const names = present.slice(0, 40).map((m) => `• ${m.full_name}`);
  if (present.length > 40) names.push(`…and ${present.length - 40} more`);
  const tail = officeName ? `\n\n— ${officeName}` : "";
  return `${head}\nTotal: ${present.length}\n\n${names.join("\n")}${tail}`;
}

/**
 * Fetch today's present athletes, build the mosaic, hand off to the
 * OS share sheet.  The `officeName` prop is optional; if missing we
 * still work with an anonymous caption.
 */
export default function PresentShareButton({ officeName }) {
  const [busy, setBusy] = useState(false);
  const handleClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.get("/muster/athletes", { mode: "checkout", scope: "athletes" });
      const present = (res.athletes || []).filter(Boolean);
      if (!present.length) {
        toast.error("Nobody is checked-in yet — nothing to share.");
        return;
      }
      const dateISO = res.date;
      let imageBlob = null;
      try { imageBlob = await buildMosaicBlob(present, dateISO, officeName); }
      catch (err) { console.warn("mosaic build failed:", err); }
      shareToWhatsApp({
        text: buildCaption(present, dateISO, officeName),
        imageBlob,
        filename: `present_${dateISO}.jpg`,
      });
    } catch (err) {
      toast.error(err?.message || "Couldn't build the present list.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      data-testid="muster-present-share-btn"
      title="Share today's present athletes (with photo collage) to a WhatsApp group"
      className="iu-btn iu-btn-secondary !border-emerald-300 !text-emerald-700 hover:!bg-emerald-50 disabled:opacity-60"
    >
      {busy ? <Loader2 size={15} className="animate-spin"/> : <Users size={15}/>}
      <Share2 size={13} className="ml-0.5"/> Share Present List
    </button>
  );
}
