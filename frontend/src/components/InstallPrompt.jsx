import React, { useEffect, useState } from "react";
import { Download, X } from "lucide-react";

/**
 * InstallPrompt — small dismissible banner that appears when Chrome / Edge /
 * Samsung Internet fires `beforeinstallprompt`. Tapping "Install" surfaces the
 * native add-to-home-screen sheet. iOS Safari doesn't fire this event, so we
 * show a different one-time tip there using the share-sheet metaphor.
 *
 * Dismissal is sticky in localStorage so members don't see it repeatedly.
 */
const DISMISS_KEY = "iu_install_dismissed_v1";

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [showIosTip, setShowIosTip] = useState(false);
  const [dismissed, setDismissed] = useState(() => !!localStorage.getItem(DISMISS_KEY));

  useEffect(() => {
    if (dismissed) return;
    // Already installed (running standalone)?
    if (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return;
    if (window.navigator.standalone) return; // iOS

    const onBefore = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener("beforeinstallprompt", onBefore);

    // iOS Safari: no event — detect once.
    const ua = window.navigator.userAgent.toLowerCase();
    const isIOS = /iphone|ipad|ipod/.test(ua) && !window.MSStream;
    const isSafari = /safari/.test(ua) && !/crios|fxios/.test(ua);
    if (isIOS && isSafari) setShowIosTip(true);

    return () => window.removeEventListener("beforeinstallprompt", onBefore);
  }, [dismissed]);

  const install = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch { /* ignore */ }
    setDeferredPrompt(null);
    dismiss();
  };
  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* ignore */ }
    setDismissed(true);
  };

  if (dismissed) return null;
  if (!deferredPrompt && !showIosTip) return null;

  return (
    <div
      data-testid="install-prompt"
      className="fixed left-1/2 -translate-x-1/2 bottom-3 z-40 w-[92%] max-w-md rounded-2xl bg-slate-900 text-white shadow-xl p-3 flex items-center gap-3"
    >
      <div className="w-10 h-10 rounded-xl bg-sky-500/20 text-sky-300 flex items-center justify-center shrink-0">
        <Download size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold">Install I Showed Up</div>
        <div className="text-[11px] text-slate-300 leading-tight mt-0.5">
          {deferredPrompt
            ? "One tap — opens like a real app from your home screen."
            : "Tap Share → Add to Home Screen to install."}
        </div>
      </div>
      {deferredPrompt && (
        <button
          onClick={install}
          data-testid="install-prompt-install"
          className="bg-sky-500 hover:bg-sky-400 transition px-3 h-8 rounded-md text-xs font-bold"
        >
          Install
        </button>
      )}
      <button
        onClick={dismiss}
        data-testid="install-prompt-dismiss"
        className="p-1 text-slate-400 hover:text-white"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}
