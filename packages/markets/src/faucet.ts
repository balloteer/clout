import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js'
import {
  ACCOUNT_SIZE,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import bs58 from 'bs58'
import {
  SolanaRewardTransferAdapter,
  type PreparedRewardTransfer,
  type RewardTransferAdapter,
  type RewardTransferConfig,
  type RewardTransferStatus,
} from './rewards.js'
import { DEVNET_GENESIS_HASH, MarketError, units } from './validation.js'

export interface MockSkrFaucetConfig extends RewardTransferConfig {
  /** Absolute mint-supply ceiling in integer units, including any already minted test tokens. */
  maxSupplyIn: string
}

/** Dedicated devnet mint authority. The API must reserve campaign grants atomically before preparation. */
export class SolanaMockSkrFaucetAdapter implements RewardTransferAdapter {
  readonly treasury: string
  readonly quoteMint: string
  private readonly transport: SolanaRewardTransferAdapter
  private readonly connection: Connection
  private readonly signer: Keypair
  private readonly maximum: bigint
  private readonly maximumSupply: bigint
  private readonly quoteDecimals: number
  private readonly priorityFee: number

  constructor(config: MockSkrFaucetConfig) {
    // This also enforces the shared devnet-only endpoint/mint policy and bounded priority fee.
    this.transport = new SolanaRewardTransferAdapter(config)
    this.signer = Keypair.fromSecretKey(Uint8Array.from(config.secretKeyUint8Array))
    this.treasury = this.transport.treasury
    this.quoteMint = this.transport.quoteMint
    this.connection = new Connection(config.marketConfig.rpcUrl, 'confirmed')
    this.maximum = units(config.maxAmountIn)
    this.maximumSupply = units(config.maxSupplyIn)
    if (this.maximum > this.maximumSupply)
      throw new MarketError(
        'FAUCET_LIMIT',
        'The per-wallet grant exceeds the configured mint supply ceiling.',
      )
    this.quoteDecimals = config.marketConfig.quoteDecimals ?? 6
    this.priorityFee = config.marketConfig.priorityFeeMicroLamports ?? 1_000
  }

  async availableBalance(): Promise<string> {
    if ((await this.connection.getGenesisHash()) !== DEVNET_GENESIS_HASH)
      throw new MarketError('WRONG_NETWORK', 'Mock SKR minting requires the Solana devnet genesis hash.')
    const mint = await getMint(this.connection, new PublicKey(this.quoteMint), 'confirmed', TOKEN_PROGRAM_ID)
    if (!mint.isInitialized || mint.decimals !== this.quoteDecimals)
      throw new MarketError('WRONG_DECIMALS', 'Configured Mock SKR decimals do not match the mint.')
    if (!mint.mintAuthority?.equals(this.signer.publicKey) || mint.freezeAuthority !== null)
      throw new MarketError(
        'INVALID_MINT_AUTHORITY',
        'Mock SKR requires the configured authority and no freeze authority.',
      )
    if (mint.supply > this.maximumSupply)
      throw new MarketError('FAUCET_SUPPLY_LIMIT', 'Mock SKR supply already exceeds the configured ceiling.')
    return (this.maximumSupply - mint.supply).toString()
  }

  async validateBudget({ amountIn }: { amountIn: string }): Promise<void> {
    const amount = units(amountIn, true)
    if (amount > BigInt(await this.availableBalance()))
      throw new MarketError(
        'FAUCET_SUPPLY_LIMIT',
        'Remaining grants exceed the configured Mock SKR supply ceiling.',
      )
    // Fully allocated campaigns still verify network, mint ownership, decimals and authority.
    if (amount === 0n) return
    const [balance, rent, lifetime] = await Promise.all([
      this.connection.getBalance(this.signer.publicKey, 'confirmed'),
      this.connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, 'confirmed'),
      this.connection.getLatestBlockhash('confirmed'),
    ])
    const message = new Transaction({ feePayer: this.signer.publicKey, ...lifetime })
      .add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.priorityFee }),
      )
      .compileMessage()
    const fee = (await this.connection.getFeeForMessage(message, 'confirmed')).value
    const lamports = (value: number | null) => {
      if (value === null || !Number.isSafeInteger(value) || value < 0)
        throw new MarketError(
          'INVALID_FEE_ESTIMATE',
          'Mock SKR account rent or transaction funding could not be verified.',
        )
      return BigInt(value)
    }
    const claims = (amount + this.maximum - 1n) / this.maximum
    if (lamports(balance) < claims * (lamports(rent) + lamports(fee)))
      throw new MarketError(
        'INSUFFICIENT_TREASURY_SOL',
        'Fund the devnet authority with SOL for remaining grants and new token accounts.',
      )
  }

  async prepare({ wallet, amountIn }: { wallet: string; amountIn: string }): Promise<PreparedRewardTransfer> {
    const amount = units(amountIn)
    if (amount > this.maximum)
      throw new MarketError('FAUCET_LIMIT', 'Mock SKR grant exceeds the configured per-wallet maximum.')
    let recipient: PublicKey
    try {
      recipient = new PublicKey(wallet)
      if (!PublicKey.isOnCurve(recipient.toBytes())) throw new Error('Off-curve recipient')
    } catch {
      throw new MarketError('INVALID_WALLET', 'Mock SKR grants require a valid wallet address.')
    }
    await this.validateBudget({ amountIn })
    const mint = new PublicKey(this.quoteMint)
    const destination = getAssociatedTokenAddressSync(mint, recipient)
    const lifetime = await this.connection.getLatestBlockhash('confirmed')
    const transaction = new Transaction({ feePayer: this.signer.publicKey, ...lifetime }).add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.priorityFee }),
      createAssociatedTokenAccountIdempotentInstruction(this.signer.publicKey, destination, recipient, mint),
      createMintToCheckedInstruction(mint, destination, this.signer.publicKey, amount, this.quoteDecimals),
    )
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
          'The Mock SKR grant cannot execute in its current state.',
          result.value.err,
        )
      return result.value.unitsConsumed
    }
    const consumed = await simulate()
    if (consumed === undefined || !Number.isSafeInteger(consumed) || consumed <= 0)
      throw new MarketError(
        'SIMULATION_FAILED',
        'The RPC did not provide valid compute usage for this grant.',
      )
    transaction.instructions[0] = ComputeBudgetProgram.setComputeUnitLimit({
      units: Math.min(1_400_000, Math.ceil(consumed * 1.15) + 1_000),
    })
    await simulate()
    transaction.sign(this.signer)
    if (!transaction.signature)
      throw new MarketError('SIGNING_FAILED', 'Mock SKR signing did not produce a signature.')
    return {
      signedBase64: transaction.serialize({ verifySignatures: true }).toString('base64'),
      signature: bs58.encode(transaction.signature),
      lastValidBlockHeight: lifetime.lastValidBlockHeight,
    }
  }

  /** Only broadcast after persisting these exact bytes and their signature in the claim ledger. */
  submit(signedBase64: string): Promise<string> {
    return this.transport.submit(signedBase64)
  }

  /** An expired signature with missing history requires review; never automatically mint a replacement. */
  reconcile(signature: string, lastValidBlockHeight: number): Promise<RewardTransferStatus> {
    return this.transport.reconcile(signature, lastValidBlockHeight)
  }
}

export function createMockSkrFaucetAdapter(config: MockSkrFaucetConfig): RewardTransferAdapter {
  return new SolanaMockSkrFaucetAdapter(config)
}
