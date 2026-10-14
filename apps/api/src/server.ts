import { createMarketService, createMockSkrFaucetAdapter, type TradeQuote } from '@clout/markets'
import { Connection } from '@solana/web3.js'
import { createApp } from './app.js'
import { MemoryRepository } from './memory.js'
import { PostgresRepository } from './postgres.js'
import { reconcilePendingUploads, type MediaService } from './media.js'
import { SupabaseMedia } from './supabase-media.js'
import { LocalMedia } from './local-media.js'
import { fileURLToPath } from 'node:url'
import { reconcilePending } from './transactions.js'
import { LinkedAccountService } from './linked-accounts.js'
import { PostgresLinkedStore } from './linked-store.js'
import { TokenVault, XProvider } from './linked-provider.js'
import { FaucetService } from './faucet.js'
import { parseTrustProxyHops } from './request-ip.js'
import { parseAndroidAppIdentity } from './app-identity.js'
import { resolveAllowedOrigins, resolveOrigin, resolveTrustProxyHops } from './runtime-config.js'

const env = process.env
const connected = env.CLOUT_MODE === 'connected'
const vercel = env.VERCEL === '1'
if (env.NODE_ENV === 'production' && !connected) throw new Error('Production requires CLOUT_MODE=connected.')
if (connected && !env.DATABASE_URL) throw new Error('Connected mode requires DATABASE_URL.')
const repository = connected ? new PostgresRepository(env.DATABASE_URL!) : new MemoryRepository()
const origin = resolveOrigin(env)
const allowedOrigins = resolveAllowedOrigins(env, origin)
if (env.MAINTENANCE_SECRET && env.MAINTENANCE_SECRET.length < 32)
  throw new Error('MAINTENANCE_SECRET must contain at least 32 characters.')
if (vercel && connected && !env.MAINTENANCE_SECRET)
  throw new Error('Connected Vercel deployments require MAINTENANCE_SECRET for durable recovery.')
const tradingConfigured = connected && !!env.SOLANA_DEVNET_RPC_URL && !!env.SKR_DEVNET_MINT
const markets = tradingConfigured
  ? createMarketService(
      {
        cluster: 'devnet',
        rpcUrl: env.SOLANA_DEVNET_RPC_URL!,
        quoteMint: env.SKR_DEVNET_MINT!,
        quoteDecimals: Number(env.SKR_DECIMALS ?? 6),
        dbcConfigAddress: env.METEORA_DBC_CONFIG,
      },
      {
        store: {
          get: async (id) => ((await repository.getQuote(id)) ?? undefined) as TradeQuote | undefined,
          set: async (quote) => repository.putQuote(quote.id, quote as unknown as Record<string, unknown>),
        },
      },
    )
  : undefined
let media: MediaService | undefined
if (connected && env.SUPABASE_URL && (env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY))
  media = new SupabaseMedia({
    url: env.SUPABASE_URL,
    secretKey: (env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY)!,
    stagingBucket: env.SUPABASE_UPLOAD_BUCKET,
    publicBucket: env.SUPABASE_VIDEO_BUCKET,
  })
else if (env.LOCAL_UPLOADS_ENABLED === 'true') {
  const host = new URL(origin).hostname
  if (env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '[::1]'].includes(host))
    throw new Error('Local uploads require a non-production loopback CLOUT_ORIGIN.')
  media = new LocalMedia(
    origin,
    fileURLToPath(new URL('../../../.tooling/uploads/', import.meta.url)),
    (uid, videoUrl) => repository.updateStream(uid, 'ready', videoUrl, null),
    (uid) => repository.updateStream(uid, 'failed', null, null),
  )
}
let linkedAccounts: LinkedAccountService | undefined
if (env.LINKED_ACCOUNTS_ENABLED === 'true') {
  if (
    !(repository instanceof PostgresRepository) ||
    !media ||
    !env.X_CLIENT_ID ||
    !env.X_CLIENT_SECRET ||
    !env.LINKED_ACCOUNTS_ENCRYPTION_KEY
  )
    throw new Error(
      'Linked accounts require persistent storage, X OAuth credentials, token encryption and durable video storage.',
    )
  linkedAccounts = new LinkedAccountService(
    new PostgresLinkedStore(repository.sql),
    repository,
    new XProvider(env.X_CLIENT_ID, env.X_CLIENT_SECRET, `${origin}/v1/linked-accounts/x/callback`),
    new TokenVault(env.LINKED_ACCOUNTS_ENCRYPTION_KEY),
    media,
    origin,
  )
}
let importing = false
const importTimer =
  !vercel && linkedAccounts
    ? setInterval(() => {
        if (importing) return
        importing = true
        void linkedAccounts!
          .run()
          .then((result) => {
            if (result.failed) console.error('Some linked imports need recovery review.')
          })
          .catch(() => console.error('Linked imports temporarily unavailable.'))
          .finally(() => {
            importing = false
          })
      }, 60_000)
    : undefined
