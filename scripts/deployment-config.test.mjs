import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('production image is scoped to the API and runs as an unprivileged user', async () => {
  const [dockerfile, ignore, apiPackage] = await Promise.all([
    read('Dockerfile'),
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
})

test('production handoff keeps secrets as placeholders and documents the portable build', async () => {
  const [example, runbook] = await Promise.all([read('apps/api/.env.example'), read('docs/judge-release.md')])

  assert.match(example, /# NODE_ENV=production/)
  assert.match(example, /# HOST=0\.0\.0\.0/)
  assert.match(example, /# CLOUT_TRUST_PROXY_HOPS=0/)
  assert.match(example, /# ANDROID_APP_PACKAGE=app\.clout\.mobile/)
  assert.match(example, /# ANDROID_APP_SHA256_CERT_FINGERPRINT=/)
  assert.match(example, /# CLOUT_ORIGIN=https:\/\/\$\{RAILWAY_PUBLIC_DOMAIN\}/)
  assert.match(runbook, /EXPO_PUBLIC_APP_IDENTITY_URI="\$CLOUT_API_URL"/)
  assert.match(runbook, /CLOUT_PREVIEW_API_URL="\$CLOUT_API_URL"/)
  assert.match(runbook, /ANDROID_APP_SHA256_CERT_FINGERPRINT=<exact fingerprint from the judge APK>/)
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
