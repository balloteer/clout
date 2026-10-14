#!/usr/bin/env bash
# Bundles JavaScript/media into an ARM64 APK signed only with the local debug key.
set -euo pipefail

CLOUT_PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$CLOUT_PROJECT_ROOT"

# Browser-only .env.local values must never silently select the APK's API.
export EXPO_NO_DOTENV=1
export CLOUT_PREVIEW_USB="${CLOUT_PREVIEW_USB:-0}"
if [[ "$CLOUT_PREVIEW_USB" == "1" ]]; then
  export EXPO_PUBLIC_API_URL='http://127.0.0.1:8787'
  echo "Building USB preview: keep the Mac API and adb reverse tcp:8787 tcp:8787 running."
elif [[ "$CLOUT_PREVIEW_USB" == "0" ]]; then
  export EXPO_PUBLIC_API_URL="${CLOUT_PREVIEW_API_URL:-}"
  if [[ -z "$EXPO_PUBLIC_API_URL" ]]; then
    echo "A portable build requires CLOUT_PREVIEW_API_URL; use CLOUT_PREVIEW_USB=1 for USB testing." >&2
    exit 1
  fi
  if [[ "$EXPO_PUBLIC_API_URL" != https://* ]]; then
    echo "CLOUT_PREVIEW_API_URL must use HTTPS; use CLOUT_PREVIEW_USB=1 for USB testing." >&2
    exit 1
  fi
  if [[ "${EXPO_PUBLIC_APP_IDENTITY_URI:-}" != https://* ]]; then
    echo "A connected portable build requires an HTTPS EXPO_PUBLIC_APP_IDENTITY_URI." >&2
    exit 1
  fi
  if [[ "${EXPO_PUBLIC_APP_IDENTITY_URI%/}" != "${EXPO_PUBLIC_API_URL%/}" ]]; then
    echo "The judge build requires the wallet identity URI to match its public API origin." >&2
    exit 1
  fi
else
  echo "CLOUT_PREVIEW_USB must be 0 or 1." >&2
  exit 1
fi

if [[ ! -d node_modules/expo ]]; then
  echo "Install workspace dependencies with npm ci before building." >&2
  exit 1
fi

(
  cd apps/mobile
  npx expo prebuild --platform android --no-install
)

# Metro copies referenced assets but does not remove old files from this cache.
# Clear only generated bundle output so removed media cannot survive a rebuild.
rm -rf apps/mobile/android/app/build/generated/res/react/release \
  apps/mobile/android/app/build/generated/assets/react/release

NODE_ENV=production bash scripts/android-env.sh apps/mobile/android/gradlew \
  -p apps/mobile/android app:assembleRelease \
  --init-script "$CLOUT_PROJECT_ROOT/scripts/android-preview.init.gradle" \
  -PreactNativeArchitectures=arm64-v8a --no-daemon --max-workers=4

mkdir -p artifacts
cp apps/mobile/android/app/build/outputs/apk/release/app-release.apk artifacts/clout-preview.apk
bash scripts/android-env.sh .tooling/android-sdk/build-tools/36.0.0/apksigner verify --verbose artifacts/clout-preview.apk
bash scripts/android-env.sh .tooling/android-sdk/build-tools/36.0.0/zipalign -c -P 16 4 artifacts/clout-preview.apk
shasum -a 256 artifacts/clout-preview.apk
echo "Built artifacts/clout-preview.apk. JavaScript/media are bundled; no Metro server is required."
