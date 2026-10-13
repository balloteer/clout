/** Extends the devnet catalog without replacing existing pools, with durable signed journals. */
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import bs58 from 'bs58'
import {
  createMarketService,
  DEVNET_GENESIS_HASH,
  type BuiltConfig,
  type BuiltLaunch,
  type MarketSnapshot,
} from '../src/index.js'
import { sampleContent } from '../../shared/src/sample-content.js'
import { curatedContent } from '../../shared/src/curated-content.js'
import { sampleMarkets, sampleMarketConfig, sampleQuoteMint } from '../../shared/src/sample-markets.js'

const directory = resolve('.tooling/devnet/sample-markets')
const mode = process.argv[2] ?? 'prepare'
if (!['prepare', 'run', 'verify'].includes(mode)) throw new Error('Use prepare, run or verify.')
const samplesOnly = process.argv.includes('--samples-only')
if (process.argv.slice(3).some((argument) => argument !== '--samples-only'))
  throw new Error('The only optional flag is --samples-only.')
const rpcUrl = process.env.CLOUT_BOOTSTRAP_DEVNET_RPC_URL ?? 'https://api.devnet.solana.com'
const origin = process.env.CLOUT_SAMPLE_METADATA_ORIGIN ?? 'https://clout-devnet-catalog.vercel.app'
if (new URL(rpcUrl).protocol !== 'https:' || new URL(origin).protocol !== 'https:')
  throw new Error('Use HTTPS devnet RPC and metadata origins.')
const connection = new Connection(rpcUrl, 'confirmed')
async function guard() {
  if ((await connection.getGenesisHash()) !== DEVNET_GENESIS_HASH)
    throw new Error('Devnet genesis mismatch. No transaction sent.')
}
async function load<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(resolve(directory, file), 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
async function save(file: string, value: unknown) {
  const path = resolve(directory, file)
  const handle = await open(`${path}.tmp`, 'w', 0o600)
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(`${path}.tmp`, path)
  const folder = await open(directory, 'r')
  try {
    await folder.sync()
  } finally {
    await folder.close()
  }
}
type Journal = { signature: string; signedBase64: string; blockhash: string; lastValidBlockHeight: number }
async function submit(
  name: string,
  build: () => Promise<{
    transaction: Transaction
    blockhash: string
    lastValidBlockHeight: number
    signer: Keypair
  }>,
) {
  await guard()
  let journal = await load<Journal>(`${name}.signed.json`)
  if (!journal) {
    const next = await build()
    next.transaction.partialSign(next.signer)
    if (!next.transaction.signature) throw new Error('Missing signature.')
    journal = {
      signature: bs58.encode(next.transaction.signature),
      signedBase64: next.transaction.serialize().toString('base64'),
      blockhash: next.blockhash,
      lastValidBlockHeight: next.lastValidBlockHeight,
    }
    await save(`${name}.signed.json`, journal)
  }
  const status = (
    await connection.getSignatureStatuses([journal.signature], { searchTransactionHistory: true })
  ).value[0]
  if (status?.err) throw new Error(`${name}: persisted transaction failed; inspect ${journal.signature}.`)
  if (status?.confirmationStatus === 'finalized') return journal.signature
  if (!status && (await connection.getBlockHeight('finalized')) > journal.lastValidBlockHeight)
    throw new Error(`${name}: expired or unknown journal; inspect before any replacement.`)
  await connection.sendRawTransaction(Buffer.from(journal.signedBase64, 'base64'), {
    skipPreflight: false,
    maxRetries: 3,
  })
  const result = await connection.confirmTransaction(
    {
      signature: journal.signature,
      blockhash: journal.blockhash,
      lastValidBlockHeight: journal.lastValidBlockHeight,
    },
    'finalized',
  )
  if (result.value.err) throw new Error(`${name}: chain rejected the transaction.`)
  return journal.signature
}
const key = async (name: string) =>
  Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(await readFile(resolve('.tooling/devnet', `${name}.json`), 'utf8'))),
  )
