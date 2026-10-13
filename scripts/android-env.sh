#!/usr/bin/env bash
# Run a command with Clout's isolated Android toolchain; does not change the caller's shell.
set -euo pipefail

CLOUT_PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export JAVA_HOME="$CLOUT_PROJECT_ROOT/.tooling/java/Contents/Home"
export ANDROID_HOME="$CLOUT_PROJECT_ROOT/.tooling/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_USER_HOME="$CLOUT_PROJECT_ROOT/.tooling/android-user"
export ANDROID_EMULATOR_HOME="$ANDROID_USER_HOME"
export ANDROID_AVD_HOME="$ANDROID_USER_HOME/avd"
export GRADLE_USER_HOME="$CLOUT_PROJECT_ROOT/.tooling/gradle"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

if [[ ! -x "$JAVA_HOME/bin/java" || ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]]; then
  echo "Android tooling is missing. Run: bash scripts/setup-android.sh" >&2
  exit 1
fi

mkdir -p "$ANDROID_USER_HOME" "$ANDROID_AVD_HOME" "$GRADLE_USER_HOME"

if [[ $# -eq 0 ]]; then
  java -version
  sdkmanager --version
  echo "Usage: bash scripts/android-env.sh <command> [arguments...]"
  exit 0
fi

exec "$@"
