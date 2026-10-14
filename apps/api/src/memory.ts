import { randomUUID } from 'node:crypto'
import {
  ApiError,
  newProfile,
  type Campaign,
  type Challenge,
  type Claim,
  type FaucetBudget,
  type FaucetState,
  type Comment,
  type IndexedEvent,
  type Post,
  type PostSummary,
  type PositionHistory,
  type Profile,
  type Repository,
  type Session,
  type TransactionIntent,
} from './domain.js'
import { demoPosts, demoProfiles } from './fixtures.js'

export class MemoryRepository implements Repository {
  readonly challenges = new Map<string, Challenge>()
  readonly sessions = new Map<string, Session>()
  readonly profiles = new Map<string, Profile>()
  readonly posts = new Map<string, Post>()
  readonly comments = new Map<string, Comment>()
  readonly likeRows = new Set<string>()
  readonly followRows = new Map<string, Set<string>>()
  readonly campaigns = new Map<string, Campaign>()
  private activeCampaign: string | null = null
  readonly claims = new Map<string, Claim>()
  readonly faucetBudgets = new Map<string, FaucetBudget>()
  readonly events = new Map<string, IndexedEvent>()
  readonly checkpoints = new Map<string, { signature: string; slot: number }>()
  readonly intents = new Map<string, TransactionIntent>()
  readonly quotes = new Map<string, Record<string, unknown>>()

