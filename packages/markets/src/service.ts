import { randomUUID } from 'node:crypto'
import type { BuiltTrade, ChainQuote, MarketAdapter, QuoteRequest, QuoteStore, TradeQuote } from './types.js'
import { MarketError, minOutput, units, validateSlippage } from './validation.js'

export class MemoryQuoteStore implements QuoteStore {
  private readonly quotes = new Map<string, TradeQuote>()
  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 10_000,
  ) {}
  async get(id: string) {
    const quote = this.quotes.get(id)
    return quote && structuredClone(quote)
  }
  async set(quote: TradeQuote) {
    for (const [id, value] of this.quotes) {
      if (Date.parse(value.expiresAt) <= this.now()) this.quotes.delete(id)
    }
    if (this.quotes.size >= this.maxEntries)
      throw new MarketError('QUOTE_CAPACITY', 'Quote capacity reached; retry shortly.')
    this.quotes.set(quote.id, structuredClone(quote))
  }
}

function validateChainQuote(quote: ChainQuote, request: QuoteRequest) {
  if (
    quote.amountIn !== request.amountIn ||
    quote.market.baseMint !== request.market.baseMint ||
    quote.market.dbcPool !== request.market.dbcPool ||
    quote.market.postId !== request.market.postId
  ) {
    throw new MarketError('INVALID_QUOTE', 'Market adapter returned a mismatched quote.')
  }
  const expectedInput = request.side === 'buy' ? quote.market.quoteMint : quote.market.baseMint
  const expectedOutput = request.side === 'buy' ? quote.market.baseMint : quote.market.quoteMint
  if (
    quote.inputMint !== expectedInput ||
    quote.outputMint !== expectedOutput ||
    quote.route !== quote.market.status
  ) {
    throw new MarketError('INVALID_QUOTE', 'Market adapter returned an invalid trade route.')
  }
  const quotedMinimum = units(quote.minimumAmountOut)
  const expected = units(quote.expectedAmountOut)
  if (
    quotedMinimum > expected ||
    quotedMinimum < BigInt(minOutput(quote.expectedAmountOut, request.slippageBps))
  ) {
    throw new MarketError('INVALID_QUOTE', 'Quote exceeds the selected slippage limit.')
  }
  units(quote.feeAmount, true)
}

/** State is explicit and injectable so the API can persist quotes across process restarts. */
export class MarketService {
  private readonly now: () => number
  private readonly store: QuoteStore
  private readonly ttlMs: number
  private readonly maxSlippage: number

  constructor(
    readonly adapter: MarketAdapter,
    options: {
      store?: QuoteStore
      now?: () => number
      quoteTtlMs?: number
      maxSlippageBps?: number
    } = {},
  ) {
    this.now = options.now ?? Date.now
    this.store = options.store ?? new MemoryQuoteStore(this.now)
    this.ttlMs = options.quoteTtlMs ?? 20_000
    this.maxSlippage = options.maxSlippageBps ?? 500
    if (!Number.isInteger(this.ttlMs) || this.ttlMs < 1_000 || this.ttlMs > 60_000) {
      throw new MarketError('INVALID_CONFIG', 'Quote lifetime must be 1–60 seconds.')
    }
    validateSlippage(this.maxSlippage, 500)
  }

  async quote(request: QuoteRequest): Promise<TradeQuote> {
    units(request.amountIn)
    validateSlippage(request.slippageBps, this.maxSlippage)
    if (request.side !== 'buy' && request.side !== 'sell')
      throw new MarketError('INVALID_SIDE', 'Choose buy or sell.')
    const quoted = await this.adapter.quote(request)
    validateChainQuote(quoted, request)
    const now = this.now()
    const quote: TradeQuote = {
      ...quoted,
      id: randomUUID(),
      owner: request.owner,
      side: request.side,
      slippageBps: request.slippageBps,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      cluster: 'devnet',
      quoteTokenLabel: 'Test SKR',
    }
    await this.store.set(quote)
    return quote
  }

  async buildTrade({ quoteId, owner }: { quoteId: string; owner: string }): Promise<BuiltTrade> {
    const quote = await this.store.get(quoteId)
    if (!quote) throw new MarketError('QUOTE_NOT_FOUND', 'Request a new quote.')
    if (quote.owner !== owner) throw new MarketError('WRONG_OWNER', 'Quote belongs to another wallet.')
    if (Date.parse(quote.expiresAt) <= this.now())
      throw new MarketError('QUOTE_EXPIRED', 'Request a fresh quote before signing.')
    const request: QuoteRequest = {
      market: quote.market,
      owner,
      side: quote.side,
      amountIn: quote.amountIn,
      slippageBps: quote.slippageBps,
    }
    const fresh = await this.adapter.quote(request)
    validateChainQuote(fresh, request)
    if (fresh.route !== quote.route || fresh.market.pool !== quote.market.pool) {
      throw new MarketError('MARKET_MIGRATED', 'Market route changed; request a fresh quote.')
    }
    if (units(fresh.expectedAmountOut) < units(quote.minimumAmountOut)) {
      throw new MarketError('PRICE_MOVED', 'Price moved beyond your slippage limit; request a fresh quote.')
    }
    // Preserve the minimum the user saw, even when the newer quote would permit a worse fill.
    const transaction = await this.adapter.buildTrade(quote)
    if (Date.parse(quote.expiresAt) <= this.now())
      throw new MarketError('QUOTE_EXPIRED', 'Quote expired while simulating; request another quote.')
    return { ...transaction, id: randomUUID(), quoteId: quote.id, quote }
  }

  async reconcileTrade({ signature, trade }: { signature: string; trade: BuiltTrade }) {
    const result = await this.adapter.reconcile({ signature, transaction: trade })
    if (result.status === 'confirmed') {
      const inputDelta = BigInt(result.tokenDeltas[trade.quote.inputMint] ?? '0')
      const outputDelta = BigInt(result.tokenDeltas[trade.quote.outputMint] ?? '0')
      if (inputDelta !== -units(trade.quote.amountIn) || outputDelta < units(trade.quote.minimumAmountOut)) {
        throw new MarketError(
          'SETTLEMENT_MISMATCH',
          'Confirmed token changes do not match this trade; reconciliation requires review.',
        )
      }
    }
    return result
  }

  inspectMarket: MarketAdapter['inspectMarket'] = (...args) => this.adapter.inspectMarket(...args)
  buildConfig: MarketAdapter['buildConfig'] = (...args) => this.adapter.buildConfig(...args)
  buildLaunch: MarketAdapter['buildLaunch'] = (...args) => this.adapter.buildLaunch(...args)
  buildTip: MarketAdapter['buildTip'] = (...args) => this.adapter.buildTip(...args)
  buildClaim: MarketAdapter['buildClaim'] = (...args) => this.adapter.buildClaim(...args)
  buildMigration: MarketAdapter['buildMigration'] = (...args) => this.adapter.buildMigration(...args)
  reconcile: MarketAdapter['reconcile'] = (...args) => this.adapter.reconcile(...args)
}
