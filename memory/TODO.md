# I Showed Up — TODO / Backlog

## ⏳ Deferred features (parked until later)

### 1. Smart Auto-Check-In on sign-in
**Idea:** When a non-admin user signs in, if they haven't already checked in today, automatically
land them on the Check-In page and trigger GPS in the background. When a good fix lands inside
the geofence, show a **5-second "Checking you in… [Cancel]"** countdown banner — auto-confirms
unless they tap Cancel. If GPS can't lock (timeout / poor accuracy), auto-fallback to QR scanner.

**Design rules (must implement together — don't half-ship):**
- Only auto-trigger if `status.checked_in === false` AND the user hasn't checked out today already
  (avoids silently checking already-out people back in / silently checking on-duty people out)
- Don't auto-trigger for admins, devices without GPS (laptops), or pending/unapproved sign-ins
- Always show a visible 5-second cancel countdown before the API call — never a silent action
- Default landing page change: non-admin → `/check-in`, admin → `/admin`

**Effort estimate:** ~30 min frontend, no backend changes.

**Status:** Parked at user's request after first QR-on-Android bug fix.

---

## 🪲 Active investigations

### QR scanner: still failing on Android phones (Jan 2026)
- Replaced `html5-qrcode` with custom `<video>` + jsQR + native `BarcodeDetector` (Jan 2026)
- User reports it's still not detecting the QR
- Need: screenshot of the scanner status text so we can tell which decoder is being used + whether the scan loop is alive (frames-seen counter)
- Additional fallback in progress: native-camera-snapshot upload (uses OS camera UI to take a picture, decode with jsQR off-camera) — bypasses all live-camera detection issues

---

## 💡 Future ideas (low priority)
- Google Phone Number Hint API for one-tap phone entry on Android Chrome
- Export Daily Sessions table to CSV / PDF
- "Reset card" endpoint to regenerate a lost member QR
- Skeleton loaders for admin pages
- Split `server.py` (~1700 lines) into focused routers
