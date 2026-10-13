/** Target-bound demo catalog sync. Never replaces a live market or edits user content. */
import { readFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import postgres from 'postgres'
import { Connection } from '@solana/web3.js'
import { createMarketService, DEVNET_GENESIS_HASH } from '../packages/markets/src/index.ts'
import { demoPosts, demoProfiles } from '../apps/api/src/fixtures.ts'
import { sampleContent } from '../packages/shared/src/sample-content.ts'
import { sampleMarkets, sampleQuoteMint, sampleMarketConfig } from '../packages/shared/src/sample-markets.ts'
import { validateTarget, SetupError } from './db-setup.mjs'
import { databaseTls } from './db-tls.mjs'

export function buildSampleSeed(mediaOrigin, registry = sampleMarkets) {
  const origin = new URL(mediaOrigin)
  if (
    (origin.protocol !== 'https:' &&
      !(origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname))) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new SetupError('Use an HTTPS API origin, or a loopback HTTP API for local development.')
  if (demoPosts.length !== 68 || Object.keys(registry).length !== 68)
    throw new SetupError('The verified 68-post/68-market catalog is incomplete.')
  const mints = new Set()
  const pools = new Set()
  for (const post of demoPosts) {
    const market = registry[post.id]
    if (
      !market ||
      market.postId !== post.id ||
      !market.creatorWallet ||
      !market.signature ||
      !market.baseMint ||
      !market.dbcPool ||
      mints.has(market.baseMint) ||
      pools.has(market.dbcPool)
    )
      throw new SetupError('Every catalog post must have a distinct verified market and creator.')
    mints.add(market.baseMint)
    pools.add(market.dbcPool)
  }
  const posts = demoPosts.map((post) => ({
    ...post,
    creatorWallet: registry[post.id].creatorWallet,
    market: { baseMint: registry[post.id].baseMint, dbcPool: registry[post.id].dbcPool },
    videoUrl: new URL(post.videoUrl, origin).href,
    thumbnailUrl: new URL(post.thumbnailUrl, origin).href,
  }))
  const creators = [...new Set(posts.map((post) => post.creatorWallet))]
  const profiles = creators.map(
    (wallet) =>
      demoProfiles.find((profile) => profile.wallet === wallet) ?? {
        wallet,
        handle: 'Clout devnet samples',
        displayName: 'Clout samples',
        bio: 'Clout demo-market operator. Original publishers retain video attribution and do not endorse these devnet test markets.',
        avatar: null,
        seekerVerified: false,
        reputation: 0,
      },
  )
  return { posts, profiles }
}
const fingerprint = (post) =>
  JSON.stringify([
    post.id,
    post.creatorWallet,
    post.caption,
    post.status,
    post.videoUrl,
    post.thumbnailUrl,
    post.demo,
    post.streamUid,
    post.createdAt,
    post.tags,
    post.source
      ? [
          post.source.provider,
          post.source.accountHandle,
          post.source.postId,
          post.source.url,
          post.source.publishedAt ?? null,
        ]
      : null,
    post.market?.baseMint ?? null,
    post.market?.dbcPool ?? null,
  ])

export async function seedInTransaction(db, seed, apply = false) {
  if (apply) await db.query('lock table public.posts, public.profiles in share row exclusive mode')
  const existing = (
    await db.query(
      'select id, creator_wallet, status, stream_uid, data from public.posts where id = any($1::text[])',
      [seed.posts.map((post) => post.id)],
    )
  ).rows
  const byId = new Map(existing.map((row) => [row.id, row]))
  const upgrades = []
  for (const post of seed.posts) {
    const row = byId.get(post.id)
    if (!row) continue
    const previous = row.data
    const consistent =
      row.creator_wallet === previous?.creatorWallet &&
      row.status === previous?.status &&
      row.stream_uid === previous?.streamUid
    if (consistent && fingerprint(previous) === fingerprint(post)) continue
    // Only the original licensed sample row may gain its first market. Match
    // every catalog field, preserving timestamps, extra JSON fields and socials.
    const editorial = sampleContent.find((sample) => sample.id === post.id)
    const original = { ...post, creatorWallet: editorial?.creatorWallet, market: null }
    if (
      consistent &&
      editorial &&
      previous?.demo === true &&
      previous?.market === null &&
      fingerprint(previous) === fingerprint(original)
    ) {
      upgrades.push(post)
      continue
    }
    throw new SetupError(`Existing post ${post.id} conflicts with the demo catalog; no rows were changed.`)
  }
  const pending = seed.posts.filter((post) => !byId.has(post.id))
  if (apply) {
    for (const profile of seed.profiles) {
      const inserted = await db.query(
        'insert into public.profiles(wallet,data) values($1,$2::jsonb) on conflict(wallet) do nothing returning data',
        [profile.wallet, profile],
      )
      if (inserted.rows.some((row) => row.data?.wallet !== profile.wallet))
        throw new SetupError('Seed profile JSON serialization failed; transaction must be rolled back.')
    }
    for (const post of pending) {
      const inserted = await db.query(
        'insert into public.posts(id,creator_wallet,stream_uid,status,data,created_at) values($1,$2,null,$3,$4::jsonb,$5::timestamptz) returning data',
        [post.id, post.creatorWallet, post.status, post, post.createdAt],
      )
      if (inserted.rows.length !== 1 || fingerprint(inserted.rows[0].data) !== fingerprint(post))
        throw new SetupError('Seed post JSON serialization failed; transaction must be rolled back.')
    }
    for (const post of upgrades) {
      const updated = await db.query(
        'update public.posts set creator_wallet=$2,data=data || $3::jsonb where id=$1 returning data',
        [post.id, post.creatorWallet, { creatorWallet: post.creatorWallet, market: post.market }],
      )
      if (updated.rows.length !== 1 || fingerprint(updated.rows[0].data) !== fingerprint(post))
        throw new SetupError('Seed market attachment failed; transaction must be rolled back.')
    }
  }
  return {
    mode: apply ? 'applied' : 'dry-run',
    catalogPosts: seed.posts.length,
    verifiedMarkets: seed.posts.filter((post) => post.market).length,
    newPosts: pending.length,
    attachedMarkets: upgrades.length,
    unchangedPosts: existing.length - upgrades.length,
  }
}
async function main() {
  if (process.argv.slice(2).some((arg) => arg !== '--apply') || process.argv.slice(2).length > 1)
    throw new SetupError('Use no flags for a dry-run, or --apply to insert the catalog.')
  const local = parseEnv(await readFile('apps/api/.env.local', 'utf8'))
  const env = { ...local, ...process.env }
  const target = validateTarget(env.DATABASE_URL)
  const mediaOrigin = env.CLOUT_SAMPLE_MEDIA_ORIGIN
  if (!mediaOrigin)
    throw new SetupError(
      'Set CLOUT_SAMPLE_MEDIA_ORIGIN to the reachable Clout API origin serving the bundled /v1/samples/media files.',
    )
  const seed = buildSampleSeed(mediaOrigin)
  const rpcUrl = env.SOLANA_DEVNET_RPC_URL ?? 'https://api.devnet.solana.com'
  if (new URL(rpcUrl).protocol !== 'https:') throw new SetupError('Use an HTTPS devnet RPC.')
  const chain = new Connection(rpcUrl, 'finalized')
  if ((await chain.getGenesisHash()) !== DEVNET_GENESIS_HASH)
    throw new SetupError('The RPC is not Solana devnet.')
  const markets = createMarketService({
    cluster: 'devnet',
    rpcUrl,
    quoteMint: sampleQuoteMint,
    quoteDecimals: 6,
    dbcConfigAddress: sampleMarketConfig,
  })
  const entries = Object.values(sampleMarkets)
  const statuses = (
    await chain.getSignatureStatuses(
      entries.map((entry) => entry.signature),
      { searchTransactionHistory: true },
    )
  ).value
  for (const [index, entry] of entries.entries()) {
    const status = statuses[index]
    if (status?.err || status?.confirmationStatus !== 'finalized')
      throw new SetupError(`Unverified devnet receipt for ${entry.postId}.`)
    const state = await markets.inspectMarket(entry)
    if (
      state.creator !== entry.creatorWallet ||
      state.quoteMint !== sampleQuoteMint ||
      state.config !== sampleMarketConfig
    )
      throw new SetupError(`Market account mismatch for ${entry.postId}.`)
    // The public devnet endpoint limits account reads. Keep complete verification
    // sequential and paced rather than issuing a burst alongside wallet traffic.
    if (index < entries.length - 1) await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  const sql = postgres(target.url.toString(), {
    ssl: databaseTls(target.url),
    max: 1,
    max_pipeline: 1,
    prepare: false,
    connect_timeout: 15,
  })
  try {
    const apply = process.argv.includes('--apply')
    const result = await sql.begin(apply ? '' : 'read only', async (tx) =>
      seedInTransaction(
        { query: async (text, values = []) => ({ rows: await tx.unsafe(text, values) }) },
        seed,
        apply,
      ),
    )
    console.log(JSON.stringify({ project: target.projectRef, network: 'devnet', ...result }))
  } finally {
    await sql.end({ timeout: 5 })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(
      error instanceof SetupError
        ? error.message
        : 'Sample seeding failed. Credentials and raw connection errors were not printed.',
    )
    process.exitCode = 1
  })
