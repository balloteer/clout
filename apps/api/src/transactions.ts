import type { Connection } from '@solana/web3.js'
import type { BuiltLaunch, BuiltTrade, MarketService, TransactionEnvelope } from '@clout/markets'
import type { Repository, TransactionIntent } from './domain.js'
import { isDemoTrade } from './demo-activity.js'

export async function reconcileIntent(
  repository: Repository,
  markets: MarketService,
  intent: TransactionIntent,
  signature: string,
  chain?: Connection,
) {
  const result =
    intent.kind === 'trade'
      ? await markets.reconcileTrade({ signature, trade: intent.envelope as unknown as BuiltTrade })
      : await markets.reconcile({ signature, transaction: intent.envelope as unknown as TransactionEnvelope })
  await repository.updateIntent(intent.id, result.status, signature)
  if (result.status === 'failed' || result.status === 'expired')
    await repository.reconcile(signature, 'dropped')
  if (result.status !== 'confirmed') return result
  if (intent.kind === 'launch')
    await repository.attachMarket(intent.postId, (intent.envelope as unknown as BuiltLaunch).market)
  if (intent.kind === 'trade') {
    const built = intent.envelope as unknown as BuiltTrade
    const base = BigInt(result.tokenDeltas[built.quote.market.baseMint] ?? '0')
    const quote = BigInt(result.tokenDeltas[built.quote.market.quoteMint] ?? '0')
    if (base !== 0n && quote !== 0n)
      await repository.ingest(
        [
          {
            signature,
            instructionPath: 'verified-intent',
            slot: result.slot,
            wallet: intent.wallet,
            postId: intent.postId,
            kind: base > 0n ? 'buy' : 'sell',
            baseAmount: (base < 0n ? -base : base).toString(),
            quoteAmount: (quote < 0n ? -quote : quote).toString(),
            finality: 'confirmed',
            ...(isDemoTrade(intent) ? { demoActivity: true } : {}),
          },
        ],
        { source: 'wallet-intents', signature, slot: result.slot },
      )
  }
  if (chain) {
    const status = (await chain.getSignatureStatuses([signature], { searchTransactionHistory: true }))
      .value[0]
    if (status && !status.err && status.confirmationStatus === 'finalized') {
      await repository.reconcile(signature, 'finalized')
      await repository.updateIntent(intent.id, 'finalized', signature)
    }
  }
  return result
}

/** Restart-safe polling of persisted signatures; never builds, signs or sends another transaction. */
export async function reconcilePending(repository: Repository, markets: MarketService, chain: Connection) {
  const height = await chain.getBlockHeight('confirmed')
  const results = await Promise.allSettled(
    (await repository.listUnsettledIntents()).map(async (intent) => {
      if (intent.signature) return reconcileIntent(repository, markets, intent, intent.signature, chain)
      if (height > Number(intent.envelope.lastValidBlockHeight))
        await repository.updateIntent(intent.id, 'expired', null)
      return undefined
    }),
  )
  return { checked: results.length, failed: results.filter((result) => result.status === 'rejected').length }
}
