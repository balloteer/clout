# Clout

**Seek the best content, win SKR**

Native Android / Seeker app built from [PLAN.md](PLAN.md), with an Expo browser preview. SKR is the backing, tipping, and rewards currency. Clout does **not** issue a platform token; individual post tokens represent market positions. SOL pays network fees only.

The preview includes 62 active posts: 50 bundled samples and 12 frame-reviewed, native portrait [Solana, SKR and AI videos](docs/curated-content.md). The feed snaps one post per gesture and starts with sound enabled. A browser that blocks audible autoplay shows **Tap to play with sound**; the mute control remains available. All active videos have finalized devnet markets using mock SKR. The 18 earlier curated posts retain their original markets and remain accessible through saved collections and existing positions.

## Run locally

```sh
npm install
npm run api
# In another terminal:
npm run web
```

Open http://localhost:8081. The default preview runs without accounts or cloud credentials and includes 50 distinct, bundled, credited portrait film excerpts. All 50 bundled clips and 12 active curated videos have finalized mock-SKR markets on Solana devnet. Sample creator labels identify licensed footage; social counts and payouts are not fabricated. Likes, saved posts, and followed sample creators persist on the device.

To connect the app to the API, copy `apps/mobile/.env.example` to `apps/mobile/.env.local`, then restart Metro. The API defaults to a local, in-memory demo repository; restarting it clears server-side demo mutations. Sign-in uses only the Seeker built-in wallet: pinned Mobile Wallet Adapter on native Android, or Seeker Connect in its Android browser. Desktop remains a read-only preview; Expo Go cannot run the native wallet integration. See [wallet setup](docs/seeker-wallet.md).

```sh
npm run android
```

For a reproducible isolated Android toolchain, APK builds, and emulator setup, see [docs/android.md](docs/android.md). Device access to a local API requires `adb reverse tcp:8787 tcp:8787` over USB or a reachable HTTPS API URL.

## What is implemented

- Five primary screens plus a Mint mock SKR screen accessible from the sidebar, phone menu and Profile, using the supplied Clout logos, Titan One and DM Sans fonts, pink/lime/ink palette, and exact slogan.
- Vertical TikTok-style paging with one active video player in a Seeker-proportioned 40:89 frame, a fixed eye investment button above Like, safe-area overlays, native background/dialog pause, playback retry, and current-post/filter restoration across tabs. Create keeps its publish action visible; Discover keeps search and filters pinned. See the [Seeker layout review](docs/mobile-layout.md). Sample discussion, bookmark persistence, creator follows, and direct video upload UI.
- Seeker-only wallet routing on Android and web, challenge signature verification, single-use nonces, hashed server sessions, secure mobile session storage. Runtime services are devnet-only; mainnet `.skr`/SGT services are disabled in this alpha.
- SKR-quoted Meteora DBC and DAMM v2 adapters: launch, quote, buy, sell, fees, explicit migration steps, checked SKR tips, devnet validation, simulation, and message-bound confirmation.
- Signed transaction recovery persisted **before** broadcast, one pending transaction per wallet, duplicate-intent guards, and background reconciliation of submitted API intents.
- Real wallet holdings and sell quotes when connected, collection receipts, creator actions, and a Supabase-compatible Postgres schema with row-level access policies.
- Cloudflare direct uploads and authenticated processing webhooks. Uploading and market launch are separate actions.
- A daily mock-SKR faucet: 1,000 SKR per wallet per UTC day, resetting at 00:00 UTC, with verified devnet mint authority, atomic database reservations, durable signed recovery and finalized receipts. It stays disabled until persistent storage is configured. SGT-based rewards are unavailable in this devnet-only alpha.
- Profile linking for up to three combined external accounts, with secure X authorization, pause/resume/disconnect and automatic owned-video imports. X/Cloudflare credentials are required; Fomo remains unavailable until its exact service and API are identified.
- Small Early alpha · Devnet notices throughout the phone and desktop navigation.
- The eye opens [Video investments](docs/investments.md): current Mock SKR in the market, a recorded backing graph above buy/sell controls, and explicit empty, unavailable and stale states. Current pool reserves and net flow across the latest 100 Clout trades are labeled separately; neither is a fabricated return or the viewer's personal balance. Operator-seeded real devnet trades are explicitly labeled **Seeded demo activity**, including verified trade and wallet counts.

The two integration guides describe the API and chain configuration: [backend](docs/backend.md), [markets](docs/markets.md).

## Network and currency

This implementation deliberately executes transactions on **devnet only**. Mainnet SKR is the existing token `SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3`; the provisioned mock mint is `8sRfkBQg3u38JFZ36poZCuBeiytksTCKHHs3Kz4eiXmC`. The app labels this **Test SKR**. A test mint has no mainnet SKR value. Mainnet transactions and authority changes require a separate explicit approval.

No treasury secrets or production service keys are committed. This alpha makes no mainnet identity or token reads. Public sample-token metadata is hosted at [Clout devnet catalog](https://clout-devnet-catalog.vercel.app); the app/API have not been deployed there.

## Checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run format:check
# With the browser preview running:
node scripts/verify-web.mjs
```

The browser check covers desktop, 400×890 Seeker proportions, and short phone layouts: exact video aspect ratio, non-overlapping 48px feed controls, playback/mute/navigation, modal pause, media-error retry, current-post/filter restoration, saved-post persistence, discovery filtering, follows, comments, market gating, upload gating, and desktop wallet gating. Market tests validate token units, slippage, quote expiry, SDK transaction construction, graduation routing and exact settlement matching. API tests use actual HTTP requests and a local Postgres-compatible engine to exercise signature replay prevention and database permissions.

## Delivery gates

See [docs/acceptance.md](docs/acceptance.md) for verified checks and remaining release work. Separate live devnet rehearsals finalized buys, sells, graduation to DAMM v2, creator fee claims and a mock-SKR tip using isolated task wallets. Hosted API/Cloudflare configuration, provider credentials, app-to-API recovery testing and physical trade testing remain prerequisites for the planned release. Supabase project `qsboauxywnuhitlpmojw` is connected: all three migrations are verified, 80 posts with 80 distinct markets are stored, with 62 visible in the active feed, and the local API has trading and the daily faucet enabled. The app preserves source attribution and uses reviewed portrait footage to fill the Seeker frame. Profile shows the live SKR balance above its stats. The owner confirmed physical Seeker login and a 1,000 mock SKR mint. Credentials stay in ignored local environment files. Provider imports remain disabled until their services are configured. See [devnet setup](docs/devnet-alpha.md).

The upstream native and Meteora dependencies currently contain npm audit advisories. Do not force incompatible SDK downgrades to silence the report. Recheck and resolve or explicitly assess those advisories before release; this branch is not represented as production-ready.

Brand sources are in `Clout-Brand-Kit/`; both PDF copies and the ZIP include the updated slogan. The original research remains in `research/`. Bundled demo-media attribution and edits are recorded in [CREDITS.md](apps/mobile/assets/media/CREDITS.md).
