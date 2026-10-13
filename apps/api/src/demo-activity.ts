import type { BuiltTrade } from '@clout/markets'
import { demoActivityWallets } from '../../../packages/shared/src/demo-activity.js'
import { sampleMarkets, sampleQuoteMint } from '../../../packages/shared/src/sample-markets.js'
import type { IndexedEvent, TransactionIntent } from './domain.js'

const wallets = new Set<string>(demoActivityWallets.map((entry) => entry.wallet))
export const demoWalletLabel = (wallet: string) =>
  demoActivityWallets.find((entry) => entry.wallet === wallet)?.label

/** Only operator-published task wallets and exact registered markets can receive this label. */
export function isDemoTrade(intent: Pick<TransactionIntent, 'wallet' | 'kind' | 'postId' | 'envelope'>) {
  if (intent.kind !== 'trade' || !wallets.has(intent.wallet)) return false
  const trade = intent.envelope as unknown as BuiltTrade
  const market = sampleMarkets[intent.postId]
  return (
    !!market &&
    trade.owner === intent.wallet &&
    trade.quote?.owner === intent.wallet &&
    trade.cluster === 'devnet' &&
    trade.quote?.cluster === 'devnet' &&
    trade.quote?.market.postId === intent.postId &&
    trade.quote.market.baseMint === market.baseMint &&
    trade.quote.market.dbcPool === market.dbcPool &&
    trade.quote.market.quoteMint === sampleQuoteMint
  )
}

/** A client-provided boolean or arbitrary wallet cannot turn an event into demo provenance. */
export const isDemoActivityEvent = (event: IndexedEvent) =>
  event.demoActivity === true && wallets.has(event.wallet) && !!sampleMarkets[event.postId]
