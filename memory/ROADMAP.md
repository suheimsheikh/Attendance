# I Showed Up — Roadmap

Living to-do backlog for functionality upgrades. Scope re-clarified
7 Jul 2026: this app is **staff attendance → payroll** + **athlete
participation tracking** for a **charitable youth sailing club**.
NOT a full club-management platform (no fees, no parent-portal SaaS,
no regatta results ingestion, etc.).

Priority legend: 🔥 do next · ⭐ high value · 🌱 nice-to-have.
Effort: XS (<1h) · S (half-day) · M (1-2 days) · L (1 week) · XL (multi-week).

---

## 🚀 Pick-next queue (user-endorsed)

- [ ] 🔥 **Group-photo Muster** — L
  - Coach snaps one wide shot at the pontoon.
  - Backend face-recognition (open-source `face_recognition` lib,
    local-only, no PII leaves server) matches faces against member
    profile photos.
  - Confirmation grid: detected face → matched member + confidence
    chip (High / Medium / Manual review).
  - Coach un-ticks misses, taps Confirm → bulk check-in with
    `method="group_photo"`.
  - Photo stored as session-evidence log (parent-query resolver).
  - **Next action**: sketch backend endpoint shape + face-lib choice
    (`face_recognition` vs `deepface` vs `insightface`) + confirm UX
    with a coach before building.

---

## Reportage upgrades

- [ ] 🔥 **Payslip PDF generator (Staff)** — M
  - New profile fields: `base_salary`, `hourly_rate`,
    `ot_rate_multiplier` (default 2×), `pf_number`, `esi_number`,
    `pan`, `bank_account`, `ifsc`.
  - New admin page `/admin/payslips` — pick month → ZIP of
    per-staff PDFs (name, days present, off, LWP, OT hrs, gross,
    statutory deductions, net).
- [ ] 🔥 **Payroll worksheet CSV** — S
  - Same compute → one row per staff → feed into bank bulk-transfer
    template or Tally.
- [ ] ⭐ **Attendance certificate PDF (Athletes)** — S
  - One-click per-athlete-per-month PDF with days attended, hours,
    coach signature block. Parents ask for these for school
    internal-assessment.
- [ ] ⭐ **Comparative report columns** — S
  - Every existing report gets a "vs last month" and "vs same month
    last year" column so trends are visible without switching pages.
- [ ] ⭐ **No-show / churn early-warning report** — M
  - List athletes whose attendance dropped >40% over the last 4 weeks
    vs prior 4 weeks. One-click "Notify parent" per row. Highest
    social-impact feature for a charitable club.
- [ ] 🌱 **Late-coming heatmap** — S
  - Day-of-week × time-of-day grid, cell colour = late-arrival
    frequency. Reveals systemic issues (Friday-afternoon patterns).
- [ ] 🌱 **Coach effectiveness ledger** — M
  - Per coach: fleet size trend, avg attendance% of their fleet,
    on-time% of sessions. Visibility for head coach, not punitive.
- [ ] 🌱 **SMS / WhatsApp log × attendance overlay** — S
  - Add "Messages sent (this month)" column to member rows in
    reports.

---

## Dashboard upgrades

- [ ] 🔥 **Single-glance `/admin` dashboard landing** — M
  - **Top ("Now")**: on campus + fleet breakdown, late today, absent
    today, guests, escorts-not-checked-in, big red banner for
    high-severity DQ >24h stale, pending-approvals chip.
  - **Middle ("This week")**: sparkline (staff + athlete daily lines),
    top 5 late-comers, birthdays this week, camps/regattas happening.
  - **Bottom ("This month")**: total staff hours / OT hrs / leave
    consumed, payroll projection, new members, dropped members.
  - **Right rail ("Attention")**: pending leave/OT/comp-off approvals
    with one-click open, DQ high-severity count, device approvals.
  - All widgets clickable → deep-link to existing pages. Zero new
    subsystems, just an executive summary.

---

## Statutory / compliance (India)

- [ ] ⭐ **EPF challan CSV export** — S
- [ ] ⭐ **ESI monthly return columns** — S
- [ ] 🌱 **Form-16 draft (yearly)** — M

---

## Other functionality (in-scope)

- [ ] ⭐ **Kiosk / TV-wall mode** — S
  - `/kiosk` route, no login required (network-protected).
  - Auto-rotating panels: Presence (compact) → today's late arrivals
    → birthdays → this-week events. Refresh 30s.
  - Runs on old TV + Raspberry Pi at reception.
- [ ] ⭐ **Bulk-import polish** — S
  - Extend the Excel importer to seed DOB + parent contacts + default
    leave balance. Currently a 15-athlete intake takes ~1h of manual
    typing.
- [ ] ⭐ **Retention cohort report** — M
  - Grid: joining-cohort × months-later × active%. Board-reporting
    metric that's near-impossible to compute manually.
- [ ] ⭐ **"Coach's fleet" landing card** — S
  - When a coach logs in, they see ONLY their fleet's presence +
    "who I need to notice today". Kills head-coach dependence on
    admin.
- [ ] 🌱 **Session evidence photos** — S
  - Coach attaches 1-2 photos to a session as coaching notes /
    proof-of-activity. Board-reporting artifacts.
- [ ] 🌱 **Voice announcement kiosk** — S
  - Auto-plays "Welcome to YCH, Arjun" when a member checks in via
    reception kiosk. OpenAI TTS via Emergent LLM key. Kids adore
    this.

---

## Recommended sequencing (if I were you)

1. **Group-photo muster** — biggest daily time saver, user-endorsed.
2. **Payslip PDF + payroll CSV** — biggest recurring admin pain.
3. **Single-glance `/admin` dashboard** — cheap; enormously changes
   perceived polish.
4. **No-show / churn early-warning** — highest social impact for a
   charitable club.
5. **Attendance certificate PDF** — you'll do this 200+ times a year
   otherwise.

Everything below that is nice-to-have and can be picked as time and
launch-priority allow.

---

## Explicitly out of scope (per user, 7 Jul 2026)

- Fees / payments module
- Parent portal (read-only slice)
- Regatta result ingestion
- Boat/equipment allocation & maintenance log
- Consent + waiver workflow
- Coach certification tracking
- Multi-site / franchise mode
- White-label SaaS
- Skills-competency matrix
- Athlete self-dashboard
- Anomaly detection (LLM)
- Face-recognition auto-check-in beyond the muster group-photo use
- Weather-cancel workflow (interesting but out of core scope)
- Medical & emergency profile (nice-to-have but not payroll-relevant)

---

## Continuing carry-overs from earlier sessions

- **P1** WhatsApp Cloud API integration (5 Meta credentials required
  from user — parked).
- **P3** `<span> in <option>` hydration warning cleanup.
- **P2/P3 (post-launch)**: JWT httpOnly cookies migration; component
  splits (Members, Reports, Muster, MyLeaves, Presence); Python
  router-complexity refactors (holidays, breaks, daily_content,
  guests, regattas, camps); 242 nested-ternary cleanup; TypeScript
  migration.
