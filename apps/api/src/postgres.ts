import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { databaseTls } from '../../../scripts/db-tls.mjs'
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
  type Profile,
  type Repository,
  type Session,
  type TransactionIntent,
} from './domain.js'

// Server connection to Supabase's session pooler; no credentials reach the app.
export class PostgresRepository implements Repository {
  readonly sql: ReturnType<typeof postgres>
  constructor(url: string) {
    // postgres.js supports max_pipeline at runtime but 3.4.7 omits it from its Options type.
    const options = {
      max: 5,
      max_pipeline: 1,
      prepare: false,
      ssl: databaseTls(url, { allowLocal: true }),
      idle_timeout: 20,
      connect_timeout: 10,
    }
    this.sql = postgres(url, options)
  }
  async putChallenge(challenge: Challenge) {
    await this
      .sql`insert into private.wallet_challenges (id, address, message, expires_at) values (${challenge.id}, ${challenge.address}, ${challenge.message}, ${new Date(challenge.expiresAt)})`
  }
  async consumeChallenge(id: string, now: number): Promise<Challenge | null> {
    const rows = await this
      .sql`delete from private.wallet_challenges where id = ${id} returning id, address, message, expires_at`
    const row = rows[0]
    if (!row || new Date(row.expires_at).getTime() <= now) return null
    return {
      id: row.id,
      address: row.address,
      message: row.message,
      expiresAt: new Date(row.expires_at).getTime(),
    }
  }
  async putSession(session: Session) {
    await this
      .sql`insert into private.wallet_sessions (token_hash, wallet, expires_at) values (${session.hash}, ${session.wallet}, ${new Date(session.expiresAt)})`
  }
  async getSession(hash: string, now: number): Promise<Session | null> {
    const [row] = await this
      .sql`select token_hash, wallet, expires_at from private.wallet_sessions where token_hash = ${hash} and expires_at > ${new Date(now)}`
    return row
      ? { hash: row.token_hash, wallet: row.wallet, expiresAt: new Date(row.expires_at).getTime() }
      : null
  }
  async revokeSession(hash: string) {
    await this.sql`delete from private.wallet_sessions where token_hash = ${hash}`
  }
  async ensureProfile(wallet: string): Promise<Profile> {
    const profile = newProfile(wallet)
    await this
      .sql`insert into public.profiles (wallet, data) values (${wallet}, ${this.sql.json(profile as unknown as postgres.JSONValue)}) on conflict (wallet) do nothing`
    return (await this.getProfile(wallet))!
  }
  async getProfile(wallet: string): Promise<Profile | null> {
    const [row] = await this.sql`select data from public.profiles where wallet = ${wallet}`
    return row?.data ?? null
  }
  async listProfiles(): Promise<Profile[]> {
    return (await this.sql`select data from public.profiles order by created_at desc limit 100`).map(
      (row) => row.data,
    )
  }
  async saveProfile(profile: Profile) {
    await this
      .sql`update public.profiles set data = ${this.sql.json(profile as unknown as postgres.JSONValue)} where wallet = ${profile.wallet}`
  }
  async listPosts(options?: { includeHidden?: boolean }): Promise<Post[]> {
    return (
      await this.sql`select data from public.posts where status = 'ready' and
        (${options?.includeHidden === true} or data->'feedHidden' is distinct from 'true'::jsonb)
        order by created_at desc limit 100`
    ).map((row) => row.data)
  }
  async getPostSummaries(postIds: string[], wallet = ''): Promise<Record<string, PostSummary>> {
    if (postIds.length > 100) throw new Error('Post summary batch exceeds the feed limit.')
    if (!postIds.length) return {}
    const rows = await this.sql`select p.id, creator.data as creator,
      reaction.total as like_count, coalesce(reaction.liked, false) as liked,
      (select count(*)::int from (select 1 from public.comments c where c.post_id = p.id limit 100) comments) as comment_count
      from public.posts p
      left join public.profiles creator on creator.wallet = p.creator_wallet
      left join lateral (
        select count(*)::int as total, bool_or(l.wallet = ${wallet}) as liked
        from public.likes l where l.post_id = p.id
      ) reaction on true
      where p.id = any(${postIds}::text[])`
    return Object.fromEntries(
      rows.map((row) => [
        row.id,
        {
          creator: row.creator ?? null,
          likes: { count: row.like_count, liked: row.liked },
          commentCount: row.comment_count,
        },
      ]),
    )
  }
  async listOwnPosts(wallet: string): Promise<Post[]> {
    return (
      await this
        .sql`select data from public.posts where creator_wallet = ${wallet} order by created_at desc limit 100`
    ).map((row) => row.data)
  }
  async getPost(id: string): Promise<Post | null> {
    const [row] = await this.sql`select data from public.posts where id = ${id}`
    return row?.data ?? null
  }
  async insertPost(post: Post) {
    await this
      .sql`insert into public.posts (id, creator_wallet, stream_uid, status, data, created_at) values (${post.id}, ${post.creatorWallet}, ${post.streamUid}, ${post.status}, ${this.sql.json(post as unknown as postgres.JSONValue)}, ${post.createdAt})`
  }
  async updateStream(
    uid: string,
    status: Post['status'],
    videoUrl: string | null,
    thumbnailUrl: string | null,
  ) {
    const rows = await this
      .sql`update public.posts set status = ${status}, data = data || ${this.sql.json({ status, videoUrl, thumbnailUrl })} where stream_uid = ${uid} and status = 'processing' returning id`
    return rows.length > 0
  }
  async listComments(postId: string): Promise<Comment[]> {
    return (
      await this
        .sql`select data from public.comments where post_id = ${postId} order by created_at desc limit 100`
    ).map((row) => row.data)
  }
  async addComment(comment: Comment) {
    await this
      .sql`insert into public.comments (id, post_id, wallet, data, created_at) values (${comment.id}, ${comment.postId}, ${comment.wallet}, ${this.sql.json(comment as unknown as postgres.JSONValue)}, ${comment.createdAt})`
  }
  async setLike(postId: string, wallet: string, liked: boolean) {
    if (liked)
      await this
        .sql`insert into public.likes (post_id, wallet) values (${postId}, ${wallet}) on conflict do nothing`
    else await this.sql`delete from public.likes where post_id = ${postId} and wallet = ${wallet}`
  }
  async likes(postId: string, wallet = '') {
    const [row] = await this
      .sql`select count(*)::int as count, coalesce(bool_or(wallet = ${wallet}), false) as liked from public.likes where post_id = ${postId}`
    return { count: row.count as number, liked: row.liked as boolean }
  }
  async setFollow(wallet: string, target: string, following: boolean) {
    if (following)
      await this
        .sql`insert into public.follows (wallet, target_wallet) values (${wallet}, ${target}) on conflict do nothing`
    else await this.sql`delete from public.follows where wallet = ${wallet} and target_wallet = ${target}`
  }
  async following(wallet: string): Promise<string[]> {
    return (await this.sql`select target_wallet from public.follows where wallet = ${wallet}`).map(
      (row) => row.target_wallet,
    )
  }
  async getCampaign(id: string): Promise<Campaign | null> {
    const [row] = await this.sql`select data from private.campaigns where id = ${id}`
    return row?.data ?? null
  }
  async putCampaign(campaign: Campaign) {
    await this.sql.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtext('clout:campaign-registration'))`
      const [pending] =
        await sql`select id from private.reward_claims where campaign_id <> ${campaign.id} and data->>'state' <> 'finalized' and not (data->>'state' = 'failed' and coalesce((data->>'attemptCount')::int, 0) >= 3) limit 1`
      if (pending) throw new Error('A previous campaign still has unresolved reward claims.')
      await sql`insert into private.campaigns (id, data) values (${campaign.id}, ${sql.json(campaign as unknown as postgres.JSONValue)}) on conflict do nothing`
      const [existing] = await sql`select data from private.campaigns where id = ${campaign.id}`
      if (
        !existing ||
        Object.keys(campaign).some((key) => existing.data[key] !== campaign[key as keyof Campaign])
      )
        throw new Error('Campaign configuration cannot change under the same ID.')
      await sql`update private.campaigns set data = data || jsonb_build_object('active', id = ${campaign.id})`
    })
  }
  async listClaims(campaignId: string): Promise<Claim[]> {
    return (
      await this
        .sql`select data from private.reward_claims where campaign_id = ${campaignId} order by created_at limit 10000`
    ).map((row) => row.data)
  }
  async acquireClaim(id: string, now: number): Promise<Claim | null> {
    const patch = { leaseToken: randomUUID(), leaseExpiresAt: now + 90000 }
    const [row] = await this
      .sql`update private.reward_claims set data = data || ${this.sql.json(patch)} where id = ${id} and data->>'state' not in ('finalized', 'expired') and coalesce((data->>'leaseExpiresAt')::bigint, 0) <= ${now} returning data`
    return row?.data ?? null
  }
  async saveClaim(claim: Claim, leaseToken: string) {
    const rows = await this
      .sql`update private.reward_claims set data = ${this.sql.json(claim as unknown as postgres.JSONValue)} where id = ${claim.id} and data->>'leaseToken' = ${leaseToken} and data->>'state' <> 'finalized' returning id`
    return rows.length === 1
  }
  async releaseClaim(id: string, leaseToken: string) {
    await this
      .sql`update private.reward_claims set data = data || '{"leaseToken":null,"leaseExpiresAt":0}'::jsonb where id = ${id} and data->>'leaseToken' = ${leaseToken}`
  }
  async reserveClaim(campaign: Campaign, sgtMint: string, wallet: string): Promise<Claim> {
    return this.sql.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtext('clout:campaign-registration'))`
      const [locked] = await sql`select data from private.campaigns where id = ${campaign.id} for update`
      if (locked?.data.period === 'utc-day') throw new Error('Daily faucet reservation required.')
      if (!locked?.data.enabled || locked.data.active !== true)
        throw new ApiError(503, 'CAMPAIGN_DISABLED', 'This reward campaign is not active.')
      const [existing] =
        await sql`select data from private.reward_claims where campaign_id = ${campaign.id} and (sgt_mint = ${sgtMint} or wallet = ${wallet})`
      if (existing) {
        if (existing.data.wallet !== wallet)
          throw new ApiError(409, 'ALREADY_CLAIMED', 'This Seeker has already reserved this reward.')
        return existing.data as Claim
      }
      const [count] =
        await sql`select count(*)::int as total from private.reward_claims where campaign_id = ${campaign.id}`
      if (count.total >= locked.data.maxClaims)
        throw new ApiError(409, 'CAMPAIGN_FULL', 'All rewards have been reserved.')
      const claim: Claim = {
        id: randomUUID(),
        campaignId: campaign.id,
        sgtMint,
        wallet,
        amount: locked.data.amount,
        state: 'reserved',
        signature: null,
        signedTransaction: null,
        lastValidBlockHeight: null,
        createdAt: new Date().toISOString(),
      }
      await sql`insert into private.reward_claims (id, campaign_id, sgt_mint, wallet, data) values (${claim.id}, ${claim.campaignId}, ${sgtMint}, ${wallet}, ${sql.json(claim as unknown as postgres.JSONValue)})`
      return claim
    }) as Promise<Claim>
  }
  async getClaim(id: string): Promise<Claim | null> {
    const [row] = await this.sql`select data from private.reward_claims where id = ${id}`
    return row?.data ?? null
  }
  async getFaucetBudget(campaignId: string): Promise<FaucetBudget | null> {
    const [row] = await this
      .sql`select baseline_supply::text, allocated_units::text, max_supply::text from private.faucet_budgets where campaign_id = ${campaignId}`
    return row
      ? {
          baselineSupply: row.baseline_supply,
          allocatedUnits: row.allocated_units,
          maxSupply: row.max_supply,
        }
      : null
  }
  async registerFaucetBudget(campaign: Campaign, baselineSupply: string) {
    await this.sql.begin(async (sql) => {
      await sql`select id from private.campaigns where id = ${campaign.id} for update`
      const [existing] =
        await sql`select max_supply::text from private.faucet_budgets where campaign_id = ${campaign.id}`
      if (existing) {
        if (existing.max_supply !== campaign.maxSupply)
          throw new Error('Faucet supply ceiling cannot change.')
        return
      }
      await sql`insert into private.faucet_budgets (campaign_id, baseline_supply, allocated_units, max_supply)
        select ${campaign.id}, ${baselineSupply}::numeric,
          coalesce(sum((data->>'amount')::numeric), 0), ${campaign.maxSupply!}::numeric
        from private.reward_claims where campaign_id = ${campaign.id} and data->>'state' <> 'finalized'
          and not (data->>'state' = 'failed' and coalesce((data->>'attemptCount')::int, 0) >= 3)
        on conflict (campaign_id) do nothing`
    })
  }
  async getFaucetState(campaignId: string, wallet?: string): Promise<FaucetState> {
    const [window] = await this.sql`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD') as day`
    const [row] = await this.sql`select
      (select count(*)::int from private.reward_claims where campaign_id = ${campaignId} and claim_day = ${window.day}::date) as today,
      (select data from private.reward_claims where campaign_id = ${campaignId} and wallet = ${wallet ?? ''} and
        (claim_day = ${window.day}::date or (data->>'state' <> 'finalized' and not (data->>'state' = 'failed' and coalesce((data->>'attemptCount')::int, 0) >= 3))) order by created_at limit 1) as claim,
      baseline_supply::text, allocated_units::text, max_supply::text
      from private.faucet_budgets where campaign_id = ${campaignId}`
    if (!row) throw new Error('Daily faucet budget is not initialized.')
    return {
      day: window.day,
      resetAt: new Date(Date.parse(`${window.day}T00:00:00.000Z`) + 86400000).toISOString(),
      claimsToday: row.today,
      budget: {
        baselineSupply: row.baseline_supply,
        allocatedUnits: row.allocated_units,
        maxSupply: row.max_supply,
      },
      claim: row.claim ?? null,
    }
  }
  async reserveFaucetClaim(campaignId: string, wallet: string): Promise<Claim> {
    try {
      const [row] = await this
        .sql`select private.reserve_daily_faucet(${campaignId}, ${wallet}, ${randomUUID()}::uuid) as claim`
      return row.claim
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      if (code === 'FAUCET_DAILY_CAP')
        throw new ApiError(409, code, 'Today’s faucet allocations have all been reserved.')
      if (code === 'FAUCET_SUPPLY_CAP')
        throw new ApiError(503, code, 'The mock mint supply ceiling has been reached.')
      if (code === 'FAUCET_DISABLED') throw new ApiError(503, code, 'The daily faucet is disabled.')
      throw error
    }
  }
  async listPendingClaims(
    campaignId: string,
    afterId = '00000000-0000-0000-0000-000000000000',
  ): Promise<Claim[]> {
    return (
      await this
        .sql`select data from private.reward_claims where campaign_id = ${campaignId} and id > ${afterId}::uuid
      and data->>'state' not in ('finalized', 'expired') and not (data->>'state' = 'failed' and coalesce((data->>'attemptCount')::int, 0) >= 3)
      order by id limit 100`
    ).map((row) => row.data)
  }
  async ingest(events: IndexedEvent[], checkpoint: { source: string; signature: string; slot: number }) {
    await this.sql.begin(async (sql) => {
      for (const event of events)
        await sql`insert into private.indexed_events (signature, instruction_path, slot, wallet, post_id, finality, data) values (${event.signature}, ${event.instructionPath}, ${event.slot}, ${event.wallet}, ${event.postId}, ${event.finality}, ${sql.json(event as unknown as postgres.JSONValue)}) on conflict (signature, instruction_path) do update set finality = excluded.finality, data = excluded.data where indexed_events.finality <> 'finalized'`
      await sql`insert into private.indexer_checkpoints (source, signature, slot) values (${checkpoint.source}, ${checkpoint.signature}, ${checkpoint.slot}) on conflict (source) do update set signature = excluded.signature, slot = excluded.slot where indexer_checkpoints.slot <= excluded.slot`
    })
  }
  async reconcile(signature: string, status: 'finalized' | 'dropped') {
    if (status === 'dropped')
      await this
        .sql`delete from private.indexed_events where signature = ${signature} and finality <> 'finalized'`
    else
      await this
        .sql`update private.indexed_events set finality = 'finalized', data = data || '{"finality":"finalized"}'::jsonb where signature = ${signature}`
  }
  async getEvents(wallet: string): Promise<IndexedEvent[]> {
    return (
      await this
        .sql`select data from private.indexed_events where wallet = ${wallet} order by slot desc limit 1000`
    ).map((row) => row.data)
  }
  async getPostEvents(postId: string): Promise<IndexedEvent[]> {
    return (
      await this
        .sql`select data from private.indexed_events where post_id = ${postId} order by slot desc, signature collate "C" desc, instruction_path collate "C" desc limit 100`
    ).map((row) => row.data)
  }
  async putIntent(intent: TransactionIntent) {
    await this
      .sql`insert into private.transaction_intents (id, wallet, post_id, state, data) values (${intent.id}, ${intent.wallet}, ${intent.postId || null}, ${intent.state}, ${this.sql.json(intent as unknown as postgres.JSONValue)}) on conflict do nothing`
  }
  async getIntent(id: string): Promise<TransactionIntent | null> {
    const [row] = await this.sql`select data from private.transaction_intents where id = ${id}`
    return row?.data ?? null
  }
  async getActiveLaunch(postId: string): Promise<TransactionIntent | null> {
    const [row] = await this
      .sql`select data from private.transaction_intents where post_id = ${postId} and data->>'kind' = 'launch' and state not in ('failed', 'expired') limit 1`
    return row?.data ?? null
  }
  async listUnsettledIntents(): Promise<TransactionIntent[]> {
    return (
      await this
        .sql`select data from private.transaction_intents where state in ('prepared', 'pending', 'confirmed') order by created_at limit 100`
    ).map((row) => row.data)
  }
  async updateIntent(id: string, state: TransactionIntent['state'], signature: string | null) {
    await this
      .sql`update private.transaction_intents set state = ${state}, signature = ${signature}, data = data || ${this.sql.json({ state, signature })} where id = ${id} and state <> 'finalized' and (signature is null or signature = ${signature})`
  }
  async attachMarket(postId: string, market: NonNullable<Post['market']>) {
    await this
      .sql`update public.posts set data = data || ${this.sql.json({ market })} where id = ${postId} and data->>'market' is null`
  }
  async putQuote(id: string, value: Record<string, unknown>) {
    await this
      .sql`insert into private.trade_quotes (id, data, expires_at) values (${id}, ${this.sql.json(value as postgres.JSONValue)}, ${String(value.expiresAt)}) on conflict (id) do nothing`
  }
  async getQuote(id: string): Promise<Record<string, unknown> | null> {
    const [row] = await this
      .sql`select data from private.trade_quotes where id = ${id} and expires_at > now()`
    return row?.data ?? null
  }
  async close() {
    await this.sql.end()
  }
}
