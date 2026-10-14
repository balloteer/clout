import { createMarketService, createMockSkrFaucetAdapter, type TradeQuote } from '@clout/markets'
import { Connection } from '@solana/web3.js'
import { createApp } from './app.js'
import { MemoryRepository } from './memory.js'
import { PostgresRepository } from './postgres.js'
import { CloudflareMedia, reconcilePendingUploads, type MediaService } from './media.js'
import { LocalMedia } from './local-media.js'
import { fileURLToPath } from 'node:url'
import { reconcilePending } from './transactions.js'
import { LinkedAccountService } from './linked-accounts.js'
import { PostgresLinkedStore } from './linked-store.js'
import { TokenVault, XProvider } from './linked-provider.js'
import { FaucetService } from './faucet.js'
import { parseTrustProxyHops } from './request-ip.js'
import { parseAndroidAppIdentity } from './app-identity.js'

const env = process.env
const connected = env.CLOUT_MODE === 'connected'
if (env.NODE_ENV === 'production' && !connected) throw new Error('Production requires CLOUT_MODE=connected.')
if (connected && !env.DATABASE_URL) throw new Error('Connected mode requires DATABASE_URL.')
const repository = connected ? new PostgresRepository(env.DATABASE_URL!) : new MemoryRepository()
const origin = env.CLOUT_ORIGIN ?? 'http://localhost:8787'
if (env.NODE_ENV === 'production' && !origin.startsWith('https://'))
  throw new Error('Production requires an HTTPS CLOUT_ORIGIN.')
const allowedOrigins = (env.CLOUT_ALLOWED_ORIGINS ?? `${origin},http://localhost:8081`)
  .split(',')
  .map((value) => value.trim())
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
if (
  connected &&
  env.CLOUDFLARE_ACCOUNT_ID &&
  env.CLOUDFLARE_STREAM_API_TOKEN &&
  env.CLOUDFLARE_STREAM_WEBHOOK_SECRET
)
  media = new CloudflareMedia(
    env.CLOUDFLARE_ACCOUNT_ID,
    env.CLOUDFLARE_STREAM_API_TOKEN,
    allowedOrigins.map((value) => new URL(value).hostname),
  )
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
      'Linked accounts require persistent storage, X OAuth credentials, token encryption and Cloudflare Stream.',
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
const importTimer = linkedAccounts
  ? setInterval(() => {
      if (importing) return
      importing = true
      void linkedAccounts!
        .run()
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
const faucetTimer = faucet
  ? setInterval(() => {
      if (minting) return
      minting = true
      void faucet!
        .resume()
        .catch(() => console.error('Faucet recovery temporarily unavailable.'))
        .finally(() => {
          minting = false
        })
    }, 15000)
  : undefined
faucetTimer?.unref()
let reconciling = false
const reconciliationTimer =
  markets && chain
    ? setInterval(() => {
        if (reconciling) return
        reconciling = true
        void reconcilePending(repository, markets, chain)
          .catch(() => console.error('Transaction reconciliation temporarily unavailable.'))
          .finally(() => {
            reconciling = false
          })
      }, 15000)
    : undefined
reconciliationTimer?.unref()
let recoveringUploads = false
let uploadRecoveryCursor: { createdAt: string; id: string } | undefined
const recoverUploads = async () => {
  if (recoveringUploads || !media?.inspectVideo) return
  recoveringUploads = true
  try {
    const result = await reconcilePendingUploads(repository, media, 25, uploadRecoveryCursor)
    uploadRecoveryCursor = result.next
  } catch {
    console.error('Video upload recovery temporarily unavailable.')
  } finally {
    recoveringUploads = false
  }
}
void recoverUploads()
const uploadRecoveryTimer = media?.inspectVideo ? setInterval(() => void recoverUploads(), 60_000) : undefined
uploadRecoveryTimer?.unref()
const { server } = createApp({
  repository,
  origin,
  mode: connected ? 'connected' : 'demo',
  allowedOrigins,
  trustProxyHops: parseTrustProxyHops(env.CLOUT_TRUST_PROXY_HOPS),
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
})
const port = Number(env.PORT ?? 8787)
const host = env.HOST ?? '127.0.0.1'
server.listen(port, host, () =>
  console.log(
    `Clout API listening on http://${host}:${port} (${connected ? 'connected devnet' : 'sample feed; markets disabled'})`,
  ),
)
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    clearInterval(reconciliationTimer)
    clearInterval(uploadRecoveryTimer)
    clearInterval(importTimer)
    clearInterval(faucetTimer)
    server.close(() => {
      void repository.close().then(() => process.exit(0))
    })
  })
