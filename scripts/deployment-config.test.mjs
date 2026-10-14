import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const parseJsonc = (value) => JSON.parse(value.replace(/,\s*([}\]])/g, '$1'))

test('portable and Vercel images are scoped to the API and run as an unprivileged user', async () => {
  const [dockerfile, vercelDockerfile, vercelConfig, ignore, apiPackage] = await Promise.all([
    read('Dockerfile'),
    read('Dockerfile.vercel'),
    read('vercel.json').then(JSON.parse),
    read('.dockerignore'),
    read('apps/api/package.json').then(JSON.parse),
  ])

  assert.match(dockerfile, /FROM node:22-bookworm-slim/)
  assert.match(dockerfile, /--workspace @clout\/api/)
  assert.match(dockerfile, /--workspace @clout\/markets/)
  assert.match(dockerfile, /--workspace @clout\/shared/)
  assert.match(dockerfile, /USER node/)
  assert.match(dockerfile, /\/ready/)
  assert.match(dockerfile, /WORKDIR \/app\/apps\/api/)
  assert.match(dockerfile, /CLOUT_TRUST_PROXY_HOPS=0/)
  assert.match(dockerfile, /COPY apps\/mobile\/assets\/media apps\/mobile\/assets\/media/)
  assert.match(
    dockerfile,
    /COPY apps\/mobile\/src\/lib\/curated-content\.json apps\/mobile\/src\/lib\/curated-content\.json/,
  )
  assert.match(dockerfile, /COPY packages\/shared\/src packages\/shared\/src/)
  assert.match(dockerfile, /"--import", "tsx"/)
  assert.equal(apiPackage.dependencies.tsx, '4.20.6')
  assert.equal(apiPackage.devDependencies?.tsx, undefined)

  assert.match(ignore, /^\*$/m)
  assert.doesNotMatch(ignore, /!.*\.env\.local/)
  assert.doesNotMatch(dockerfile, /\.env\.local|\.tooling|artifacts/)

  assert.match(vercelDockerfile, /FROM node:22-bookworm-slim/)
  assert.match(vercelDockerfile, /CLOUT_TRUST_PROXY_HOPS=1/)
  assert.match(vercelDockerfile, /--workspace @clout\/api/)
  assert.match(vercelDockerfile, /COPY apps\/mobile\/assets\/media apps\/mobile\/assets\/media/)
  assert.match(vercelDockerfile, /USER node/)
  assert.match(vercelDockerfile, /"--import", "tsx"/)
  assert.doesNotMatch(vercelDockerfile, /HEALTHCHECK|\.env\.local|artifacts/)
  assert.equal(vercelConfig.framework, undefined)
  assert.deepEqual(vercelConfig.regions, ['sfo1'])
  assert.match(ignore, /!Dockerfile\.vercel/)
})

test('production handoff keeps secrets as placeholders and documents the portable build', async () => {
  const [example, runbook] = await Promise.all([read('apps/api/.env.example'), read('docs/judge-release.md')])

  assert.match(example, /Dockerfile\.vercel sets NODE_ENV, HOST/)
  assert.match(example, /VERCEL_PROJECT_PRODUCTION_URL/)
  assert.match(example, /MAINTENANCE_SECRET=/)
  assert.match(example, /# ANDROID_APP_PACKAGE=app\.clout\.mobile/)
  assert.match(example, /# ANDROID_APP_SHA256_CERT_FINGERPRINT=/)
  assert.match(runbook, /EXPO_PUBLIC_APP_IDENTITY_URI="\$CLOUT_API_URL"/)
  assert.match(runbook, /CLOUT_PREVIEW_API_URL="\$CLOUT_API_URL"/)
  assert.match(runbook, /ANDROID_APP_SHA256_CERT_FINGERPRINT=<exact fingerprint from the judge APK>/)
  assert.match(runbook, /Dockerfile\.vercel/)
  assert.match(runbook, /workers\/recovery-worker/)
  assert.match(runbook, /--secrets-file \.dev\.vars\.production/)
  assert.doesNotMatch(runbook, /Railway|RAILWAY|railway/)
  const buildScript = await read('scripts/build-android-preview.sh')
  assert.match(buildScript, /portable build requires CLOUT_PREVIEW_API_URL/)
  assert.match(buildScript, /connected portable build requires an HTTPS EXPO_PUBLIC_APP_IDENTITY_URI/)
  assert.match(buildScript, /wallet identity URI to match its public API origin/)
  assert.match(runbook, /127\.0\.0\.1:8787/)
  assert.match(
    example,
    /DATABASE_URL=postgresql:\/\/postgres\.PROJECT_REF:PERCENT_ENCODED_PASSWORD@POOLER_HOST/,
  )
  assert.doesNotMatch(example, /FAUCET_MINT_AUTHORITY_SECRET_BASE64=[A-Za-z0-9+/]{80,}={0,2}/)
})

test('Cloudflare recovery Worker is scheduled, pinned, secret-bound and has no public control route', async () => {
  const [worker, config, ignore, workerPackage, workerLock, migration, migrationHelper] = await Promise.all([
    read('workers/recovery-worker/index.mjs'),
    read('workers/recovery-worker/wrangler.jsonc').then(parseJsonc),
    read('.gitignore'),
    read('workers/recovery-worker/package.json').then(JSON.parse),
    read('workers/recovery-worker/package-lock.json').then(JSON.parse),
    read('supabase/migrations/20261013090000_upload_recovery_checks.sql'),
    read('scripts/db-upload-recovery.mjs'),
  ])
  assert.deepEqual(config.triggers.crons, ['* * * * *'])
  assert.equal(config.main, 'index.mjs')
  assert.deepEqual(config.secrets.required, ['CLOUT_API_ORIGIN', 'MAINTENANCE_SECRET'])
  assert.match(workerPackage.devDependencies.wrangler, /^\d+\.\d+\.\d+$/)
  assert.equal(workerLock.packages['node_modules/wrangler'].version, workerPackage.devDependencies.wrangler)
  assert.match(worker, /\/v1\/maintenance\/reconcile/)
  assert.match(worker, /Authorization: `Bearer \$\{env\.MAINTENANCE_SECRET\}`/)
  assert.match(worker, /new Response\('Not found', \{ status: 404 \}\)/)
  assert.match(ignore, /\*\*\/\.dev\.vars\*/)
  assert.match(migration, /create table private\.upload_recovery_checks/)
  assert.match(migration, /enable row level security/)
  assert.match(migration, /revoke all .* from public, anon, authenticated/)
  assert.match(migrationHelper, /validateTarget\(process\.env\.DATABASE_URL\)/)
})
