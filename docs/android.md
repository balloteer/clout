# Android development build

Clout needs a native Android build for Mobile Wallet Adapter. Expo Go cannot run the wallet integration. The development APK uses a debug signing key and loads JavaScript from Metro. The standalone preview APK bundles JavaScript and media and opens without Metro. Both are test builds, not dApp Store releases.

## Standalone preview APK

After installing the local toolchain and workspace dependencies:

```bash
bash scripts/build-android-preview.sh
```

This produces `artifacts/clout-preview.apk` for ARM64 devices, including Seeker. The build uses release bundling and an explicit Gradle configuration that forces the generated debug key; it never selects a production signing key. The script clears generated Metro bundle output first so removed assets cannot linger in incremental builds. APK signature and 16 KB ZIP alignment are checked before the command reports success. Install it with:

```bash
bash scripts/android-env.sh adb install -r artifacts/clout-preview.apk
```

Public API, RPC and wallet-identity environment values are bundled at build time. The build script disables dotenv loading so a browser's `.env.local` cannot silently change the APK. By default its API is blank: 50 bundled samples play offline and the 12 active curated videos require internet. Connected services require an API. Use `CLOUT_PREVIEW_API_URL=https://your-api.example bash scripts/build-android-preview.sh` for a reachable HTTPS API. Rebuild after changing public environment values.

The current artifact is a **portable judge preview**, version **0.1.8 (9)**. It contains the repaired Seeker wallet connection, `.skr` profile names, a visible Profile SKR balance and per-post investments, 80 verified mock-SKR markets (62 active posts and 18 archived picks), reviewed portrait videos, a current market SKR balance and recorded investment chart, pinned trade approval, direct Supabase Storage uploads, sound enabled by default, Markets filtering, native vertical paging and the daily faucet UI. Reproduce it with:

```bash
CLOUT_PREVIEW_API_URL=https://cloutvercel.vercel.app \
EXPO_PUBLIC_APP_IDENTITY_URI=https://cloutvercel.vercel.app \
bash scripts/build-android-preview.sh
bash scripts/android-env.sh adb -s YOUR_SEEKER_SERIAL install -r artifacts/clout-preview.apk
```

The judge preview embeds the production HTTPS API and contains no localhost endpoint, so its Supabase, trading and faucet requests work without Metro, a Mac process or USB forwarding. The Expo plugin removes the development cleartext network policy when the USB flag is disabled.

Latest rebuilt artifact: **2026-10-14**, **0.1.8 (9)**, **94,032,017 bytes**, SHA-256 `bda71cbfc22db60ef0b97cacd9751c6b52f0f8b18117763445c5fdeb37641847`. APK signature verification and 16 KB ZIP alignment pass. It retains the original preview signing certificate, so `adb install -r` updates the existing app without clearing its data.

The owner confirmed physical Seeker login and a 1,000 mock SKR mint on version 0.1.2 (3). The in-place updates preserve app data; version 0.1.6 shows the 980 SKR remainder and two actual held positions with their cumulative backing, executable value and return. Its investment sheet loaded the live 174.072802 SKR reserve, produced a real devnet quote, and kept **Approve in wallet** fully visible at `[75,2421][1125,2571]` after quote expansion. No wallet transaction was approved during this check. Evidence is under `artifacts/native-review/v016-*`. The current connected API independently returns 62 active posts with 62 markets; all 80 registrations remain stored.

Version 0.1.5 passed the native emulator smoke at 400×890 dp with the exact installed APK hash: audible portrait playback, pause/resume, mute/unmute, and Airforcetuan → Kling → Pika → Kling paging. The first market's actual activity endpoint and native sheet showed **174.072802 mock SKR**, **eight verified trades**, and **four demo wallets**. The graph and 50 dp Get quote button fit without scrolling; Close remains 48 dp. The seeded label is visible. PID-scoped Android/React Native error logs are empty. No wallet action was approved. Evidence: `artifacts/native-review/v015-native-results.json` and `v015-investments.png`. Physical user trade approval remains an owner validation step.

## Isolated macOS ARM64 setup

From the repository root:

```bash
npm ci
bash scripts/setup-android.sh
bash scripts/android-env.sh npx --yes solana-mobile@latest doctor
bash scripts/build-android-debug.sh
```

