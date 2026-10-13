/** Task-only two-wallet devnet smoke test: one-SKR buy, half sell, creator fee claim and one-SKR tip. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { Connection, Keypair, Transaction } from '@solana/web3.js'
import bs58 from 'bs58'
import {
  createMarketService,
  DEVNET_GENESIS_HASH,
  type BuiltTrade,
  type TransactionEnvelope,
} from '../src/index.js'
import { sampleMarkets, sampleMarketConfig, sampleQuoteMint } from '../../shared/src/sample-markets.js'
const rpcUrl = process.env.CLOUT_BOOTSTRAP_DEVNET_RPC_URL ?? 'https://api.devnet.solana.com'
if (new URL(rpcUrl).protocol !== 'https:') throw new Error('HTTPS devnet RPC required.')
const connection = new Connection(rpcUrl, 'confirmed')
const directory = '.tooling/devnet/rehearsal'
async function load<T>(name: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(`${directory}/${name}.json`, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
async function save(name: string, value: unknown) {
  await writeFile(`${directory}/${name}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(`${directory}/${name}.tmp`, `${directory}/${name}.json`)
}
const taskKey = async (name: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(`.tooling/devnet/${name}.json`, 'utf8'))))
async function guard() {
  if ((await connection.getGenesisHash()) !== DEVNET_GENESIS_HASH) throw new Error('Devnet genesis mismatch.')
}
type Journal<T> = { built: T; signature: string; signedBase64: string }
async function execute<T extends TransactionEnvelope>(
  name: string,
  signer: Keypair,
  build: () => Promise<T>,
) {
  await guard()
  let journal = await load<Journal<T>>(name)
  if (!journal) {
    const built = await build()
    if (built.owner !== signer.publicKey.toBase58() || built.cluster !== 'devnet')
      throw new Error('Wrong transaction owner/network.')
    const tx = Transaction.from(Buffer.from(built.transactionBase64, 'base64'))
    tx.partialSign(signer)
    if (!tx.signature) throw new Error('Missing signature.')
    journal = { built, signature: bs58.encode(tx.signature), signedBase64: tx.serialize().toString('base64') }
    await save(name, journal)
  }
  const status = (
    await connection.getSignatureStatuses([journal.signature], { searchTransactionHistory: true })
  ).value[0]
  if (status?.err) throw new Error(`${name}: transaction failed.`)
  if (status?.confirmationStatus !== 'finalized') {
    if (!status && (await connection.getBlockHeight('finalized')) > journal.built.lastValidBlockHeight)
      throw new Error(`${name}: expired/unknown transaction; stop for review.`)
    await connection.sendRawTransaction(Buffer.from(journal.signedBase64, 'base64'), {
      skipPreflight: false,
      maxRetries: 3,
    })
    const result = await connection.confirmTransaction(
      {
        signature: journal.signature,
        blockhash: journal.built.blockhash,
        lastValidBlockHeight: journal.built.lastValidBlockHeight,
      },
      'finalized',
    )
    if (result.value.err) throw new Error(`${name}: rejected on chain.`)
  }
  console.log(JSON.stringify({ step: name, signature: journal.signature, status: 'finalized' }))
  return journal
}
async function main() {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await guard()
  const service = createMarketService({
    cluster: 'devnet',
    rpcUrl,
    quoteMint: sampleQuoteMint,
    quoteDecimals: 6,
    dbcConfigAddress: sampleMarketConfig,
    quoteTtlMs: 60_000,
  })
  const backer = await taskKey('backer')
  const creator = await taskKey('creator')
  const market = sampleMarkets['big-buck-bunny']
  if (!market) throw new Error('Verified sample market required.')
  const buy = await execute('buy', backer, async () => {
    const quote = await service.quote({
      market,
      owner: backer.publicKey.toBase58(),
      side: 'buy',
      amountIn: '1000000',
      slippageBps: 100,
    })
    return service.buildTrade({ quoteId: quote.id, owner: quote.owner })
  })
  const buyReceipt = await service.reconcileTrade({ signature: buy.signature, trade: buy.built })
  if (buyReceipt.status !== 'confirmed')
    throw new Error('Buy settlement metadata not available; retry same journal.')
  const received = BigInt(buyReceipt.tokenDeltas[market.baseMint] ?? '0')
  if (received <= 1n) throw new Error('No received position tokens.')
  const sell = await execute<BuiltTrade>('sell', backer, async () => {
    const quote = await service.quote({
      market,
      owner: backer.publicKey.toBase58(),
      side: 'sell',
      amountIn: (received / 2n).toString(),
      slippageBps: 100,
    })
    return service.buildTrade({ quoteId: quote.id, owner: quote.owner })
  })
  const sellReceipt = await service.reconcileTrade({ signature: sell.signature, trade: sell.built })
  if (sellReceipt.status !== 'confirmed')
    throw new Error('Sell settlement metadata not available; retry same journal.')
  // Persist each prepared fee envelope as well; already-finalized claims are never reconstructed.
  let claims = await load<TransactionEnvelope[]>('fee-envelopes')
  if (!claims) {
    claims = await service.buildClaim({ market, creator: creator.publicKey.toBase58() })
    await save('fee-envelopes', claims)
  }
  if (claims.length === 0) throw new Error('Creator fee rehearsal requires at least one claim transaction.')
  const feeReceipts = []
  let creatorFeeIncrease = 0n
  for (let i = 0; i < claims.length; i++) {
    const claim = await execute(`claim-${i}`, creator, async () => claims![i])
    const receipt = await service.reconcile({ signature: claim.signature, transaction: claim.built })
    if (receipt.status !== 'confirmed')
      throw new Error('Creator fee settlement unavailable; retry the persisted journal.')
    creatorFeeIncrease += BigInt(receipt.tokenDeltas[sampleQuoteMint] ?? '0')
    feeReceipts.push(receipt)
  }
  if (creatorFeeIncrease <= 0n) throw new Error('Creator fee claim did not increase the mock SKR balance.')
  const tip = await execute('tip', backer, () =>
    service.buildTip({
      owner: backer.publicKey.toBase58(),
      recipient: creator.publicKey.toBase58(),
      amountIn: '1000000',
    }),
  )
  const tipReceipt = await service.reconcile({ signature: tip.signature, transaction: tip.built })
  if (tipReceipt.status !== 'confirmed' || feeReceipts.some((receipt) => receipt.status !== 'confirmed'))
    throw new Error('Fee/tip settlement unavailable; retry journals.')
  const report = {
    network: 'devnet',
    quoteMint: sampleQuoteMint,
    postId: market.postId,
    pool: market.dbcPool,
    buy: buyReceipt,
    sell: sellReceipt,
    creatorFees: feeReceipts,
    tip: tipReceipt,
    scope: 'Task-only direct SDK rehearsal; not a physical Seeker wallet or live API user session.',
  }
  await writeFile('artifacts/devnet-trade-rehearsal.json', JSON.stringify(report, null, 2) + '\n')
  console.log('Two-wallet buy, sell, creator fees and mock SKR tip verified.')
}
main().catch((error) => {
  console.error(
    (error instanceof SyntaxError
      ? 'Invalid local JSON file; parse details were not printed.'
      : error instanceof Error
        ? error.message
        : 'Rehearsal failed.'
    ).replace(/https?:\/\/[^\s]+/g, '[URL]'),
  )
  process.exitCode = 1
})
