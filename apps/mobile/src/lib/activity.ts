export type TradeEvent = {
  signature: string
  slot: number
  kind: 'buy' | 'sell'
  baseAmount: string
  quoteAmount: string
  finality: 'confirmed' | 'finalized'
}
export type MarketActivity = {
  events: TradeEvent[]
  baseDecimals: number
  quoteDecimals: number
  source: 'clout-transactions'
}

/** Approximate display-only execution prices. Signing uses integer amounts elsewhere. */
export function executionPrices(activity: MarketActivity) {
  if (
    !Number.isInteger(activity.baseDecimals) ||
    !Number.isInteger(activity.quoteDecimals) ||
    activity.baseDecimals < 0 ||
    activity.quoteDecimals < 0 ||
    activity.baseDecimals > 9 ||
    activity.quoteDecimals > 9
  )
    return []
  return activity.events
    .filter(
      (event) =>
        (event.finality === 'confirmed' || event.finality === 'finalized') &&
        Number.isSafeInteger(event.slot) &&
        event.slot >= 0 &&
        /^[1-9]\d{0,19}$/.test(event.baseAmount) &&
        /^[1-9]\d{0,19}$/.test(event.quoteAmount),
    )
    .sort((a, b) => a.slot - b.slot)
    .map((event) => ({
      ...event,
      price:
        (Number(event.quoteAmount) / Number(event.baseAmount)) *
        10 ** (activity.baseDecimals - activity.quoteDecimals),
    }))
}
