# Devnet alpha setup

Clout runs only on Solana devnet. The user-funded isolated wallet provisioned a six-decimal mock SKR mint and 30 actual Meteora DBC markets. The 50 licensed five-to-ten-second clips are bundled at 480 × 1068, matching the Seeker panel's 40:89 ratio. Market records in `packages/shared/src/sample-markets.ts` were generated only after finalized launch receipts and on-chain account verification.

- Mock SKR mint: `8sRfkBQg3u38JFZ36poZCuBeiytksTCKHHs3Kz4eiXmC`.
- Public licensed metadata: <https://clout-devnet-catalog.vercel.app>.
- Sample market graduation threshold: 1,000 mock SKR. The separate bootstrap rehearsal configuration uses two mock SKR.
- Complete launch receipts: ignored `artifacts/devnet-sample-markets.json`; public addresses/signatures also live in the shared source registry.
- Task keys and exact signed transaction journals: ignored `.tooling/devnet/`, with private file permissions. No user wallet file is read.

The app's sidebar, mobile menu and Profile expose **Mint mock SKR**. This faucet uses the same configured mint as post markets. It grants 1,000 mock SKR per authenticated wallet per UTC day, resetting at 00:00 UTC. Database reservations enforce the daily limit, including concurrent requests and restarts. The default operational limits are 10,000 wallet allocations per day and an absolute one-billion mock-SKR supply ceiling. Grants are persisted before broadcast and displayed as received only after finalization. Unknown expired signatures stop for review. Mainnet SGT rewards and identity services are unavailable in this alpha.

## Connect persistent services

Save the supplied project's transaction-pooler `DATABASE_URL` in ignored `apps/api/.env.local`. Do not paste its password into chat. Setup commands accept only Supabase project `qsboauxywnuhitlpmojw`, enforce TLS and redact raw connection failures.

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

The helper verifies devnet genesis, finalized receipts, quote mint, creator and pool configuration before inserting 50 posts. Dry-run is the default. It never replaces existing profiles or posts, and conflicting post IDs roll back the entire import. Bundled media routes whitelist catalog filenames and support byte ranges. A deployed API must include the bundled media directory.

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

These commands reuse persisted signed bytes and finalized receipts. An expired unknown or failed transaction requires inspection; no replacement launch is silently created. Mock SKR and all post tokens in this alpha have no monetary value.
