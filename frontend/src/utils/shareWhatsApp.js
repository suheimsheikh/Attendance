import { toast } from "sonner";

/**
 * shareToWhatsApp — one-tap share of a check-in event to any WhatsApp
 * chat (parents' group, coaches' group, individual).
 *
 * Platform behaviour:
 *   • **Mobile** (Android Chrome, iOS Safari) — uses the Web Share API
 *     so the OS share sheet appears with WhatsApp as a natural target,
 *     including the photo File.
 *   • **Desktop** (Windows/Mac Chrome/Edge/Safari) — the OS share sheet
 *     does NOT list WhatsApp because WhatsApp Desktop doesn't register
 *     as a share target. We instead:
 *       1. Copy the caption to the clipboard
 *       2. Download the photo (if any) as a JPG so the coach can drag
 *          it straight into WhatsApp Web / Desktop
 *       3. Open WhatsApp Web with the text pre-filled (`wa.me`)
 *       4. Toast "Caption copied · image saved to Downloads — paste in
 *          WhatsApp Web"
 *
 * WhatsApp's Business/Cloud APIs cannot post into groups (Meta policy),
 * so a human tap is unavoidable — this flow reduces it to one click on
 * mobile and two on desktop.
 *
 * @param {Object} opts
 * @param {string} opts.text        Caption / message body.
 * @param {Blob=}  opts.imageBlob   Optional image (selfie / mosaic).
 * @param {string=} opts.filename   Filename for the image File.
 * @returns {Promise<{ok: boolean, mode: string}>}
 */
export async function shareToWhatsApp({ text, imageBlob, filename = "checkin.jpg" }) {
  // Best case: mobile Web Share with files. Try file first because on
  // most desktop browsers `canShare({files})` returns false and we'll
  // fall through to the desktop path below instead of showing a share
  // sheet that has no WhatsApp on it.
  const onDesktop = isDesktop();
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
    // Web Share without files — only useful on mobile. Skip on desktop.
    if (typeof navigator !== "undefined" && navigator.share && !onDesktop) {
      await navigator.share({ text });
      return { ok: true, mode: "web-share-text" };
    }
  } catch (e) {
    if (e?.name === "AbortError") return { ok: false, mode: "cancelled" };
    // On MOBILE, a Web Share failure (usually NotAllowedError from a
    // lost transient-activation window after awaits) must NOT fall
    // through to the desktop path — otherwise phones get a useless
    // WhatsApp Web tab + forced download + clipboard overwrite (Feb
    // 2026 code-review HIGH finding). Silent no-op is safer; the user
    // can retry from the visible Share button.
    if (!onDesktop) {
      console.debug("web-share failed on mobile (activation lost?):", e?.name);
      return { ok: false, mode: "web-share-failed" };
    }
    // fall through to desktop-friendly path only when we're really on desktop
  }
  if (!onDesktop) return { ok: false, mode: "no-share-available" };
  return desktopShareFallback({ text, imageBlob, filename });
}

/**
 * Desktop-friendly fallback: copy caption, download image, open
 * WhatsApp Web with text pre-filled, and prompt the user to paste.
 */
async function desktopShareFallback({ text, imageBlob, filename }) {
  let copied = false;
  let downloaded = false;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text || "");
      copied = true;
    }
  } catch { /* clipboard may be blocked without permission — not fatal */ }

  if (imageBlob && typeof document !== "undefined") {
    try {
      const url = URL.createObjectURL(imageBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      downloaded = true;
    } catch { /* download blocked — user can still paste text */ }
  }

  let openedWindow = null;
  if (typeof window !== "undefined") {
    const url = `https://web.whatsapp.com/send?text=${encodeURIComponent(text || "")}`;
    openedWindow = window.open(url, "_blank", "noopener");
  }

  // Nudge the user so they know where the image ended up and what to do.
  // Toast copy adapts to what actually worked — no false "WhatsApp Web
  // opened" claim if the popup blocker killed the tab (Feb 2026
  // code-review MEDIUM finding).
  const bits = [];
  if (copied) bits.push("caption copied");
  if (downloaded) bits.push("image saved to Downloads");
  const suffix = bits.length ? ` · ${bits.join(", ")}` : "";
  if (openedWindow) {
    toast.message("WhatsApp Web opened" + suffix, {
      description: downloaded
        ? "Paste the message, then drag the image from Downloads into the chat."
        : "Paste the message into your chat.",
    });
  } else {
    // Popup blocked — user needs to open WhatsApp Web manually.
    toast.warning("Couldn't open WhatsApp Web" + suffix, {
      description: "Your browser blocked the popup. Open web.whatsapp.com yourself, then paste"
        + (downloaded ? " and drag the image from Downloads." : "."),
    });
  }
  return { ok: !!openedWindow, mode: openedWindow ? "desktop-fallback" : "desktop-fallback-blocked" };
}

