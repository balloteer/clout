import type { PositionHistory } from './domain.js'

const unsigned = (value: string) => /^(0|[1-9]\d*)$/.test(value)

export function positionPerformance(
  currentBaseAmount: string,
  currentQuoteValue: string | null,
  history?: PositionHistory,
) {
  if (!unsigned(currentBaseAmount) || (currentQuoteValue !== null && !unsigned(currentQuoteValue)))
    throw new Error('Portfolio amounts must be unsigned integers.')
  const amounts = [
    history?.boughtQuoteAmount ?? '0',
    history?.soldQuoteAmount ?? '0',
    history?.boughtBaseAmount ?? '0',
    history?.soldBaseAmount ?? '0',
  ]
  if (amounts.some((amount) => !unsigned(amount)))
    throw new Error('Portfolio history amounts must be unsigned integers.')
  const [boughtQuote, soldQuote, boughtBase, soldBase] = amounts.map(BigInt)
  const historyMatches = boughtBase - soldBase === BigInt(currentBaseAmount) && boughtQuote > 0n
  const performanceAvailable = historyMatches && currentQuoteValue !== null
  const profitLoss = performanceAvailable ? BigInt(currentQuoteValue) + soldQuote - boughtQuote : null
  return {
    boughtQuoteAmount: boughtQuote.toString(),
    soldQuoteAmount: soldQuote.toString(),
    netInvestedQuoteAmount: historyMatches ? (boughtQuote - soldQuote).toString() : null,
    backingAvailable: historyMatches,
    performanceAvailable,
    profitLossQuoteAmount: profitLoss?.toString() ?? null,
    returnBps: profitLoss === null ? null : ((profitLoss * 10_000n) / boughtQuote).toString(),
  }
}
