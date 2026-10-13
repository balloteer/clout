/** Real, explicitly labelled devnet activity. Default prepare mode never broadcasts. */
import { link, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  getMint,
} from '@solana/spl-token'
import bs58 from 'bs58'
import {
  createMarketService,
  DEVNET_GENESIS_HASH,
  type BuiltTrade,
  type TransactionEnvelope,
} from '../src/index.js'
import { sampleMarkets, sampleMarketConfig, sampleQuoteMint } from '../../shared/src/sample-markets.js'
import { demoActivityWallets } from '../../shared/src/demo-activity.js'
import { demoPlan } from './demo-activity-plan.js'

const mode = process.argv[2] ?? 'prepare'
if (!['prepare', 'fund', 'prepare-creator', 'fund-creator', 'run', 'verify'].includes(mode))
  throw new Error('Use prepare, fund, prepare-creator, fund-creator, run or verify.')
const argument = process.argv[3]
if (process.argv.length > 4 || (argument && !argument.startsWith('--posts=')))
  throw new Error('Optional argument: --posts=id,id')
const postIds = argument?.slice(8).split(',') ?? []
const directory = resolve('.tooling/devnet/demo-activity')
const rpcUrl = process.env.CLOUT_BOOTSTRAP_DEVNET_RPC_URL ?? 'https://api.devnet.solana.com'
if (new URL(rpcUrl).protocol !== 'https:') throw new Error('HTTPS devnet RPC required.')
const connection = new Connection(rpcUrl, 'confirmed')
const service = createMarketService({
  cluster: 'devnet',
  rpcUrl,
  quoteMint: sampleQuoteMint,
  quoteDecimals: 6,
  dbcConfigAddress: sampleMarketConfig,
  quoteTtlMs: 60000,
  maxSlippageBps: 100,
})
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const mint = new PublicKey(sampleQuoteMint)
async function guard() {
  if ((await connection.getGenesisHash()) !== DEVNET_GENESIS_HASH) throw new Error('Devnet genesis mismatch.')
}
async function load<T>(name: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(resolve(directory, name), 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
async function save(name: string, value: unknown) {
  const path = resolve(directory, name),
    handle = await open(`${path}.tmp`, 'w', 0o600)
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
async function taskKey(name: string) {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(await readFile(`.tooling/devnet/${name}.json`, 'utf8'))),
  )
}
async function demoKeys() {
  return Promise.all(
    demoActivityWallets.map(async (wallet, index) => {
      const key = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(await readFile(resolve(directory, `wallet-${index + 1}.json`), 'utf8'))),
      )
      if (key.publicKey.toBase58() !== wallet.wallet) throw new Error('Demo wallet allowlist mismatch.')
      return key
    }),
  )
}
type Journal = {
  signature: string
  signedBase64: string
  built: TransactionEnvelope
  trade?: BuiltTrade
  finalized?: boolean
  broadcast?: {
    state: 'not-attempted' | 'sending' | 'accepted' | 'not-submitted-expired' | 'preflight-rejected'
    attemptedAt?: string
    rpcSignature?: string
    reason?: string
  }
}
type Receipt = {
  postId: string
  wallet: string
  demo: boolean
  side: string
  signature: string
  slot: number
  tokenDeltas: Record<string, string>
  feeLamports: string | null
  state: { state: string; signature: string | null; postId: string }
}
async function archivedUnsubmitted(
  name: string,
  journal: Journal,
  state: 'not-submitted-expired' | 'preflight-rejected',
  reason: string,
) {
  journal.broadcast = { state, reason }
  await save(`${name}.json`, journal)
  const source = resolve(directory, `${name}.json`),
    archive = resolve(directory, `${name}.rejected-${journal.signature}.json`)
  await link(source, archive)
  await unlink(source)
  const folder = await open(directory, 'r')
  try {
    await folder.sync()
  } finally {
    await folder.close()
  }
}
function isExpiredBlockhashPreflight(error: unknown) {
  return error instanceof SendTransactionError && /blockhash not found/i.test(error.message)
}
async function existingReceipts(): Promise<Receipt[]> {
  try {
    const stored = JSON.parse(await readFile('artifacts/demo-activity-receipts.json', 'utf8')) as {
      network?: string
      mint?: string
      receipts?: Receipt[]
    }
    if (stored.network !== 'devnet' || stored.mint !== sampleQuoteMint || !Array.isArray(stored.receipts))
      throw new Error('Existing demo receipt report has the wrong network or mint.')
    return stored.receipts
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
async function submit(
  name: string,
  signers: Keypair[],
  build: () => Promise<TransactionEnvelope>,
  hooks?: {
    prepared: (trade: BuiltTrade) => Promise<unknown>
    signed: (id: string, signature: string) => Promise<unknown>
  },
) {
  await guard()
  let journal = await load<Journal>(`${name}.json`)
  for (let buildAttempt = 0; ; buildAttempt++) {
    if (!journal) {
      const built = await build()
      if (built.cluster !== 'devnet' || built.owner !== signers[0].publicKey.toBase58())
        throw new Error('Transaction owner/network mismatch.')
      const tx = Transaction.from(Buffer.from(built.transactionBase64, 'base64'))
      if (tx.serializeMessage().toString('base64') !== built.messageBase64)
        throw new Error('Message binding mismatch.')
      tx.partialSign(...signers)
      if (!tx.signature) throw new Error('Missing signature.')
      journal = {
        built,
        signature: bs58.encode(tx.signature),
        signedBase64: tx.serialize().toString('base64'),
        ...('quote' in built ? { trade: built as BuiltTrade } : {}),
        broadcast: { state: 'not-attempted' },
      }
      await save(`${name}.json`, journal)
    }
    const persisted = Transaction.from(Buffer.from(journal.signedBase64, 'base64'))
    if (
      journal.built.cluster !== 'devnet' ||
      journal.built.owner !== signers[0].publicKey.toBase58() ||
      persisted.serializeMessage().toString('base64') !== journal.built.messageBase64 ||
      !persisted.signature ||
      bs58.encode(persisted.signature) !== journal.signature ||
      !persisted.verifySignatures() ||
      (journal.trade && JSON.stringify(journal.trade) !== JSON.stringify(journal.built))
    )
      throw new Error('Persisted transaction binding mismatch.')
    if (
      journal.broadcast?.state === 'not-submitted-expired' ||
      journal.broadcast?.state === 'preflight-rejected'
    )
      throw new Error(`${name}: rejected transaction journal must remain archived.`)
    // The exact transaction and intent must both be durable before a possible broadcast.
    if (hooks) {
      if (!journal.trade) throw new Error('Trade journal required.')
      await hooks.prepared(journal.trade)
      await hooks.signed(journal.trade.quoteId, journal.signature)
    }
    const status = (
      await connection.getSignatureStatuses([journal.signature], { searchTransactionHistory: true })
    ).value[0]
    if (status?.err) throw new Error(`${name}: failed transaction requires review.`)
    const confirmation = hooks ? 'confirmed' : 'finalized'
    if (
      status?.confirmationStatus !== 'finalized' &&
      !(confirmation === 'confirmed' && status?.confirmationStatus === 'confirmed')
    ) {
      const height = !status ? await connection.getBlockHeight('confirmed') : 0
      if (!status && height > journal.built.lastValidBlockHeight)
        throw new Error(`${name}: unknown expired transaction; no automatic replacement.`)
      if (
        !status &&
        journal.broadcast?.state === 'not-attempted' &&
        height + 20 >= journal.built.lastValidBlockHeight
      ) {
        if (buildAttempt >= 1)
          throw new Error(`${name}: transaction lifetime expired twice before submission.`)
        await archivedUnsubmitted(
          name,
          journal,
          'not-submitted-expired',
          'Fresh-height guard prevented submission near expiry.',
        )
        journal = null
        continue
      }
      journal.broadcast = { state: 'sending', attemptedAt: new Date().toISOString() }
      await save(`${name}.json`, journal)
      try {
        const rpcSignature = await connection.sendRawTransaction(
          Buffer.from(journal.signedBase64, 'base64'),
          { skipPreflight: false, maxRetries: 3 },
        )
        if (rpcSignature !== journal.signature) throw new Error('RPC returned a different signature.')
        journal.broadcast = {
          state: 'accepted',
          attemptedAt: journal.broadcast.attemptedAt,
          rpcSignature,
        }
        await save(`${name}.json`, journal)
      } catch (error) {
        if (!isExpiredBlockhashPreflight(error)) throw error
        if (buildAttempt >= 1) throw error
        await archivedUnsubmitted(
          name,
          journal,
          'preflight-rejected',
          'RPC preflight rejected the expired blockhash.',
        )
        journal = null
        continue
      }
      const result = await connection.confirmTransaction(
        {
          signature: journal.signature,
          blockhash: journal.built.blockhash,
          lastValidBlockHeight: journal.built.lastValidBlockHeight,
        },
        confirmation,
      )
      if (result.value.err) throw new Error(`${name}: chain rejected transaction.`)
    }
    journal.finalized = status?.confirmationStatus === 'finalized' || confirmation === 'finalized'
    await save(`${name}.json`, journal)
    return journal
  }
}
async function envelope(tx: Transaction, owner: PublicKey): Promise<TransactionEnvelope> {
  const lifetime = await connection.getLatestBlockhash('confirmed')
  tx.feePayer = owner
  tx.recentBlockhash = lifetime.blockhash
  const simulated = await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
    sigVerify: false,
    commitment: 'confirmed',
  })
  if (simulated.value.err) throw new Error('Funding simulation failed.')
  return {
    owner: owner.toBase58(),
    cluster: 'devnet',
    ...lifetime,
    messageBase64: tx.serializeMessage().toString('base64'),
    transactionBase64: tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64'),
    simulation: { unitsConsumed: simulated.value.unitsConsumed ?? null, slot: simulated.context.slot },
  }
}
async function main() {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await guard()
  const lock = await open(resolve(directory, 'active.lock'), 'wx', 0o600)
  await lock.writeFile(String(process.pid))
  await lock.close()
  let repository: { sql: { end: () => Promise<unknown> } } | undefined
  try {
    const payer = await taskKey('payer'),
      creator = await taskKey('creator'),
      wallets = await demoKeys()
    if (
      payer.publicKey.toBase58() !== 'H8xYY5wr3o8Q4xKK8NDZSf9vb7vxuVvZcgHws9t7kge3' ||
      creator.publicKey.toBase58() !== 'HDXHbGGRibekDCYGHABe16PAzKJWezgbwBniG37KBHGp'
    )
      throw new Error('Task key mismatch.')
    const mintState = await getMint(connection, mint, 'confirmed')
    if (mintState.decimals !== 6 || !mintState.mintAuthority?.equals(payer.publicKey))
      throw new Error('Mock SKR mint mismatch.')
    if (mode === 'prepare-creator' || mode === 'fund-creator') {
      // One bounded top-up covers twelve new markets while keeping payer allocation below 0.41 SOL.
      const build = () =>
        envelope(
          new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: payer.publicKey,
              toPubkey: creator.publicKey,
              lamports: 120_000_000,
            }),
          ),
          payer.publicKey,
        )
      if (mode === 'prepare-creator') {
        const built = await build()
        console.log(
          JSON.stringify({
            simulationOnly: true,
            recipient: creator.publicKey.toBase58(),
            lamports: 120_000_000,
            simulation: built.simulation,
          }),
        )
        return
      }
      const journal = await submit('creator-top-up', [payer], build)
      console.log(
        JSON.stringify({
          recipient: creator.publicKey.toBase58(),
          lamports: 120_000_000,
          signature: journal.signature,
          finalized: true,
        }),
      )
      await writeFile(
        'artifacts/demo-creator-funding.json',
        JSON.stringify(
          {
            network: 'devnet',
            recipient: creator.publicKey.toBase58(),
            lamports: 120_000_000,
            signature: journal.signature,
            finalized: true,
          },
          null,
          2,
        ) + '\n',
      )
      return
    }
    const funding = []
    for (let i = 0; i < wallets.length; i++) {
      const owner = wallets[i].publicKey,
        ata = getAssociatedTokenAddressSync(mint, owner)
      const build = () =>
        envelope(
          new Transaction().add(
            SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: owner, lamports: 40_000_000 }),
            createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata, owner, mint),
            createTransferCheckedInstruction(
              getAssociatedTokenAddressSync(mint, creator.publicKey),
              mint,
              ata,
              creator.publicKey,
              1_000_000_000n,
              6,
            ),
          ),
          payer.publicKey,
        )
      if (mode === 'fund') {
        const journal = await submit(`fund-${i + 1}`, [payer, creator], build)
        funding.push({ wallet: owner.toBase58(), signature: journal.signature, finalized: true })
        console.log(
          JSON.stringify({ step: 'fund', wallet: i + 1, signature: journal.signature, finalized: true }),
        )
      } else if (mode === 'prepare') {
        const funded = await load<Journal>(`fund-${i + 1}.json`)
        if (funded?.finalized) {
          funding.push({ wallet: owner.toBase58(), signature: funded.signature, alreadyFinalized: true })
          continue
        }
        const built = await build()
        funding.push({
          wallet: owner.toBase58(),
          lamports: 40_000_000,
          mockSkrUnits: '1000000000',
          simulation: built.simulation,
        })
      }
      await wait(1200)
    }
    if (mode === 'fund') {
      await writeFile(
        'artifacts/demo-activity-funding.json',
        JSON.stringify({ network: 'devnet', mint: sampleQuoteMint, funding }, null, 2) + '\n',
      )
      return
    }
    if (mode === 'prepare' && !postIds.length) {
      console.log(JSON.stringify({ mode, mint: sampleQuoteMint, newMintUnits: '0', funding }))
      return
    }
    const requested = postIds.length
      ? demoPlan(postIds)
      : await load<ReturnType<typeof demoPlan>>('plan.json')
    if (!requested) throw new Error('Run prepare --posts=... before trading.')
    const canonicalPlan = demoPlan(requested.markets.map((market) => market.postId))
    if (JSON.stringify(requested) !== JSON.stringify(canonicalPlan))
      throw new Error('Stored demo plan differs from the bounded action template.')
    const prior = await load<ReturnType<typeof demoPlan>>('plan.json')
    if (prior && JSON.stringify(prior) !== JSON.stringify(requested))
      throw new Error('Existing demo plan is immutable.')
    for (const market of requested.markets)
      if (!sampleMarkets[market.postId]) throw new Error('Selected post needs a finalized catalog market.')
    if (!prior) await save('plan.json', requested)
    if (mode === 'prepare') {
      const first = sampleMarkets[requested.markets[0].postId],
        snapshot = await service.inspectMarket(first)
      if (snapshot.status !== 'dbc' || snapshot.migrationThreshold !== '1000000000')
        throw new Error('Unexpected demo curve.')
      const quote = await service.quote({
        market: first,
        owner: wallets[0].publicKey.toBase58(),
        side: 'buy',
        amountIn: '18000000',
        slippageBps: 100,
      })
      const built = await service.buildTrade({ quoteId: quote.id, owner: quote.owner })
      const report = {
        ...requested,
        mint: sampleQuoteMint,
        newMintUnits: '0',
        funding,
        simulation: built.simulation,
        note: 'Simulation and execution use the dedicated labelled demo wallets.',
      }
      await writeFile('artifacts/demo-activity-plan.json', JSON.stringify(report, null, 2) + '\n')
      console.log(JSON.stringify(report))
      return
    }
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for durable verified activity.')
    const { PostgresRepository } = await import('../../../apps/api/src/postgres.js')
    const { DemoActivityRecorder } = await import('../../../apps/api/src/demo-activity-recorder.js')
    const { validateTarget } = (await import(
      new URL('../../../scripts/db-setup.mjs', import.meta.url).href
    )) as {
      validateTarget(value: string): { url: URL }
    }
    const target = validateTarget(process.env.DATABASE_URL)
    const db = new PostgresRepository(target.url.toString())
    repository = db
    const recorder = new DemoActivityRecorder(db, service, connection)
    const storedReceipts = await existingReceipts()
    const report: Receipt[] = []
    for (const [marketIndex, plan] of requested.markets.entries()) {
      const market = sampleMarkets[plan.postId]
      const batch: { name: string; journal: Journal }[] = []
      if (mode === 'run') {
        const checkpoint = await load<Record<string, unknown>>(`${plan.postId}.verified.json`)
        const completed = await Promise.all(
          plan.actions.map((_, index) =>
            load<Journal>(`${plan.postId}-${String(index + 1).padStart(2, '0')}.json`),
          ),
        )
        if (
          checkpoint?.postId === plan.postId &&
          checkpoint.dbcPool === market.dbcPool &&
          checkpoint.quoteMint === sampleQuoteMint &&
          checkpoint.status === 'dbc' &&
          completed.every((journal) => journal?.finalized)
        ) {
          const resumed = completed.map((journal, index) => {
            const action = plan.actions[index],
              wallet = wallets[action.walletIndex].publicKey.toBase58(),
              matches = storedReceipts.filter(
                (receipt) =>
                  receipt.signature === journal!.signature &&
                  receipt.postId === plan.postId &&
                  receipt.wallet === wallet &&
                  receipt.side === action.side &&
                  receipt.demo === true &&
                  receipt.state.state === 'finalized' &&
                  receipt.state.signature === journal!.signature &&
                  receipt.state.postId === plan.postId &&
                  receipt.slot > 0 &&
                  typeof receipt.tokenDeltas[market.baseMint] === 'string' &&
                  typeof receipt.tokenDeltas[sampleQuoteMint] === 'string',
              )
            if (matches.length !== 1) throw new Error('Finalized checkpoint receipt mismatch.')
            return matches[0]
          })
          report.push(...resumed)
          console.log(
            JSON.stringify({
              market: marketIndex + 1,
              postId: plan.postId,
              finalizedTrades: resumed.length,
              resumed: true,
            }),
          )
          continue
        }
      }
      for (const [index, action] of plan.actions.entries()) {
        const name = `${plan.postId}-${String(index + 1).padStart(2, '0')}`
        const owner = wallets[action.walletIndex]
        const journal =
          mode === 'verify'
            ? await load<Journal>(`${name}.json`)
            : await submit(
                name,
                [owner],
                async () => {
                  let amountIn: string
                  if (action.side === 'buy') {
                    amountIn = action.amountIn
                  } else {
                    const account = await getAccount(
                      connection,
                      getAssociatedTokenAddressSync(new PublicKey(market.baseMint), owner.publicKey),
                      'confirmed',
                    )
                    amountIn = (account.amount / BigInt(action.divisor)).toString()
                    if (BigInt(amountIn) <= 0n) throw new Error('Demo wallet has no position to sell.')
                  }
                  const quote = await service.quote({
                    market,
                    owner: owner.publicKey.toBase58(),
                    side: action.side,
                    amountIn,
                    slippageBps: 100,
                  })
                  // The quote already includes the service's fresh, verified market snapshot.
                  if (
                    quote.market.postId !== plan.postId ||
                    quote.market.baseMint !== market.baseMint ||
                    quote.market.dbcPool !== market.dbcPool ||
                    quote.market.status !== 'dbc' ||
                    quote.market.config !== sampleMarketConfig ||
                    quote.market.migrationThreshold !== '1000000000' ||
                    quote.market.quoteMint !== sampleQuoteMint
                  )
                    throw new Error('Curve binding/migration changed.')
                  if (
                    action.side === 'buy' &&
                    BigInt(quote.market.quoteReserve) + BigInt(amountIn) >= 500_000_000n
                  )
                    throw new Error('Demo reserve ceiling reached.')
                  return service.buildTrade({ quoteId: quote.id, owner: quote.owner })
                },
                {
                  prepared: (built) => {
                    if (
                      built.owner !== owner.publicKey.toBase58() ||
                      built.quote.market.postId !== plan.postId ||
                      built.quote.side !== action.side ||
                      (action.side === 'buy' && built.quote.amountIn !== action.amountIn)
                    )
                      throw new Error('Journal does not match the bounded demo action.')
                    return recorder.savePrepared(built)
                  },
                  signed: (id, signature) => recorder.recordSignature(id, signature),
                },
              )
        if (!journal?.trade) throw new Error('Verified trade journal is missing.')
        const state = await recorder.reconcile(journal.trade.quoteId, journal.signature)
        // Reconciliation above already verifies the exact message and actual token deltas.
        // Read that persisted evidence instead of fetching the same chain transaction twice.
        const event = (await db.getPostEvents(plan.postId)).find(
          (event) =>
            event.signature === journal.signature &&
            event.wallet === owner.publicKey.toBase58() &&
            event.postId === plan.postId &&
            event.kind === action.side &&
            event.instructionPath === 'verified-intent' &&
            event.demoActivity === true &&
            ['confirmed', 'finalized'].includes(event.finality),
        )
        if (!['confirmed', 'finalized'].includes(state.state) || !event)
          throw new Error('Trade settlement is not available; retry same journal.')
        const actualInput = action.side === 'buy' ? event.quoteAmount : event.baseAmount
        const actualOutput = action.side === 'buy' ? event.baseAmount : event.quoteAmount
        if (
          actualInput !== journal.trade.quote.amountIn ||
          BigInt(actualOutput) < BigInt(journal.trade.quote.minimumAmountOut)
        )
          throw new Error('Persisted settlement amounts do not match the signed trade.')
        batch.push({ name, journal })
        report.push({
          postId: plan.postId,
          wallet: owner.publicKey.toBase58(),
          demo: true,
          side: action.side,
          signature: journal.signature,
          slot: event.slot,
          tokenDeltas: {
            [market.baseMint]: action.side === 'buy' ? event.baseAmount : `-${event.baseAmount}`,
            [sampleQuoteMint]: action.side === 'buy' ? `-${event.quoteAmount}` : event.quoteAmount,
          },
          // Indexed trade events do not retain chain fees; never substitute an estimate.
          feeLamports: null,
          state,
        })
        await writeFile(
          'artifacts/demo-activity-receipts.json',
          JSON.stringify({ network: 'devnet', mint: sampleQuoteMint, receipts: report }, null, 2) + '\n',
        )
        console.log(
          JSON.stringify({
            market: marketIndex + 1,
            postId: plan.postId,
            step: index + 1,
            side: action.side,
            signature: journal.signature,
            status: state.state,
          }),
        )
        await wait(1500)
      }
      // At most eight sequentially confirmed trades await finality; never queue another market.
      const deadline = Date.now() + 90000
      while (true) {
        const statuses = await connection.getSignatureStatuses(
          batch.map((item) => item.journal.signature),
          { searchTransactionHistory: true },
        )
        if (statuses.value.some((status) => status?.err))
          throw new Error('Demo transaction failed before finality; review required.')
        if (statuses.value.every((status) => status?.confirmationStatus === 'finalized')) break
        if (Date.now() > deadline) throw new Error('Finality not established; retry identical journals.')
        await wait(3000)
      }
      for (const item of batch) {
        const state = await recorder.reconcile(item.journal.trade!.quoteId, item.journal.signature)
        if (state.state !== 'finalized') throw new Error('Finalized demo event not persisted.')
        item.journal.finalized = true
        await save(`${item.name}.json`, item.journal)
        report.find((receipt) => receipt.signature === item.journal.signature)!.state = state
      }
      await writeFile(
        'artifacts/demo-activity-receipts.json',
        JSON.stringify({ network: 'devnet', mint: sampleQuoteMint, receipts: report }, null, 2) + '\n',
      )
      console.log(
        JSON.stringify({ market: marketIndex + 1, postId: plan.postId, finalizedTrades: batch.length }),
      )
      const snapshot = await service.inspectMarket(market)
      if (
        snapshot.status !== 'dbc' ||
        BigInt(snapshot.quoteReserve) <= 0n ||
        BigInt(snapshot.quoteReserve) >= 500_000_000n
      )
        throw new Error('Final demo reserve outside bounds.')
      await save(`${plan.postId}.verified.json`, snapshot)
    }
  } finally {
    await repository?.sql.end()
    await unlink(resolve(directory, 'active.lock'))
  }
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      error: 'Demo activity stopped; persisted journals retained.',
      code: error?.code ?? error?.name ?? 'Unknown',
      message:
        error instanceof Error &&
        !(error instanceof SyntaxError) &&
        !/https?:|postgres|password|secret|ENOTFOUND/i.test(error.message)
          ? error.message
          : undefined,
    }),
  )
  process.exitCode = 1
})
