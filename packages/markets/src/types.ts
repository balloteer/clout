export type MarketRoute = 'dbc' | 'damm-v2'
export type MarketStatus = MarketRoute | 'migration-required' | 'migration-pending'
export type TradeSide = 'buy' | 'sell'

export interface MarketReference {
  postId: string
  baseMint: string
  dbcPool: string
}

export interface MarketSnapshot extends MarketReference {
  status: MarketStatus
  pool: string
  creator: string
  config: string
  quoteMint: string
  baseDecimals: number
  quoteDecimals: number
  quoteReserve: string
  migrationThreshold: string
  progressBps: number
  slot: number
}

export interface QuoteRequest {
  market: MarketReference
  owner: string
  side: TradeSide
  /** Integer smallest units: quote-token units for buys; post-token units for sells. */
  amountIn: string
  slippageBps: number
}

export interface ChainQuote {
  market: MarketSnapshot
  route: MarketRoute
  inputMint: string
  outputMint: string
  inputDecimals: number
  outputDecimals: number
  amountIn: string
  expectedAmountOut: string
  minimumAmountOut: string
  feeAmount: string
  feeMint: string
  priceImpactPercent: string | null
}

export interface TradeQuote extends ChainQuote {
  id: string
  owner: string
  side: TradeSide
  slippageBps: number
  createdAt: string
  expiresAt: string
  cluster: 'devnet'
  quoteTokenLabel: 'Test SKR'
}

export interface TransactionEnvelope {
  transactionBase64: string
  /** Exact message binding used for confirmation; persist this alongside the intent. */
  messageBase64: string
  blockhash: string
  lastValidBlockHeight: number
  owner: string
  cluster: 'devnet'
  simulation: { unitsConsumed: number | null; slot: number }
}

export interface BuiltTrade extends TransactionEnvelope {
  id: string
  quoteId: string
  quote: TradeQuote
}

export interface LaunchRequest {
  postId: string
  creator: string
  name: string
  symbol: string
  /** HTTPS JSON containing image, description and the canonical post link. */
  metadataUri: string
}

export interface BuiltLaunch extends TransactionEnvelope {
  market: MarketReference
  metadataUri: string
}

export interface TipRequest {
  owner: string
  recipient: string
  amountIn: string
}

export interface BuiltTip extends TransactionEnvelope {
  recipient: string
  quoteMint: string
  quoteDecimals: number
  amountIn: string
}

export interface ConfigRequest {
  payer: string
  feeClaimer: string
  leftoverReceiver: string
  /** Whole test SKR needed to graduate; small devnet value is explicit. */
  migrationThresholdTokens: number
}

export interface BuiltConfig extends TransactionEnvelope {
  configAddress: string
  parameters: {
    quoteMint: string
    quoteDecimals: number
    postDecimals: 6
    postSupplyTokens: 1000000000
    tradingFeeBps: 100
    creatorTradingFeePercentage: 50
    migratedTradingFeeBps: 100
    migrationThresholdTokens: number
  }
}

export interface BuiltMigration extends TransactionEnvelope {
  phase: 'create-locker' | 'migrate'
  market: MarketReference
  successorPool: string
}

export type Reconciliation =
  | { status: 'pending' | 'expired'; signature: string }
  | { status: 'failed'; signature: string; error: unknown }
  | {
      status: 'confirmed'
      signature: string
      slot: number
      blockTime: number | null
      feeLamports: string
      tokenDeltas: Record<string, string>
    }

/** Infrastructure boundary: domain code never exposes web3.js or SDK classes. */
export interface MarketAdapter {
  inspectMarket(market: MarketReference): Promise<MarketSnapshot>
  quote(request: QuoteRequest): Promise<ChainQuote>
  buildTrade(quote: TradeQuote): Promise<TransactionEnvelope>
  buildLaunch(request: LaunchRequest): Promise<BuiltLaunch>
  buildTip(request: TipRequest): Promise<BuiltTip>
  buildConfig(request: ConfigRequest): Promise<BuiltConfig>
  buildClaim(request: { market: MarketReference; creator: string }): Promise<TransactionEnvelope[]>
  buildMigration(request: { market: MarketReference; payer: string }): Promise<BuiltMigration>
  reconcile(request: { signature: string; transaction: TransactionEnvelope }): Promise<Reconciliation>
}

/** Persist intents in the API database; never accept an envelope supplied by a client for reconciliation. */
export interface QuoteStore {
  get(id: string): Promise<TradeQuote | undefined>
  set(quote: TradeQuote): Promise<void>
}

export interface MarketServiceConfig {
  cluster: 'devnet'
  rpcUrl: string
  /** A separately provisioned devnet test token; never the mainnet SKR address. */
  quoteMint: string
  quoteDecimals?: number
  dbcConfigAddress?: string
  quoteTtlMs?: number
  maxSlippageBps?: number
  priorityFeeMicroLamports?: number
}