importTimer?.unref()
const chain = tradingConfigured
  ? new Connection(env.SOLANA_DEVNET_RPC_URL!, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15000) }),
    })
  : undefined
// This alpha never reads mainnet, including identity/SGT verification.
if (env.REWARDS_ENABLED === 'true')
  throw new Error('SGT rewards are unavailable in the devnet-only alpha. Use the bounded mock SKR faucet.')
let faucet: FaucetService | undefined
if (env.FAUCET_ENABLED === 'true') {
  if (
    !connected ||
    !tradingConfigured ||
    !env.FAUCET_CAMPAIGN_ID ||
    !env.FAUCET_AMOUNT_UNITS ||
    !(env.FAUCET_MAX_DAILY_CLAIMS ?? env.FAUCET_MAX_CLAIMS) ||
    !env.FAUCET_MAX_SUPPLY_UNITS ||
    !env.FAUCET_MINT_AUTHORITY_SECRET_BASE64
  )
    throw new Error(
      'The enabled faucet requires persistent storage, a bounded campaign, devnet mock mint and funded mint authority.',
    )
  const encoded = env.FAUCET_MINT_AUTHORITY_SECRET_BASE64
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 64 || key.toString('base64') !== encoded)
    throw new Error('Invalid faucet mint authority key encoding.')
  const transport = createMockSkrFaucetAdapter({
    marketConfig: {
      cluster: 'devnet',
      rpcUrl: env.SOLANA_DEVNET_RPC_URL!,
      quoteMint: env.SKR_DEVNET_MINT!,
      quoteDecimals: Number(env.SKR_DECIMALS ?? 6),
    },
    secretKeyUint8Array: key,
    maxAmountIn: env.FAUCET_AMOUNT_UNITS,
    maxSupplyIn: env.FAUCET_MAX_SUPPLY_UNITS,
  })
  key.fill(0)
  faucet = new FaucetService(
    repository,
    {
      id: env.FAUCET_CAMPAIGN_ID,
      symbol: 'SKR',
      mint: env.SKR_DEVNET_MINT!,
      amount: env.FAUCET_AMOUNT_UNITS,
      maxClaims: Number(env.FAUCET_MAX_DAILY_CLAIMS ?? env.FAUCET_MAX_CLAIMS),
      period: 'utc-day',
      enabled: true,
      authority: transport.treasury,
      maxSupply: env.FAUCET_MAX_SUPPLY_UNITS,
    },
    Number(env.SKR_DECIMALS ?? 6),
    transport,
  )
  await faucet.initialize()
}
let minting = false
const faucetTimer =
  !vercel && faucet
    ? setInterval(() => {
        if (minting) return
        minting = true
        void faucet!
          .resume()
          .then((result) => {
            if (result.failed) console.error('Some faucet claims remain unrecovered.')
          })
          .catch(() => console.error('Faucet recovery temporarily unavailable.'))
          .finally(() => {
            minting = false
          })
      }, 15000)
    : undefined
faucetTimer?.unref()
let reconciling = false
const reconciliationTimer =
  !vercel && markets && chain
    ? setInterval(() => {
        if (reconciling) return
        reconciling = true
        void reconcilePending(repository, markets, chain)
          .then((result) => {
            if (result.failed) console.error('Some transaction intents remain unreconciled.')
          })
          .catch(() => console.error('Transaction reconciliation temporarily unavailable.'))
          .finally(() => {
            reconciling = false
          })
      }, 15000)
    : undefined
