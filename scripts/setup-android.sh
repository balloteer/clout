#!/usr/bin/env bash
# Local macOS ARM64 toolchain. Pinned archives are checked before extraction.
set -euo pipefail

CLOUT_PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUT_TOOLING="$CLOUT_PROJECT_ROOT/.tooling"

if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "This bootstrap targets macOS ARM64. Use your platform's Android SDK/JDK instructions." >&2
  exit 1
fi
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != --accept-licenses ) ]]; then
  echo "Usage: bash scripts/setup-android.sh [--accept-licenses]" >&2
  exit 1
fi

mkdir -p "$CLOUT_TOOLING/downloads" "$CLOUT_TOOLING/java" "$CLOUT_TOOLING/android-sdk/cmdline-tools"

download() {
  local url="$1" file="$2" checksum="$3"
  if [[ ! -f "$file" ]]; then
    curl --fail --location --retry 3 "$url" --output "$file"
  fi
  local actual
  actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  if [[ "$actual" != "$checksum" ]]; then
    echo "Checksum mismatch: $file. Review and remove the incomplete archive before retrying." >&2
    exit 1
  fi
}

if [[ ! -x "$CLOUT_TOOLING/java/Contents/Home/bin/java" ]]; then
  download \
    'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_aarch64_mac_hotspot_17.0.20.1_1.tar.gz' \
    "$CLOUT_TOOLING/downloads/jdk17.tar.gz" \
    '196d13ba5f10414bef7f6a05a9b3f00edacb18ebacef2b99485db9e2ee18f0e8'
  tar -xzf "$CLOUT_TOOLING/downloads/jdk17.tar.gz" -C "$CLOUT_TOOLING/java" --strip-components=1
fi

if [[ ! -x "$CLOUT_TOOLING/android-sdk/cmdline-tools/latest/bin/sdkmanager" ]]; then
  download \
    'https://dl.google.com/android/repository/commandlinetools-mac_arm64-15859902_latest.zip' \
    "$CLOUT_TOOLING/downloads/android-commandline.zip" \
    '835b62a26162b229b441d1f6d4680383815a270809eb33522c0d480fa5002c4e'
  unzip -q "$CLOUT_TOOLING/downloads/android-commandline.zip" -d "$CLOUT_TOOLING/android-sdk/cmdline-tools"
  mv "$CLOUT_TOOLING/android-sdk/cmdline-tools/cmdline-tools" "$CLOUT_TOOLING/android-sdk/cmdline-tools/latest"
fi

if [[ "${1:-}" == --accept-licenses ]]; then
  # The explicit flag accepts the licenses printed by Google's SDK manager.
  set +e
  yes | bash "$CLOUT_PROJECT_ROOT/scripts/android-env.sh" sdkmanager --licenses
  license_status=${PIPESTATUS[1]}
  set -e
  if [[ "$license_status" -ne 0 ]]; then
    exit "$license_status"
  fi
else
  bash "$CLOUT_PROJECT_ROOT/scripts/android-env.sh" sdkmanager --licenses
fi

bash "$CLOUT_PROJECT_ROOT/scripts/android-env.sh" sdkmanager \
  'platform-tools' 'platforms;android-36' 'build-tools;36.0.0'

echo "Toolchain ready. Run commands with: bash scripts/android-env.sh <command>"
