import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, stat, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

const configure = fileURLToPath(new URL('./configure-devnet.mjs', import.meta.url))
const seed = fileURLToPath(new URL('./seed-samples.mjs', import.meta.url))
const safeFailure =
  'Devnet configuration failed. Check the local manifests and isolated authority file; secret values were not printed.'
// Deliberately synthetic: no real wallet, RPC, database or environment credential is read.
const syntheticBytes = Array.from({ length: 64 }, (_, index) => index)
const originalEnv = 'UNRELATED_SETTING="keep this value"\nREWARDS_ENABLED=true\nFAUCET_ENABLED=true\n'

async function run(script, cwd, args = [], loader = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [...(loader ? ['--import', import.meta.resolve('tsx')] : []), script, ...args],
      { cwd, env: { NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'clout-configure-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const path of ['apps/api', '.tooling/devnet', 'artifacts'])
    await mkdir(join(directory, path), { recursive: true })
  await writeFile(join(directory, 'apps/api/.env.local'), originalEnv, { mode: 0o644 })
  await writeFile(
    join(directory, '.tooling/devnet/provisioned.json'),
    JSON.stringify({ token: { mint: 'synthetic-mock-mint' } }),
  )
  await writeFile(
    join(directory, 'artifacts/devnet-sample-markets.json'),
    JSON.stringify({
      network: 'devnet',
      genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
      quoteMint: 'synthetic-mock-mint',
      config: 'synthetic-pool-config',
      markets: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`sample-${index}`, {}])),
    }),
  )
  await writeFile(join(directory, '.tooling/devnet/payer.json'), JSON.stringify(syntheticBytes), {
    mode: 0o600,
  })
  return directory
}

test('malformed authority JSON never prints private fragments and leaves environment unchanged', async (t) => {
  const directory = await fixture(t)
  await writeFile(
    join(directory, '.tooling/devnet/payer.json'),
    '[10,20,30,"SYNTHETIC_PRIVATE_FRAGMENT",invalid-json]',
  )
  const result = await run(configure, directory)
  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr.trim(), safeFailure)
  assert.ok(!result.stderr.includes('SYNTHETIC_PRIVATE_FRAGMENT'))
  assert.ok(!result.stderr.includes('10,20,30'))
  assert.equal(await readFile(join(directory, 'apps/api/.env.local'), 'utf8'), originalEnv)
})

test('configuration refuses malformed key byte values before writing credentials', async (t) => {
  const directory = await fixture(t)
  const invalid = [
    syntheticBytes.slice(1),
    { length: 64 },
    ...[-1, 256, 1.5, '10', null].map((value) => [value, ...syntheticBytes.slice(1)]),
  ]
  for (const bytes of invalid) {
    await writeFile(join(directory, '.tooling/devnet/payer.json'), JSON.stringify(bytes))
    const result = await run(configure, directory)
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.trim(), safeFailure)
    assert.equal(await readFile(join(directory, 'apps/api/.env.local'), 'utf8'), originalEnv)
  }
})

test('exclusive temporary write ignores an existing old-name symlink and preserves unrelated configuration', async (t) => {
  const directory = await fixture(t)
  const unrelated = join(directory, 'unrelated-file')
  const legacyTemporary = join(directory, 'apps/api/.env.local.tmp')
  await writeFile(unrelated, 'must remain untouched', { mode: 0o644 })
  await symlink(unrelated, legacyTemporary)
  const result = await run(configure, directory)
  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
  const status = JSON.parse(result.stdout)
  assert.equal(status.mode, 'demo')
  assert.equal(status.faucetEnabled, false)
  assert.ok(!result.stdout.includes(Buffer.from(syntheticBytes).toString('base64')))
  assert.equal(await readFile(unrelated, 'utf8'), 'must remain untouched')
  assert.equal((await stat(unrelated)).mode & 0o777, 0o644)
  assert.equal((await lstat(legacyTemporary)).isSymbolicLink(), true)
  const target = join(directory, 'apps/api/.env.local')
  assert.equal((await stat(target)).mode & 0o777, 0o600)
  const env = parseEnv(await readFile(target, 'utf8'))
  assert.equal(env.UNRELATED_SETTING, 'keep this value')
  assert.equal(env.CLOUT_MODE, 'demo')
  assert.equal(env.FAUCET_ENABLED, 'false')
  assert.equal(env.REWARDS_ENABLED, 'false')
  assert.equal(env.FAUCET_MINT_AUTHORITY_SECRET_BASE64, Buffer.from(syntheticBytes).toString('base64'))
  assert.deepEqual((await readdir(join(directory, 'apps/api'))).sort(), ['.env.local', '.env.local.tmp'])
})

test('sample seed rejects unknown or conflicting flags before reading configuration or contacting services', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'clout-seed-flags-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const args of [['--dry-run'], ['--apply', '--dry-run'], ['--apply', '--apply']]) {
    const result = await run(seed, directory, args, true)
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.trim(), 'Use no flags for a dry-run, or --apply to insert the catalog.')
    assert.deepEqual(await readdir(directory), [])
  }
})
