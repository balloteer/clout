/** Additive, target-bound catalog import. Dry-run unless --apply; never modifies or deletes existing rows. */
import { readFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import postgres from 'postgres'
import { Connection } from '@solana/web3.js'
import { createMarketService, DEVNET_GENESIS_HASH } from '../packages/markets/src/index.ts'
import { demoPosts, demoProfiles } from '../apps/api/src/fixtures.ts'
import { sampleMarkets, sampleQuoteMint, sampleMarketConfig } from '../packages/shared/src/sample-markets.ts'
import { validateTarget, SetupError } from './db-setup.mjs'
import { databaseTls } from './db-tls.mjs'

export function buildSampleSeed(mediaOrigin) {
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
  if (demoPosts.length < 50 || Object.keys(sampleMarkets).length < 30)
    throw new SetupError('The verified 50-post/30-market catalog is incomplete.')
  const posts = demoPosts.map((post) => ({
    ...post,
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
        bio: 'Licensed sample content. Isolated devnet market creator; no Seeker verification.',
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
    post.market?.baseMint ?? null,
    post.market?.dbcPool ?? null,
  ])

export async function seedInTransaction(db, seed, apply = false) {
  if (apply) await db.query('lock table public.posts, public.profiles in share row exclusive mode')
  const existing = (
    await db.query('select id, data from public.posts where id = any($1::text[])', [
      seed.posts.map((post) => post.id),
    ])
  ).rows
  const byId = new Map(existing.map((row) => [row.id, row.data]))
  for (const post of seed.posts) {
    const previous = byId.get(post.id)
    if (previous && fingerprint(previous) !== fingerprint(post))
      throw new SetupError(
        `Existing post ${post.id} conflicts with the licensed catalog; no rows were changed.`,
      )
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
  }
  return {
    mode: apply ? 'applied' : 'dry-run',
    catalogPosts: seed.posts.length,
    verifiedMarkets: seed.posts.filter((post) => post.market).length,
    newPosts: pending.length,
    unchangedPosts: existing.length,
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
  for (const entry of Object.values(sampleMarkets)) {
    const status = (await chain.getSignatureStatuses([entry.signature], { searchTransactionHistory: true }))
      .value[0]
    if (status?.err || status?.confirmationStatus !== 'finalized')
      throw new SetupError(`Unverified devnet receipt for ${entry.postId}.`)
    const state = await markets.inspectMarket(entry)
    if (
      state.creator !== entry.creatorWallet ||
      state.quoteMint !== sampleQuoteMint ||
      state.config !== sampleMarketConfig
    )
      throw new SetupError(`Market account mismatch for ${entry.postId}.`)
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
