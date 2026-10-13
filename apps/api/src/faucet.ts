import { ApiError, type Campaign, type Claim, type Repository } from './domain.js'
import { processPayout, type RewardTransport } from './rewards.js'
import { walletAddress } from './auth.js'
export interface FaucetTransport extends RewardTransport {
  availableBalance(): Promise<string>
}
export const publicFaucetClaim = (claim: Claim) => ({
  id: claim.id,
  campaignId: claim.campaignId,
  day: claim.day,
  state: claim.state,
  signature: claim.signature,
  amount: claim.amount,
  createdAt: claim.createdAt,
  attemptCount: claim.attemptCount ?? 0,
  needsReview: claim.state === 'expired',
  retryable: claim.state === 'failed' && (claim.attemptCount ?? 0) < 3,
})
export const unavailableFaucet = {
  available: false,
  reason: 'The mock SKR faucet needs a funded devnet mint authority and persistent server storage.',
  symbol: 'SKR',
  label: 'Mock SKR',
  network: 'devnet',
  mint: null,
  amount: '1000000000',
  decimals: 6,
  period: 'utc-day',
  day: null,
  resetAt: null,
  dailyLimit: '1000000000',
  claimedAmount: '0',
  remainingAmount: '0',
  cooldownSeconds: 86400,
  nextClaimAt: null,
  claim: null,
}
export class FaucetService {
  constructor(
    private repository: Repository,
    readonly campaign: Campaign,
    private decimals: number,
    private transport: FaucetTransport,
  ) {
    if (
      !/^faucet_[a-zA-Z0-9_-]{1,56}$/.test(campaign.id) ||
      campaign.period !== 'utc-day' ||
      campaign.symbol !== 'SKR' ||
      campaign.mint !== transport.quoteMint ||
      campaign.authority !== transport.treasury ||
      !campaign.maxSupply ||
      !/^\d+$/.test(campaign.maxSupply) ||
      BigInt(campaign.maxSupply) > 18446744073709551615n ||
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > 9 ||
      !/^\d+$/.test(campaign.amount) ||
      BigInt(campaign.amount) !== 1000n * 10n ** BigInt(decimals) ||
      !Number.isInteger(campaign.maxClaims) ||
      campaign.maxClaims < 1 ||
      campaign.maxClaims > 10000 ||
      BigInt(campaign.amount) > BigInt(campaign.maxSupply)
    )
      throw new Error('Invalid bounded daily mock SKR faucet configuration.')
  }
  async initialize() {
    // Restart must allow an already-landed mint to reconcile even when remaining capacity is zero.
    await this.transport.validateBudget({ amountIn: '0' })
    await this.repository.putCampaign(this.campaign)
    if (!(await this.repository.getFaucetBudget(this.campaign.id))) {
      const capacity = await this.transport.availableBalance()
      if (!/^\d+$/.test(capacity) || BigInt(capacity) > BigInt(this.campaign.maxSupply!))
        throw new Error('Invalid mock mint supply snapshot.')
      const baseline = (BigInt(this.campaign.maxSupply!) - BigInt(capacity)).toString()
      // Registration locks the campaign and never replaces an existing baseline after restart.
      await this.repository.registerFaucetBudget(this.campaign, baseline)
    }
  }
  async status(wallet?: string) {
    const state = await this.repository.getFaucetState(this.campaign.id, wallet)
    const own = state.claim
    const todayClaim = own?.day === state.day
    const capacity =
      BigInt(state.budget.maxSupply) -
      BigInt(state.budget.baselineSupply) -
      BigInt(state.budget.allocatedUnits)
    let available =
      this.campaign.enabled &&
      !own &&
      state.claimsToday < this.campaign.maxClaims &&
      capacity >= BigInt(this.campaign.amount)
    let reason = !this.campaign.enabled
      ? 'The mock SKR faucet is disabled.'
      : own
        ? own.state === 'finalized'
          ? 'You have received today’s 1,000 mock SKR allocation. It resets at 00:00 UTC.'
          : own.state === 'expired'
            ? 'Your previous mint needs review. A replacement will not be sent automatically.'
            : own.state === 'failed' && (own.attemptCount ?? 0) >= 3
              ? 'Today’s mint failed after all attempts. Your next allocation is available after 00:00 UTC.'
              : 'Your existing mint request is being tracked. No second allocation will be created.'
        : state.claimsToday >= this.campaign.maxClaims
          ? 'Today’s faucet allocations have all been reserved. They reset at 00:00 UTC.'
          : capacity < BigInt(this.campaign.amount)
            ? 'The mock mint supply ceiling has been reached.'
            : undefined
    if (available) {
      try {
        // Fund just this request. The durable lifetime ledger, not an RPC read, reserves supply.
        await this.transport.validateBudget({ amountIn: this.campaign.amount })
      } catch {
        available = false
        reason = 'The devnet faucet authority, SOL funding, mint supply or RPC is unavailable.'
      }
    }
    if (!wallet && available) {
      available = false
      reason = 'Connect your Seeker wallet to mint mock SKR.'
    }
    return {
      available,
      reason,
      symbol: 'SKR',
      label: 'Mock SKR',
      network: 'devnet',
      mint: this.campaign.mint,
      amount: this.campaign.amount,
      decimals: this.decimals,
      period: 'utc-day',
      day: state.day,
      resetAt: state.resetAt,
      dailyLimit: this.campaign.amount,
      claimedAmount: todayClaim ? this.campaign.amount : '0',
      remainingAmount: todayClaim ? '0' : this.campaign.amount,
      cooldownSeconds: 86400,
      nextClaimAt: todayClaim ? state.resetAt : null,
      claim: own ? publicFaucetClaim(own) : null,
    }
  }
  async claim(wallet: string) {
    walletAddress(wallet)
    if (!this.campaign.enabled) throw new ApiError(503, 'FAUCET_UNAVAILABLE', 'The faucet is disabled.')
    const status = await this.status(wallet)
    if (!status.claim && !status.available)
      throw new ApiError(
        503,
        'FAUCET_UNAVAILABLE',
        status.reason ?? 'The daily faucet cannot grant a new allocation now.',
      )
    // The DB clock and serialized reservation decide the entitlement, never a client-provided day.
    // An unresolved earlier day returns the same intent instead of replacing an ambiguous mint.
    const claim = await this.repository.reserveFaucetClaim(this.campaign.id, wallet)
    try {
      await processPayout(this.repository, this.transport, claim.id)
    } catch {
      /* Durable state is recovered by the worker. */
    }
    return publicFaucetClaim((await this.repository.getClaim(claim.id))!)
  }
  async get(wallet: string, id: string) {
    const claim = await this.repository.getClaim(id)
    if (!claim || claim.wallet !== wallet || claim.campaignId !== this.campaign.id)
      throw new ApiError(404, 'CLAIM_NOT_FOUND', 'Mint request not found.')
    return publicFaucetClaim(claim)
  }
  async resume() {
    let cursor: string | undefined
    for (;;) {
      const claims = await this.repository.listPendingClaims(this.campaign.id, cursor)
      if (!claims.length) return
      for (const claim of claims) {
        try {
          await processPayout(this.repository, this.transport, claim.id)
        } catch {
          /* Retry the same durable intent later, including requests from earlier UTC days. */
        }
      }
      cursor = claims.at(-1)!.id
    }
  }
}