  constructor(
    seed = true,
    private now = Date.now,
  ) {
    if (seed) {
      for (const profile of demoProfiles) this.profiles.set(profile.wallet, structuredClone(profile))
      for (const post of demoPosts) this.posts.set(post.id, structuredClone(post))
    }
  }
  async putChallenge(challenge: Challenge) {
    for (const [key, value] of this.challenges) if (value.expiresAt < Date.now()) this.challenges.delete(key)
    if (this.challenges.size >= 10000) throw new ApiError(429, 'BUSY', 'Try again shortly.')
    this.challenges.set(challenge.id, challenge)
  }
  async consumeChallenge(id: string, now: number) {
    const challenge = this.challenges.get(id)
    this.challenges.delete(id) // No await between lookup and deletion: atomic within this process.
    return challenge && challenge.expiresAt > now ? challenge : null
  }
  async putSession(session: Session) {
    for (const [key, value] of this.sessions) if (value.expiresAt < Date.now()) this.sessions.delete(key)
    this.sessions.set(session.hash, session)
  }
  async getSession(hash: string, now: number) {
    const session = this.sessions.get(hash)
    return session && session.expiresAt > now ? session : null
  }
  async revokeSession(hash: string) {
    this.sessions.delete(hash)
  }
  async ensureProfile(wallet: string) {
    const profile = this.profiles.get(wallet) ?? newProfile(wallet)
    this.profiles.set(wallet, profile)
    return profile
  }
  async getProfile(wallet: string) {
    return this.profiles.get(wallet) ?? null
  }
  async listProfiles() {
    return [...this.profiles.values()]
  }
  async saveProfile(profile: Profile) {
    this.profiles.set(profile.wallet, profile)
  }
  async listPosts(options?: { includeHidden?: boolean }) {
    return [...this.posts.values()]
      .filter((post) => post.status === 'ready' && (options?.includeHidden || post.feedHidden !== true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100)
  }
  async getPostSummaries(postIds: string[], wallet?: string): Promise<Record<string, PostSummary>> {
    if (postIds.length > 100) throw new Error('Post summary batch exceeds the feed limit.')
    const summaries: Record<string, PostSummary> = {}
    for (const id of postIds) {
      const post = this.posts.get(id)
      if (!post) continue
      summaries[id] = {
        creator: this.profiles.get(post.creatorWallet) ?? null,
        likes: await this.likes(id, wallet),
        commentCount: (await this.listComments(id)).length,
      }
    }
    return summaries
  }
  async listOwnPosts(wallet: string) {
    return [...this.posts.values()]
      .filter((post) => post.creatorWallet === wallet)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async listProcessingUploads(limit: number, after?: { createdAt: string; id: string }) {
    return [...this.posts.values()]
      .filter((post) => post.status === 'processing' && !!post.streamUid && post.source === undefined)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .filter(
        (post) =>
          !after ||
          post.createdAt > after.createdAt ||
          (post.createdAt === after.createdAt && post.id > after.id),
      )
      .slice(0, limit)
  }
  async getPost(id: string) {
    return this.posts.get(id) ?? null
  }
  async insertPost(post: Post) {
    this.posts.set(post.id, post)
  }
  async updateStream(
    uid: string,
    status: Post['status'],
    videoUrl: string | null,
    thumbnailUrl: string | null,
  ) {
    const post = [...this.posts.values()].find((post) => post.streamUid === uid)
    if (!post) return false
    if (post.status !== 'processing')
      return post.status === status && post.videoUrl === videoUrl && post.thumbnailUrl === thumbnailUrl // Exact callback replays succeed without changing a terminal state.
    Object.assign(post, { status, videoUrl, thumbnailUrl })
    return true
  }
  async listComments(postId: string) {
    return [...this.comments.values()].filter((row) => row.postId === postId).slice(-100)
  }
  async addComment(comment: Comment) {
    this.comments.set(comment.id, comment)
  }
  async setLike(postId: string, wallet: string, liked: boolean) {
    const key = `${postId}:${wallet}`
    if (liked) this.likeRows.add(key)
    else this.likeRows.delete(key)
  }
  async likes(postId: string, wallet?: string) {
    return {
      count: [...this.likeRows].filter((key) => key.startsWith(`${postId}:`)).length,
      liked: !!wallet && this.likeRows.has(`${postId}:${wallet}`),
    }
  }
  async setFollow(wallet: string, target: string, following: boolean) {
    const follows = this.followRows.get(wallet) ?? new Set<string>()
    if (following) follows.add(target)
    else follows.delete(target)
    this.followRows.set(wallet, follows)
  }
  async following(wallet: string) {
    return [...(this.followRows.get(wallet) ?? [])]
  }
  async getCampaign(id: string) {
    return this.campaigns.get(id) ?? null
  }
  async putCampaign(campaign: Campaign) {
    const previous = this.campaigns.get(campaign.id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(campaign))
      throw new Error('Campaign configuration cannot change under the same ID.')
    if (
      [...this.claims.values()].some(
        (claim) =>
          claim.campaignId !== campaign.id &&
          claim.state !== 'finalized' &&
          !(claim.state === 'failed' && (claim.attemptCount ?? 0) >= 3),
      )
    )
      throw new Error('A previous campaign still has unresolved reward claims.')
    this.campaigns.set(campaign.id, campaign)
    this.activeCampaign = campaign.id
  }
  async listClaims(campaignId: string) {
    return [...this.claims.values()]
      .filter((row) => row.campaignId === campaignId)
      .map((row) => structuredClone(row))
  }
  async reserveClaim(campaign: Campaign, sgtMint: string, wallet: string) {
    if (campaign.period === 'utc-day') throw new Error('Daily faucet reservation required.')
    const previous = [...this.claims.values()].find(
      (claim) => claim.campaignId === campaign.id && (claim.sgtMint === sgtMint || claim.wallet === wallet),
    )
    if (previous) {
      if (previous.wallet !== wallet)
        throw new ApiError(409, 'ALREADY_CLAIMED', 'This Seeker has already reserved this reward.')
      return previous
    }
    if (!campaign.enabled || (this.activeCampaign !== null && this.activeCampaign !== campaign.id))
      throw new ApiError(503, 'CAMPAIGN_DISABLED', 'This reward campaign is not active.')
    if (
      [...this.claims.values()].filter((claim) => claim.campaignId === campaign.id).length >=
      campaign.maxClaims
    )
      throw new ApiError(409, 'CAMPAIGN_FULL', 'All rewards have been reserved.')
    const claim: Claim = {
      id: randomUUID(),
      campaignId: campaign.id,
      sgtMint,
      wallet,
      amount: campaign.amount,
      state: 'reserved',
      signature: null,
      signedTransaction: null,
      lastValidBlockHeight: null,
      createdAt: new Date().toISOString(),
    }
    this.claims.set(claim.id, claim)
    return claim
  }
  async getFaucetBudget(campaignId: string) {
    const budget = this.faucetBudgets.get(campaignId)
    return budget ? structuredClone(budget) : null
  }
  async registerFaucetBudget(campaign: Campaign, baselineSupply: string) {
    const previous = this.faucetBudgets.get(campaign.id)
    if (previous) {
      if (previous.maxSupply !== campaign.maxSupply) throw new Error('Faucet supply ceiling cannot change.')
      return
    }
    const outstanding = [...this.claims.values()]
      .filter((claim) => claim.campaignId === campaign.id && unresolved(claim))
      .reduce((sum, claim) => sum + BigInt(claim.amount), 0n)
    if (BigInt(baselineSupply) + outstanding > BigInt(campaign.maxSupply!))
      throw new Error('Existing faucet reservations exceed the supply ceiling.')
    this.faucetBudgets.set(campaign.id, {
      baselineSupply,
      allocatedUnits: outstanding.toString(),
      maxSupply: campaign.maxSupply!,
    })
  }
  async getFaucetState(campaignId: string, wallet?: string): Promise<FaucetState> {
    const time = this.now()
    const day = new Date(time).toISOString().slice(0, 10)
    const claims = [...this.claims.values()].filter((claim) => claim.campaignId === campaignId)
    return {
      day,
      resetAt: new Date(Date.parse(`${day}T00:00:00.000Z`) + 86400000).toISOString(),
      claimsToday: claims.filter((claim) => claim.day === day).length,
      budget: structuredClone(this.faucetBudgets.get(campaignId)!),
      claim: structuredClone(
        claims.find((claim) => claim.wallet === wallet && (claim.day === day || unresolved(claim))) ?? null,
      ),
    }
  }
  async reserveFaucetClaim(campaignId: string, wallet: string) {
    // No awaits before reservation: memory is only a deterministic test/demo implementation.
    const campaign = this.campaigns.get(campaignId)
    if (!campaign?.enabled || campaign.period !== 'utc-day' || this.activeCampaign !== campaignId)
      throw new ApiError(503, 'FAUCET_DISABLED', 'The daily faucet is disabled.')
    const time = this.now()
    const day = new Date(time).toISOString().slice(0, 10)
    const claims = [...this.claims.values()].filter((claim) => claim.campaignId === campaignId)
    const previous = claims.find(
      (claim) => claim.wallet === wallet && (claim.day === day || unresolved(claim)),
    )
    if (previous) return structuredClone(previous)
    if (claims.filter((claim) => claim.day === day).length >= campaign.maxClaims)
      throw new ApiError(409, 'FAUCET_DAILY_CAP', 'Today’s faucet allocations have all been reserved.')
    const budget = this.faucetBudgets.get(campaignId)
    if (
      !budget ||
      BigInt(budget.baselineSupply) + BigInt(budget.allocatedUnits) + BigInt(campaign.amount) >
        BigInt(budget.maxSupply)
    )
      throw new ApiError(503, 'FAUCET_SUPPLY_CAP', 'The mock mint supply ceiling has been reached.')
    const claim: Claim = {
      id: randomUUID(),
      campaignId,
      sgtMint: `faucet:${wallet}`,
      wallet,
      amount: campaign.amount,
      state: 'reserved',
      signature: null,
      signedTransaction: null,
      lastValidBlockHeight: null,
      day,
      createdAt: new Date(time).toISOString(),
    }
    budget.allocatedUnits = (BigInt(budget.allocatedUnits) + BigInt(campaign.amount)).toString()
    this.claims.set(claim.id, claim)
    return structuredClone(claim)
  }
  async listPendingClaims(campaignId: string, afterId = '') {
    return [...this.claims.values()]
      .filter(
        (claim) =>
          claim.campaignId === campaignId &&
          claim.id > afterId &&
          unresolved(claim) &&
          claim.state !== 'expired',
      )
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, 100)
      .map((claim) => structuredClone(claim))
  }
  async getClaim(id: string) {
    const claim = this.claims.get(id)
    return claim ? structuredClone(claim) : null
  }
  async acquireClaim(id: string, now: number) {
    const claim = this.claims.get(id)
    if (
      !claim ||
      claim.state === 'finalized' ||
      claim.state === 'expired' ||
      (claim.leaseExpiresAt ?? 0) > now
    )
      return null
    claim.leaseToken = randomUUID()
    claim.leaseExpiresAt = now + 90000
    return structuredClone(claim)
  }
  async saveClaim(claim: Claim, leaseToken: string) {
    const current = this.claims.get(claim.id)
    if (!current || current.state === 'finalized' || current.leaseToken !== leaseToken) return false
    if (
      claim.signature &&
      [...this.claims.values()].some((row) => row.id !== claim.id && row.signature === claim.signature)
    )
      return false
    this.claims.set(claim.id, structuredClone(claim))
    return true
  }
  async releaseClaim(id: string, leaseToken: string) {
    const current = this.claims.get(id)
    if (current?.leaseToken === leaseToken) {
      current.leaseToken = null
      current.leaseExpiresAt = 0
    }
  }
  async ingest(events: IndexedEvent[], checkpoint: { source: string; signature: string; slot: number }) {
    for (const event of events) {
      const key = `${event.signature}:${event.instructionPath}`
      const existing = this.events.get(key)
      if (!existing || event.finality === 'finalized') this.events.set(key, structuredClone(event))
    }
    const prior = this.checkpoints.get(checkpoint.source)
    if (!prior || checkpoint.slot >= prior.slot) this.checkpoints.set(checkpoint.source, checkpoint)
  }
  async reconcile(signature: string, status: 'finalized' | 'dropped') {
    for (const [key, event] of this.events)
      if (event.signature === signature) {
        if (status === 'dropped' && event.finality !== 'finalized') this.events.delete(key)
        else if (status === 'finalized') event.finality = 'finalized'
      }
  }
  async getEvents(wallet: string) {
    return [...this.events.values()].filter((event) => event.wallet === wallet)
  }
  async getPositionHistory(wallet: string): Promise<PositionHistory[]> {
    const totals = new Map<string, PositionHistory>()
    for (const event of this.events.values()) {
      if (event.wallet !== wallet) continue
      const total = totals.get(event.postId) ?? {
        postId: event.postId,
        boughtBaseAmount: '0',
        soldBaseAmount: '0',
        boughtQuoteAmount: '0',
        soldQuoteAmount: '0',
      }
      const baseKey = event.kind === 'buy' ? 'boughtBaseAmount' : 'soldBaseAmount'
      const quoteKey = event.kind === 'buy' ? 'boughtQuoteAmount' : 'soldQuoteAmount'
      total[baseKey] = (BigInt(total[baseKey]) + BigInt(event.baseAmount)).toString()
      total[quoteKey] = (BigInt(total[quoteKey]) + BigInt(event.quoteAmount)).toString()
      totals.set(event.postId, total)
    }
    return [...totals.values()]
  }
  async getPostEvents(postId: string) {
    return [...this.events.values()]
      .filter((event) => event.postId === postId)
      .sort(
        (a, b) =>
          b.slot - a.slot ||
          (a.signature < b.signature ? 1 : a.signature > b.signature ? -1 : 0) ||
          (a.instructionPath < b.instructionPath ? 1 : a.instructionPath > b.instructionPath ? -1 : 0),
      )
      .slice(0, 100)
      .map((event) => structuredClone(event))
  }
  async putIntent(intent: TransactionIntent) {
    if (
      intent.kind === 'launch' &&
      [...this.intents.values()].some(
        (row) =>
          row.kind === 'launch' && row.postId === intent.postId && !['failed', 'expired'].includes(row.state),
      )
    )
      return
    if (!this.intents.has(intent.id)) this.intents.set(intent.id, intent)
  }
  async getIntent(id: string) {
    return this.intents.get(id) ?? null
  }
  async getActiveLaunch(postId: string) {
    return (
      [...this.intents.values()].find(
        (row) => row.kind === 'launch' && row.postId === postId && !['failed', 'expired'].includes(row.state),
      ) ?? null
    )
  }
  async listUnsettledIntents() {
    return [...this.intents.values()]
      .filter((row) => ['prepared', 'pending', 'confirmed'].includes(row.state))
      .slice(0, 100)
  }
  async updateIntent(id: string, state: TransactionIntent['state'], signature: string | null) {
    const intent = this.intents.get(id)
    if (!intent || (intent.signature && intent.signature !== signature) || intent.state === 'finalized')
      return false
    Object.assign(intent, { state, signature })
    return true
  }
  async attachMarket(postId: string, market: NonNullable<Post['market']>) {
    const post = this.posts.get(postId)
    if (post && !post.market) post.market = market
  }
  async putQuote(id: string, value: Record<string, unknown>) {
    this.quotes.set(id, value)
  }
  async getQuote(id: string) {
    return this.quotes.get(id) ?? null
  }
  async close() {
    /* No external resource in local demo mode. */
  }
}
function unresolved(claim: Claim) {
  return claim.state !== 'finalized' && !(claim.state === 'failed' && (claim.attemptCount ?? 0) >= 3)
}
