# Build the Attendance app for staff phones (EAS)

The web/console runs on Emergent. To let staff **scan the gate QR + use camera/GPS check-in on their phones**, you build a native app with **Expo EAS** (cloud build). The app keeps talking to your **deployed** Emergent backend.

> ⚠️ EAS builds run on Expo's cloud and need YOUR Expo login, so run these on your own computer with the project code (use **Save to GitHub** / download from Emergent), not inside the Emergent container.

---

## 0. One-time prerequisites
- A free **Expo account** → https://expo.dev/signup
- Node.js 18+ installed on your machine
- Install the EAS CLI:
  ```bash
  npm install -g eas-cli
  ```

## 1. Deploy the backend first (get the permanent URL)
- In Emergent, click **Deploy**. Copy the permanent app URL (e.g. `https://your-app.emergent.host`).
- This is your `EXPO_PUBLIC_BACKEND_URL`. The preview URL expires — do **not** use it for builds.

## 2. Point the build at your deployed backend
- Open `frontend/eas.json` and replace **every** `https://REPLACE-WITH-YOUR-DEPLOYED-BACKEND-URL`
  with your deployed URL from step 1 (in the `development`, `preview`, and `production` profiles).

## 3. Link the project to EAS (one-time)
```bash
cd frontend
eas login
eas init        # creates the EAS project and writes extra.eas.projectId into app.json
```

## 4. Build the staff Android app (APK — easiest to field test)
```bash
eas build -p android --profile preview
```
- When it finishes, EAS gives you a **download link / QR code**.
- Send that link to staff → they download & install the **APK** directly on Android phones
  (they may need to allow "Install from unknown sources").

## 5. Build for iPhone (optional)
iOS can't side-load a bare APK equivalent. Use TestFlight:
```bash
eas build -p ios --profile production   # needs an Apple Developer account ($99/yr)
eas submit -p ios --latest              # uploads to App Store Connect → invite staff via TestFlight
```
(For a few internal test iPhones you can instead use `--profile preview` with an ad-hoc provisioning profile; EAS will guide you.)

## 6. Roll out updates later (no rebuild)
For JS-only changes you can push Over-The-Air updates:
```bash
npx expo install expo-updates   # if not already
eas update --branch production
```

---

## What each build profile does (`frontend/eas.json`)
| Profile | Output | Use |
|---|---|---|
| `development` | Dev-client APK | Live debugging on a device |
| `preview` | **Standalone APK** | **Field testing with staff** ✅ |
| `production` | Android App Bundle (.aab) | Google Play release |

## Notes
- App identifiers are set in `frontend/app.json`: Android `package` & iOS `bundleIdentifier` = `com.attendance.mobile` (change before a public store release if you like).
- Camera & location permission prompts are configured via the `expo-camera` / `expo-location` plugins and iOS `infoPlist` strings.
- The native app uses the **same APIs** as the web app — staff log in by phone, scan the office QR, and the geofence/photo work with real device GPS & camera (no "Simulate at office" needed on a real build).
