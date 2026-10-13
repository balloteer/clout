import type { MarketReference, MarketSnapshot } from '@clout/markets'
import type { IndexedEvent, Post } from './domain.js'

const integer = (value: string) => /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
export const compareEvents = (a: IndexedEvent, b: IndexedEvent) =>
  a.slot - b.slot ||
  compareText(a.signature, b.signature) ||
  compareText(a.instructionPath, b.instructionPath)

/** A bounded, zero-based cash-flow window; deliberately not reserve or price history. */
export function investmentHistory(events: IndexedEvent[]) {
  const ordered = events
    .filter(
      (event) =>
        ['confirmed', 'finalized'].includes(event.finality) &&
        ['buy', 'sell'].includes(event.kind) &&
        Number.isSafeInteger(event.slot) &&
        event.slot >= 0 &&
        integer(event.quoteAmount) &&
        integer(event.baseAmount),
    )
    .sort(compareEvents)
    .slice(-100)
  let buys = 0n
  let sells = 0n
  const points = ordered.map(({ signature, slot, kind, quoteAmount }) => {
    if (kind === 'buy') buys += BigInt(quoteAmount)
    else sells += BigInt(quoteAmount)
    return { signature, slot, kind, quoteAmount, netQuoteAmount: (buys - sells).toString() }
  })
  return {
    source: 'clout-transactions' as const,
    coverage: 'latest-100-trades' as const,
    baseline: 'window-start-zero' as const,
    points,
    buyVolume: buys.toString(),
    sellVolume: sells.toString(),
    netQuoteAmount: (buys - sells).toString(),
  }
}

export interface PoolMetric {
  available: boolean
  amount: string | null
  decimals: number
  metric: 'dbc-quote-reserve'
  label: 'SKR in curve'
  status: MarketSnapshot['status'] | null
  slot: number | null
  observedAt: string | null
  stale: boolean
  reason?: string
}

/** One bounded RPC read at a time, with no unbounded queue when readers change videos. */
export class MarketMetrics {
  private cache = new Map<string, { postId: string; until: number; value: PoolMetric }>()
  private active?: { postId: string; key: string; invalidated: boolean; promise: Promise<PoolMetric> }
  private nextRead = 0
  constructor(
    private options: {
      inspect?: (market: MarketReference) => Promise<MarketSnapshot>
      quoteMint?: string
      decimals: number
      now?: () => number
      ttlMs?: number
      gapMs?: number
      timeoutMs?: number
    },
  ) {}

  private now() {
    return this.options.now?.() ?? Date.now()
  }
  private unavailable(reason: string): PoolMetric {
    return {
      available: false,
      amount: null,
      decimals: this.options.decimals,
      metric: 'dbc-quote-reserve',
      label: 'SKR in curve',
      status: null,
      slot: null,
      observedAt: null,
      stale: false,
      reason,
    }
  }
  invalidate(postId: string) {
    for (const [key, entry] of this.cache) if (entry.postId === postId) this.cache.delete(key)
    // An older read may still complete after reconciliation; never let it restore the old value.
    if (this.active?.postId === postId) this.active.invalidated = true
  }
  private async bounded(promise: Promise<PoolMetric>) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<PoolMetric>((resolve) => {
          timer = setTimeout(
            () => resolve(this.unavailable('The network is taking longer than usual. Try again shortly.')),
            this.options.timeoutMs ?? 8000,
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  async read(post: Pick<Post, 'id' | 'market'>): Promise<PoolMetric> {
    if (!post.market) return this.unavailable('This video has no market yet.')
    if (!this.options.inspect || !this.options.quoteMint)
      return this.unavailable('Market balances are not configured.')
    const market = { postId: post.id, ...post.market }
    const key = JSON.stringify([
      post.id,
      market.baseMint,
      market.dbcPool,
      this.options.quoteMint,
      this.options.decimals,
    ])
    const cached = this.cache.get(key)
    if (cached && cached.until > this.now()) return cached.value
    if (this.active) {
      if (this.active.key === key && !this.active.invalidated) return this.bounded(this.active.promise)
      return this.unavailable('Market balances are refreshing. Try again shortly.')
    }
    if (this.now() < this.nextRead)
      return this.unavailable('Market balances are refreshing. Try again shortly.')
    this.nextRead = this.now() + (this.options.gapMs ?? 3000)
    const active = {
      postId: post.id,
      key,
      invalidated: false,
      promise: Promise.resolve(this.unavailable('Refreshing.')),
    }
    this.active = active
    active.promise = (async () => {
      let value: PoolMetric
      try {
        const snapshot = await this.options.inspect!(market)
        if (
          snapshot.postId !== market.postId ||
          snapshot.baseMint !== market.baseMint ||
          snapshot.dbcPool !== market.dbcPool ||
          snapshot.quoteMint !== this.options.quoteMint ||
          snapshot.quoteDecimals !== this.options.decimals ||
          !integer(snapshot.quoteReserve) ||
          !Number.isSafeInteger(snapshot.slot) ||
          snapshot.slot < 0
        )
          throw new Error('Unexpected market snapshot')
        value = {
          ...this.unavailable('Live liquidity after curve migration is not available yet.'),
          status: snapshot.status,
          slot: snapshot.slot,
          observedAt: new Date(this.now()).toISOString(),
        }
        // quoteReserve comes from the DBC account even after migration; it is not DAMM liquidity.
        if (snapshot.status === 'dbc') {
          value.available = true
          value.amount = snapshot.quoteReserve
          delete value.reason
        }
      } catch {
        value = this.unavailable('The network balance is unavailable. Try again shortly.')
      }
      if (active.invalidated)
        return this.unavailable('The balance changed. Refresh to read the latest amount.')
      if (this.cache.size >= 128 && !this.cache.has(key)) this.cache.delete(this.cache.keys().next().value!)
      this.cache.set(key, {
        postId: post.id,
        until: this.now() + (value.available ? (this.options.ttlMs ?? 30000) : 5000),
        value,
      })
      return value
    })().finally(() => {
      if (this.active === active) this.active = undefined
    })
    // Timeout only releases the HTTP reader. Keep the single-flight lock until the actual RPC settles.
    return this.bounded(active.promise)
  }
}
