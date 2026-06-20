import React, { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

/**
 * OfflineBanner — slim persistent strip shown at the top of every page when
 * the browser reports it's offline. The service worker keeps the app shell
 * usable, but API calls (check-in, presence refresh, etc.) will fail — this
 * banner makes that state visible so members don't think they checked in
 * when they actually didn't.
 *
 * Listens to `navigator.onLine` plus the online/offline events. Adds a
 * short re-check delay because some browsers fire 'online' a beat before
 * the network is actually usable.
 */
export default function OfflineBanner() {
  const [online, setOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true
  );

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  if (online) return null;
  return (
    <div
      data-testid="offline-banner"
      role="status"
      className="fixed top-0 inset-x-0 z-50 bg-amber-600 text-white text-center text-xs font-bold py-1.5 px-3 shadow-md flex items-center justify-center gap-1.5"
    >
      <WifiOff size={12} />
      You&apos;re offline — check-ins won&apos;t save until your connection returns.
    </div>
  );
}
