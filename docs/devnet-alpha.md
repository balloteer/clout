# Devnet alpha setup

Clout runs only on Solana devnet. The user-funded isolated wallet provisioned a six-decimal mock SKR mint and 68 actual Meteora DBC markets: one for each of the 50 licensed samples and 18 curated Solana, SKR and AI videos. The 50 licensed five-to-ten-second clips are bundled at 480 × 1068, matching the Seeker panel's 40:89 ratio. Market records in `packages/shared/src/sample-markets.ts` were generated only after finalized launch receipts and on-chain account verification.

- Mock SKR mint: `8sRfkBQg3u38JFZ36poZCuBeiytksTCKHHs3Kz4eiXmC`.
- Public catalog metadata: <https://clout-devnet-catalog.vercel.app>.
- Sample market graduation threshold: 1,000 mock SKR. The separate bootstrap rehearsal configuration uses two mock SKR.
- Complete launch receipts: ignored `artifacts/devnet-sample-markets.json`; public addresses/signatures also live in the shared source registry.
- Task keys and exact signed transaction journals: ignored `.tooling/devnet/`, with private file permissions. No user wallet file is read.

The app's sidebar, mobile menu and Profile expose **Mint mock SKR**. This faucet uses the same configured mint as post markets. It grants 1,000 mock SKR per authenticated wallet per UTC day, resetting at 00:00 UTC. Database reservations enforce the daily limit, including concurrent requests and restarts. The default operational limits are 10,000 wallet allocations per day and an absolute one-billion mock-SKR supply ceiling. Grants are persisted before broadcast and displayed as received only after finalization. Unknown expired signatures stop for review. Mainnet SGT rewards and identity services are unavailable in this alpha.

## Connect persistent services

The owner’s project `qsboauxywnuhitlpmojw` is connected. All three migrations are applied and verified, and the 68-post/68-market catalog is seeded. The local API runs in connected mode with trading and the daily faucet enabled. The preview at `http://localhost:8081` calls that API and preserves the bundled media and curated source attribution. This does not deploy the API or app publicly.

Save the supplied project's session-pooler `DATABASE_URL` (port 5432) in ignored `apps/api/.env.local`. Do not paste its password into chat. Supabase’s official public CA is bundled and scoped to database TLS; hostname verification stays enabled. Setup commands accept only Supabase project `qsboauxywnuhitlpmojw`, enforce TLS and redact raw connection failures.

```sh
node --env-file-if-exists=apps/api/.env.local scripts/db-setup.mjs
# After its read-only check reports the expected empty or already-migrated schema:
node --env-file-if-exists=apps/api/.env.local scripts/db-setup.mjs --apply
node --env-file-if-exists=apps/api/.env.local scripts/db-linked.mjs
node --env-file-if-exists=apps/api/.env.local scripts/db-linked.mjs --apply
node --env-file-if-exists=apps/api/.env.local scripts/db-faucet.mjs
node --env-file-if-exists=apps/api/.env.local scripts/db-faucet.mjs --apply
node scripts/configure-devnet.mjs
```

`configure-devnet.mjs` writes only the isolated task mint/config/authority and bounded faucet settings to the ignored API environment file. It keeps demo mode and the faucet disabled while `DATABASE_URL` is missing. It preserves other service settings. Restart the API after configuring it.

Set `CLOUT_SAMPLE_MEDIA_ORIGIN` to the reachable API origin serving `/v1/samples/media/`. HTTPS is required except for an explicit loopback development origin. Seed the existing database additively:

```sh
node --import tsx scripts/seed-samples.mjs
node --import tsx scripts/seed-samples.mjs --apply
```

The helper verifies devnet genesis, all 68 finalized receipts, quote mint, operator and pool configuration before synchronizing the catalog. Dry-run is the default. It preserves existing markets and profiles, inserts missing curated rows, and attaches a first market only to an exact original unmarketed sample row. Conflicting post IDs roll back the entire import. No balances, claims or user content are changed. Bundled media routes whitelist catalog filenames and support byte ranges. A deployed API must include the bundled media directory.

Set `EXPO_PUBLIC_API_URL` in `apps/mobile/.env.local` to the API reachable by the device and restart Metro/rebuild the APK. For USB local development, use `http://127.0.0.1:8787` with `adb reverse tcp:8787 tcp:8787`. Native Android uses Mobile Wallet Adapter pinned to the Seeker wallet. Android browser sign-in uses Seeker Connect, also pinned to that wallet; desktop previews remain read-only. See [Seeker wallet setup](seeker-wallet.md), including the browser relay terms.

X automatic imports also require X OAuth/API configuration, a token-encryption key and Cloudflare Stream credentials. Profile permits at most three combined accounts. Fomo is intentionally unavailable until the specific app and its supported authorization/import API are known. No actual external account was linked during tests.

## Reproduce chain preparation

```sh
npx tsx packages/markets/scripts/bootstrap-devnet.ts prepare
npx tsx packages/markets/scripts/bootstrap-devnet.ts provision
npx tsx packages/markets/scripts/build-sample-metadata.ts
# Publish the generated public metadata before launching immutable post tokens.
npx tsx packages/markets/scripts/seed-sample-markets.ts prepare
npx tsx packages/markets/scripts/seed-sample-markets.ts run
npx tsx packages/markets/scripts/seed-sample-markets.ts verify
```

The market extension reuses the existing task creator, curve configuration and mint, preserving the original 30 pool addresses. It does not create a new operator or transfer additional funding. These commands reuse persisted signed bytes and finalized receipts. An expired unknown or failed transaction requires inspection; no replacement launch is silently created. Mock SKR and all post tokens in this alpha have no monetary value.

## Complete catalog checkpoint

All 38 missing markets were initialized on devnet, bringing the catalog to 68 distinct post mints and pools. The original 30 registrations remain unchanged. Each launch was simulated, journaled before broadcast, finalized and checked against the existing mock SKR mint, creator and curve configuration. Public receipts live in `packages/shared/src/sample-markets.ts`; no private keys are committed.

The funding wallet is `H8xYY5wr3o8Q4xKK8NDZSf9vb7vxuVvZcgHws9t7kge3`; the existing market operator is `HDXHbGGRibekDCYGHABe16PAzKJWezgbwBniG37KBHGp`. Both are isolated development wallets, and the extension used the operator’s existing devnet SOL. Curated publishers retain their source attribution and do not operate or endorse the Clout demo markets. The Markets tab filters actual references, and the eye appears only on posts with a market.
