/**
 * shareToWhatsApp — one-tap share of a check-in event to any WhatsApp
 * chat (parents' group, coaches' group, individual). Uses the browser
 * Web Share API when available (Android Chrome, iOS Safari, most
 * modern mobile browsers) so the OS share sheet appears with WhatsApp
 * as the natural target. Falls back to the `wa.me` deep link on desktop
 * or older browsers — that pops a "choose contact" screen in WhatsApp.
 *
 * WhatsApp's Business/Cloud APIs cannot post into groups (Meta policy),
 * so a human tap is unavoidable. This flow keeps that tap to one click.
 *
 * @param {Object} opts
 * @param {string} opts.text        Caption / message body.
 * @param {Blob=}  opts.imageBlob   Optional image (selfie). Included as a
 *                                  File when the platform supports file
 *                                  sharing; silently dropped otherwise.
 * @param {string=} opts.filename   Filename for the image File.
 * @returns {Promise<{ok: boolean, mode: string}>}
 */
export async function shareToWhatsApp({ text, imageBlob, filename = "checkin.jpg" }) {
  try {
    if (imageBlob && typeof navigator !== "undefined" && navigator.canShare) {
      const file = new File([imageBlob], filename, {
        type: imageBlob.type || "image/jpeg",
      });
      const payload = { text, files: [file] };
      if (navigator.canShare(payload)) {
        await navigator.share(payload);
        return { ok: true, mode: "web-share-file" };
      }
    }
    if (typeof navigator !== "undefined" && navigator.share) {
      await navigator.share({ text });
      return { ok: true, mode: "web-share-text" };
    }
  } catch (e) {
    if (e?.name === "AbortError") return { ok: false, mode: "cancelled" };
    // fall through to deep-link fallback
  }
  // Desktop / older browser fallback — opens WhatsApp with the text
  // pre-filled; user picks the chat manually.
  const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
  if (typeof window !== "undefined") window.open(url, "_blank", "noopener");
  return { ok: true, mode: "wa-me" };
}

/** Format the standard check-in caption used across self / escort / muster. */
export function formatCheckinCaption({ action, name, siteName, when = new Date() }) {
  const hhmm = when.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  });
  const isOut = action === "checkout";
  const emoji = isOut ? "🏁" : "✅";
  const verb  = isOut ? "Check-out" : "Check-in";
  const bits = [`${emoji} ${name}`, `${verb} ${hhmm}`];
  if (siteName) bits.push(siteName);
  return bits.join(" · ");
}

/** Convert a data-URL selfie to a Blob so the Web Share API can attach it. */
export async function dataUrlToBlob(dataUrl) {
  if (!dataUrl) return null;
  try {
    const res = await fetch(dataUrl);
    return await res.blob();
  } catch {
    return null;
  }
}
