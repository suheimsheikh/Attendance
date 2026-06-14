# Put the app on staff phones — the EASY way (no typing commands)

You only do a tiny setup on your laptop **once**. Then each phone just scans a QR code.

---

## PART A — On your laptop (one time, ~10 minutes)

### 1) Install Node.js (one download)
- Go to **https://nodejs.org** → click the big green **“LTS”** button → install it (just keep clicking Next/Install).

### 2) Put your backend online
- In Emergent, click **Deploy**.
- Copy the web address it gives you (looks like `https://your-app.emergent.host`). Keep it handy.

### 3) Get the project onto your laptop
- In Emergent, click **Save to GitHub** (top of the chat).
- Open your GitHub, find the project, click the green **Code** button → **Download ZIP**.
- **Unzip** it (double-click the ZIP). You now have a project folder.

### 4) Double-click the launcher 🚀
Open the project's **`frontend`** folder, then:
- **On a Mac:** double-click **`start-test.command`**
- **On Windows:** double-click **`start-test.bat`**

A black window opens and asks for your **backend address** — paste the one from step 2 and press Enter.
It sets everything up by itself (first time takes 2–3 minutes), then shows a **big QR code**.

> Leave that black window OPEN during your whole test. Closing it stops the app.

*(Mac note: if it says “cannot be opened because it is from an unidentified developer,” right‑click the file → **Open** → **Open**. You only do this once.)*

---

## PART B — On each staff phone (1 minute each)

**Android:** Play Store → install **“Expo Go”** → open it → **Scan QR code** → point at your laptop’s QR.

**iPhone:** App Store → install **“Expo Go”** → open the normal **Camera** app → point at the QR → tap the yellow banner.

The app opens → they sign in with their **phone number**.
You approve their phone in **Console → Access Requests**, and they’re in for good.

---

## That’s it. Quick reminders
- ✅ Camera QR scan + GPS work for real in Expo Go (no “Simulate” needed).
- ⚠️ Phones can load the app only while that **black window is running** on your laptop. It’s meant for **testing**.
  When you’re happy, we make a real installable app (`EAS_BUILD.md`) so it stays on phones without your laptop.
- If a phone can’t connect: make sure you **Deployed** (step 2) and pasted that address, not the temporary preview link.

---

### Even simpler option (no laptop at all) — if you just want a quick look
After you **Deploy**, you can open the deployed web address **in the phone’s browser** and use
**“Add to Home Screen.”** Great for the login, the live board and leave requests. For the live
**camera QR scanning + GPS check-in**, use the Expo Go steps above (or the installable app later).
