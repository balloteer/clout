# Judge release runbook

The current `clout-preview.apk` is a USB preview. A judge-ready APK must point at a public HTTPS API. The API container in the repository is deployable without adding credentials to Git; Railway variables provide the runtime configuration.

## 1. Deploy the API on Railway

1. Create a Railway service from the repository's `main` branch. Keep the service root at `/` because the API imports the shared `packages/markets` workspace and the root lockfile.
2. Generate a public domain under **Settings → Networking**. Railway detects the root `Dockerfile`; if it does not, set `RAILWAY_DOCKERFILE_PATH=/Dockerfile`.
3. Set the healthcheck path to `/ready`, timeout to 300 seconds, and restart policy to **On Failure** with 10 retries. The container already starts the API and listens on Railway's injected `PORT` at `0.0.0.0`. Readiness fails if the database cannot answer.
4. Add the variables below. Seal database, RPC-provider, Cloudflare, OAuth, encryption, webhook and authority credentials. Do not paste any of them into build arguments, repository files, Expo variables or logs.

Railway's legacy `railway.json` configuration is intentionally omitted. Railway deprecated Config as Code for new services and recommends dashboard settings or its Infrastructure as Code workflow. The checked Dockerfile remains the portable runtime definition.

### Required for login, feed and trading

```dotenv
NODE_ENV=production
CLOUT_MODE=connected
HOST=0.0.0.0
CLOUT_ORIGIN=https://${{RAILWAY_PUBLIC_DOMAIN}}
CLOUT_ALLOWED_ORIGINS=https://${{RAILWAY_PUBLIC_DOMAIN}}
CLOUT_TRUST_PROXY_HOPS=0
DATABASE_URL=<sealed Supabase server pooler URL>
SOLANA_DEVNET_RPC_URL=<sealed devnet RPC URL>
SKR_DEVNET_MINT=8sRfkBQg3u38JFZ36poZCuBeiytksTCKHHs3Kz4eiXmC
SKR_DECIMALS=6
METEORA_DBC_CONFIG=<devnet DBC configuration address>
```

Railway supplies `PORT`; leave it unset. `DATABASE_URL` must use the Supabase server-side session/shared pooler on port 5432, with special characters in the password percent-encoded. The API validates the Supabase hostname and uses the pinned public Supabase CA.

Keep `CLOUT_TRUST_PROXY_HOPS=0` for the initial deploy. This uses the direct socket address and ignores forwarded headers. Set a nonzero value only after verifying the exact fixed proxy chain in the deployed environment; the API rejects malformed or shorter chains rather than trusting a client-supplied address.

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

### Required for uploads

```dotenv
LOCAL_UPLOADS_ENABLED=false
CLOUDFLARE_ACCOUNT_ID=<account ID>
CLOUDFLARE_STREAM_API_TOKEN=<sealed Stream-scoped token>
CLOUDFLARE_STREAM_WEBHOOK_SECRET=<signing secret returned by the webhook API>
```

Configure Cloudflare Stream to send signed callbacks to:

```text
https://${{RAILWAY_PUBLIC_DOMAIN}}/v1/webhooks/stream
```

Register that URL with `PUT /accounts/<ACCOUNT_ID>/stream/webhook`, then copy the response's `result.secret` into `CLOUDFLARE_STREAM_WEBHOOK_SECRET`. Updating the webhook URL rotates the secret, so update the Railway variable after every webhook change.

Local uploads are intentionally refused in production. Linked X accounts additionally require `LINKED_ACCOUNTS_ENABLED=true`, X OAuth credentials, and a stable sealed `LINKED_ACCOUNTS_ENCRYPTION_KEY`. Leave linked accounts disabled for the judge build unless the complete provider flow has been exercised. Fomo remains unavailable.

## 2. Verify the deployment

Run these read-only checks against the generated domain:

```sh
export CLOUT_API_URL="https://YOUR-SERVICE.up.railway.app"
curl --fail --silent --show-error "$CLOUT_API_URL/live"
curl --fail --silent --show-error "$CLOUT_API_URL/ready"
curl --fail --silent --show-error "$CLOUT_API_URL/v1/config"
```

`/live` must return `{"status":"ok"}`, `/ready` must return `{"status":"ready"}`, and `/v1/config` must report `mode: connected` and `network: devnet`. Before building the APK, confirm that `features.trading` and `features.faucet` are `true`; confirm `features.uploads` is `true` only after Cloudflare is configured. Exercise a feed request separately because a database connection does not prove the seeded catalog is present.

## 3. Build and install the portable APK

```sh
EXPO_PUBLIC_APP_IDENTITY_URI="$CLOUT_API_URL" \
  CLOUT_PREVIEW_API_URL="$CLOUT_API_URL" \
  bash scripts/build-android-preview.sh
shasum -a 256 artifacts/clout-preview.apk
bash scripts/android-env.sh .tooling/android-sdk/build-tools/36.0.0/apksigner \
  verify --print-certs artifacts/clout-preview.apk
```

Take the SHA-256 certificate fingerprint from `apksigner`, then add these Railway variables and redeploy the same API:

```dotenv
ANDROID_APP_PACKAGE=app.clout.mobile
ANDROID_APP_SHA256_CERT_FINGERPRINT=<exact fingerprint from the judge APK>
```

Verify `/.well-known/assetlinks.json` returns `app.clout.mobile` and that exact fingerprint, then install the already-built APK with `bash scripts/android-env.sh adb install -r artifacts/clout-preview.apk`. The API origin is now the Mobile Wallet Adapter identity URI without a second website.

Confirm the APK bundle contains the HTTPS hostname and does not contain `127.0.0.1:8787`. Do not set `CLOUT_PREVIEW_USB=1`. The script refuses a connected portable build without the matching HTTPS identity origin. The preview remains signed by this machine's current debug key; retain this exact APK for judging and use a permanent production keystore for a dApp Store release.

## 4. Judge acceptance on the exact APK

- Launch with the Mac disconnected and confirm the feed loads and audible playback starts.
- Connect only the Seeker built-in wallet, close and reopen the app, and confirm the signed session restores.
- Ensure the judge wallet has devnet SOL; the mock SKR faucet does not supply network fees.
- Claim 1,000 mock SKR and confirm the finalized explorer link and Profile balance.
- Open a video market, buy, approve in the wallet, wait for finalization, and confirm the new balance and position in both Profile and Collection.
- Sell 25% and confirm the UI never offers more than the held post-token balance.
- Cancel one wallet approval, retry safely, restart during a pending transaction, and recover the same intent without creating a duplicate.
- Upload a portrait MP4, wait for Cloudflare processing, open it from Profile, launch its market, and then invest.
- Record an uninterrupted walkthrough and retain the APK SHA-256, release commit, public API URL and devnet explorer links with the submission.

The repository's `artifacts/` directory is ignored. Upload the APK and walkthrough separately or attach them to a release; a repository clone does not contain those files.
