import { displayAtomic } from './amounts'

export type InvestmentPoint = {
  signature: string
  slot: number
  kind: 'buy' | 'sell'
  quoteAmount: string
  netQuoteAmount: string
}
export type InvestmentActivity = {
  pool: {
    available: boolean
    amount: string | null
    decimals: number
    metric: 'dbc-quote-reserve'
    label: string
    status: string | null
    slot: number | null
    observedAt: string | null
    stale: boolean
    reason?: string
  }
  investmentHistory: {
    source: 'clout-transactions'
    coverage: 'latest-100-trades'
    baseline: 'window-start-zero'
    points: InvestmentPoint[]
    buyVolume: string
    sellVolume: string
    netQuoteAmount: string
  }
  quoteDecimals: number
}

export function signedInvestmentAmount(amount: string, decimals: number) {
  const value = BigInt(amount)
  return `${value < 0n ? '−' : ''}${displayAtomic((value < 0n ? -value : value).toString(), decimals, decimals)}`
}

/** Normalize integer cash flows only for drawing; amounts remain exact in labels. */
export function investmentCoordinates(points: readonly InvestmentPoint[]) {
  if (
    points.some(
      (point, index) =>
        !/^-?(0|[1-9]\d{0,39})$/.test(point.netQuoteAmount) ||
        !Number.isSafeInteger(point.slot) ||
        point.slot < 0 ||
        (index > 0 && point.slot < points[index - 1].slot),
    )
  )
    return null
  const values = points.map((point) => BigInt(point.netQuoteAmount))
  const low = values.reduce((min, value) => (value < min ? value : min), values[0] ?? 0n)
  const high = values.reduce((max, value) => (value > max ? value : max), values[0] ?? 0n)
  return {
    low: low.toString(),
    high: high.toString(),
    points: points.map((point, index) => ({
      x: points.length === 1 ? 150 : 8 + (index / (points.length - 1)) * 284,
      y: high === low ? 53 : 94 - Number(((values[index] - low) * 8200n) / (high - low)) / 100,
    })),
  }
}