The setup script displays Android SDK licenses for acceptance. An unattended installation can explicitly accept them with `bash scripts/setup-android.sh --accept-licenses`.

Everything installed by these scripts lives in ignored `.tooling/`: the JDK, Android SDK, Android user settings, downloads and Gradle cache. The scripts do not edit shell profiles or replace a system Java or Android installation. Use the wrapper for each tool command; it exports the needed environment only to that command.

Metro excludes `.tooling`, APK artifacts, the original brand kit, research files and the generated Android project from its monorepo scan. App assets and shared packages remain included. This prevents native build caches from slowing development reloads.

The pinned macOS ARM64 archives are verified against SHA-256 checksums before extraction. Current build inputs:

| Component                      | Version                                  |
| ------------------------------ | ---------------------------------------- |
| Eclipse Temurin JDK            | 17.0.20.1+1, ARM64                       |
| Android command-line tools     | 15859902, ARM64                          |
| Android compile and target SDK | 36                                       |
| Android build tools            | 36.0.0                                   |
| Android platform tools         | Installed from the SDK repository        |
| Gradle wrapper                 | 9.3.1, generated by Expo                 |
| Android NDK                    | 27.1.12297006, requested by React Native |

SDK and native dependency requirements come from the installed Expo/React Native packages and generated Gradle project. Gradle may download additional SDK components, NDK and CMake during the first build. Google's current command-line package still includes `sdkmanager` but prints a deprecation notice recommending `android sdk`.

The build script generates `apps/mobile/android` using Expo prebuild, compiles only `arm64-v8a`, and copies the APK to `artifacts/clout-debug.apk`. Generated native files and APKs are ignored by Git. The first build needs network access and several gigabytes of free space. Repeat builds use the local caches.

## Run on a Seeker

Enable Android developer options and USB debugging on the phone, connect USB, and approve the computer on the device.

```bash
bash scripts/android-env.sh adb devices -l
bash scripts/android-env.sh npx --yes solana-mobile@latest device install ./artifacts/clout-debug.apk
npm run dev
```

Open the Metro development URL printed by Expo in the installed Clout development client. For USB networking, forward Metro's port:

```bash
bash scripts/android-env.sh adb reverse tcp:8081 tcp:8081
```

The local API defaults to port 8787. Forward that port too and use `http://127.0.0.1:8787` for the phone's configured development API URL:

```bash
bash scripts/android-env.sh adb reverse tcp:8787 tcp:8787
```

Use the numeric loopback address for this USB setup. The tested emulator could not resolve the hostname `localhost` from Android's network client.

The phone must use Seeker's built-in Seed Vault Wallet. Native association verifies the installed production package and signing certificate and opens its explicit Android component; optional returned endpoint metadata does not identify the wallet. Browser association retains the official `https://connect.solanamobile.com` endpoint. Generic wallet choosers and earlier generic-wallet sessions are rejected. Verify the physical wallet's devnet behavior; automated transport checks cannot establish device ownership. Trading and the faucet use only the configured devnet mock-SKR mint. The server may read mainnet through an isolated RPC solely to display `.skr` profile names; mainnet SGT checks and all mainnet transactions remain disabled. Mock SKR has no monetary value. A wallet/network mismatch must stop signing.

