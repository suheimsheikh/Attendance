/**
 * GeoPermissionBanner — surfaces when the browser has DENIED location
 * permission for the app. Without location we cannot record where a
 * check-in happened, so we tell the user how to re-enable it
 * (browser-specific one-liner). Renders nothing on granted/prompt/
 * unsupported states.
 */
import React from "react";
import { MapPin, AlertTriangle } from "lucide-react";

function detectHint() {
  const ua = navigator.userAgent || "";
  if (/CriOS|Chrome/.test(ua) && /Mobile/i.test(ua))
    return "Chrome mobile → tap the site name in the address bar → Permissions → Location → Allow.";
  if (/Chrome/.test(ua))
    return "Chrome → click the padlock/tune icon in the address bar → Site settings → Location → Allow.";
  if (/Safari/.test(ua) && /Mobile/i.test(ua))
    return "Safari iOS → Settings → Safari → Location → Ask (then reload this page).";
  if (/Safari/.test(ua))
    return "Safari → menu → Settings for This Website → Location → Allow.";
  if (/Firefox/.test(ua))
    return "Firefox → click the padlock in the address bar → Permissions → Access your location → Allow.";
  return "Open your browser's site-settings and set Location to 'Allow' for this page.";
}

export default function GeoPermissionBanner({ state }) {
  if (state !== "denied") return null;
  return (
    <div
      className="mb-3 rounded-lg border border-rose-200 bg-rose-50 p-3 flex items-start gap-3"
      data-testid="geo-permission-banner"
      role="alert"
    >
      <AlertTriangle size={18} className="text-rose-600 shrink-0 mt-0.5" />
      <div className="flex-1 text-sm">
        <div className="font-bold text-rose-800 flex items-center gap-1.5">
          <MapPin size={14} /> Location access blocked
        </div>
        <p className="text-rose-700 mt-0.5 leading-snug">
          We need your location to record where you checked in.
          Right now your browser is blocking it.
        </p>
        <p className="text-[12px] text-rose-700 mt-1 leading-snug">
          <b>Fix:</b> {detectHint()}
        </p>
      </div>
    </div>
  );
}
