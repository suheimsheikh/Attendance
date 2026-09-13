# WhatsApp Integration — Guide & Decisions

_Last updated: 13 Jun 2026_

## What was built (Option A — shipped, live-safe)
One-tap parent notification for absentees, using `wa.me` deep links.
- No Meta account, no API key, no cost, **no ban risk** (uses the sender's own WhatsApp).
- Muster page → "Absent without information" banner → **"Notify parents individually"**.
  Each absent athlete has a green WhatsApp button per parent on file (F / M / G).
  One tap opens WhatsApp with the parent's number + the absence note pre-filled; press send.
- Also added a WhatsApp button to the parent popover (`ParentContact`) on every muster row.

### Files
- `backend/routes/muster.py` — `/muster/absent-report` now also returns `athlete_contacts`
  (id, name, father/mother/guardian mobiles). Old `athletes`/`coaches` name arrays unchanged.
- `frontend/src/utils/shareWhatsApp.js` — `normalizeWaNumber`, `openWhatsAppChat`, `formatAbsentParentMessage`.
- `frontend/src/pages/muster/AbsentShareBanner.jsx` — per-athlete notify list.
- `frontend/src/components/ParentContact.jsx` — added WhatsApp action.

### Number normalisation
Stored numbers are digits-only (no country code). Rules applied for `wa.me`:
`91XXXXXXXXXX` kept · `0XXXXXXXXXX` → `91XXXXXXXXXX` · bare 10-digit → prefix `91` · 11–15 digits kept · shorter → skipped ("no number on file").

## Why WhatsApp GROUPS stay manual (do NOT automate)
Meta's official WhatsApp Cloud API has **no group-posting feature at all**.
The only way is unofficial tools (whatsapp-web.js / Baileys) that log in as a personal
account → Meta detects & **permanently bans the number**. Too risky for a live app.
Groups therefore keep the existing manual "Share to group" button.

## Option B (NOT built) — full-auto parent messages via Meta Cloud API
Only worth it if daily volume makes one-tap tedious. Setup steps for the user:
1. `business.facebook.com` → create Meta Business account.
2. Business verification (upload registration doc). 1–3 days.
3. `developers.facebook.com` → Create App (Business type) → add WhatsApp product.
4. Register a **dedicated** phone number (must be removed from regular WhatsApp first). Verify via OTP.
5. Create a System User (Admin) → assign app + WhatsApp account → grant
   `whatsapp_business_messaging` + `whatsapp_business_management` → generate permanent token.
6. Submit a **Utility** message template (e.g. "Dear parent, {{1}} was marked {{2}} on {{3}} at {{4}}."). Approval 1–24h.
7. User provides **Phone Number ID** + **permanent token** → wire into backend and send automatically.

### Cost (verified Jun 2026)
Per-message billing by country/category. Utility cheap + volume discounts.
⚠️ Meta removes the free 24h service-message window on **1 Oct 2026** — nearly all messages billed after that.
When implementing Option B: route through `integration_expert` (auth/3rd-party rule).

## User decisions on record
- Prioritise parents (a). Keep groups manual (safe). Parent numbers already stored.
- Wanted the simplest path → shipped Option A (deep links) without a feature toggle (purely additive).
