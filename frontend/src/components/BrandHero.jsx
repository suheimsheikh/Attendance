import React from "react";

/**
 * BrandHero — prominent YCH logo treatment shown on the Check-In page.
 * Designed to feel like a club lobby on a phone (large logo, evocative
 * typography) while staying compact on desktop where the sidebar already
 * shows the club identity.
 *
 * Tailwind sizing:
 *  - Mobile  : logo h-32 (128px), name in big serif
 *  - Tablet  : logo h-28
 *  - Desktop : logo h-20 alongside more horizontal layout
 */
export default function BrandHero() {
  return (
    <div
      className="mb-6 md:mb-7 flex flex-col items-center text-center"
      data-testid="checkin-brand-hero"
    >
      {/* Animated wash behind the logo — subtle, only on first render */}
      <div className="relative">
        <span
          aria-hidden="true"
          className="absolute inset-0 -z-10 rounded-full blur-2xl opacity-60"
          style={{
            background: "radial-gradient(closest-side, rgba(14,165,233,0.35), rgba(14,165,233,0) 70%)",
          }}
        />
        <img
          src="/yc-logo.png"
          alt="Yacht Club of Hyderabad"
          className="h-32 sm:h-28 md:h-20 lg:h-24 w-auto object-contain animate-[brand-pop_700ms_ease-out]"
          draggable={false}
        />
      </div>

      <h1
        className="mt-3 text-[26px] sm:text-3xl md:text-2xl lg:text-3xl font-extrabold tracking-tight text-slate-900 leading-none"
        style={{ fontFamily: "'Cormorant Garamond', 'Playfair Display', 'Georgia', serif", letterSpacing: "0.01em" }}
      >
        Yacht Club of Hyderabad
      </h1>
      <p
        className="mt-1 text-[11px] sm:text-xs md:text-[11px] uppercase tracking-[0.28em] text-slate-500 font-bold"
      >
        I&nbsp;Showed&nbsp;Up
      </p>

      <style>{`
        @keyframes brand-pop {
          0%   { transform: scale(0.86); opacity: 0; }
          60%  { transform: scale(1.04); opacity: 1; }
          100% { transform: scale(1);    opacity: 1; }
        }
      `}</style>
    </div>
  );
}
