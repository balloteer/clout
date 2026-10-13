#!/usr/bin/env bash
# Creates an ARM64 development APK for a Seeker or ARM64 emulator.
set -euo pipefail

CLOUT_PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$CLOUT_PROJECT_ROOT"

if [[ ! -d node_modules/expo ]]; then
  echo "Install workspace dependencies with npm ci before building." >&2
  exit 1
fi

(
  cd apps/mobile
  npx expo prebuild --platform android --no-install
)

bash scripts/android-env.sh apps/mobile/android/gradlew \
  -p apps/mobile/android app:assembleDebug \
  -PreactNativeArchitectures=arm64-v8a --no-daemon --max-workers=4

mkdir -p artifacts
cp apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk artifacts/clout-debug.apk
shasum -a 256 artifacts/clout-debug.apk
echo "Built artifacts/clout-debug.apk. Start Metro with npm run dev before opening this development build."