For real-wallet release validation, set `EXPO_PUBLIC_APP_IDENTITY_URI` to an HTTPS origin you control and publish its `/.well-known/assetlinks.json` with the Android package `app.clout.mobile` and the correct signing-certificate SHA-256 fingerprint. The app omits the URI in an unconfigured preview; a wallet may reject an unverified identity. A custom app deep link is not a web identity, and successful Fakewallet authorization does not establish production wallet trust. See [MWA native identity verification](https://solana-mobile.github.io/mobile-wallet-adapter/spec/spec.html).

## Optional isolated emulator

An emulator can verify native launch, playback and the wallet handoff. It cannot prove physical Seeker eligibility.

```bash
bash scripts/android-env.sh sdkmanager 'emulator' 'system-images;android-36;google_apis;arm64-v8a'
printf 'no\n' | bash scripts/android-env.sh avdmanager create avd --name clout-dev --package 'system-images;android-36;google_apis;arm64-v8a' --device pixel_9
bash scripts/android-env.sh emulator -avd clout-dev -no-window -no-audio -no-snapshot -gpu swiftshader -memory 2048 -cores 2
```

Run the emulator command in a separate terminal. Its files stay in `.tooling/android-user/avd`. The Solana Mobile CLI's emulator creation command currently assumes the default `~/.android/avd` path after creation, so the isolated setup uses Android's own AVD manager and emulator launcher.

After Android finishes booting:

```bash
bash scripts/android-env.sh npx --yes solana-mobile@latest device tune --device emulator-5554 -y
bash scripts/android-env.sh npx --yes solana-mobile@latest device install fakewallet
bash scripts/android-env.sh npx --yes solana-mobile@latest device install ./artifacts/clout-debug.apk
bash scripts/android-env.sh adb reverse tcp:8081 tcp:8081
```

Use the MWA fake wallet only for development. Stop the emulator with `bash scripts/android-env.sh adb -s emulator-5554 emu kill`.

## Device acceptance

The 2026-10-12 local run verified native launch, video playback, Feed/Profile navigation, Fakewallet devnet authorization and signed login through the local API on an ARM64 Android 36 emulator. The authenticated sample wallet correctly had no Seeker badge, and video playback resumed after wallet return. These historical checks used the development APK and a test wallet. They predate the Seeker-only policy; Fakewallet is now intentionally rejected.

The final standalone preview passed a fresh launch with no Metro forwarding, advancing video frames after a cold start, ten alternating 333 dp/200 ms flicks using regularly timed native input, and comments pause/resume. Earlier checkpoints also verified all five tabs, saving a post into Collection and reopening the correct video. The current preview contains the JavaScript bundle and 50 distinct licensed video excerpts with matching posters; 49 clips are 10 seconds and the first Caminandes clip is 5 seconds. The catalog and asset manifest record source intervals, license attribution and content hashes. JavaScript and Android runtime error logs were empty during these checks.

The native layout review uses Seeker's official 1200 × 2670 portrait resolution, a 40:89 ratio. The isolated emulator is configured at 480 logical dpi (400 × 890 dp), with a second pass at 460 logical dpi (approximately 417 × 929 dp). The published 460 PPI specification describes physical pixel density; it does not establish the phone's Android logical density. These are layout test profiles, not a claim that an emulator reproduces Seeker hardware.

```bash
bash scripts/android-env.sh adb -s emulator-5554 shell wm size 1200x2670
bash scripts/android-env.sh adb -s emulator-5554 shell wm density 480
bash scripts/android-env.sh adb -s emulator-5554 shell settings put system font_scale 1.5
# Restore default text size after the accessibility pass.
bash scripts/android-env.sh adb -s emulator-5554 shell settings put system font_scale 1.0
```

At both layout profiles, the immersive feed measured the full 1200 × 2670 pixels. Native checks at 100%, 130% and 150% text size kept captions clear of the action rail and the backing button, with navigation above the Android gesture area. Feed controls and sheet close buttons now have at least 48 dp targets. Comments pause playback while open, and Android Back dismisses the market sheet. Android's photo picker selected a local test clip, caption editing updated the character count, and scrolling reached the wallet-gated publish action. No upload or funded transaction was submitted. Review screenshots and accessibility trees are in `artifacts/native-review`.

Before the final paging-only corrections, the standalone APK also repeated the review without Metro: swiping up changed to the next video, swiping down restored the prior video, saving added the post to Collection, and all five tabs remained usable at 150% text size. Profile and Create content scrolled to their lower actions. Frame comparisons confirmed moving video, and the native JavaScript/runtime error log remained empty. The app was stopped and the emulator text scale restored to 100% after the check.

The software-keyboard review found and fixed a hidden caption field. Native keyboard avoidance, temporary tab hiding, and explicit caption focus scrolling keep the complete field above the keyboard; dismissing the keyboard restores navigation. A 12-line caption also remained fully visible, and the publish action opened the wallet sheet on its first tap while typing. Modal sheets received separate keyboard avoidance because they use a separate native window. Editable community comments and market fields still need a connected API fixture for their keyboard check; they are unavailable in the portable offline preview.

Signed-session restoration passed with the local API process held stable: after signing in, the development app was force-stopped and reopened, and Profile restored the same authenticated wallet without requesting another signature. The sample API uses in-memory sessions, so restarting that server intentionally requires a new login.

A successful APK build proves native compilation and packaging. The owner confirmed physical Seeker login and a 1,000 mock SKR mint on version 0.1.2 (3). Remaining physical validation covers trade signing, confirmation and cancellation, selling after migration, creator fee claims and upload processing. Real X authorization/import and a supported Fomo integration also require their configured services. A disconnected device cannot establish these results.

The preview passes 16 KB APK ZIP alignment and all 25 ARM64 libraries have load-segment alignment of at least 16 KB. A deeper audit found that 24 bundled native libraries do not end their RELRO segment on a 16 KB boundary. The current Expo/React Native dependency set therefore needs further native-library work and testing before claiming full support for 16 KB devices. The local emulator uses 4 KB pages. See [Android's ELF and RELRO checks](https://developer.android.com/guide/practices/page-sizes#elf-alignment).

The release APK needs production configuration, release signing credentials and the completed acceptance flow. Mainnet execution and store publication require their own explicit authorization.

## Sources

- [Expo SDK platform compatibility](https://docs.expo.dev/versions/latest/)
- [React Native Android environment setup](https://reactnative.dev/docs/set-up-your-environment)
- [Official Android command-line tools](https://developer.android.com/studio#command-line-tools-only)
- [Eclipse Temurin 17 downloads](https://adoptium.net/temurin/releases/?version=17)
- [Solana Mobile CLI](https://github.com/solana-mobile/solana-mobile-cli)
- [Official Seeker display specifications](https://solanamobile.com/seeker)
- [Android touch-target guidance](https://developer.android.com/guide/topics/ui/accessibility/apps#touch-targets)

## Repeatable native gesture checks

The software-rendered emulator occasionally gives `adb shell input swipe` gaps of 50–90 ms between motion events. Android's [VelocityTracker](https://android.googlesource.com/platform/frameworks/native/+/refs/heads/main/libs/input/VelocityTracker.cpp) discards velocity after a gap greater than 40 ms, including at pointer release. Our captured 333 dp flick had a 60 ms final gap and snapped back. The same coordinates and duration advanced a page when injected asynchronously with 15–16 ms event timestamps. This isolates an input-timing limitation in that test; it does not replace testing on physical Seeker hardware.

`scripts/android/CloutSwipe.java` is an Android 36 shell test helper, not app code. It injects a regular event timeline without waiting for each frame to render. Compile it with the isolated SDK and run only against the test emulator:

```bash
mkdir -p .tooling/native-input-classes .tooling/native-input-dex
bash scripts/android-env.sh javac \
  -cp .tooling/android-sdk/platforms/android-36/android.jar \
  -d .tooling/native-input-classes scripts/android/CloutSwipe.java
bash scripts/android-env.sh .tooling/android-sdk/build-tools/36.0.0/d8 \
  --lib .tooling/android-sdk/platforms/android-36/android.jar \
  --output .tooling/native-input-dex .tooling/native-input-classes/CloutSwipe.class
bash scripts/android-env.sh jar cf .tooling/clout-input.jar -C .tooling/native-input-dex classes.dex
bash scripts/android-env.sh adb -s emulator-5554 push .tooling/clout-input.jar /data/local/tmp/clout-input.jar
# Up: 333 dp over 200 ms at the 480-dpi test profile.
bash scripts/android-env.sh adb -s emulator-5554 shell \
  'CLASSPATH=/data/local/tmp/clout-input.jar app_process /system/bin CloutSwipe 550 1900 900 200'
# Down: the corresponding reverse gesture.
bash scripts/android-env.sh adb -s emulator-5554 shell \
  'CLASSPATH=/data/local/tmp/clout-input.jar app_process /system/bin CloutSwipe 550 700 1700 200'
```

Allow the native page animation to settle before the next gesture. `adb shell dumpsys input` records the recent MotionEvents and their timestamps. Raw traces and both failed synchronous attempts and successful asynchronous sequences are retained in `artifacts/native-review`.
