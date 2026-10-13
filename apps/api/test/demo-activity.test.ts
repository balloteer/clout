import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { BuiltTrade, MarketService } from '@clout/markets'
import type { Connection } from '@solana/web3.js'
import { demoActivityWallets } from '../../../packages/shared/src/demo-activity.js'
import {
  sampleMarkets,
  sampleQuoteMint,
  sampleMarketConfig,
} from '../../../packages/shared/src/sample-markets.js'
import { MemoryRepository } from '../src/memory.js'
import { DemoActivityRecorder } from '../src/demo-activity-recorder.js'
import { investmentHistory } from '../src/market-metrics.js'
import { isDemoTrade } from '../src/demo-activity.js'

const signature = '1'.repeat(88)
const wallet = demoActivityWallets[0].wallet
const market = sampleMarkets['big-buck-bunny']
const built = (): BuiltTrade =>
  ({
    id: '11111111-1111-4111-8111-111111111111',
    quoteId: '11111111-1111-4111-8111-111111111111',
    owner: wallet,
    cluster: 'devnet',
    messageBase64: 'ZXhhY3QtbWVzc2FnZQ==',
    transactionBase64: 'dHJhbnNhY3Rpb24=',
    blockhash: 'blockhash',
    lastValidBlockHeight: 100,
    simulation: { unitsConsumed: 1000, slot: 1 },
    quote: {
      id: '11111111-1111-4111-8111-111111111111',
      owner: wallet,
      cluster: 'devnet',
      side: 'buy',
      market: {
        ...market,
        quoteMint: sampleQuoteMint,
        creator: market.creatorWallet,
        config: sampleMarketConfig,
        status: 'dbc',
        pool: market.dbcPool,
        baseDecimals: 6,
        quoteDecimals: 6,
        quoteReserve: '0',
        migrationThreshold: '1000000000',
        progressBps: 0,
        slot: 1,
      },
      route: 'dbc',
      inputMint: sampleQuoteMint,
      outputMint: market.baseMint,
      inputDecimals: 6,
      outputDecimals: 6,
      amountIn: '1000000',
      expectedAmountOut: '50',
      minimumAmountOut: '49',
      feeAmount: '10000',
      feeMint: sampleQuoteMint,
      priceImpactPercent: null,
      slippageBps: 100,
      createdAt: '2026-10-13T00:00:00.000Z',
      expiresAt: '2026-10-13T00:00:20.000Z',
      quoteTokenLabel: 'Test SKR',
    },
  }) as BuiltTrade

test('demo recorder persists before broadcast, reconciles exact real deltas, labels only allowlisted market activity and resumes idempotently', async () => {
  const repository = new MemoryRepository()
  let finalized = false
  let reconciles = 0
  const markets = {
    reconcileTrade: async ({ trade, signature: actual }: { trade: BuiltTrade; signature: string }) => {
      reconciles++
      assert.equal(trade.messageBase64, built().messageBase64)
      assert.equal(actual, signature)
      return {
        status: 'confirmed',
        signature,
        slot: 100,
        tokenDeltas: { [market.baseMint]: '50', [sampleQuoteMint]: '-1000000' },
      }
    },
  } as unknown as MarketService
  const chain = {
    getSignatureStatuses: async () => ({
      value: [{ err: null, confirmationStatus: finalized ? 'finalized' : 'confirmed' }],
    }),
  } as unknown as Connection
  const recorder = new DemoActivityRecorder(repository, markets, chain)
  const trade = built()
  const id = await recorder.savePrepared(trade)
  // PostgreSQL JSONB can reorder object keys without changing the exact envelope.
  repository.intents.get(id)!.envelope = Object.fromEntries(Object.entries(trade).reverse())
  assert.equal(await recorder.savePrepared(trade), id)
  assert.equal((await repository.getIntent(id))?.signature, null)
  assert.deepEqual(await repository.getPostEvents(market.postId), [])
  await assert.rejects(recorder.reconcile(id, signature), /Persist the signature/)
  assert.equal(reconciles, 0)
  await recorder.recordSignature(id, signature)
  assert.equal((await repository.getIntent(id))?.state, 'pending')
  assert.equal((await recorder.reconcile(id, signature)).state, 'confirmed')
  assert.equal((await repository.getPostEvents(market.postId))[0].demoActivity, true)
  finalized = true
  assert.equal(
    (await new DemoActivityRecorder(repository, markets, chain).reconcile(id, signature)).state,
    'finalized',
  )
  const events = await repository.getPostEvents(market.postId)
  assert.equal(events.length, 1)
  assert.equal(events[0].quoteAmount, '1000000')
  assert.equal(events[0].finality, 'finalized')
  assert.deepEqual(investmentHistory(events).demo, { tradeCount: 1, walletCount: 1 })
  await recorder.reconcile(id, signature)
  assert.equal(reconciles, 2)
  await assert.rejects(recorder.recordSignature(id, '2'.repeat(88)), /another signature/)
  await assert.rejects(recorder.savePrepared({ ...trade, messageBase64: 'changed' }), /different transaction/)
})