/**
 * Rough desktop-vs-mobile heuristic. Web Share API is technically
 * available on desktop Chrome but consumer-side it opens a sheet that
 * doesn't include WhatsApp, so we treat those as "desktop" for the
 * purposes of picking the right UX path.
 */
function isDesktop() {
  if (typeof navigator === "undefined") return true;
  const ua = navigator.userAgent || "";
  if (/Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua)) return false;
  // navigator.userAgentData is more reliable when present
  if (navigator.userAgentData?.mobile) return false;
  return true;
}

/** Format the standard check-in caption used across self / escort / muster. */
export function formatDistance(m) {
  if (m == null || Number.isNaN(Number(m))) return "";
  const n = Number(m);
  return n >= 1000 ? `${(n / 1000).toFixed(1)} km` : `${Math.round(n)} m`;
}

export function formatCheckinCaption({ action, name, siteName, when = new Date(), distanceM = null, offSite = false }) {
  const hhmm = when.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  });
  const isOut = action === "checkout";
  const emoji = isOut ? "🏁" : "✅";
  const verb  = isOut ? "OUT:" : "IN:";
  const bits = [`${emoji} ${name}`, `${verb} ${hhmm}`];
  const dist = formatDistance(distanceM);
  const place = siteName || "site";
  if (dist) {
    bits.push(offSite ? `⚠️ ${dist} from ${place} (OFF-SITE)` : `📍 ${dist} from ${place}`);
  } else if (siteName) {
    bits.push(siteName);
  }
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


/**
 * Normalise a stored parent mobile into a wa.me-ready number:
 * digits only, with a country code. Numbers in the DB are cleaned to
 * digits (see backend norm_mobile) but usually lack a country code, so
 * bare 10-digit Indian mobiles get a "91" prefix. Returns null if the
 * value can't be a real mobile (too short / empty).
 */
export function normalizeWaNumber(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, "");
  if (!d) return null;
  if (d.length === 12 && d.startsWith("91")) return d;           // 91XXXXXXXXXX
  if (d.length === 11 && d.startsWith("0")) return "91" + d.slice(1); // 0XXXXXXXXXX
  if (d.length === 10) return "91" + d;                          // bare Indian mobile
  if (d.length >= 11 && d.length <= 15) return d;                // already has some CC
  return null;                                                    // too short to dial
}

/**
 * Open a WhatsApp chat with a specific number, message pre-filled.
 * Uses the universal `wa.me` deep link which works on mobile (opens the
 * WhatsApp app) and desktop (opens WhatsApp Web / Desktop). One tap → the
 * chat opens with the text ready; the user just presses send. No Meta API,
 * no cost, no ban risk (it uses the sender's own WhatsApp).
 */
export function openWhatsAppChat({ phone, text }) {
  const num = normalizeWaNumber(phone);
  if (!num) {
    toast.error("No valid WhatsApp number on file for this contact");
    return false;
  }
  const url = `https://wa.me/${num}?text=${encodeURIComponent(text || "")}`;
  const win = typeof window !== "undefined" ? window.open(url, "_blank", "noopener") : null;
  if (!win) {
    toast.warning("Couldn't open WhatsApp", {
      description: "Your browser blocked the popup — allow popups and try again.",
    });
    return false;
  }
  return true;
}

/**
 * Build the parent-facing "absent without information" message for a
 * single athlete. Bilingual — Telugu first (parents read this), then the
 * English version below a divider. Kept short and respectful.
 */
export function formatAbsentParentMessage({ name, dateIso, academy }) {
  const day = dateIso
    ? new Date(dateIso + "T00:00:00").toLocaleDateString("en-GB", {
        weekday: "long", day: "numeric", month: "long",
      })
    : new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const teFrom = academy ? `${academy} నుండి ` : "";
  const enFrom = academy ? ` from ${academy}` : "";
  const telugu =
    `నమస్తే 🙏\n\n` +
    `${teFrom}${name} గురించి ఒక సందేశం.\n\n` +
    `${name} ఈరోజు (${day}) శిక్షణకు హాజరు కాలేదు, మరియు మాకు ఎటువంటి ముందస్తు సమాచారం లేదు ` +
    `(అనుమతించిన సెలవు లేదా టూర్ నమోదు కాలేదు).\n\n` +
    `దయచేసి వారి స్థితిని వీలైనంత త్వరగా తెలియజేయండి. ధన్యవాదాలు.`;
  const english =
    `Namaste 🙏\n\n` +
    `This is a note${enFrom} regarding ${name}.\n\n` +
    `${name} has not reported for training today (${day}) and we have no prior information ` +
    `(no approved leave or tour on record).\n\n` +
    `Kindly confirm their status at your earliest. Thank you.`;
  return `${telugu}\n\n——————————\n\n${english}`;
}
