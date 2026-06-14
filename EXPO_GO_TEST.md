# Test the app on staff phones with Expo Go (easiest way)

This lets you try the **real app** (camera QR + GPS) on any Android or iPhone in minutes.
No app store, no APK — staff install one free helper app called **Expo Go** and tap a code.

> 💡 How it works in one line: your **laptop runs the app and shows a QR code**; each phone
> opens **Expo Go** and scans that QR to load your app. Keep the laptop running during the test.

---

## PART A — One-time setup on your laptop (do this once)

### Step 1 — Put your backend online (so phones can reach the data)
1. In Emergent, click **Deploy**.
2. When it finishes, **copy the permanent web address** it gives you
   (looks like `https://your-app.emergent.host`). You'll paste it in Step 4.

### Step 2 — Get the project code onto your laptop
1. In Emergent, use **Save to GitHub** (top of the chat) to push the code.
2. On your laptop, download/clone that GitHub project, then open a terminal in it.
   *(On Windows: install “Git” and “Node.js LTS” first from their official sites. On Mac: install “Node.js LTS”.)*

### Step 3 — Install the tools (one line)
In the terminal, inside the project folder:
```
cd frontend
npm install
```

### Step 4 — Tell the app where your backend is
1. Inside the `frontend` folder, create a file named exactly **`.env`**
2. Put this one line in it (use YOUR address from Step 1):
```
EXPO_PUBLIC_BACKEND_URL=https://your-app.emergent.host
```
3. Save the file.

### Step 5 — Start it (this shows the QR code)
```
npx expo start --tunnel --go
```
- Wait ~30 seconds. A big **QR code** appears in the terminal window.
- Leave this window open during your whole test. (To stop later: press `Ctrl + C`.)

---

## PART B — On each staff phone (takes 1 minute per phone)

### Android phones
1. Open the **Play Store** → search **“Expo Go”** → install it.
2. Open **Expo Go** → tap **“Scan QR code”** → point at the QR on your laptop screen.
3. The app loads. Done — they log in with their **phone number**.

### iPhones
1. Open the **App Store** → search **“Expo Go”** → install it.
2. Open the normal **Camera** app → point at the QR on your laptop screen.
3. A yellow banner appears at the top → **tap it** → the app opens in Expo Go.
4. Log in with the phone number.

---

## What staff do after it opens
1. Enter their **phone number** → tap **Continue**.
2. If you pre-added them as Admin, they're in instantly. Otherwise it says **“Waiting for approval.”**
3. You (admin) approve their device in the **Console → Access Requests** (or phone → Admin → Access Requests).
4. They're now signed in for good on that phone — they scan the **Office QR** at the gate to check in/out.

---

## Good to know
- ✅ Camera scanning + GPS geofence **work for real** in Expo Go (no “Simulate” toggle needed).
- ⚠️ The app only loads while your **laptop is running Step 5**. Once a phone has loaded it, it keeps
  working until the app is closed/reloaded. Expo Go is great for **testing** — for a permanent app on
  every phone, do the APK build later (see `EAS_BUILD.md`).
- If a phone says it can’t connect, make sure you used **`--tunnel`** in Step 5 and that you **Deployed**
  the backend in Step 1 (not the temporary preview link).
- First load can take 1–2 minutes while it downloads; after that it’s fast.