test('demo provenance rejects unregistered traders, markets and caller flags; mixed history counts only actual labelled events', async () => {
  const repository = new MemoryRepository()
  const recorder = new DemoActivityRecorder(repository, {} as MarketService, {} as Connection)
  await assert.rejects(
    recorder.savePrepared({ ...built(), owner: 'ordinary-user' }),
    /registered demo wallet/,
  )
  const wrongMarket = structuredClone(built())
  wrongMarket.quote.market.dbcPool = 'wrong-pool'
  await assert.rejects(recorder.savePrepared(wrongMarket), /registered demo wallet/)
  const trade = built()
  assert.equal(
    isDemoTrade({
      wallet,
      kind: 'trade',
      postId: market.postId,
      envelope: trade as unknown as Record<string, unknown>,
    }),
    true,
  )
  const event = {
    signature,
    instructionPath: 'verified-intent',
    slot: 100,
    wallet,
    postId: market.postId,
    kind: 'buy' as const,
    baseAmount: '5',
    quoteAmount: '100',
    finality: 'finalized' as const,
    demoActivity: true,
  }
  const history = investmentHistory([
    event,
    { ...event, signature: 'ordinary', wallet: 'ordinary-user' },
    { ...event, signature: 'demo-2', wallet: demoActivityWallets[1].wallet },
    { ...event, signature: 'not-labelled', demoActivity: false },
  ])
  assert.deepEqual(history.demo, { tradeCount: 2, walletCount: 2 })
  assert.equal(history.points.filter((point) => point.demoActivity).length, 2)
  assert.equal(history.netQuoteAmount, '400')
  assert.equal(investmentHistory([{ ...event, wallet: 'ordinary-user' }]).demo, undefined)
})

test('failed persistence prevents signature authorization and malformed/failed settlements produce no demo points', async () => {
  const repository = new MemoryRepository()
  const put = repository.putIntent.bind(repository)
  repository.putIntent = async () => {
    throw new Error('durable write failed')
  }
  const markets = {
    reconcileTrade: async () => ({ status: 'failed', signature }),
  } as unknown as MarketService
  const recorder = new DemoActivityRecorder(repository, markets, {} as Connection)
  await assert.rejects(recorder.savePrepared(built()), /durable write failed/)
  await assert.rejects(recorder.recordSignature(built().quoteId, signature), /not found/)
  repository.putIntent = put
  const id = await recorder.savePrepared(built())
  await recorder.recordSignature(id, signature)
  assert.equal((await recorder.reconcile(id, signature)).state, 'failed')
  assert.deepEqual(await repository.getPostEvents(market.postId), [])
  await assert.rejects(recorder.recordSignature(id, signature), /terminal demo intent/)
})