type Provisioned = { token: { mint: string; decimals: number }; wallets: { creator: string } }
type Verified = MarketSnapshot & { signature: string; metadataUri: string; verifiedAt: string }
async function main() {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await guard()
  const provisioned: Provisioned = JSON.parse(await readFile('.tooling/devnet/provisioned.json', 'utf8'))
  if (provisioned.token.mint !== sampleQuoteMint || provisioned.token.decimals !== 6)
    throw new Error('The existing Mock SKR mint must be preserved.')
  const posts = [
    ...sampleContent.map((post) => ({ id: post.id, ordinal: post.ordinal })),
    ...(samplesOnly ? [] : curatedContent.map((post, index) => ({ id: post.id, ordinal: 51 + index }))),
  ]
  if (
    sampleContent.length !== 50 ||
    curatedContent.length !== 18 ||
    new Set(posts.map((post) => post.id)).size !== posts.length
  )
    throw new Error('The complete 50-sample and 18-curated catalog is required.')
  for (const post of posts) {
    const response = await fetch(`${origin}/metadata/${post.id}.json`)
    if (!response.ok || !response.headers.get('content-type')?.includes('json'))
      throw new Error(`Public metadata unavailable for ${post.id}.`)
    const metadata = (await response.json()) as {
      attributes?: { trait_type: string; value: string }[]
      description?: string
    }
    if (
      !metadata.attributes?.some((a) => a.trait_type === 'Post ID' && a.value === post.id) ||
      !metadata.description?.includes('Solana devnet only')
    )
      throw new Error(`Invalid metadata for ${post.id}.`)
  }
  const verified = (await load<Record<string, Verified>>('verified.json')) ?? {}
  const missingCount = posts.filter((post) => !verified[post.id]).length
  const creatorLamports = await connection.getBalance(new PublicKey(provisioned.wallets.creator), 'confirmed')
  const estimatedReserveLamports = missingCount * 22_000_000 + 20_000_000
  console.log(
    JSON.stringify({
      mode,
      network: 'devnet',
      posts: posts.length,
      existingMarkets: posts.filter((post) => sampleMarkets[post.id]).length,
      missingMarkets: missingCount,
      creator: provisioned.wallets.creator,
      creatorLamports,
      estimatedReserveLamports,
      quoteMint: provisioned.token.mint,
      metadataOrigin: origin,
    }),
  )
  if (mode === 'prepare') return
  const config = await load<BuiltConfig>('config.json')
  if (!config || config.configAddress !== sampleMarketConfig)
    throw new Error('The existing shared market configuration must be preserved.')
  if (mode === 'run') {
    const creator = await key('creator')
    if (creator.publicKey.toBase58() !== provisioned.wallets.creator) throw new Error('Creator mismatch.')
    if (creatorLamports < estimatedReserveLamports)
      throw new Error('Fund the existing devnet creator wallet before extending the catalog.')
  }
  if (!config) throw new Error('Sample market configuration has not been provisioned.')
  const service = createMarketService({
    cluster: 'devnet',
    rpcUrl,
    quoteMint: provisioned.token.mint,
    quoteDecimals: 6,
    dbcConfigAddress: config.configAddress,
  })
  for (const post of posts) {
    // Keep public devnet traffic sequential, including read-only account verification.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    let launch = await load<BuiltLaunch>(`${post.id}.launch.json`)
    const published = sampleMarkets[post.id]
    if (
      published &&
      (!launch ||
        launch.market.baseMint !== published.baseMint ||
        launch.market.dbcPool !== published.dbcPool)
    )
      throw new Error(`Existing market journal mismatch for ${post.id}; never replace a published pool.`)
    if (published && (await load<Journal>(`${post.id}.signed.json`))?.signature !== published.signature)
      throw new Error(`Existing market signature mismatch for ${post.id}; no transaction sent.`)
    let signature: string
    if (mode === 'run') {
      const creator = await key('creator')
      if (!launch) {
        launch = await service.buildLaunch({
          postId: post.id,
          creator: creator.publicKey.toBase58(),
          name: `Clout sample ${String(post.ordinal).padStart(3, '0')}`,
          symbol: `POST${String(post.ordinal).padStart(3, '0')}`,
          metadataUri: `${origin}/metadata/${post.id}.json`,
        })
        await save(`${post.id}.launch.json`, launch)
      }
      const built = launch
      signature = await submit(post.id, async () => ({
        transaction: Transaction.from(Buffer.from(built.transactionBase64, 'base64')),
        blockhash: built.blockhash,
        lastValidBlockHeight: built.lastValidBlockHeight,
        signer: creator,
      }))
    } else {
      const journal = await load<Journal>(`${post.id}.signed.json`)
      if (!journal) throw new Error(`No persisted launch for ${post.id}.`)
      signature = journal.signature
      const status = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true }))
        .value[0]
      if (status?.err || status?.confirmationStatus !== 'finalized')
        throw new Error(`Unverified launch for ${post.id}.`)
    }
    if (!launch) throw new Error(`Missing launch ${post.id}.`)
    if (published && signature !== published.signature)
      throw new Error(`Existing market signature mismatch for ${post.id}.`)
    const snapshot = await service.inspectMarket(launch.market)
    if (
      snapshot.creator !== provisioned.wallets.creator ||
      snapshot.quoteMint !== provisioned.token.mint ||
      snapshot.config !== config.configAddress
    )
      throw new Error(`Unexpected market accounts for ${post.id}.`)
    verified[post.id] = {
      ...snapshot,
      signature,
      metadataUri: launch.metadataUri,
      verifiedAt: new Date().toISOString(),
    }
    await save('verified.json', verified)
    console.log(
      JSON.stringify({
        post: post.id,
        pool: snapshot.dbcPool,
        signature,
        verifiedCount: Object.keys(verified).length,
      }),
    )
  }
  const publicManifest = {
    network: 'devnet',
    genesisHash: DEVNET_GENESIS_HASH,
    quoteMint: provisioned.token.mint,
    config: config.configAddress,
    creator: provisioned.wallets.creator,
    metadataOrigin: origin,
    markets: verified,
  }
  await mkdir('artifacts', { recursive: true })
  await writeFile('artifacts/devnet-sample-markets.json', JSON.stringify(publicManifest, null, 2) + '\n')
  const registry = Object.fromEntries(
    Object.entries(verified).map(([id, value]) => [
      id,
      {
        postId: id,
        baseMint: value.baseMint,
        dbcPool: value.dbcPool,
        creatorWallet: value.creator,
        signature: value.signature,
      },
    ]),
  )
  await writeFile(
    'packages/shared/src/sample-markets.ts',
    `/** Generated only after finalized devnet launches and account verification. */\nexport const sampleMarketNetwork = 'devnet' as const\nexport const sampleQuoteMint = '${provisioned.token.mint}'\nexport const sampleMarketConfig = '${config.configAddress}'\nexport const sampleMarkets: Record<string, { postId: string; baseMint: string; dbcPool: string; creatorWallet: string; signature: string }> = ${JSON.stringify(registry, null, 2)}\n`,
  )
  console.log(
    `Verified ${posts.length} requested devnet catalog markets. Public registry contains ${Object.keys(verified).length} markets.`,
  )
}
main().catch((error: unknown) => {
  console.error(
    (error instanceof SyntaxError
      ? 'Invalid local JSON file; parse details were not printed.'
      : error instanceof Error
        ? error.message
        : 'Seeding failed.'
    ).replace(/https?:\/\/[^\s]+/g, '[URL]'),
  )
  process.exitCode = 1
})
