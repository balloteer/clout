/** Bounded, deterministic devnet demo actions. Sells spend a fraction of that demo wallet's own position. */
export type DemoAction =
  | { side: 'buy'; walletIndex: number; amountIn: string }
  | { side: 'sell'; walletIndex: number; divisor: number }
export function demoActions(marketIndex: number): DemoAction[] {
  if (!Number.isInteger(marketIndex) || marketIndex < 0 || marketIndex >= 12)
    throw new Error('Demo activity supports at most twelve selected markets.')
  const buy = (walletIndex: number, amount: number): DemoAction => ({
    side: 'buy',
    walletIndex,
    amountIn: String(amount * 1_000_000),
  })
  if (marketIndex < 6)
    return [
      buy(0, 18 + marketIndex * 3),
      buy(1, 32 + marketIndex * 2),
      buy(2, 25 + marketIndex * 4),
      { side: 'sell', walletIndex: 0, divisor: 4 },
      buy(3, 42 + marketIndex * 3),
      buy(0, 27 + marketIndex * 2),
      { side: 'sell', walletIndex: 1, divisor: 3 },
      buy(2, 55 + marketIndex * 4),
    ]
  return [
    buy(0, 25 + marketIndex * 3),
    buy(1, 45 + marketIndex * 2),
    { side: 'sell', walletIndex: 0, divisor: 4 },
    buy(2, 35 + marketIndex * 2),
  ]
}
export function demoPlan(postIds: readonly string[]) {
  if (
    !postIds.length ||
    postIds.length > 12 ||
    new Set(postIds).size !== postIds.length ||
    postIds.some((id) => !/^[a-zA-Z0-9-]{1,100}$/.test(id))
  )
    throw new Error('Choose one to twelve distinct canonical post IDs.')
  const markets = postIds.map((postId, index) => ({ postId, actions: demoActions(index) }))
  const grossBuyUnits = markets
    .flatMap((m) => m.actions)
    .reduce((sum, action) => sum + (action.side === 'buy' ? BigInt(action.amountIn) : 0n), 0n)
  if (grossBuyUnits > 4_000_000_000n) throw new Error('Demo quote budget exceeded.')
  for (const market of markets) {
    const gross = market.actions.reduce((sum, a) => sum + (a.side === 'buy' ? BigInt(a.amountIn) : 0n), 0n)
    if (gross >= 400_000_000n) throw new Error('Per-market demo budget exceeded.')
  }
  return {
    version: 1,
    network: 'devnet' as const,
    markets,
    grossBuyUnits: grossBuyUnits.toString(),
    maxReserveUnits: '500000000',
    slippageBps: 100,
    maxFundingUnits: '4000000000',
  }
}
