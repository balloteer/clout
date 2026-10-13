/** SDK boundary for legacy web3.js classes; these remain isolated in @clout/markets. */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  Message,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  type Signer,
} from '@solana/web3.js'
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token'
import BN from 'bn.js'
import bs58 from 'bs58'
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveClient,
  DynamicBondingCurveIdl,
  DammV2DynamicFeeMode,
  LOCKER_PROGRAM_ID,
  METAPLEX_PROGRAM_ID,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  SwapMode as DbcSwapMode,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurve,
  deriveBaseKeyForLocker,
  deriveDammV2PoolAddress,
  deriveDbcPoolAddress,
  deriveEscrow,
  type PoolConfig,
  type VirtualPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CP_AMM_PROGRAM_ID, CpAmm, CpAmmIdl, SwapMode as DammSwapMode } from '@meteora-ag/cp-amm-sdk'
import type {
  BuiltConfig,
  BuiltLaunch,
  BuiltMigration,
  BuiltTip,
  ChainQuote,
  ConfigRequest,
  LaunchRequest,
  MarketAdapter,
  MarketReference,
  MarketServiceConfig,
  MarketSnapshot,
  QuoteRequest,
  Reconciliation,
  TradeQuote,
  TipRequest,
  TransactionEnvelope,
} from './types.js'
import {
  DEVNET_GENESIS_HASH,
  MarketError,
  SKR_DECIMALS,
  SKR_MAINNET_MINT,
  decimals,
  marketStatus,
  minOutput,
  progressBps,
  units,
  validateMetadata,
  validateSlippage,
} from './validation.js'

const MAX_PRIORITY_FEE_MICROLAMPORTS = 100_000n

function boundTransactionMessage(actual: { serialize(): Uint8Array }, expectedBase64: string) {
  const actualBase64 = Buffer.from(actual.serialize()).toString('base64')
  if (actualBase64 === expectedBase64) return true
  // Seeker's built-in wallet may replace the compute-unit price when it signs.
  // Permit only that bounded fee field; all accounts, other instruction bytes,
  // the payer and the blockhash remain bound to the persisted intent.
  if (!(actual instanceof Message)) return false
  let expected: Message
  try {
    expected = Message.from(Buffer.from(expectedBase64, 'base64'))
  } catch {
    return false
  }
  if (
    actual.recentBlockhash !== expected.recentBlockhash ||
    actual.header.numRequiredSignatures !== expected.header.numRequiredSignatures ||
    actual.header.numReadonlySignedAccounts !== expected.header.numReadonlySignedAccounts ||
    actual.header.numReadonlyUnsignedAccounts !== expected.header.numReadonlyUnsignedAccounts ||
    actual.accountKeys.length !== expected.accountKeys.length ||
    actual.instructions.length !== expected.instructions.length ||
    actual.accountKeys.some((address, index) => !address.equals(expected.accountKeys[index]))
  )
    return false
  return actual.instructions.every((instruction, index) => {
    const persisted = expected.instructions[index]
    if (
      !persisted ||
      instruction.programIdIndex !== persisted.programIdIndex ||
      instruction.accounts.length !== persisted.accounts.length ||
      instruction.accounts.some((account, accountIndex) => account !== persisted.accounts[accountIndex])
    )
      return false
    if (instruction.data === persisted.data) return true
    if (!actual.accountKeys[instruction.programIdIndex]?.equals(ComputeBudgetProgram.programId)) return false
    const signedData = Buffer.from(bs58.decode(instruction.data))
    const persistedData = Buffer.from(bs58.decode(persisted.data))
    return (
      signedData.length === 9 &&
      persistedData.length === 9 &&
      signedData[0] === 3 &&
      persistedData[0] === 3 &&
      signedData.readBigUInt64LE(1) <= MAX_PRIORITY_FEE_MICROLAMPORTS
    )
  })
}

function key(value: string): PublicKey {
  try {
    return new PublicKey(value)
  } catch {
    throw new MarketError('INVALID_ADDRESS', 'Invalid Solana address.')
  }
}

function wallet(value: string): PublicKey {
  const address = key(value)
  if (!PublicKey.isOnCurve(address.toBytes()))
    throw new MarketError('INVALID_WALLET', 'Wallet must be a signing public key.')
  return address
}

