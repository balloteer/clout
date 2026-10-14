# Judge release runbook

The judge APK points at a public HTTPS API. Vercel builds the repository's `Dockerfile.vercel` as an autoscaling container Function; Supabase provides the durable database and video storage.

## 1. Deploy the API on Vercel

1. Import `https://github.com/balloteer/clout` into Vercel and keep the project root at the repository root (`.`). The API imports the root lockfile, shared workspaces and bundled sample media.
2. Select the **Container** preset if Vercel does not automatically detect `Dockerfile.vercel`. Do not set a build or output command. `vercel.json` keeps the Function in `sfo1`, close to the Supabase `us-west-2` pooler.
3. Under **Settings → Environment Variables**, enable automatic System Environment Variables. The API derives its stable HTTPS identity origin from `VERCEL_PROJECT_PRODUCTION_URL`. A custom `CLOUT_ORIGIN` is needed only if that automatic value is deliberately disabled.
4. Add the variables below to **Production**. Choose Vercel's **Secret** type for every credential named below. Disable automatic Preview deployments for this API unless you create an isolated connected Preview environment with its own database, origin and credentials; an unconfigured Preview intentionally fails closed. Never put server credentials in build arguments, Git, Expo variables or logs.

`Dockerfile.vercel` sets `NODE_ENV=production`, `HOST=0.0.0.0` and `CLOUT_TRUST_PROXY_HOPS=1`. Vercel injects `PORT` and replaces `x-forwarded-for` with the client IP. Do not override those values for the production project.

### Required for login, feed and trading

```dotenv
CLOUT_MODE=connected
DATABASE_URL=<sealed Supabase server pooler URL>
SOLANA_DEVNET_RPC_URL=<sealed devnet RPC URL>
SKR_DEVNET_MINT=8sRfkBQg3u38JFZ36poZCuBeiytksTCKHHs3Kz4eiXmC
SKR_DECIMALS=6
METEORA_DBC_CONFIG=<devnet DBC configuration address>
LOCAL_UPLOADS_ENABLED=false
REWARDS_ENABLED=false
MAINTENANCE_SECRET=<one stable 64-character hexadecimal secret>
```

Generate `MAINTENANCE_SECRET` once with `openssl rand -hex 32`. Store the exact same value in Vercel and the Cloudflare recovery Worker. Set `DATABASE_URL`, `SOLANA_DEVNET_RPC_URL`, `MAINTENANCE_SECRET` and `FAUCET_MINT_AUTHORITY_SECRET_BASE64` to the **Secret** type. `DATABASE_URL` must use the Supabase server-side session/shared pooler on port 5432, with special characters in the password percent-encoded. The API uses a bounded connection pool and the pinned public Supabase CA.

Apply `supabase/migrations/20261013090000_upload_recovery_checks.sql` before enabling the recovery Worker. The safe helper is `node --env-file=apps/api/.env.local scripts/db-upload-recovery.mjs --apply`; it pins the existing Supabase project and verifies the private grants afterward. Also apply `supabase/migrations/20261014034917_supabase_video_storage.sql`; it creates the restricted private staging bucket and public playback bucket. The recovery table rotates checks across pending uploads.

### Required for the daily mock SKR faucet

```dotenv
FAUCET_ENABLED=true
FAUCET_CAMPAIGN_ID=<stable deployment-specific identifier>
FAUCET_AMOUNT_UNITS=1000000000
FAUCET_MAX_DAILY_CLAIMS=10000
FAUCET_MAX_SUPPLY_UNITS=1000000000000000
FAUCET_MINT_AUTHORITY_SECRET_BASE64=<sealed 64-byte devnet authority key in base64>
```

The authority must control the configured mock mint and have enough devnet SOL for transaction fees and recipient token-account rent. Keep the campaign ID and supply ceiling stable across redeploys. Never reuse a mainnet key.

## 2. Configure Supabase Storage

In the same Supabase project used by `DATABASE_URL`, open **Project Settings → API Keys** and create or copy a server-only secret key. Add these values to the Vercel Production environment, then redeploy:

```dotenv
SUPABASE_URL=https://qsboauxywnuhitlpmojw.supabase.co
SUPABASE_SECRET_KEY=<sealed server-only secret key>
SUPABASE_UPLOAD_BUCKET=clout-upload-staging
SUPABASE_VIDEO_BUCKET=clout-videos
```

Set the key to Vercel's **Secret** type. The API creates a single-object signed URL; video bytes upload directly from the phone to Supabase and do not cross Vercel's request-body boundary. The server validates the private MP4 before publishing its stable public URL. Do not expose the secret key through Expo variables or the APK.