reconciliationTimer?.unref()
let uploadRecoveryPromise: Promise<void> | undefined
let uploadRecoveryCursor: { createdAt: string; id: string } | undefined
const recoverUploads = () => {
  if (uploadRecoveryPromise || !media?.inspectVideo) return uploadRecoveryPromise ?? Promise.resolve()
  uploadRecoveryPromise = (async () => {
    try {
      const result = await reconcilePendingUploads(repository, media, 25, uploadRecoveryCursor)
      uploadRecoveryCursor = result.next
      if (result.failed) console.error('Some video uploads could not be inspected during recovery.')
    } catch {
      console.error('Video upload recovery temporarily unavailable.')
    } finally {
      uploadRecoveryPromise = undefined
    }
  })()
  return uploadRecoveryPromise
}
if (!vercel) void recoverUploads()
const uploadRecoveryTimer =
  !vercel && media?.inspectVideo ? setInterval(() => void recoverUploads(), 60_000) : undefined
uploadRecoveryTimer?.unref()
let maintenancePromise: Promise<{ ok: boolean; jobs: Record<string, string> }> | undefined
const runMaintenance = () => {
  if (maintenancePromise) return maintenancePromise
  maintenancePromise = (async () => {
    const jobs: Array<[string, () => Promise<unknown>]> = []
    if (linkedAccounts)
      jobs.push([
        'linkedAccounts',
        async () => {
          const result = await linkedAccounts.run(5)
          if (result.failed) throw new Error('Linked-account recovery was incomplete.')
        },
      ])
    if (faucet)
      jobs.push([
        'faucet',
        async () => {
          const result = await faucet.resume(2)
          if (result.failed) throw new Error('Faucet recovery was incomplete.')
        },
      ])
    if (markets && chain)
      jobs.push([
        'transactions',
        async () => {
          const result = await reconcilePending(repository, markets, chain)
          if (result.failed) throw new Error('Transaction recovery was incomplete.')
        },
      ])
    if (media?.inspectVideo)
      jobs.push([
        'uploads',
        async () => {
          // A Storage reconciliation may stream and validate a 50 MiB video. Keep each
          // one-minute platform invocation bounded to one concurrent batch.
          const result = await reconcilePendingUploads(repository, media, 3, undefined, true)
          if (result.failed) throw new Error('Upload recovery was incomplete.')
        },
      ])
    const results = await Promise.allSettled(jobs.map(([, run]) => run()))
    const statuses = Object.fromEntries(
      jobs.map(([name], index) => [name, results[index].status === 'fulfilled' ? 'ok' : 'failed']),
    )
    const ok = results.every((result) => result.status === 'fulfilled')
    if (!ok)
      console.error('Maintenance recovery partially failed', {
        jobs: Object.entries(statuses)
          .filter(([, status]) => status === 'failed')
          .map(([name]) => name),
      })
    return { ok, jobs: statuses }
  })().finally(() => {
    maintenancePromise = undefined
  })
  return maintenancePromise
}
const { server } = createApp({
  repository,
  origin,
  mode: connected ? 'connected' : 'demo',
  allowedOrigins,
  trustProxyHops: parseTrustProxyHops(resolveTrustProxyHops(env)),
  androidAppIdentity: parseAndroidAppIdentity(
    env.ANDROID_APP_SHA256_CERT_FINGERPRINT,
    env.ANDROID_APP_PACKAGE,
  ),
  markets,
  media,
  linkedAccounts,
  faucet,
  webhookSecret: env.CLOUDFLARE_STREAM_WEBHOOK_SECRET,
  quoteMint: tradingConfigured ? env.SKR_DEVNET_MINT : undefined,
  quoteDecimals: Number(env.SKR_DECIMALS ?? 6),
  chain,
  maintenance: connected ? runMaintenance : undefined,
  maintenanceSecret: env.MAINTENANCE_SECRET,
})
const port = Number(env.PORT ?? 8787)
const host = env.HOST ?? '127.0.0.1'
server.listen(port, host, () =>
  console.log(
    `Clout API listening on http://${host}:${port} (${connected ? 'connected devnet' : 'sample feed; markets disabled'})`,
  ),
)
let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(reconciliationTimer)
    clearInterval(uploadRecoveryTimer)
    clearInterval(importTimer)
    clearInterval(faucetTimer)
    server.close(() => {
      void (async () => {
        await uploadRecoveryPromise
        await maintenancePromise
        await repository.close()
        process.exit(0)
      })()
    })
  })
