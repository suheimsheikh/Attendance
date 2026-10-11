// Client-side image compression for ID document scans.
// Resizes the longest edge to ~2000px and re-encodes as JPEG ~82% so the
// stored file, OCR read, on-screen view and Print/Save-as-PDF all use a
// smaller-but-crisp version. PDFs and non-image files are returned untouched.
const MAX_EDGE = 2000;
const QUALITY = 0.82;

export async function compressImage(file) {
  if (!file || !file.type?.startsWith("image/")) return file;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file; // Can't decode — upload as-is.
  }

  const { width, height } = bitmap;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; // flatten any transparency to white for print
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", QUALITY));
  if (!blob || blob.size >= file.size) return file; // compression didn't help

  const name = (file.name || "scan").replace(/\.[^.]+$/, "") + ".jpg";
  return new File([blob], name, { type: "image/jpeg", lastModified: Date.now() });
}
