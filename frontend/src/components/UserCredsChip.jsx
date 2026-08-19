import React from "react";
import Avatar from "./Avatar";
import { useAuth } from "../auth";

/**
 * Persistent user-credential chip pinned to the top-right of every
 * authenticated screen. Requested 19 Aug 2026 so admins can always
 * see at a glance which account they are signed in as (name +
 * role + login handle + photo) without having to open the sidebar.
 *
 * UX rules:
 *  • fixed positioning so it never occupies page-flow space
 *  • sits below the mobile hamburger bar (`top-16` on mobile, `top-3`
 *    on desktop where there is no top bar)
 *  • soft glass background so it stays visible on any page bg
 *    without stealing attention from primary content
 *  • hidden on the mobile *header* row itself (which already shows
 *    the avatar) to avoid double-rendering the same info
 *  • pointer-events allow the user to click through to /profile
 */
export default function UserCredsChip() {
  const { user } = useAuth();
  if (!user) return null;
  // Escort tokens have no `role` / `category` — show a lighter label.
  const isEscort = !!user.is_escort;
  const role = isEscort
    ? "Escort"
    : (user.rank || user.role || user.category || "").toString();
  // Prefer email as login handle for admins; fall back to mobile for
  // phone-login accounts (athletes/coaches/staff).
  const handle = user.email || user.mobile || user.phone || "";
  return (
    <a
      href="/profile"
      data-testid="user-creds-chip"
      title="You are signed in as this user — tap to open your profile"
      className="
        fixed z-40 top-3 right-3
        md:top-3 md:right-4
        flex items-center gap-2 pl-1 pr-3 py-1
        rounded-full bg-white/85 backdrop-blur-md
        border border-slate-200 shadow-sm
        hover:bg-white hover:shadow transition
        max-w-[min(70vw,320px)]
        text-slate-800 no-underline
        hidden md:flex
      "
    >
      <Avatar name={user.full_name} photo={user.photo} size={28} />
      <div className="min-w-0 leading-tight">
        <div
          data-testid="user-creds-chip-name"
          className="text-xs font-semibold truncate"
        >
          {user.full_name}
        </div>
        <div className="text-[10px] text-slate-500 truncate">
          {role}
          {role && handle ? " · " : ""}
          {handle}
        </div>
      </div>
    </a>
  );
}
