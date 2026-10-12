# Camp-Day Absentee Dispatch to the Parents WhatsApp Group

A once-a-day prompt that nudges whoever is on duty to post the day's absentee
summary into the parents WhatsApp group — now reaching present coaches, not just admins, and only on days a camp is running.

## Who it's for
- **Coaches who are checked in (present) today** — the people on the ground during a camp.
- **Admins** — continue to be prompted as they are today.
- The parents in the WhatsApp group are the end audience of the posted summary.

## What already exists (and what changes)
This is largely built. A daily prompt already:
- Detects the day's absentees/late/leave/tour/LOP and shows a preview.
- Opens WhatsApp with a ready-made message to post.
- Uses a shared "sent" flag so that once one person posts it, nobody else is prompted that day.

Today it only appears to admins, every working day. The change is to **unlock it for present coaches** and **limit it to camp days**.

## Core features and experience
- **Appears only on camp days.** If no camp is active that day, the prompt never shows (for coaches or admins). Camp days are when the academy has parents to report to.
- **Appears to present coaches + admins.** A coach sees it only if they have checked in that day; a coach who hasn't arrived is never nagged.
- **Shows once per day, group-wide.** The first present coach or admin who taps Send closes it for everyone for the rest of that day. "Not now" only hides it on that one person's device.
- **Full attendance summary**, A–Z and one name per line: Absent · Late · On leave · On tour · LOP, with the camp/academy name and date as a header.
- **One-tap share.** Tapping Send opens WhatsApp with the message pre-filled; the person taps the parents group to post it.

## How it reaches the parents group
- The app cannot auto-post into a WhatsApp group, nor can it pick the group for the sender — this is a WhatsApp limitation (accepted). The sender chooses the parents group in the WhatsApp share sheet and posts.
- It posts **one summary to one group** that the sender selects each time. It does **not** message each absent child's parents individually — that is a separate capability noted in a later phase.

## User flow
1. On a camp day, a coach checks in and opens/returns to the app after the daily cut-off time.
2. A dismissible card appears: "Dispatch today's absentees", with the previewed list.
3. The coach taps **Send to WhatsApp** → WhatsApp opens with the message ready → they pick the parents group and post. The prompt is now closed for everyone that day.
4. Or the coach taps **Not now** → it hides on their device and may reappear later that day until someone sends it.
5. On a non-camp day, the prompt does not appear at all.

## UI/UX feel
Same lightweight, dismissible card already in use — an amber "attention" header, a scrollable preview grouped by status, and two actions (Not now / Send to WhatsApp). No new screens or navigation.

## Implementation phases

**Phase 1 — MVP (built now)**
- Show the existing daily absentee-dispatch prompt to present coaches as well as admins.
- Gate the prompt to camp days only (no camp active → no prompt for anyone).
- Keep the current once-per-day group-wide "sent" behaviour, the current message content (Absent · Late · On leave · On tour · LOP), the current cut-off time, and the WhatsApp share-sheet flow.

**Phase 2 — Convenience (later)**
- A manual "Send absentees now" button so a coach can trigger the share without waiting for the prompt.
- Guidance/remembered hint for which parents group to pick when a coach runs multiple camps/institutions.

**Phase 3 — Direct-to-parent messaging (later, bigger)**
- Message each absent child's parents individually (not just one group post), using their stored contact numbers. Direct WhatsApp-to-each-parent needs the WhatsApp Business API (pre-approved templates, per-message cost, business verification); an SMS fallback via the existing contact numbers is the cheaper alternative. Scoped separately.

## Assumptions
- **"Present" = checked in today.** A coach with any check-in for the day qualifies; one who hasn't checked in does not see the prompt.
- **"Camp day" = at least one camp active that date.** This gate applies to everyone, including admins — so on non-camp days admins will no longer see this particular prompt (its purpose is parent reporting during camps).
- **Cut-off time stays as it is today** (the prompt appears from mid-morning onward, not at dawn).
- **Message content and format stay as today** (full status summary, A–Z, one per line, camp/academy name + date header).
- **One group, chosen each time by the sender.** No stored/auto-selected group, no auto-post, no per-parent messaging in the MVP.
- **Dismissal rules stay as today**: "Not now" is per-device for that day; "Send" closes it group-wide for that day.
- If there are no absentees/late/leave/tour/LOP entries on a camp day, the prompt stays silent (nothing to report).
