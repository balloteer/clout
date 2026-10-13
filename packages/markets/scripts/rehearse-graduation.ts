/** Isolated devnet graduation rehearsal. Never touches the public sample market registry. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { DynamicBondingCurveClient, SwapMode } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token'
import BN from 'bn.js'
import bs58 from 'bs58'
import {
  createMarketService,
  DEVNET_GENESIS_HASH,
  MarketError,
  type BuiltLaunch,
  type BuiltMigration,
  type BuiltTrade,
  type Reconciliation,
  type TransactionEnvelope,
} from '../src/index.js'

const mode = process.argv[2] ?? 'prepare'
if (!['prepare', 'run', 'verify'].includes(mode)) throw new Error('Use prepare, run or verify.')
const directory = '.tooling/devnet/graduation-rehearsal'
const reportPath = 'artifacts/devnet-graduation-rehearsal.json'
const rpcUrl = process.env.CLOUT_BOOTSTRAP_DEVNET_RPC_URL ?? 'https://api.devnet.solana.com'
const metadataUri = 'https://clout-devnet-catalog.vercel.app/metadata/big-buck-bunny.json'
if (new URL(rpcUrl).protocol !== 'https:' || new URL(rpcUrl).username || new URL(rpcUrl).password)
  throw new Error('A credential-free HTTPS devnet RPC is required.')
const connection = new Connection(rpcUrl, 'confirmed')
type Provisioned = {
  network: string
  genesisHash: string
  token: { mint: string; decimals: number }
  wallets: Record<'payer' | 'creator' | 'backer', string>
  dbcConfigAddress: string
  migrationThresholdTokens: number
}
type Journal<T extends TransactionEnvelope> = { built: T; signature: string; signedBase64: string }
const report: Record<string, unknown> = {
  network: 'devnet',
  scope:
    'Isolated task wallets and a separate two-Mock-SKR graduation market. No catalog market or physical user wallet involved.',
  complete: false,
}
async function save(name: string, value: unknown) {
  await writeFile(`${directory}/${name}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(`${directory}/${name}.tmp`, `${directory}/${name}.json`)
}
async function load<T>(name: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(`${directory}/${name}.json`, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
async function writeReport() {
  await mkdir('artifacts', { recursive: true })
  await writeFile(
    reportPath,
    JSON.stringify({ ...report, updatedAt: new Date().toISOString() }, null, 2) + '\n',
  )
}
async function guard() {
  if ((await connection.getGenesisHash()) !== DEVNET_GENESIS_HASH)
    throw new Error('Devnet genesis mismatch. No transaction sent.')
}
async function execute<T extends TransactionEnvelope>(
  name: string,
  signer: Keypair,
  build: () => Promise<T>,
) {
  await guard()
  report.currentStep = name
  await writeReport()
  let journal = await load<Journal<T>>(name)
  if (!journal) {
    const built = await build()
    if (built.owner !== signer.publicKey.toBase58() || built.cluster !== 'devnet')
      throw new Error('Wrong transaction signer/network.')
    const tx = Transaction.from(Buffer.from(built.transactionBase64, 'base64'))
    if (tx.serializeMessage().toString('base64') !== built.messageBase64)
      throw new Error('Envelope message mismatch.')
    tx.partialSign(signer)
    if (!tx.signature) throw new Error('Missing task-wallet signature.')
    journal = { built, signature: bs58.encode(tx.signature), signedBase64: tx.serialize().toString('base64') }
    await save(name, journal)
  }
  const bytes = Buffer.from(journal.signedBase64, 'base64')
  const tx = Transaction.from(bytes)
  if (
    !tx.verifySignatures() ||
    !tx.feePayer?.equals(signer.publicKey) ||
    !tx.signature ||
    bs58.encode(tx.signature) !== journal.signature ||
    tx.serializeMessage().toString('base64') !== journal.built.messageBase64
  )
    throw new Error('Persisted signed journal failed verification.')
  const read = async () =>
    (await connection.getSignatureStatuses([journal.signature], { searchTransactionHistory: true })).value[0]
  let status = await read()
  if (!status && (await connection.getBlockHeight('finalized')) > journal.built.lastValidBlockHeight) {
    status = await read()
    if (!status) throw new Error(`${name}: expired with unknown history; no replacement will be prepared.`)
  }
  if (status?.confirmationStatus === 'finalized' && status.err)
    throw new Error(`${name}: finalized failure; inspect the persisted signature.`)
  if (status?.confirmationStatus !== 'finalized') {
    const returned = await connection.sendRawTransaction(bytes, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    })
    if (returned !== journal.signature) throw new Error('RPC returned a different signature.')
    const result = await connection.confirmTransaction(
      {
        signature: journal.signature,
        blockhash: journal.built.blockhash,
        lastValidBlockHeight: journal.built.lastValidBlockHeight,
      },
      'finalized',
    )
    if (result.value.err) throw new Error(`${name}: transaction rejected on chain.`)
  }
  console.log(JSON.stringify({ step: name, signature: journal.signature, status: 'finalized' }))
  return journal
}
async function main() {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await guard()
  const provisioned = JSON.parse(await readFile('.tooling/devnet/provisioned.json', 'utf8')) as Provisioned
  if (
    provisioned.network !== 'devnet' ||
    provisioned.genesisHash !== DEVNET_GENESIS_HASH ||
    provisioned.migrationThresholdTokens !== 2 ||
    provisioned.token.decimals !== 6
  )
    throw new Error('Expected the isolated two-token devnet rehearsal configuration.')
  report.quoteMint = provisioned.token.mint
  report.config = provisioned.dbcConfigAddress
  const service = createMarketService({
    cluster: 'devnet',
    rpcUrl,
    quoteMint: provisioned.token.mint,
    quoteDecimals: 6,
    dbcConfigAddress: provisioned.dbcConfigAddress,
    quoteTtlMs: 60_000,
  })
  const balances: Record<string, number> = {}
  for (const name of ['payer', 'creator', 'backer'] as const)
    balances[name] = await connection.getBalance(new PublicKey(provisioned.wallets[name]), 'confirmed')
  report.initialSolLamports = balances
  if (mode === 'prepare') {
    await save('preflight', { ...report, checkedAt: new Date().toISOString() })
    console.log(
      JSON.stringify({
        network: 'devnet',
        mode,
        quoteMint: provisioned.token.mint,
        config: provisioned.dbcConfigAddress,
        balances,
      }),
    )
    return
  }
  if (mode === 'verify') {
    const previous = JSON.parse(await readFile(reportPath, 'utf8')) as Record<string, unknown>
    if (
      previous.network !== 'devnet' ||
      previous.quoteMint !== provisioned.token.mint ||
      previous.config !== provisioned.dbcConfigAddress
    )
      throw new Error('Public rehearsal report does not match the isolated task configuration.')
    Object.assign(report, previous)
    const launch = await load<Journal<BuiltLaunch>>('launch')
    if (!launch) throw new Error('No persisted rehearsal launch.')
    const latestMarket = await service.inspectMarket(launch.built.market)
    if (latestMarket.status !== 'damm-v2')
      throw new Error('The rehearsal successor is not a verified DAMM v2 market.')
    const fees = await load<TransactionEnvelope[]>('creator-fee-envelopes')
    if (!fees?.length) throw new Error('Creator fee claim envelopes are missing.')
    const steps = [
      'launch',
      'graduation-buy',
      'migration',
      'post-migration-sell',
      ...fees.map((_, index) => `creator-fee-${index}`),
    ]
    const journals = await Promise.all(steps.map((step) => load<Journal<TransactionEnvelope>>(step)))
    if (journals.some((journal) => !journal))
      throw new Error('A persisted signed rehearsal journal is missing.')
    const statuses = (
      await connection.getSignatureStatuses(
        journals.map((journal) => journal!.signature),
        { searchTransactionHistory: true },
      )
    ).value
    for (let index = 0; index < steps.length; index++) {
      const status = statuses[index]
      if (status?.err || status?.confirmationStatus !== 'finalized')
        throw new Error(`${steps[index]} is not verified finalized.`)
    }
    report.finalizedTransactions = steps.map((step, index) => ({
      step,
      signature: journals[index]!.signature,
      slot: statuses[index]!.slot,
      commitment: 'finalized',
    }))
    report.latestMarket = latestMarket
    report.verified = true
    report.lastVerifiedAt = new Date().toISOString()
    await writeReport()
    console.log(
      JSON.stringify({
        network: 'devnet',
        status: 'verified',
        finalizedTransactions: steps.length,
        successor: latestMarket.pool,
      }),
    )
    return
  }
  const taskKey = async (name: 'payer' | 'creator' | 'backer') => {
    const signer = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(await readFile(`.tooling/devnet/${name}.json`, 'utf8'))),
    )
    if (signer.publicKey.toBase58() !== provisioned.wallets[name])
      throw new Error(`Isolated ${name} key does not match the task manifest.`)
    return signer
  }
  const payer = await taskKey('payer'),
    creator = await taskKey('creator'),
    backer = await taskKey('backer')
  const metadata = await fetch(metadataUri, { signal: AbortSignal.timeout(15_000), redirect: 'error' })
  if (!metadata.ok || !metadata.headers.get('content-type')?.includes('json'))
    throw new Error('Licensed public rehearsal metadata is unavailable.')
  const launch = await execute('launch', creator, () =>
    service.buildLaunch({
      postId: 'devnet-graduation-rehearsal',
      creator: creator.publicKey.toBase58(),
      name: 'Clout graduation rehearsal',
      symbol: 'GRADTEST',
      metadataUri,
    }),
  )
  const market = launch.built.market
  report.market = market
  let before = await load<Awaited<ReturnType<typeof service.inspectMarket>>>('initial-snapshot')
  if (!before) {
    before = await service.inspectMarket(market)
    await save('initial-snapshot', before)
  }
  if (before.migrationThreshold !== '2000000') throw new Error('Unexpected migration threshold.')
  report.initialMarket = before
  const buy = await execute<BuiltTrade>('graduation-buy', backer, async () => {
    const sdk = new DynamicBondingCurveClient(connection, 'confirmed')
    const virtualPool = await sdk.state.getPool(new PublicKey(market.dbcPool))
    const curve = await sdk.state.getPoolConfig(new PublicKey(provisioned.dbcConfigAddress))
    if (!virtualPool || !curve) throw new Error('Missing rehearsal pool/config.')
    const slot = await connection.getSlot('confirmed')
    const point = curve.activationType === 0 ? slot : await connection.getBlockTime(slot)
    if (point === null) throw new Error('RPC block time unavailable.')
    // Discover the exact capacity using SDK partial-fill math, then submit only an exact-in Clout quote.
    const capacity = sdk.pool.swapQuote2({
      virtualPool,
      config: curve,
      swapBaseForQuote: false,
      amountIn: new BN(3_000_000),
      swapMode: SwapMode.PartialFill,
      slippageBps: 100,
      hasReferral: false,
      eligibleForFirstSwapWithMinFee: false,
      currentPoint: new BN(point),
    })
    const amount = capacity.includedFeeInputAmount
    if (amount.lten(0) || amount.gtn(3_000_000))
      throw new Error('Graduation buy exceeds the three-Mock-SKR rehearsal bound.')
    await save('graduation-amount', {
      amountIn: amount.toString(),
      reserveBefore: virtualPool.poolState.quoteReserve.toString(),
      estimatedOutput: capacity.outputAmount.toString(),
    })
    const quote = await service.quote({
      market,
      owner: backer.publicKey.toBase58(),
      side: 'buy',
      amountIn: amount.toString(),
      slippageBps: 100,
    })
    return service.buildTrade({ quoteId: quote.id, owner: quote.owner })
  })
  const buyReceipt = await service.reconcileTrade({ signature: buy.signature, trade: buy.built })
  if (buyReceipt.status !== 'confirmed')
    throw new Error('Graduation buy metadata is not confirmed; retry the same journal.')
  report.graduationBuy = buyReceipt
  const threshold = await service.inspectMarket(market)
  report.afterBuy = threshold
  await writeReport()
  if (!(await load('migration')) && threshold.status !== 'migration-required')
    throw new Error(`Expected migration-required after exact fill; got ${threshold.status}.`)
  const migrate = await execute<BuiltMigration>('migration', payer, async () => {
    let built = await service.buildMigration({ market, payer: payer.publicKey.toBase58() })
    if (built.phase === 'create-locker') {
      await execute('vesting-locker', payer, async () => built)
      built = await service.buildMigration({ market, payer: payer.publicKey.toBase58() })
    }
    if (built.phase !== 'migrate') throw new Error('Migration did not reach the DAMM step.')
    return built
  })
  report.migration = await service.reconcile({ signature: migrate.signature, transaction: migrate.built })
  const graduated = await service.inspectMarket(market)
  if (graduated.status !== 'damm-v2' || graduated.pool !== migrate.built.successorPool)
    throw new Error('Migration did not produce the verified DAMM v2 successor.')
  report.graduatedMarket = graduated
  const received = BigInt(buyReceipt.tokenDeltas[market.baseMint] ?? '0')
  if (received <= 10n) throw new Error('Graduation buy did not deliver position tokens.')
  const sell = await execute<BuiltTrade>('post-migration-sell', backer, async () => {
    const quote = await service.quote({
      market,
      owner: backer.publicKey.toBase58(),
      side: 'sell',
      amountIn: (received / 10n).toString(),
      slippageBps: 100,
    })
    if (quote.route !== 'damm-v2') throw new Error('Sell did not route to DAMM v2.')
    return service.buildTrade({ quoteId: quote.id, owner: quote.owner })
  })
  const sellReceipt = await service.reconcileTrade({ signature: sell.signature, trade: sell.built })
  if (
    sellReceipt.status !== 'confirmed' ||
    BigInt(sellReceipt.tokenDeltas[provisioned.token.mint] ?? '0') <= 0n
  )
    throw new Error('No confirmed Mock SKR received from the graduated sale.')
  report.postMigrationSell = sellReceipt
  const creatorAta = getAssociatedTokenAddressSync(new PublicKey(provisioned.token.mint), creator.publicKey)
  let feesBefore = await load<string>('creator-fees-before')
  if (feesBefore === null) {
    feesBefore = (await getAccount(connection, creatorAta, 'confirmed')).amount.toString()
    await save('creator-fees-before', feesBefore)
  }
  let envelopes = await load<TransactionEnvelope[]>('creator-fee-envelopes')
  if (!envelopes) {
    envelopes = await service.buildClaim({ market, creator: creator.publicKey.toBase58() })
    await save('creator-fee-envelopes', envelopes)
  }
  if (!envelopes.length) throw new Error('No creator fee claims were built after graduation trading.')
  const fees: Reconciliation[] = []
  for (let i = 0; i < envelopes.length; i++) {
    const claim = await execute(`creator-fee-${i}`, creator, async () => envelopes![i])
    const receipt = await service.reconcile({ signature: claim.signature, transaction: claim.built })
    if (receipt.status !== 'confirmed') throw new Error('Creator fee claim metadata unavailable.')
    fees.push(receipt)
  }
  const creatorAfter = (await getAccount(connection, creatorAta, 'finalized')).amount
  if (creatorAfter <= BigInt(feesBefore))
    throw new Error('Creator Mock SKR balance did not increase after fee claims.')
  report.creatorFees = fees
  report.creatorFeeIncrease = (creatorAfter - BigInt(feesBefore)).toString()
  report.complete = true
  report.currentStep = 'complete'
  await writeReport()
  console.log('Verified DBC graduation, DAMM v2 sell and creator fee claims on isolated devnet market.')
}
main().catch(async (error: unknown) => {
  const message = (error instanceof Error ? error.message : 'Graduation rehearsal failed.').replace(
    /https?:\/\/[^\s]+/g,
    '[URL]',
  )
  report.error = {
    message,
    ...(error instanceof MarketError ? { code: error.code, details: error.details } : {}),
  }
  await writeReport().catch(() => {})
  console.error(message)
  process.exitCode = 1
})
