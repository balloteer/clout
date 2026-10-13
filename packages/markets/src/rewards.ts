import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  type SignatureStatus,
} from '@solana/web3.js'
import {
  ACCOUNT_SIZE,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import bs58 from 'bs58'
import { MeteoraMarketAdapter } from './meteora.js'
import { DEVNET_GENESIS_HASH, MarketError, units } from './validation.js'
import type { MarketServiceConfig } from './types.js'

export interface PreparedRewardTransfer {
  signedBase64: string
  signature: string
  lastValidBlockHeight: number
}
/** `expired` means the blockhash lifetime ended with no RPC history; it is NOT proof of nonpayment. */
export type RewardTransferStatus = 'pending' | 'finalized' | 'failed' | 'expired'
export interface RewardTransferAdapter {
  readonly treasury: string
  readonly quoteMint: string
  availableBalance(): Promise<string>
  validateBudget(request: { amountIn: string }): Promise<void>
  prepare(request: { wallet: string; amountIn: string }): Promise<PreparedRewardTransfer>
  /** Call only after the exact signed bytes and signature have been committed to the claim ledger. */
  submit(signedBase64: string): Promise<string>
  reconcile(signature: string, lastValidBlockHeight: number): Promise<RewardTransferStatus>
}
export interface RewardTransferConfig {
  marketConfig: MarketServiceConfig
  /** Inject only when the explicitly funded campaign is enabled; never pass a user wallet key. */
  secretKeyUint8Array: Uint8Array
  /** Per-claim integer limit. Campaign-wide allocation is reserved atomically by the API ledger. */
  maxAmountIn: string
}

/** Optional devnet treasury transport. Construction never reads secrets or sends a transaction. */
export class SolanaRewardTransferAdapter implements RewardTransferAdapter {
  readonly treasury: string
  readonly quoteMint: string
  private readonly signer: Keypair
  private readonly connection: Connection
  private readonly builder: MeteoraMarketAdapter
  private readonly maximum: bigint
  private readonly quoteDecimals: number
  private readonly priorityFee: number

  constructor(config: RewardTransferConfig) {
    // Reuse the market boundary's devnet, HTTPS, quote-mint and bounded-priority-fee policy.
    this.builder = new MeteoraMarketAdapter(config.marketConfig)
    this.maximum = units(config.maxAmountIn)
    if (config.secretKeyUint8Array.length !== 64)
      throw new MarketError('INVALID_TREASURY', 'An explicit 64-byte devnet treasury key is required.')
    this.signer = Keypair.fromSecretKey(Uint8Array.from(config.secretKeyUint8Array))
    this.treasury = this.signer.publicKey.toBase58()
    this.quoteMint = config.marketConfig.quoteMint
    this.quoteDecimals = config.marketConfig.quoteDecimals ?? 6
    this.priorityFee = config.marketConfig.priorityFeeMicroLamports ?? 1_000
    this.connection = new Connection(config.marketConfig.rpcUrl, 'confirmed')
  }

  private async guardCluster() {
    if ((await this.connection.getGenesisHash()) !== DEVNET_GENESIS_HASH)
      throw new MarketError('WRONG_NETWORK', 'Reward transfers require the Solana devnet genesis hash.')
  }

  async availableBalance(): Promise<string> {
    await this.guardCluster()
    const mintAddress = new PublicKey(this.quoteMint)
    const mint = await getMint(this.connection, mintAddress, 'confirmed', TOKEN_PROGRAM_ID)
    if (!mint.isInitialized || mint.decimals !== this.quoteDecimals)
      throw new MarketError('WRONG_DECIMALS', 'Configured Test SKR decimals do not match the mint.')
    const source = getAssociatedTokenAddressSync(mintAddress, this.signer.publicKey)
    const account = await getAccount(this.connection, source, 'confirmed', TOKEN_PROGRAM_ID)
    if (!account.owner.equals(this.signer.publicKey) || !account.mint.equals(mintAddress) || account.isFrozen)
      throw new MarketError('INVALID_TREASURY', 'The funded treasury Test SKR account is not usable.')
    return account.amount.toString()
  }

  async validateBudget({ amountIn }: { amountIn: string }): Promise<void> {
    const amount = units(amountIn)
    if (amount > BigInt(await this.availableBalance()))
      throw new MarketError(
        'INSUFFICIENT_TREASURY',
        'Fund the devnet Test SKR treasury before enabling this campaign.',
      )
    const [balance, rent, lifetime] = await Promise.all([
      this.connection.getBalance(this.signer.publicKey, 'confirmed'),
      this.connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE, 'confirmed'),
      this.connection.getLatestBlockhash('confirmed'),
    ])
    // One treasury signature per payout, reserving the adapter's full CU ceiling and configured priority fee.
    const feeMessage = new Transaction({ feePayer: this.signer.publicKey, ...lifetime })
      .add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.priorityFee }),
      )
      .compileMessage()
    const fee = (await this.connection.getFeeForMessage(feeMessage, 'confirmed')).value
    const asLamports = (value: number | null) => {
      if (value === null || !Number.isSafeInteger(value) || value < 0)
        throw new MarketError(
          'INVALID_FEE_ESTIMATE',
          'The treasury SOL balance, account rent or network fee could not be verified.',
        )
      return BigInt(value)
    }
    const claims = (amount + this.maximum - 1n) / this.maximum
    const required = claims * (asLamports(rent) + asLamports(fee))
    if (asLamports(balance) < required)
      throw new MarketError(
        'INSUFFICIENT_TREASURY_SOL',
        'Fund the devnet treasury with SOL for every remaining reward transfer and token account rent.',
      )
  }

  async prepare({ wallet, amountIn }: { wallet: string; amountIn: string }): Promise<PreparedRewardTransfer> {
    if (units(amountIn) > this.maximum)
      throw new MarketError('REWARD_LIMIT', 'Reward exceeds the configured per-claim maximum.')
    await this.validateBudget({ amountIn })
    const built = await this.builder.buildTip({ owner: this.treasury, recipient: wallet, amountIn })
    const transaction = Transaction.from(Buffer.from(built.transactionBase64, 'base64'))
    transaction.sign(this.signer)
    if (!transaction.signature)
      throw new MarketError('SIGNING_FAILED', 'Reward signing did not produce a signature.')
    return {
      signedBase64: transaction.serialize({ verifySignatures: true }).toString('base64'),
      signature: bs58.encode(transaction.signature),
      lastValidBlockHeight: built.lastValidBlockHeight,
    }
  }

  async submit(signedBase64: string): Promise<string> {
    await this.guardCluster()
    if (signedBase64.length > 2_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signedBase64))
      throw new MarketError('INVALID_TRANSACTION', 'Invalid persisted reward transaction.')
    const bytes = Buffer.from(signedBase64, 'base64')
    const transaction = Transaction.from(bytes)
    if (
      !transaction.feePayer?.equals(this.signer.publicKey) ||
      transaction.signatures.length !== 1 ||
      !transaction.signature ||
      !transaction.verifySignatures()
    )
      throw new MarketError('INVALID_TRANSACTION', 'Reward transaction must have a valid treasury signature.')
    const signature = bs58.encode(transaction.signature)
    const returned = await this.connection.sendRawTransaction(bytes, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 3,
    })
    if (returned !== signature)
      throw new MarketError(
        'SIGNATURE_MISMATCH',
        'RPC returned an unexpected transaction signature; reconcile the persisted signature.',
      )
    return signature
  }

  async reconcile(signature: string, lastValidBlockHeight: number): Promise<RewardTransferStatus> {
    await this.guardCluster()
    if (
      !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature) ||
      !Number.isSafeInteger(lastValidBlockHeight) ||
      lastValidBlockHeight <= 0
    )
      throw new MarketError(
        'INVALID_TRANSACTION',
        'Invalid persisted reward transaction lifetime or signature.',
      )
    const read = async () =>
      (await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0]
    const terminal = (status: SignatureStatus): RewardTransferStatus =>
      status.confirmationStatus === 'finalized' ? (status.err ? 'failed' : 'finalized') : 'pending'
    const current = await read()
    if (current) return terminal(current)
    if ((await this.connection.getBlockHeight('finalized')) <= lastValidBlockHeight) return 'pending'
    // Recheck after finalized height. Missing/pruned history remains ambiguous: callers must not replace an expired signature.
    const afterExpiry = await read()
    return afterExpiry ? terminal(afterExpiry) : 'expired'
  }
}

export function createRewardTransferAdapter(config: RewardTransferConfig): RewardTransferAdapter {
  return new SolanaRewardTransferAdapter(config)
}
