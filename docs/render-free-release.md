# Free judge API on Render

Clout's Vercel Hobby deployment exhausted its rolling Fluid Active CPU allowance and was paused on October 20, 2026. The zero-cost judge deployment now targets a Render Free web service while preserving Supabase as the durable database and Storage provider.

The current service is live at `https://clout-api-ssk8.onrender.com`.

Render builds the existing root container through [`render.yaml`](../render.yaml). The API derives its stable HTTPS origin from Render's `RENDER_EXTERNAL_URL`, trusts one Render proxy hop, and disables its in-process recovery loops. The Cloudflare recovery Worker owns scheduled recovery and calls the API every ten minutes. That interval keeps a Render Free service awake because Render sleeps a free web service after fifteen minutes without inbound traffic, while remaining within the single service's 750 monthly free instance hours.

## 1. Create the free service

1. Push this branch to `main` on `https://github.com/balloteer/clout`.
2. Sign in to [Render](https://dashboard.render.com/) and choose **New → Blueprint**.
3. Connect the `balloteer/clout` repository and select its root `render.yaml`.
4. Keep the `clout-api` service on the **Free** plan. Do not add a paid service or database.
5. Supply the secret values requested by the Blueprint. Reuse the existing production values; changing the campaign or authority would split the faucet ledger.

| Render variable                       | Source                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `DATABASE_URL`                        | Existing Supabase shared/session pooler URL from `apps/api/.env.local`   |
| `SOLANA_DEVNET_RPC_URL`               | Existing sealed devnet RPC URL                                           |
| `METEORA_DBC_CONFIG`                  | Existing devnet DBC configuration address                                |
| `MAINTENANCE_SECRET`                  | Exact secret already stored in the Cloudflare recovery Worker            |
| `SUPABASE_SECRET_KEY`                 | Supabase Dashboard → Project Settings → API Keys; server-only secret key |
| `FAUCET_CAMPAIGN_ID`                  | Existing stable production campaign ID                                   |
| `FAUCET_MINT_AUTHORITY_SECRET_BASE64` | Existing dedicated devnet faucet authority                               |

Never paste these values into Git, chat, an Expo variable, or a screenshot. Render stores them as service secrets. The Android package and signing certificate fingerprint are already declared as non-secret configuration in the Blueprint.

## 2. Verify the Render deployment

Copy the service's `https://...onrender.com` URL and run:

```sh
export CLOUT_API_URL="https://YOUR-SERVICE.onrender.com"
curl --fail --silent --show-error "$CLOUT_API_URL/live"
curl --fail --silent --show-error "$CLOUT_API_URL/ready"
curl --fail --silent --show-error "$CLOUT_API_URL/v1/config"
curl --fail --silent --show-error "$CLOUT_API_URL/v1/feed?limit=1"
```

Expected results:

- `/live` returns `{"status":"ok"}`.
- `/ready` returns `{"status":"ready"}`.
- `/v1/config` reports connected mode, devnet, trading, faucet, and uploads enabled.
- `/v1/feed` returns the Supabase-backed catalog.

## 3. Point scheduled recovery at Render

The checked Worker schedule is `*/10 * * * *`. Update the ignored `workers/recovery-worker/.dev.vars.production` file without printing its secret:

```dotenv
CLOUT_API_ORIGIN=https://YOUR-SERVICE.onrender.com
MAINTENANCE_SECRET=THE_EXACT_RENDER_VALUE
```

Then deploy from `workers/recovery-worker`:

```sh
npm ci
npm run deploy -- --secrets-file .dev.vars.production
```

Confirm the Cloudflare Cron Trigger reports a successful event. A direct browser request to the Worker still returns 404 by design.

## 4. Rebuild the judge APK

The current submitted APK is pinned to the disabled Vercel origin. Build a replacement against Render:

```sh
EXPO_PUBLIC_APP_IDENTITY_URI="$CLOUT_API_URL" \
  CLOUT_PREVIEW_API_URL="$CLOUT_API_URL" \
  bash scripts/build-android-preview.sh
```

Verify the APK contains the Render hostname and does not contain the old Vercel origin or a loopback address. Install it on the physical Seeker, then rehearse wallet login, feed loading, the daily mock SKR faucet, investing, selling, profile positions, and upload completion.

Replace the file behind the submitted Google Drive APK link or update the submission URL so judges receive the Render build.

## Free-tier behavior

Render Free services are for demos and previews. The service may restart, has an ephemeral filesystem, and is suspended if the workspace exhausts its included limits. Clout's durable state and videos remain in Supabase, so a restart does not lose application data. Keep only this one Render Free web service in the workspace so its 750 hours cover the month.