function required<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new MarketError('ACCOUNT_NOT_FOUND', message)
  return value
}

function discriminator<const Accounts extends readonly { name: string; discriminator: readonly number[] }[]>(
  idl: { accounts: Accounts },
  name: NoInfer<Accounts[number]['name']>,
): Buffer {
  return Buffer.from(
    required(
      idl.accounts.find((account) => account.name === name),
      `SDK account type ${name} is missing.`,
    ).discriminator,
  )
}

export class MeteoraMarketAdapter implements MarketAdapter {
  private readonly connection: Connection
  private readonly dbc: DynamicBondingCurveClient
  private readonly damm: CpAmm
  private readonly quoteMint: PublicKey
  private readonly quoteDecimals: number
  private readonly configAddress?: PublicKey
  private readonly priorityFee: number

  constructor(config: MarketServiceConfig) {
    if (config.cluster !== 'devnet')
      throw new MarketError('UNSUPPORTED_CLUSTER', 'This build permits devnet transactions only.')
    let url: URL
    try {
      url = new URL(config.rpcUrl)
    } catch {
      throw new MarketError('INVALID_CONFIG', 'A devnet HTTPS RPC URL is required.')
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new MarketError(
        'INVALID_CONFIG',
        'A devnet HTTPS RPC URL without embedded credentials is required.',
      )
    }
    this.quoteMint = key(config.quoteMint)
    if (
      this.quoteMint.toBase58() === SKR_MAINNET_MINT ||
      this.quoteMint.toBase58() === 'So11111111111111111111111111111111111111112'
    ) {
      throw new MarketError(
        'INVALID_QUOTE_MINT',
        'Configure a separate devnet Test SKR mint. SOL is only for network fees.',
      )
    }
    this.quoteDecimals = decimals(config.quoteDecimals ?? SKR_DECIMALS)
    this.configAddress = config.dbcConfigAddress ? key(config.dbcConfigAddress) : undefined
    this.priorityFee = config.priorityFeeMicroLamports ?? 1_000
    if (!Number.isInteger(this.priorityFee) || this.priorityFee < 0 || this.priorityFee > 100_000) {
      throw new MarketError(
        'INVALID_CONFIG',
        'Priority fee must be 0–100000 micro-lamports per compute unit.',
      )
    }
    this.connection = new Connection(config.rpcUrl, 'confirmed')
    this.dbc = new DynamicBondingCurveClient(this.connection, 'confirmed')
    this.damm = new CpAmm(this.connection)
  }

  private async guardCluster(): Promise<void> {
    if ((await this.connection.getGenesisHash()) !== DEVNET_GENESIS_HASH) {
      throw new MarketError(
        'WRONG_NETWORK',
        'RPC is not Solana devnet; transaction construction was refused.',
      )
    }
  }

  private async assertAccount(
    address: PublicKey,
    owner: PublicKey,
    expectedDiscriminator?: Buffer,
  ): Promise<void> {
    const account = required(
      await this.connection.getAccountInfo(address, 'confirmed'),
      'Required chain account is missing.',
    )
    if (
      !account.owner.equals(owner) ||
      (expectedDiscriminator &&
        !account.data.subarray(0, expectedDiscriminator.length).equals(expectedDiscriminator))
    ) {
      throw new MarketError(
        'INVALID_ACCOUNT',
        'Chain account owner or discriminator does not match the expected program.',
      )
    }
  }

  private async mintDecimals(address: PublicKey): Promise<number> {
    // SKR and post-position mints are conventional SPL tokens. Other token programs fail closed.
    const mint = await getMint(this.connection, address, 'confirmed', TOKEN_PROGRAM_ID)
    if (!mint.isInitialized) throw new MarketError('INVALID_MINT', 'Token mint is not initialized.')
    return decimals(mint.decimals)
  }