Local uploads are refused in production. Linked X accounts additionally require `LINKED_ACCOUNTS_ENABLED=true`, X OAuth credentials and a stable sealed `LINKED_ACCOUNTS_ENCRYPTION_KEY`. Leave linked accounts disabled for the judge build unless the complete provider flow has been exercised. Fomo remains unavailable.

## 3. Deploy the Cloudflare recovery Worker

Vercel containers scale to zero, so in-process timers are not the durable scheduler. The checked `workers/recovery-worker` calls the API's secret-protected, idempotent recovery endpoint once per minute. It reconciles pending devnet transactions, faucet mints, Storage uploads and enabled account imports.

```sh
cd workers/recovery-worker
npm ci
npx wrangler login
umask 077
cat > .dev.vars.production
# Enter exactly two dotenv lines, then press Control-D:
# CLOUT_API_ORIGIN=https://YOUR-PROJECT.vercel.app
# MAINTENANCE_SECRET=<the exact Vercel value>
npm run deploy -- --secrets-file .dev.vars.production
rm .dev.vars.production
```

Wrangler is pinned by this directory's package lock, both required secrets are uploaded atomically with the first deployment, and the ignored temporary file never enters Git. The Worker exposes no public control route; HTTP requests return 404. Its Cron Trigger invokes `POST /v1/maintenance/reconcile` with the shared bearer secret. Check **Workers & Pages → clout-devnet-recovery → Triggers** and confirm the `* * * * *` schedule is active.

## 4. Verify the deployment

Run these read-only checks against the production domain:

```sh
export CLOUT_API_URL="https://YOUR-PROJECT.vercel.app"
curl --fail --silent --show-error "$CLOUT_API_URL/live"
curl --fail --silent --show-error "$CLOUT_API_URL/ready"
curl --fail --silent --show-error "$CLOUT_API_URL/v1/config"
```

`/live` must return `{"status":"ok"}`, `/ready` must return `{"status":"ready"}`, and `/v1/config` must report `mode: connected` and `network: devnet`. Confirm `features.trading`, `features.faucet` and `features.uploads` are `true`. Exercise a feed request separately because database connectivity does not prove the seeded catalog is present. Confirm the recovery Worker's latest Cron event succeeded.

## 5. Build and install the portable APK

```sh
EXPO_PUBLIC_APP_IDENTITY_URI="$CLOUT_API_URL" \
  CLOUT_PREVIEW_API_URL="$CLOUT_API_URL" \
  bash scripts/build-android-preview.sh
shasum -a 256 artifacts/clout-preview.apk
bash scripts/android-env.sh .tooling/android-sdk/build-tools/36.0.0/apksigner \
  verify --print-certs artifacts/clout-preview.apk
```

Take the SHA-256 certificate fingerprint from `apksigner`, add these Vercel Production variables, and redeploy the same API:

```dotenv
ANDROID_APP_PACKAGE=app.clout.mobile
ANDROID_APP_SHA256_CERT_FINGERPRINT=<exact fingerprint from the judge APK>
```

Verify `/.well-known/assetlinks.json` returns `app.clout.mobile` and that exact fingerprint. Install the already-built APK with `bash scripts/android-env.sh adb install -r artifacts/clout-preview.apk`. The API origin is now the Mobile Wallet Adapter identity URI without a second website.

Confirm the APK bundle contains the HTTPS hostname and does not contain `127.0.0.1:8787`. Do not set `CLOUT_PREVIEW_USB=1`. The script refuses a connected portable build without the matching HTTPS identity origin. The preview remains signed by this machine's current debug key; retain this exact APK for judging and use a permanent production keystore for a dApp Store release.

## 6. Judge acceptance on the exact APK

- Launch with the Mac disconnected and confirm the feed loads and audible playback starts.
- Connect only the Seeker built-in wallet, close and reopen the app, and confirm the signed session restores.
- Ensure the judge wallet has devnet SOL; the mock SKR faucet does not supply network fees.
- Claim 1,000 mock SKR and confirm the finalized explorer link and Profile balance.
- Open a video market, buy, approve in the wallet, wait for finalization, and confirm the new balance and position in both Profile and Collection.
- Sell 25% and confirm the UI never offers more than the held post-token balance.
- Cancel one wallet approval, retry safely, restart during a pending transaction, and recover the same intent without creating a duplicate.
- Upload a portrait MP4 no larger than 50 MiB, wait for Storage validation, open it from Profile, launch its market, and then invest.
- Record an uninterrupted walkthrough and retain the APK SHA-256, release commit, public API URL and devnet explorer links with the submission.

The repository's `artifacts/` directory is ignored. Upload the APK and walkthrough separately or attach them to a release; a repository clone does not contain those files.
