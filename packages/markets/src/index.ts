export * from './types.js'
export * from './validation.js'
export { MarketService, MemoryQuoteStore } from './service.js'
export { MeteoraMarketAdapter } from './meteora.js'
export * from './rewards.js'
export * from './faucet.js'

import { MarketService } from './service.js'
import { MeteoraMarketAdapter } from './meteora.js'
import type { MarketServiceConfig, QuoteStore } from './types.js'

export function createMarketService(
  config: MarketServiceConfig,
  options: { store?: QuoteStore } = {},
): MarketService {
  return new MarketService(new MeteoraMarketAdapter(config), {
    store: options.store,
    quoteTtlMs: config.quoteTtlMs,
    maxSlippageBps: config.maxSlippageBps,
  })
}