  private async readConfig(address: PublicKey): Promise<PoolConfig> {
    if (this.configAddress && !this.configAddress.equals(address)) {
      throw new MarketError('WRONG_CONFIG', 'Market does not use the configured Clout curve.')
    }
    await this.assertAccount(
      address,
      DYNAMIC_BONDING_CURVE_PROGRAM_ID,
      discriminator(DynamicBondingCurveIdl, 'PoolConfig'),
    )
    const config = required(await this.dbc.state.getPoolConfig(address), 'DBC configuration is missing.')
    if (
      !config.quoteMint.equals(this.quoteMint) ||
      config.quoteTokenFlag !== 0 ||
      config.tokenType !== TokenType.SPLToken
    ) {
      throw new MarketError(
        'WRONG_QUOTE_TOKEN',
        'Pool must use the configured Test SKR mint and SPL post tokens.',
      )
    }
    if (config.migrationOption !== MigrationOption.MET_DAMM_V2) {
      throw new MarketError('UNSUPPORTED_MIGRATION', 'Clout supports DAMM v2 graduation only.')
    }
    if ((await this.mintDecimals(this.quoteMint)) !== this.quoteDecimals) {
      throw new MarketError('WRONG_DECIMALS', 'Configured Test SKR decimals do not match the mint.')
    }
    return config
  }

