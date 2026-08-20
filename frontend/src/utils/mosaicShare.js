/**
 * Photo-mosaic share helper (Feb 2026) — shared between the muster
 * "Present List" banner and the bulk-checkin auto-share flow.  Draws a
 * grid of circular member photos with a header on an off-screen canvas
 * and returns a JPEG blob suitable for `navigator.share`.
 *
 * Same-origin photo URLs (`/api/members/{id}/photo?v=…`) mean the
 * canvas can be exported to a Blob without a CORS taint.
 */

const COLS = 5;
const CELL_W = 130;
const CELL_H = 156;    // 108 photo + 8 gap + ~30 name
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
  img.crossOrigin = "anonymous";
  img.src = src;
});

const drawInitialsTile = (ctx, x, y, size, name) => {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = "#e2e8f0";
  ctx.fill();
  const initials = (name || "?").split(/\s+/).slice(0, 2).map((s) => s[0] || "").join("").toUpperCase();
  ctx.fillStyle = "#334155";
  ctx.font = "bold 34px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(initials, x + size / 2, y + size / 2);
  ctx.restore();
};

const drawCircularPhoto = (ctx, img, x, y, size) => {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  const scale = Math.max(size / img.width, size / img.height);
  const drawW = img.width * scale;
  const drawH = img.height * scale;
  ctx.drawImage(img, x + (size - drawW) / 2, y + (size - drawH) / 2, drawW, drawH);
  ctx.restore();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.strokeStyle = "#10b981";
  ctx.lineWidth = 3;
  ctx.stroke();
};

const ellipsise = (ctx, txt, maxW) => {
  if (!txt) return "";
  if (ctx.measureText(txt).width <= maxW) return txt;
  let s = txt;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
};

/**
 * Build a JPEG blob showing a grid of member photos with a header.
 * @param {{full_name:string, photo?:string}[]} members
 * @param {string} title — big header text (e.g. "✅ Checked in · 09:34")
 * @param {string} [subtitle] — small header text (e.g. "3 athletes · YCH Boat Shed")
 * @returns {Promise<Blob|null>}
 */
export async function buildPhotoMosaicBlob(members, title, subtitle) {
  if (!members?.length) return null;
  const rows = Math.ceil(members.length / COLS);
  const width = COLS * CELL_W + PADDING * 2;
  const height = HEADER_H + rows * CELL_H + PADDING;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#f8fafc";
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = "#065f46";
  ctx.font = "bold 28px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(title, PADDING, PADDING);

  if (subtitle) {
    ctx.fillStyle = "#475569";
    ctx.font = "18px system-ui, sans-serif";
    ctx.fillText(subtitle, PADDING, PADDING + 36);
  }

  const imgs = await Promise.all(members.map((m) => loadImage(m.photo)));
  members.forEach((m, i) => {
    const row = Math.floor(i / COLS);
    const col = i % COLS;
    const cx = PADDING + col * CELL_W + (CELL_W - PHOTO_SIZE) / 2;
    const cy = HEADER_H + row * CELL_H;
    if (imgs[i]) drawCircularPhoto(ctx, imgs[i], cx, cy, PHOTO_SIZE);
    else drawInitialsTile(ctx, cx, cy, PHOTO_SIZE, m.full_name);
    ctx.fillStyle = "#0f172a";
    ctx.font = "600 14px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const name = ellipsise(ctx, m.full_name || "—", CELL_W - 8);
    ctx.fillText(name, PADDING + col * CELL_W + CELL_W / 2, cy + PHOTO_SIZE + 8);
  });

  return await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.9));
}
