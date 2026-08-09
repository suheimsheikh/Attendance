import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@/index.css";
import App from "@/App";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Perf pass 24 Feb 2026 — bumped from 60s to 5min. Most surfaces
      // (Grid, Dashboard, Reports) don't need sub-minute freshness;
      // 5-min caches let tab-switches feel instant. Hot-refresh
      // surfaces (Presence, Approvals) override this locally.
      staleTime: 5 * 60_000,
      // Keep prefetched / previous responses in memory for 15 min
      // after their last observer unmounts — makes back-navigation
      // to a recently-visited page render immediately from cache.
      gcTime: 15 * 60_000,
      refetchOnWindowFocus: false,
      // Retry once on transient network errors (default 3 makes a
      // failing page feel sluggish; one retry is a good balance).
      retry: 1,
    },
  },
});

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);

// Register service worker for PWA (install + offline shell). Only in production
// builds — CRA's dev server doesn't serve sw.js reliably, and registering it in
// dev can cache a stale dev bundle.
if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.debug("SW registration failed:", err);
    });
  });
}
