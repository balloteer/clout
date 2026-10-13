/** Configure only this app's isolated devnet credentials. Never prints or reads an unrelated wallet. */
import { chmod, readFile, rename, writeFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { parseEnv } from 'node:util'
import { validateTarget, SetupError } from './db-setup.mjs'
async function main() {
  const path = 'apps/api/.env.local'
  const raw = await readFile(path, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  const current = parseEnv(raw)
  const provisioned = JSON.parse(await readFile('.tooling/devnet/provisioned.json', 'utf8'))
  const registry = JSON.parse(await readFile('artifacts/devnet-sample-markets.json', 'utf8'))
  if (
    registry.network !== 'devnet' ||
    registry.genesisHash !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' ||
    registry.quoteMint !== provisioned.token.mint ||
    Object.keys(registry.markets).length < 30
  )
    throw new Error('Expected verified devnet sample registry.')
  const bytes = JSON.parse(await readFile('.tooling/devnet/payer.json', 'utf8'))
  if (
    !Array.isArray(bytes) ||
    bytes.length !== 64 ||
    bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  )
    throw new Error('Invalid isolated devnet authority.')
  const secret = Uint8Array.from(bytes)
  bytes.fill(0)
  const connected = !!current.DATABASE_URL
  if (connected) validateTarget(current.DATABASE_URL)
  const updates = {
    CLOUT_MODE: connected ? 'connected' : 'demo',
    SOLANA_DEVNET_RPC_URL: current.SOLANA_DEVNET_RPC_URL || 'https://api.devnet.solana.com',
    SKR_DEVNET_MINT: registry.quoteMint,
    SKR_DECIMALS: '6',
    METEORA_DBC_CONFIG: registry.config,
    REWARDS_ENABLED: 'false',
    FAUCET_ENABLED: connected ? 'true' : 'false',
    FAUCET_CAMPAIGN_ID: 'faucet_daily_20261013',
    FAUCET_AMOUNT_UNITS: '1000000000',
    FAUCET_MAX_DAILY_CLAIMS: '10000',
    FAUCET_MAX_SUPPLY_UNITS: '1000000000000000',
    FAUCET_MINT_AUTHORITY_SECRET_BASE64: Buffer.from(secret).toString('base64'),
  }
  secret.fill(0)
  const seen = new Set()
  const lines = raw
    .split(/\r?\n/)
    .filter((line) => line.length)
    .map((line) => {
      const key = /^([A-Z0-9_]+)=/.exec(line)?.[1]
      if (!key || !(key in updates)) return line
      seen.add(key)
      return `${key}=${updates[key]}`
    })
  for (const [key, value] of Object.entries(updates)) if (!seen.has(key)) lines.push(`${key}=${value}`)
  const temporary = `${path}.${randomUUID()}.tmp`
  let created = false
  try {
    await writeFile(temporary, lines.join('\n') + '\n', { mode: 0o600, flag: 'wx' })
    created = true
    await rename(temporary, path)
    await chmod(path, 0o600)
  } finally {
    if (created) await rm(temporary, { force: true })
  }
  console.log(
    JSON.stringify({
      configured: 'isolated devnet mock SKR and 30 sample markets',
      mode: updates.CLOUT_MODE,
      faucetEnabled: connected,
      next: connected
        ? 'Apply reviewed migrations and seed catalog before starting API.'
        : 'Save the supplied Supabase project DATABASE_URL in apps/api/.env.local, then rerun this command. Faucet remains disabled until storage is connected.',
    }),
  )
}
main().catch((error) => {
  console.error(
    error instanceof SetupError
      ? error.message
      : 'Devnet configuration failed. Check the local manifests and isolated authority file; secret values were not printed.',
  )
  process.exitCode = 1
})
