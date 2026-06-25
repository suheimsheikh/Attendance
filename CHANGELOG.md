# Changelog — I Showed Up

Each section lists what's in **preview** but hasn't been deployed yet, so you
can skim it before pressing Deploy. Once you redeploy, move that block under
the dated "Released" header at the bottom and reset the "Unreleased" section.

---

## 🚧 Unreleased — pending deploy to `i-showed-up.ychyderabad.com`

### 🆕 New features

- **Breaks & Holidays** — new collection + Calendar action "Apply break". Mark a
  day off for everyone, all athletes / coaches / staff, one institution, or a
  hand-picked group. Affected members render under the **Leave** column on the
  Presence Board with "On break · {name}" instead of being marked Absent. Backed
  by `/api/breaks` CRUD.
- **Calendar consolidation** — Camps menu item retired from the main sidebar;
  Camps and Breaks are now created from the Calendar page (`New camp`,
  `Apply break`, `New regatta` buttons). Day-detail modal shows all three.
- **Full data Backup & Restore** moved out of Admin Console into the main
  sidebar. The archive now contains **every** collection (members + photos,
  attendance, leaves, devices, camps, regattas, **breaks**, parent
  notifications, SMS log, etc.) so you can clone prod ↔ preview cleanly.
  Replace-mode is automatically blocked on production to prevent wipes.
- **Coming up this week** banner on the Admin Console — colored chips for any
  camp / break / regatta active or starting in the next 7 days, LIVE pill on
  in-progress events, tap to open the full calendar.
- **Monthly Attendance report** — new columns: Present · Leave · Tour ·
  Comp-Off · Absent · **Total accounted / Span**. Quick-pick chips for
  *This month*, *Last month*, *Last 7 days*. Break days fold into Leave; CSV
  and PDF exports updated to match.
- **Forgot-to-check-out SMS reminder** — daily cron at the office-local time
  set in Office Settings (default 20:00). Sends one SMS per member with an
  open session, idempotent via `reminder_sent_at`. Admins can also fire it
  manually via "Send now (test)".
- **Auto-checkout audit badge** — Daily Sessions admin page now shows an
  *Auto-closed* badge on rows that the midnight cron closed automatically,
  plus a new *Auto-closed* count card.
- **Parent fuzzy-match Excel import** (carried over from prior session, still
  awaiting end-to-end verification on the deployed site).

### ✨ UI polish

- **Presence Board cards** — institution chip moved off the name line so long
  names like "ESWA SURAGAJYOTHI" / "PREETHI KONDAKARI" no longer get clipped
  by the institution badge. Name + parent-phone icons sit on row 1; rank ·
  category · institution chip sit on row 2.
- **Members page** — Parents/Guardian column widened; full parent names like
  "SHIVA SHANKAR GUNDLANARUA" now display without truncation. When no parent
  name is set, compact **F / M / G** square badges show instead of the long
  "Father / Mother / Guardian" labels.
- **Coach menu order** — Muster Roll now sits above Presence in the sidebar.

### 🛠 Reports / data accuracy

- Hours & Attendance now counts an **open** session (still checked-in, no
  check-out yet) as a Present day for today, so the afternoon report no longer
  looks like nobody showed up. Hours total still only includes closed sessions
  (correct), so totals stay accurate.

### 🔒 Safety guards

- Backup & Restore **Replace** mode is disabled on the production host with
  an amber notice — prevents accidentally wiping live data.

### 🏗 Plumbing

- New backend module `breaks.py` with `Break` model + helpers used in
  `presence()` to override member status.
- Presence pipeline now applies break overlay alongside the existing camp /
  leave overlays.

---

## Released

<!-- When you deploy, paste the Unreleased block here under a "## 2026-MM-DD"
     heading and clear the Unreleased section above. -->