  private async readMarket(market: MarketReference): Promise<{
    snapshot: MarketSnapshot
    virtualPool: VirtualPool
    config: PoolConfig
  }> {
    await this.guardCluster()
    if (!market.postId || market.postId.length > 128)
      throw new MarketError('INVALID_POST', 'A post identifier is required.')
    const poolKey = key(market.dbcPool)
    await this.assertAccount(
      poolKey,
      DYNAMIC_BONDING_CURVE_PROGRAM_ID,
      discriminator(DynamicBondingCurveIdl, 'VirtualPool'),
    )
    const virtualPool = required(await this.dbc.state.getPool(poolKey), 'DBC pool is missing.')
    const pool = virtualPool.poolState
    if (!pool.baseMint.equals(key(market.baseMint)))
      throw new MarketError('WRONG_MARKET', 'Pool does not belong to this post mint.')
    const config = await this.readConfig(pool.config)
    if (!deriveDbcPoolAddress(this.quoteMint, pool.baseMint, pool.config).equals(poolKey)) {
      throw new MarketError('INVALID_POOL', 'DBC pool is not the canonical pool address.')
    }
    const dammConfig = required(
      DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption],
      'Unknown migration fee configuration.',
    )
    const successor = deriveDammV2PoolAddress(dammConfig, pool.baseMint, this.quoteMint)
    const successorAccount = pool.isMigrated
      ? await this.connection.getAccountInfo(successor, 'confirmed')
      : null
    if (
      successorAccount &&
      (!successorAccount.owner.equals(CP_AMM_PROGRAM_ID) ||
        !successorAccount.data.subarray(0, 8).equals(discriminator(CpAmmIdl, 'Pool')))
    ) {
      throw new MarketError('INVALID_ACCOUNT', 'Graduated pool has an unexpected program or discriminator.')
    }
    const quoteReserve = pool.quoteReserve.toString()
    const migrationThreshold = config.migrationQuoteThreshold.toString()
    const status = marketStatus(
      pool.isMigrated !== 0,
      successorAccount !== null,
      quoteReserve,
      migrationThreshold,
    )
    return {
      virtualPool,
      config,
      snapshot: {
        ...market,
        status,
        pool: status === 'damm-v2' ? successor.toBase58() : market.dbcPool,
        creator: pool.creator.toBase58(),
        config: pool.config.toBase58(),
        quoteMint: this.quoteMint.toBase58(),
        baseDecimals: await this.mintDecimals(pool.baseMint),
        quoteDecimals: this.quoteDecimals,
        quoteReserve,
        migrationThreshold,
        progressBps: pool.isMigrated ? 10_000 : progressBps(quoteReserve, migrationThreshold),
        slot: await this.connection.getSlot('confirmed'),
      },
    }
  }

  async inspectMarket(market: MarketReference): Promise<MarketSnapshot> {
    return (await this.readMarket(market)).snapshot
  }

  private async point(activationType: number): Promise<BN> {
    const slot = await this.connection.getSlot('confirmed')
    if (activationType === 0) return new BN(slot)
    if (activationType !== 1) throw new MarketError('INVALID_ACTIVATION', 'Unknown market activation type.')
    return new BN(required(await this.connection.getBlockTime(slot), 'RPC block time is unavailable.'))
  }

  async quote(request: QuoteRequest): Promise<ChainQuote> {
    wallet(request.owner)
    units(request.amountIn)
    validateSlippage(request.slippageBps)
    if (request.side !== 'buy' && request.side !== 'sell')
      throw new MarketError('INVALID_SIDE', 'Choose buy or sell.')
    const { snapshot, virtualPool, config } = await this.readMarket(request.market)
    if (snapshot.status !== 'dbc' && snapshot.status !== 'damm-v2') {
      throw new MarketError(
        'MIGRATION_PENDING',
        'This market is graduating. Trading resumes after DAMM v2 migration confirms.',
      )
    }
    const buy = request.side === 'buy'
    const inputMint = buy ? snapshot.quoteMint : snapshot.baseMint
    const outputMint = buy ? snapshot.baseMint : snapshot.quoteMint
    const shared = {
      market: snapshot,
      route: snapshot.status,
      inputMint,
      outputMint,
      inputDecimals: buy ? snapshot.quoteDecimals : snapshot.baseDecimals,
      outputDecimals: buy ? snapshot.baseDecimals : snapshot.quoteDecimals,
      amountIn: request.amountIn,
    }
    if (snapshot.status === 'dbc') {
      const quoted = this.dbc.pool.swapQuote2({
        virtualPool,
        config,
        swapBaseForQuote: !buy,
        amountIn: new BN(request.amountIn),
        swapMode: DbcSwapMode.ExactIn,
        slippageBps: request.slippageBps,
        hasReferral: false,
        eligibleForFirstSwapWithMinFee: false,
        currentPoint: await this.point(config.activationType),
      })
      if (!quoted.amountLeft.isZero())
        throw new MarketError('PARTIAL_FILL', 'This trade crosses graduation; choose a smaller amount.')
      return {
        ...shared,
        expectedAmountOut: quoted.outputAmount.toString(),
        minimumAmountOut: minOutput(quoted.outputAmount.toString(), request.slippageBps),
        feeAmount: quoted.tradingFee.add(quoted.protocolFee).toString(),
        feeMint: config.collectFeeMode === CollectFeeMode.QuoteToken ? snapshot.quoteMint : outputMint,
        priceImpactPercent: null,
      }
    }
    const pool = await this.dammPool(snapshot)
    const quoted = this.damm.getQuote2({
      inputTokenMint: key(inputMint),
      amountIn: new BN(request.amountIn),
      swapMode: DammSwapMode.ExactIn,
      slippage: request.slippageBps / 100,
      poolState: pool,
      currentPoint: await this.point(pool.activationType),
      hasReferral: false,
      tokenADecimal: pool.tokenAMint.equals(key(snapshot.baseMint))
        ? snapshot.baseDecimals
        : snapshot.quoteDecimals,
      tokenBDecimal: pool.tokenBMint.equals(key(snapshot.baseMint))
        ? snapshot.baseDecimals
        : snapshot.quoteDecimals,
    })
    if (!quoted.amountLeft.isZero())
      throw new MarketError('PARTIAL_FILL', 'The market cannot fill the complete input.')
    return {
      ...shared,
      expectedAmountOut: quoted.outputAmount.toString(),
      minimumAmountOut: minOutput(quoted.outputAmount.toString(), request.slippageBps),
      feeAmount: quoted.claimingFee.add(quoted.protocolFee).add(quoted.compoundingFee).toString(),
      feeMint: pool.collectFeeMode === 0 ? outputMint : pool.tokenBMint.toBase58(),
      priceImpactPercent: quoted.priceImpact.toString(),
    }
  }

  private async dammPool(market: MarketSnapshot) {
    await this.assertAccount(key(market.pool), CP_AMM_PROGRAM_ID, discriminator(CpAmmIdl, 'Pool'))
    const pool = await this.damm.fetchPoolState(key(market.pool))
    const expected = new Set([market.baseMint, market.quoteMint])
    if (
      !expected.has(pool.tokenAMint.toBase58()) ||
      !expected.has(pool.tokenBMint.toBase58()) ||
      pool.tokenAMint.equals(pool.tokenBMint) ||
      pool.tokenAFlag !== 0 ||
      pool.tokenBFlag !== 0
    ) {
      throw new MarketError('WRONG_MARKET', 'Graduated pool mints do not match the post market.')
    }
    return pool
  }

  async buildTrade(quote: TradeQuote): Promise<TransactionEnvelope> {
    const owner = wallet(quote.owner)
    units(quote.amountIn)
    units(quote.minimumAmountOut)
    const snapshot = await this.inspectMarket(quote.market)
    if (snapshot.status !== quote.route || snapshot.pool !== quote.market.pool) {
      throw new MarketError('MARKET_MIGRATED', 'Request a fresh quote for the graduated market.')
    }
    let transaction: Transaction
    if (quote.route === 'dbc') {
      transaction = await this.dbc.pool.swap2({
        owner,
        pool: key(snapshot.pool),
        amountIn: new BN(quote.amountIn),
        minimumAmountOut: new BN(quote.minimumAmountOut),
        swapBaseForQuote: quote.side === 'sell',
        referralTokenAccount: null,
        swapMode: DbcSwapMode.ExactIn,
      })
    } else {
      const pool = await this.dammPool(snapshot)
      transaction = await this.damm.swap2({
        payer: owner,
        pool: key(snapshot.pool),
        inputTokenMint: key(quote.inputMint),
        outputTokenMint: key(quote.outputMint),
        amountIn: new BN(quote.amountIn),
        minimumAmountOut: new BN(quote.minimumAmountOut),
        tokenAMint: pool.tokenAMint,
        tokenBMint: pool.tokenBMint,
        tokenAVault: pool.tokenAVault,
        tokenBVault: pool.tokenBVault,
        tokenAProgram: TOKEN_PROGRAM_ID,
        tokenBProgram: TOKEN_PROGRAM_ID,
        referralTokenAccount: null,
        swapMode: DammSwapMode.ExactIn,
        poolState: pool,
      })
    }
    return this.envelope(transaction, owner)
  }

  async buildConfig(request: ConfigRequest): Promise<BuiltConfig> {
    await this.guardCluster()
    const payer = wallet(request.payer)
    if (
      !Number.isSafeInteger(request.migrationThresholdTokens) ||
      request.migrationThresholdTokens < 1 ||
      request.migrationThresholdTokens > 1_000_000
    ) {
      throw new MarketError('INVALID_CONFIG', 'Use a whole graduation threshold from 1 to 1000000 Test SKR.')
    }
    if ((await this.mintDecimals(this.quoteMint)) !== this.quoteDecimals)
      throw new MarketError('WRONG_DECIMALS', 'Test SKR mint decimals mismatch.')
    const config = Keypair.generate()
    const curve = buildCurve({
      token: {
        tokenType: TokenType.SPLToken,
        tokenBaseDecimal: TokenDecimal.SIX,
        tokenQuoteDecimal: this.quoteDecimals,
        tokenAuthorityOption: TokenAuthorityOption.Immutable,
        totalTokenSupply: 1_000_000_000,
        leftover: 0,
      },
      fee: {
        baseFeeParams: {
          baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
          feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 },
        },
        dynamicFeeEnabled: false,
        collectFeeMode: CollectFeeMode.QuoteToken,
        creatorTradingFeePercentage: 50,
        poolCreationFee: 0,
        enableFirstSwapWithMinFee: false,
      },
      migration: {
        migrationOption: MigrationOption.MET_DAMM_V2,
        migrationFeeOption: MigrationFeeOption.Customizable,
        migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
        migratedPoolFee: {
          collectFeeMode: MigratedCollectFeeMode.QuoteToken,
          dynamicFee: DammV2DynamicFeeMode.Disabled,
          poolFeeBps: 100,
        },
      },
      liquidityDistribution: {
        partnerLiquidityPercentage: 0,
        partnerPermanentLockedLiquidityPercentage: 50,
        creatorLiquidityPercentage: 0,
        creatorPermanentLockedLiquidityPercentage: 50,
      },
      lockedVesting: {
        totalLockedVestingAmount: 0,
        numberOfVestingPeriod: 0,
        cliffUnlockAmount: 0,
        totalVestingDuration: 0,
        cliffDurationFromMigrationTime: 0,
      },
      activationType: ActivationType.Timestamp,
      percentageSupplyOnMigration: 20,
      migrationQuoteThreshold: request.migrationThresholdTokens,
    })
    const transaction = await this.dbc.partner.createConfig({
      ...curve,
      config: config.publicKey,
      payer,
      feeClaimer: key(request.feeClaimer),
      leftoverReceiver: key(request.leftoverReceiver),
      quoteMint: this.quoteMint,
    })
    return {
      ...(await this.envelope(transaction, payer, [config])),
      configAddress: config.publicKey.toBase58(),
      parameters: {
        quoteMint: this.quoteMint.toBase58(),
        quoteDecimals: this.quoteDecimals,
        postDecimals: 6,
        postSupplyTokens: 1000000000,
        tradingFeeBps: 100,
        creatorTradingFeePercentage: 50,
        migratedTradingFeeBps: 100,
        migrationThresholdTokens: request.migrationThresholdTokens,
      },
    }
  }

  async buildLaunch(request: LaunchRequest): Promise<BuiltLaunch> {
    await this.guardCluster()
    validateMetadata(request.name, request.symbol, request.metadataUri)
    if (!request.postId || request.postId.length > 128)
      throw new MarketError('INVALID_POST', 'A post identifier is required.')
    const creator = wallet(request.creator)
    const configAddress = required(
      this.configAddress,
      'Configure the shared Clout DBC configuration before launch.',
    )
    const config = await this.readConfig(configAddress)
    if (config.fixedTokenSupplyFlag !== 1 || config.tokenUpdateAuthority !== TokenAuthorityOption.Immutable) {
      throw new MarketError(
        'INVALID_CONFIG',
        'Post markets require fixed supply and immutable token authority.',
      )
    }
    const baseFee = config.poolFees.baseFee
    if (
      config.tokenDecimal !== 6 ||
      config.preMigrationTokenSupply.toString() !== '1000000000000000' ||
      config.postMigrationTokenSupply.toString() !== '1000000000000000' ||
      baseFee.cliffFeeNumerator.toString() !== '10000000' ||
      baseFee.firstFactor !== 0 ||
      !baseFee.secondFactor.isZero() ||
      !baseFee.thirdFactor.isZero() ||
      config.poolFees.dynamicFee.initialized !== 0 ||
      config.creatorTradingFeePercentage !== 50 ||
      config.collectFeeMode !== CollectFeeMode.QuoteToken ||
      config.migrationFeeOption !== MigrationFeeOption.Customizable ||
      config.migratedPoolFeeBps !== 100 ||
      config.migratedDynamicFee !== DammV2DynamicFeeMode.Disabled ||
      config.migratedCollectFeeMode !== MigratedCollectFeeMode.QuoteToken
    ) {
      throw new MarketError(
        'INVALID_CONFIG',
        'Shared configuration does not match Clout fixed-supply and 1% SKR fee policy.',
      )
    }
    const baseMint = Keypair.generate()
    const transaction = await this.dbc.creator.createPool({
      name: request.name,
      symbol: request.symbol,
      uri: request.metadataUri,
      payer: creator,
      poolCreator: creator,
      config: configAddress,
      baseMint: baseMint.publicKey,
    })
    return {
      ...(await this.envelope(transaction, creator, [baseMint])),
      metadataUri: request.metadataUri,
      market: {
        postId: request.postId,
        baseMint: baseMint.publicKey.toBase58(),
        dbcPool: deriveDbcPoolAddress(this.quoteMint, baseMint.publicKey, configAddress).toBase58(),
      },
    }
  }

  async buildTip(request: TipRequest): Promise<BuiltTip> {
    await this.guardCluster()
    const owner = wallet(request.owner)
    const recipient = wallet(request.recipient)
    const amount = units(request.amountIn)
    if (owner.equals(recipient)) throw new MarketError('INVALID_RECIPIENT', 'Choose another wallet to tip.')
    if ((await this.mintDecimals(this.quoteMint)) !== this.quoteDecimals) {
      throw new MarketError('WRONG_DECIMALS', 'Configured Test SKR decimals do not match the mint.')
    }
    const source = getAssociatedTokenAddressSync(this.quoteMint, owner)
    const destination = getAssociatedTokenAddressSync(this.quoteMint, recipient)
    const transaction = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(owner, destination, recipient, this.quoteMint),
      createTransferCheckedInstruction(
        source,
        this.quoteMint,
        destination,
        owner,
        amount,
        this.quoteDecimals,
      ),
    )
    return {
      ...(await this.envelope(transaction, owner)),
      recipient: recipient.toBase58(),
      quoteMint: this.quoteMint.toBase58(),
      quoteDecimals: this.quoteDecimals,
      amountIn: request.amountIn,
    }
  }

  async buildClaim(request: { market: MarketReference; creator: string }): Promise<TransactionEnvelope[]> {
    const creator = wallet(request.creator)
    const { snapshot, virtualPool } = await this.readMarket(request.market)
    if (snapshot.creator !== request.creator)
      throw new MarketError('WRONG_CREATOR', 'Only the recorded creator can claim creator fees.')
    const transactions: Transaction[] = []
    const state = virtualPool.poolState
    // DBC fees remain claimable after graduation; claim them as well as current DAMM position fees.
    if (!state.creatorBaseFee.isZero() || !state.creatorQuoteFee.isZero()) {
      transactions.push(
        await this.dbc.creator.claimCreatorTradingFee({
          creator,
          payer: creator,
          receiver: creator,
          pool: key(request.market.dbcPool),
          maxBaseAmount: state.creatorBaseFee,
          maxQuoteAmount: state.creatorQuoteFee,
        }),
      )
    }
    if (snapshot.status === 'damm-v2') {
      const pool = await this.dammPool(snapshot)
      const positions = await this.damm.getUserPositionByPool(key(snapshot.pool), creator)
      for (const position of positions) {
        transactions.push(
          await this.damm.claimPositionFee2({
            owner: creator,
            receiver: creator,
            pool: key(snapshot.pool),
            position: position.position,
            positionNftAccount: position.positionNftAccount,
            tokenAMint: pool.tokenAMint,
            tokenBMint: pool.tokenBMint,
            tokenAVault: pool.tokenAVault,
            tokenBVault: pool.tokenBVault,
            tokenAProgram: TOKEN_PROGRAM_ID,
            tokenBProgram: TOKEN_PROGRAM_ID,
          }),
        )
      }
    }
    const envelopes: TransactionEnvelope[] = []
    for (const transaction of transactions) envelopes.push(await this.envelope(transaction, creator))
    return envelopes
  }

  async buildMigration(request: { market: MarketReference; payer: string }): Promise<BuiltMigration> {
    const payer = wallet(request.payer)
    const { snapshot, config } = await this.readMarket(request.market)
    if (snapshot.status !== 'migration-required')
      throw new MarketError('MIGRATION_NOT_READY', 'Pool is not awaiting migration.')
    const dammConfig = required(
      DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption],
      'Unknown migration fee configuration.',
    )
    const successorPool = deriveDammV2PoolAddress(
      dammConfig,
      key(snapshot.baseMint),
      this.quoteMint,
    ).toBase58()
    const escrow = deriveEscrow(deriveBaseKeyForLocker(key(snapshot.dbcPool)))
    const vesting = config.lockedVestingConfig
    const needsLocker = !vesting.amountPerPeriod.isZero() || !vesting.cliffUnlockAmount.isZero()
    if (needsLocker && !(await this.connection.getAccountInfo(escrow, 'confirmed'))) {
      const tx = await this.dbc.migration.createLocker({ pool: key(snapshot.dbcPool), payer })
      return {
        ...(await this.envelope(tx, payer)),
        phase: 'create-locker',
        market: request.market,
        successorPool,
      }
    }
    const result = await this.dbc.migration.migrateToDammV2({
      pool: key(snapshot.dbcPool),
      dammConfig,
      payer,
    })
    return {
      ...(await this.envelope(result.transaction, payer, [
        result.firstPositionNftKeypair,
        result.secondPositionNftKeypair,
      ])),
      phase: 'migrate',
      market: request.market,
      successorPool,
    }
  }

  private async envelope(
    transaction: Transaction,
    owner: PublicKey,
    signers: Signer[] = [],
  ): Promise<TransactionEnvelope> {
    await this.guardCluster()
    const allowedPrograms = new Set(
      [
        DYNAMIC_BONDING_CURVE_PROGRAM_ID,
        CP_AMM_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
        SystemProgram.programId,
        ComputeBudgetProgram.programId,
        METAPLEX_PROGRAM_ID,
        LOCKER_PROGRAM_ID,
      ].map((address) => address.toBase58()),
    )
    if (transaction.instructions.some((ix) => !allowedPrograms.has(ix.programId.toBase58()))) {
      throw new MarketError('UNEXPECTED_PROGRAM', 'Transaction contains an unexpected program.')
    }
    const instructions = transaction.instructions.filter(
      (ix) => !ix.programId.equals(ComputeBudgetProgram.programId),
    )
    const lifetime = await this.connection.getLatestBlockhash('confirmed')
    transaction.feePayer = owner
    transaction.recentBlockhash = lifetime.blockhash
    transaction.lastValidBlockHeight = lifetime.lastValidBlockHeight
    transaction.instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.priorityFee }),
      ...instructions,
    ]
    const simulate = async () => {
      const result = await this.connection.simulateTransaction(
        new VersionedTransaction(transaction.compileMessage()),
        {
          sigVerify: false,
          commitment: 'confirmed',
        },
      )
      if (result.value.err)
        throw new MarketError(
          'SIMULATION_FAILED',
          'The transaction cannot execute in its current state.',
          result.value.err,
        )
      return result
    }
    const estimate = await simulate()
    const consumed = required(estimate.value.unitsConsumed, 'RPC did not provide compute usage.')
    transaction.instructions[0] = ComputeBudgetProgram.setComputeUnitLimit({
      units: Math.min(1_400_000, Math.ceil(consumed * 1.15) + 1_000),
    })
    const simulation = await simulate()
    if (signers.length) transaction.partialSign(...signers)
    return {
      transactionBase64: transaction
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString('base64'),
      messageBase64: transaction.serializeMessage().toString('base64'),
      owner: owner.toBase58(),
      cluster: 'devnet',
      ...lifetime,
      simulation: { unitsConsumed: simulation.value.unitsConsumed ?? null, slot: simulation.context.slot },
    }
  }

  async reconcile({
    signature,
    transaction,
  }: {
    signature: string
    transaction: TransactionEnvelope
  }): Promise<Reconciliation> {
    await this.guardCluster()
    if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature))
      throw new MarketError('INVALID_SIGNATURE', 'Invalid transaction signature.')
    if (transaction.cluster !== 'devnet')
      throw new MarketError('WRONG_NETWORK', 'Transaction intent is not a devnet intent.')
    // We build legacy/v0 transactions for the pinned SDK. web3.js accepts a numeric runtime version.
    const result = await this.connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 1 as 0,
    })
    if (!result) {
      const statuses = await this.connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true,
      })
      const status = statuses.value[0]
      if (
        status?.err &&
        (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
      ) {
        return { status: 'failed', signature, error: status.err }
      }
      if (status) return { status: 'pending', signature } // Confirmed metadata may lag; do not declare it expired.
      const height = await this.connection.getBlockHeight('confirmed')
      return { status: height > transaction.lastValidBlockHeight ? 'expired' : 'pending', signature }
    }
    if (!boundTransactionMessage(result.transaction.message, transaction.messageBase64)) {
      throw new MarketError(
        'TRANSACTION_MISMATCH',
        'Signature does not belong to the transaction built for this intent.',
      )
    }
    const meta = required(result.meta, 'Confirmed transaction metadata is not available yet.')
    if (meta.err) return { status: 'failed', signature, error: meta.err }
    const deltas: Record<string, bigint> = {}
    for (const balance of meta.preTokenBalances ?? []) {
      if (balance.owner === transaction.owner)
        deltas[balance.mint] = (deltas[balance.mint] ?? 0n) - BigInt(balance.uiTokenAmount.amount)
    }
    for (const balance of meta.postTokenBalances ?? []) {
      if (balance.owner === transaction.owner)
        deltas[balance.mint] = (deltas[balance.mint] ?? 0n) + BigInt(balance.uiTokenAmount.amount)
    }
    return {
      status: 'confirmed',
      signature,
      slot: result.slot,
      blockTime: result.blockTime ?? null,
      feeLamports: String(meta.fee),
      tokenDeltas: Object.fromEntries(
        Object.entries(deltas).map(([mint, delta]) => [mint, delta.toString()]),
      ),
    }
  }
}
