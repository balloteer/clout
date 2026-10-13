import { ApiError, type Campaign, type Claim, type Repository } from './domain.js'
import type { SeekerVerifier } from './seeker.js'

export interface RewardTransport {
  readonly treasury: string
  readonly quoteMint: string
  validateBudget(input: { amountIn: string }): Promise<void>
  prepare(input: {
    wallet: string
    amountIn: string
  }): Promise<{ signedBase64: string; signature: string; lastValidBlockHeight: number }>
  submit(signedBase64: string): Promise<string>
  reconcile(
    signature: string,
    lastValidBlockHeight: number,
  ): Promise<'pending' | 'finalized' | 'failed' | 'expired'>
}
export const publicClaim = (claim: Claim) => {
  const { signedTransaction: _bytes, leaseToken: _lease, leaseExpiresAt: _expires, ...visible } = claim
  return {
    ...visible,
    needsReview: claim.state === 'expired',
    retryable: claim.state === 'failed' && (claim.attemptCount ?? 0) < 3,
    symbol: 'Test SKR',
    network: 'devnet',
  }
}

export class RewardService {
  constructor(
    private repository: Repository,
    readonly campaign: Campaign,
    private decimals: number,
    private seeker: SeekerVerifier,
    private transport: RewardTransport,
    private now = Date.now,
  ) {
    if (
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > 9 ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(campaign.id) ||
      campaign.symbol !== 'SKR' ||
      campaign.mint !== transport.quoteMint ||
      !/^\d+$/.test(campaign.amount) ||
      BigInt(campaign.amount) <= 0n ||
      !Number.isInteger(campaign.maxClaims) ||
      campaign.maxClaims < 1 ||
      campaign.maxClaims > 100 ||
      BigInt(campaign.amount) * BigInt(campaign.maxClaims) > 18446744073709551615n
    )
      throw new Error('Invalid bounded SKR campaign configuration.')
  }
  async initialize() {
    await this.repository.putCampaign(this.campaign)
  }
  async status(wallet?: string) {
    const claims = await this.repository.listClaims(this.campaign.id)
    const remaining = Math.max(0, this.campaign.maxClaims - claims.length)
    const unpaid = this.campaign.maxClaims - claims.filter((claim) => claim.state === 'finalized').length
    let available = this.campaign.enabled && remaining > 0
    let reason = !this.campaign.enabled
      ? 'Campaign disabled.'
      : remaining === 0
        ? 'All rewards have been reserved.'
        : undefined
    if (available) {
      try {
        await this.transport.validateBudget({
          amountIn: (BigInt(this.campaign.amount) * BigInt(unpaid)).toString(),
        })
      } catch {
        available = false
        reason = 'The campaign is not fully funded or its devnet connection is unavailable.'
      }
    }
    const ownClaim = wallet ? claims.find((claim) => claim.wallet === wallet) : undefined
    return {
      available,
      claim: ownClaim ? publicClaim(ownClaim) : null,
      campaign: {
        id: this.campaign.id,
        symbol: 'Test SKR',
        amount: this.campaign.amount,
        decimals: this.decimals,
        maxClaims: this.campaign.maxClaims,
        remaining,
      },
      reason,
    }
  }
  async claim(wallet: string) {
    if (!this.campaign.enabled) throw new ApiError(503, 'REWARDS_UNAVAILABLE', 'This campaign is disabled.')
    let eligibility
    try {
      eligibility = await this.seeker.check(wallet)
    } catch {
      throw new ApiError(503, 'VERIFICATION_UNAVAILABLE', 'Seeker verification is temporarily unavailable.')
    }
    if (!eligibility.hasSGT || !eligibility.mintAddress)
      throw new ApiError(403, 'SEEKER_REQUIRED', 'This wallet must currently hold a Seeker Genesis Token.')
    const previous = (await this.repository.listClaims(this.campaign.id)).find(
      (claim) => claim.sgtMint === eligibility.mintAddress || claim.wallet === wallet,
    )
    if (!previous && !(await this.status()).available)
      throw new ApiError(503, 'REWARDS_UNAVAILABLE', 'This campaign is not available or fully funded.')
    const claim = await this.repository.reserveClaim(this.campaign, eligibility.mintAddress, wallet)
    try {
      await this.process(claim.id)
    } catch {
      /* Reservation and any signed bytes remain durable for the worker. */
    }
    return publicClaim((await this.repository.getClaim(claim.id))!)
  }
  async process(id: string) {
    return processPayout(this.repository, this.transport, id, this.now())
  }
  async resume() {
    const claims = (await this.repository.listClaims(this.campaign.id)).filter(
      (claim) =>
        claim.state !== 'finalized' &&
        claim.state !== 'expired' &&
        !(claim.state === 'failed' && (claim.attemptCount ?? 0) >= 3),
    )
    for (const claim of claims) {
      try {
        await this.process(claim.id)
      } catch {
        /* Leave durable state for a later tick. */
      }
    }
  }
}

// Shared persistence boundary for the future SGT reward program and the devnet-only mock faucet.
// This function grants no eligibility; callers must reserve a bounded, owner-bound claim first.
export async function processPayout(
  repository: Repository,
  transport: RewardTransport,
  id: string,
  now = Date.now(),
) {
  let claim = await repository.acquireClaim(id, now)
  if (!claim?.leaseToken) return
  const lease = claim.leaseToken
  const persist = async () => {
    if (!(await repository.saveClaim(claim!, lease))) throw new Error('Reward claim lease was replaced.')
  }
  try {
    if (claim.signature && claim.signedTransaction && claim.lastValidBlockHeight !== null) {
      const state = await transport.reconcile(claim.signature, claim.lastValidBlockHeight)
      if (state === 'finalized') {
        claim.state = state
        await persist()
        return
      }
      if (state === 'pending') {
        const submitted = await transport.submit(claim.signedTransaction)
        if (submitted !== claim.signature)
          throw new Error('Reward transport returned a mismatched signature.')
        claim.state = 'submitted'
        await persist()
        return
      }
      claim.state = state
      await persist()
      // A missing historical status can mean pruned RPC history, not proof of non-payment.
      if (state === 'expired') return
      if ((claim.attemptCount ?? 0) >= 3) return
      claim.previousAttempts = [...(claim.previousAttempts ?? []), { signature: claim.signature, state }]
      claim.signature = null
      claim.signedTransaction = null
      claim.lastValidBlockHeight = null
    }
    if ((claim.attemptCount ?? 0) >= 3) return
    const prepared = await transport.prepare({ wallet: claim.wallet, amountIn: claim.amount })
    claim = {
      ...claim,
      state: 'prepared',
      signature: prepared.signature,
      signedTransaction: prepared.signedBase64,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
      attemptCount: (claim.attemptCount ?? 0) + 1,
    }
    // The durable commit is the boundary: no transmission happens before it succeeds.
    await persist()
    const submitted = await transport.submit(prepared.signedBase64)
    if (submitted !== prepared.signature) throw new Error('Reward transport returned a mismatched signature.')
    claim.state = 'submitted'
    await persist()
  } finally {
    await repository.releaseClaim(id, lease)
  }
}
