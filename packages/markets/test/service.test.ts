import assert from 'node:assert/strict'
import test from 'node:test'
import { MarketService, MemoryQuoteStore } from '../src/service.js'
import type {
  ChainQuote,
  MarketAdapter,
  QuoteRequest,
  TradeQuote,
  TransactionEnvelope,
} from '../src/types.js'

const market = { postId: 'post-1', baseMint: 'post-token', dbcPool: 'dbc-pool' }
const request: QuoteRequest = { market, owner: 'wallet', side: 'buy', amountIn: '1000000', slippageBps: 100 }
const envelope: TransactionEnvelope = {
  transactionBase64: 'encoded',
  messageBase64: 'message',
  blockhash: 'hash',
  lastValidBlockHeight: 100,
  owner: 'wallet',
  cluster: 'devnet',
  simulation: { unitsConsumed: 10000, slot: 1 },
}

function fixture() {
  let now = 10_000
  let builtQuote: TradeQuote | undefined
  let chainQuote: ChainQuote = {
    market: {
      ...market,
      status: 'dbc',
      pool: 'dbc-pool',
      creator: 'creator',
      config: 'config',
      quoteMint: 'test-skr',
      baseDecimals: 6,
      quoteDecimals: 6,
      quoteReserve: '10',
      migrationThreshold: '100',
      progressBps: 1000,
      slot: 1,
    },
    route: 'dbc',
    inputMint: 'test-skr',
    outputMint: 'post-token',
    inputDecimals: 6,
    outputDecimals: 6,
    amountIn: '1000000',
    expectedAmountOut: '10000',
    minimumAmountOut: '9900',
    feeAmount: '10000',
    feeMint: 'test-skr',
    priceImpactPercent: null,
  }
  const adapter = {
    quote: async () => structuredClone(chainQuote),
    buildTrade: async (quote: TradeQuote) => {
      builtQuote = quote
      return envelope
    },
  } as unknown as MarketAdapter
  const service = new MarketService(adapter, { now: () => now })
  return {
    service,
    adapter,
    getBuilt: () => builtQuote,
    setTime: (value: number) => {
      now = value
    },
    setQuote: (update: Partial<ChainQuote>) => {
      chainQuote = { ...chainQuote, ...update }
    },
    getQuote: () => chainQuote,
  }
}

test('quotes identify devnet Test SKR and bind the authorized wallet', async () => {
  const { service } = fixture()
  const quote = await service.quote(request)
  assert.equal(quote.quoteTokenLabel, 'Test SKR')
  assert.equal(quote.cluster, 'devnet')
  assert.equal(quote.owner, request.owner)
  assert.equal(Date.parse(quote.expiresAt) - Date.parse(quote.createdAt), 20000)
  await assert.rejects(service.buildTrade({ quoteId: quote.id, owner: 'attacker' }), { code: 'WRONG_OWNER' })
})

test('expired and unknown quotes cannot be built', async () => {
  const { service, setTime } = fixture()
  const quote = await service.quote(request)
  setTime(Date.parse(quote.expiresAt))
  await assert.rejects(service.buildTrade({ quoteId: quote.id, owner: request.owner }), {
    code: 'QUOTE_EXPIRED',
  })
  await assert.rejects(service.buildTrade({ quoteId: 'unknown', owner: request.owner }), {
    code: 'QUOTE_NOT_FOUND',
  })
})

test('build preserves user-approved minimum while validating current price', async () => {
  const { service, setQuote, getBuilt } = fixture()
  const quote = await service.quote(request)
  setQuote({ expectedAmountOut: '9950', minimumAmountOut: '9850' })
  const built = await service.buildTrade({ quoteId: quote.id, owner: request.owner })
  assert.equal(getBuilt()?.minimumAmountOut, '9900')
  assert.equal(built.quoteId, quote.id)
  assert.equal(built.messageBase64, envelope.messageBase64)
})

test('fresh price below the approved minimum refuses construction', async () => {
  const { service, setQuote } = fixture()
  const quote = await service.quote(request)
  setQuote({ expectedAmountOut: '9800', minimumAmountOut: '9702' })
  await assert.rejects(service.buildTrade({ quoteId: quote.id, owner: request.owner }), {
    code: 'PRICE_MOVED',
  })
})

test('graduation invalidates DBC quotes even if the new route has a favorable price', async () => {
  const { service, setQuote, getQuote } = fixture()
  const quote = await service.quote(request)
  setQuote({ route: 'damm-v2', market: { ...getQuote().market, status: 'damm-v2', pool: 'successor' } })
  await assert.rejects(service.buildTrade({ quoteId: quote.id, owner: request.owner }), {
    code: 'MARKET_MIGRATED',
  })
})

test('untrusted quote values cannot weaken slippage or swap the asset', async () => {
  const { service, setQuote } = fixture()
  setQuote({ minimumAmountOut: '1' })
  await assert.rejects(service.quote(request), { code: 'INVALID_QUOTE' })
  setQuote({ minimumAmountOut: '9900', outputMint: 'wrong-mint' })
  await assert.rejects(service.quote(request), { code: 'INVALID_QUOTE' })
})

test('quote expiry during slow simulation prevents signing an old quote', async () => {
  const { service, adapter, setTime } = fixture()
  const quote = await service.quote(request)
  adapter.buildTrade = async () => {
    setTime(Date.parse(quote.expiresAt))
    return envelope
  }
  await assert.rejects(service.buildTrade({ quoteId: quote.id, owner: request.owner }), {
    code: 'QUOTE_EXPIRED',
  })
})

test('callers cannot mutate the server quote through returned object references', async () => {
  const { service, getBuilt } = fixture()
  const quote = await service.quote(request)
  quote.minimumAmountOut = '1'
  quote.market.pool = 'attacker'
  await service.buildTrade({ quoteId: quote.id, owner: request.owner })
  assert.equal(getBuilt()?.minimumAmountOut, '9900')
  assert.equal(getBuilt()?.market.pool, 'dbc-pool')
})

test('memory quote storage has a capacity bound and expires old entries', async () => {
  let now = 0
  const store = new MemoryQuoteStore(() => now, 1)
  const quote = await fixture().service.quote(request)
  await store.set(quote)
  await assert.rejects(store.set({ ...quote, id: 'second' }), { code: 'QUOTE_CAPACITY' })
  now = Date.parse(quote.expiresAt)
  await store.set({ ...quote, id: 'second', expiresAt: new Date(now + 1000).toISOString() })
  assert.equal(await store.get(quote.id), undefined)
})

test('trade settlement verifies both the real input debit and approved minimum output', async () => {
  const { service, adapter } = fixture()
  const quote = await service.quote(request)
  const trade = await service.buildTrade({ quoteId: quote.id, owner: request.owner })
  adapter.reconcile = async () => ({
    status: 'confirmed',
    signature: 'signature',
    slot: 1,
    blockTime: 10,
    feeLamports: '5000',
    tokenDeltas: { 'test-skr': '-1000000', 'post-token': '9950' },
  })
  assert.equal((await service.reconcileTrade({ signature: 'signature', trade })).status, 'confirmed')
  adapter.reconcile = async () => ({
    status: 'confirmed',
    signature: 'signature',
    slot: 1,
    blockTime: 10,
    feeLamports: '5000',
    tokenDeltas: { 'test-skr': '-1000000', 'post-token': '9800' },
  })
  await assert.rejects(service.reconcileTrade({ signature: 'signature', trade }), {
    code: 'SETTLEMENT_MISMATCH',
  })
})
