#!/bin/bash
# Double-click this file (Mac) to start the staff test.
cd "$(dirname "$0")"
echo "================================================"
echo "   Attendance App  -  Staff Test Launcher"
echo "================================================"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js is not installed yet."
  echo "  1) Go to  https://nodejs.org"
  echo "  2) Download the big green 'LTS' button and install it."
  echo "  3) Then double-click this file again."
  echo ""
  read -p "Press Enter to close..."
  exit 1
fi

if [ ! -f .env ]; then
  echo "  Paste your DEPLOYED backend address (from the Emergent Deploy button)."
  echo "  Example:  https://your-app.emergent.host"
  echo ""
  read -p "  Backend address: " URL
  echo "EXPO_PUBLIC_BACKEND_URL=$URL" > .env
  echo "  Saved."
  echo ""
fi

if [ ! -d node_modules ]; then
  echo "  Setting up for the first time (about 2-3 minutes)... please wait."
  npm install
  echo ""
fi

echo "  Starting! A QR code will appear below in a moment."
echo "  >> On each phone: open 'Expo Go' and scan this QR code. <<"
echo "  Keep this window OPEN during your test. Close it to stop."
echo ""
npx expo start --tunnel --go
