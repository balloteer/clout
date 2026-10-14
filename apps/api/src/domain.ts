export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

export interface Profile {
  wallet: string
  handle: string
  displayName: string
  bio: string
  avatar: string | null
  seekerVerified: boolean
  reputation: number
}
export interface Post {
  id: string
  creatorWallet: string
  caption: string
  videoUrl: string | null
  thumbnailUrl: string | null
  streamUid: string | null
  status: 'processing' | 'ready' | 'failed'
  createdAt: string
  demo: boolean
  /** Operator catalog visibility only; hidden posts and their trades remain addressable. */
  feedHidden?: boolean
  tags: string[]
  market: { baseMint: string; dbcPool: string } | null
  source?: {
    provider: 'x' | 'fomo'
    accountHandle: string
    postId: string
    url: string
    publishedAt?: string
  }
}
export interface Comment {
  id: string
  postId: string
  wallet: string
  body: string
  createdAt: string
}
export interface PostSummary {
  creator: Profile | null
  likes: { count: number; liked: boolean }
  commentCount: number
}
export interface Challenge {
  id: string
  address: string
  message: string
  expiresAt: number
}
export interface Session {
  hash: string
  wallet: string
  expiresAt: number
}
export interface Campaign {
  id: string
  symbol: 'SKR'
  mint: string
  amount: string
  maxClaims: number
  enabled: boolean
  authority?: string
  maxSupply?: string
  period?: 'utc-day'
}
export interface Claim {
  id: string
  campaignId: string
  sgtMint: string
  wallet: string
  amount: string
  state: 'reserved' | 'prepared' | 'submitted' | 'finalized' | 'expired' | 'failed'
  signature: string | null
  signedTransaction: string | null
  lastValidBlockHeight: number | null
  createdAt: string
  day?: string
  leaseToken?: string | null
  leaseExpiresAt?: number
  attemptCount?: number
  previousAttempts?: { signature: string; state: 'expired' | 'failed' }[]
}
export interface FaucetBudget {
  baselineSupply: string
  allocatedUnits: string
  maxSupply: string
}
export interface FaucetState {
  day: string
  resetAt: string
  claimsToday: number
  budget: FaucetBudget
  claim: Claim | null
}
export interface IndexedEvent {
  signature: string
  instructionPath: string
  slot: number
  wallet: string
  postId: string
  kind: 'buy' | 'sell'
  baseAmount: string
  quoteAmount: string
  finality: 'confirmed' | 'finalized'
  demoActivity?: boolean
}
export interface PositionHistory {
  postId: string
  boughtBaseAmount: string
  soldBaseAmount: string
  boughtQuoteAmount: string
  soldQuoteAmount: string
}
export interface TransactionIntent {
  id: string
  wallet: string
  kind: 'trade' | 'launch' | 'fee-claim' | 'migration' | 'tip'
  postId: string
  envelope: Record<string, unknown>
  signature: string | null
  state: 'prepared' | 'pending' | 'confirmed' | 'finalized' | 'expired' | 'failed'
  createdAt: string
}
export interface Repository {
  healthCheck(): Promise<void>
  putChallenge(challenge: Challenge): Promise<void>
  consumeChallenge(id: string, now: number): Promise<Challenge | null>
  putSession(session: Session): Promise<void>
  getSession(hash: string, now: number): Promise<Session | null>
  revokeSession(hash: string): Promise<void>
  ensureProfile(wallet: string): Promise<Profile>
  getProfile(wallet: string): Promise<Profile | null>
  listProfiles(): Promise<Profile[]>
  saveProfile(profile: Profile): Promise<void>
  listPosts(options?: { includeHidden?: boolean }): Promise<Post[]>
  getPostSummaries(postIds: string[], wallet?: string): Promise<Record<string, PostSummary>>
  listOwnPosts(wallet: string): Promise<Post[]>
  listProcessingUploads(limit: number, after?: { createdAt: string; id: string }): Promise<Post[]>
  getPost(id: string): Promise<Post | null>
  insertPost(post: Post): Promise<void>
  updateStream(
    uid: string,
    status: Post['status'],
    videoUrl: string | null,
    thumbnailUrl: string | null,
  ): Promise<boolean>
  listComments(postId: string): Promise<Comment[]>
  addComment(comment: Comment): Promise<void>
  setLike(postId: string, wallet: string, liked: boolean): Promise<void>
  likes(postId: string, wallet?: string): Promise<{ count: number; liked: boolean }>
  setFollow(wallet: string, target: string, following: boolean): Promise<void>
  following(wallet: string): Promise<string[]>
  getCampaign(id: string): Promise<Campaign | null>
  putCampaign(campaign: Campaign): Promise<void>
  listClaims(campaignId: string): Promise<Claim[]>
  reserveClaim(campaign: Campaign, sgtMint: string, wallet: string): Promise<Claim>
  getFaucetBudget(campaignId: string): Promise<FaucetBudget | null>
  registerFaucetBudget(campaign: Campaign, baselineSupply: string): Promise<void>
  getFaucetState(campaignId: string, wallet?: string): Promise<FaucetState>
  reserveFaucetClaim(campaignId: string, wallet: string): Promise<Claim>
  listPendingClaims(campaignId: string, afterId?: string): Promise<Claim[]>
  getClaim(id: string): Promise<Claim | null>
  acquireClaim(id: string, now: number): Promise<Claim | null>
  saveClaim(claim: Claim, leaseToken: string): Promise<boolean>
  releaseClaim(id: string, leaseToken: string): Promise<void>
  ingest(
    events: IndexedEvent[],
    checkpoint: { source: string; signature: string; slot: number },
  ): Promise<void>
  reconcile(signature: string, status: 'finalized' | 'dropped'): Promise<void>
  getEvents(wallet: string): Promise<IndexedEvent[]>
  getPositionHistory(wallet: string): Promise<PositionHistory[]>
  getPostEvents(postId: string): Promise<IndexedEvent[]>
  putIntent(intent: TransactionIntent): Promise<void>
  getIntent(id: string): Promise<TransactionIntent | null>
  getActiveLaunch(postId: string): Promise<TransactionIntent | null>
  listUnsettledIntents(): Promise<TransactionIntent[]>
  updateIntent(id: string, state: TransactionIntent['state'], signature: string | null): Promise<boolean>
  attachMarket(postId: string, market: NonNullable<Post['market']>): Promise<void>
  putQuote(id: string, value: Record<string, unknown>): Promise<void>
  getQuote(id: string): Promise<Record<string, unknown> | null>
  close(): Promise<void>
}

export const newProfile = (wallet: string): Profile => ({
  wallet,
  handle: `${wallet.slice(0, 4)}…${wallet.slice(-4)}`,
  displayName: 'New seeker',
  bio: '',
  avatar: null,
  seekerVerified: false,
  reputation: 0,
})
