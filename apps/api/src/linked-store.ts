import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import { ApiError, type Post, type Repository } from './domain.js'
export interface LinkedAccount {
  id: string
  wallet: string
  provider: 'x' | 'fomo'
  providerUserId: string
  handle: string
  displayName: string
  status: 'active' | 'paused' | 'reauthorization_required' | 'error'
  tokens: string
  createdAt: string
  since: string
  sinceId?: string
  pageToken?: string | null
  pageNewestId?: string | null
  nextPollAt: number
  lastImportedAt?: string
  lastError?: string
  leaseToken?: string
  leaseUntil?: number
}
export interface OAuthAttempt {
  hash: string
  wallet: string
  sessionHash: string
  secret: string
  expiresAt: number
  accountId?: string
  browserHash?: string
  clientChallenge: string
  completionHash?: string
  grant?: string
  completedAccountId?: string
}
export interface OAuthProof {
  hash: string
  wallet: string
  sessionHash: string
  completionHash: string
  clientChallenge: string
  now: number
}
export interface ImportJob {
  id: string
  accountId: string
  wallet: string
  provider: string
  sourceId: string
  videoUrl: string
  post: Post
  state: 'queued' | 'submitting' | 'processing' | 'ready' | 'failed' | 'needs_review'
  streamUid?: string
}
export interface LinkedStore {
  putOAuth(attempt: OAuthAttempt): Promise<void>
  beginOAuth(hash: string, browserHash: string, now: number): Promise<OAuthAttempt | null>
  consumeOAuth(hash: string, browserHash: string, now: number): Promise<OAuthAttempt | null>
  putCompletion(attempt: OAuthAttempt): Promise<void>
  getCompletion(proof: OAuthProof): Promise<OAuthAttempt | null>
  finishCompletion(proof: OAuthProof, account: LinkedAccount): Promise<boolean>
  list(wallet?: string): Promise<LinkedAccount[]>
  get(id: string): Promise<LinkedAccount | null>
  connect(account: LinkedAccount): Promise<void>
  change(id: string, wallet: string, action: 'pause' | 'resume' | 'disconnect'): Promise<void>
  acquire(id: string, now: number): Promise<LinkedAccount | null>
  save(id: string, lease: string, patch: Partial<LinkedAccount>): Promise<boolean>
  release(id: string, lease: string): Promise<void>
  reserve(job: ImportJob): Promise<boolean>
  jobs(accountId: string): Promise<ImportJob[]>
  markSubmitting(id: string): Promise<boolean>
  getJob(id: string): Promise<ImportJob | null>
  jobByStream(uid: string): Promise<ImportJob | null>
  bind(id: string, uid: string): Promise<boolean>
  finish(id: string, state: 'ready' | 'failed' | 'needs_review'): Promise<void>
}
const clone = <T>(value: T): T => structuredClone(value)
const matchesProof = (row: OAuthAttempt | undefined, proof: OAuthProof) =>
  !!row &&
  row.expiresAt > proof.now &&
  row.wallet === proof.wallet &&
  row.sessionHash === proof.sessionHash &&
  row.completionHash === proof.completionHash &&
  row.clientChallenge === proof.clientChallenge
const missing = () => new ApiError(404, 'LINK_NOT_FOUND', 'Linked account not found.')
export class MemoryLinkedStore implements LinkedStore {
  accounts = new Map<string, LinkedAccount>()
  attempts = new Map<string, OAuthAttempt>()
  imports = new Map<string, ImportJob>()
  constructor(private repository: Repository) {}
  async putOAuth(row: OAuthAttempt) {
    for (const [id, prior] of this.attempts)
      if (prior.expiresAt <= Date.now() || prior.wallet === row.wallet) this.attempts.delete(id)
    this.attempts.set(row.hash, clone(row))
  }
  async beginOAuth(hash: string, browserHash: string, now: number) {
    const row = this.attempts.get(hash)
    if (!row || row.completionHash || row.browserHash || row.expiresAt <= now) return null
    row.browserHash = browserHash
    return clone(row)
  }
  async consumeOAuth(hash: string, browserHash: string, now: number) {
    const row = this.attempts.get(hash)
    if (!row || row.completionHash || row.browserHash !== browserHash || row.expiresAt <= now) return null
    this.attempts.delete(hash)
    return clone(row)
  }
  async putCompletion(row: OAuthAttempt) {
    this.attempts.set(row.hash, clone(row))
  }
  async getCompletion(proof: OAuthProof) {
    const row = this.attempts.get(proof.hash)
    return matchesProof(row, proof) ? clone(row!) : null
  }
  async finishCompletion(proof: OAuthProof, account: LinkedAccount) {
    const row = this.attempts.get(proof.hash)
    if (!matchesProof(row, proof)) return false
    if (row!.completedAccountId) return true
    await this.connect(account)
    row!.completedAccountId = account.id
    delete row!.grant
    row!.secret = ''
    return true
  }
  async list(wallet?: string) {
    return [...this.accounts.values()].filter((row) => !wallet || row.wallet === wallet).map(clone)
  }
  async get(id: string) {
    return clone(this.accounts.get(id) ?? null)
  }
  async connect(account: LinkedAccount) {
    const prior = [...this.accounts.values()].find(
      (row) => row.provider === account.provider && row.providerUserId === account.providerUserId,
    )
    if (prior && prior.wallet !== account.wallet)
      throw new ApiError(409, 'ACCOUNT_ALREADY_LINKED', 'This account is linked to another Clout wallet.')
    if (!prior && [...this.accounts.values()].filter((row) => row.wallet === account.wallet).length >= 3)
      throw new ApiError(409, 'ACCOUNT_LIMIT', 'You can link up to three accounts in total.')
    if (prior) {
      account.id = prior.id
      account.createdAt = prior.createdAt
      account.since = prior.since
      account.sinceId = prior.sinceId
    }
    this.accounts.set(account.id, clone(account))
  }
  async change(id: string, wallet: string, action: 'pause' | 'resume' | 'disconnect') {
    const row = this.accounts.get(id)
    if (!row || row.wallet !== wallet) throw missing()
    if (action === 'disconnect') {
      this.accounts.delete(id)
      return
    }
    if (action === 'resume' && row.status === 'reauthorization_required')
      throw new ApiError(409, 'X_REAUTH_REQUIRED', 'Reconnect this account first.')
    row.status = action === 'pause' ? 'paused' : 'active'
    row.nextPollAt = 0
    delete row.leaseToken
    row.leaseUntil = 0
  }
  async acquire(id: string, now: number) {
    const row = this.accounts.get(id)
    if (!row || row.status !== 'active' || row.nextPollAt > now || (row.leaseUntil ?? 0) > now) return null
    row.leaseToken = randomUUID()
    row.leaseUntil = now + 15 * 60_000
    return clone(row)
  }
  async save(id: string, lease: string, patch: Partial<LinkedAccount>) {
    const row = this.accounts.get(id)
    if (!row || row.leaseToken !== lease) return false
    Object.assign(row, clone(patch))
    return true
  }
  async release(id: string, lease: string) {
    const row = this.accounts.get(id)
    if (row?.leaseToken === lease) {
      delete row.leaseToken
      row.leaseUntil = 0
    }
  }
  async reserve(job: ImportJob) {
    if (
      [...this.imports.values()].some(
        (row) => row.wallet === job.wallet && row.provider === job.provider && row.sourceId === job.sourceId,
      )
    )
      return false
    this.imports.set(job.id, clone(job))
    try {
      await this.repository.insertPost(job.post)
    } catch (error) {
      this.imports.delete(job.id)
      throw error
    }
    return true
  }
  async jobs(id: string) {
    return [...this.imports.values()]
      .filter((row) => row.accountId === id && ['queued', 'submitting', 'processing'].includes(row.state))
      .slice(0, 100)
      .map(clone)
  }
  async markSubmitting(id: string) {
    const job = this.imports.get(id)
    if (job?.state !== 'queued') return false
    job.state = 'submitting'
    return true
  }
  async getJob(id: string) {
    return clone(this.imports.get(id) ?? null)
  }
  async jobByStream(uid: string) {
    return clone([...this.imports.values()].find((job) => job.streamUid === uid) ?? null)
  }
  async bind(id: string, uid: string) {
    const job = this.imports.get(id)
    if (
      !job ||
      !['submitting', 'processing', 'needs_review'].includes(job.state) ||
      (job.streamUid && job.streamUid !== uid)
    )
      return false
    job.streamUid = uid
    job.state = 'processing'
    const post = await this.repository.getPost(job.post.id)
    if (!post) return false
    post.streamUid = uid
    job.post.streamUid = uid
    return true
  }
  async finish(id: string, state: 'ready' | 'failed' | 'needs_review') {
    const job = this.imports.get(id)
    if (job && job.state !== 'ready') {
      job.state = state
      const account = this.accounts.get(job.accountId)
      if (state === 'ready' && account) {
        account.lastImportedAt = new Date().toISOString()
        delete account.lastError
      }
    }
  }
}
export class PostgresLinkedStore implements LinkedStore {
  constructor(private sql: ReturnType<typeof postgres>) {}
  private json(value: unknown) {
    return this.sql.json(value as postgres.JSONValue)
  }
  async putOAuth(row: OAuthAttempt) {
    await this.sql.begin(async (sql) => {
      await sql`delete from private.link_oauth where wallet = ${row.wallet} or expires_at <= now()`
      await sql`insert into private.link_oauth(hash,wallet,expires_at,data) values (${row.hash},${row.wallet},${new Date(row.expiresAt)},${this.json(row)})`
    })
  }
  async beginOAuth(hash: string, browserHash: string, now: number): Promise<OAuthAttempt | null> {
    const [row] = await this
      .sql`update private.link_oauth set data = data || ${this.json({ browserHash })} where hash=${hash} and expires_at > ${new Date(now)} and data->>'browserHash' is null and data->>'completionHash' is null returning data`
    return row?.data ?? null
  }
  async consumeOAuth(hash: string, browserHash: string, now: number): Promise<OAuthAttempt | null> {
    const [row] = await this
      .sql`delete from private.link_oauth where hash=${hash} and expires_at > ${new Date(now)} and data->>'browserHash'=${browserHash} and data->>'completionHash' is null returning data`
    return row?.data ?? null
  }
  async putCompletion(row: OAuthAttempt) {
    await this
      .sql`insert into private.link_oauth(hash,wallet,expires_at,data) values (${row.hash},${row.wallet},${new Date(row.expiresAt)},${this.json(row)})`
  }
  async getCompletion(proof: OAuthProof): Promise<OAuthAttempt | null> {
    const [row] = await this
      .sql`select data from private.link_oauth where hash=${proof.hash} and wallet=${proof.wallet} and expires_at > ${new Date(proof.now)} and data->>'sessionHash'=${proof.sessionHash} and data->>'completionHash'=${proof.completionHash} and data->>'clientChallenge'=${proof.clientChallenge}`
    return row?.data ?? null
  }
  async finishCompletion(proof: OAuthProof, account: LinkedAccount) {
    return this.sql.begin(async (sql) => {
      const [row] =
        await sql`select data from private.link_oauth where hash=${proof.hash} and wallet=${proof.wallet} and expires_at > ${new Date(proof.now)} and data->>'sessionHash'=${proof.sessionHash} and data->>'completionHash'=${proof.completionHash} and data->>'clientChallenge'=${proof.clientChallenge} for update`
      if (!row) return false
      if (row.data.completedAccountId) return true
      await this.connectRows(sql, account, row.data.accountId)
      await sql`update private.link_oauth set data=(data - 'grant' - 'secret') || ${this.json({ completedAccountId: account.id })} where hash=${proof.hash}`
      return true
    })
  }
  async list(wallet?: string): Promise<LinkedAccount[]> {
    const rows = wallet
      ? await this.sql`select data from private.linked_accounts where wallet=${wallet} order by created_at`
      : await this
          .sql`select data from private.linked_accounts where data->>'status'='active' and coalesce((data->>'nextPollAt')::bigint,0) <= ${Date.now()} order by coalesce((data->>'nextPollAt')::bigint,0) limit 100`
    return rows.map((row) => row.data)
  }
  async get(id: string): Promise<LinkedAccount | null> {
    const [row] = await this.sql`select data from private.linked_accounts where id=${id}`
    return row?.data ?? null
  }
  async connect(account: LinkedAccount) {
    await this.sql.begin((sql) => this.connectRows(sql, account))
  }
  private async connectRows(sql: postgres.TransactionSql, account: LinkedAccount, expectedId?: string) {
    await sql`select pg_advisory_xact_lock(hashtext(${`clout:links:${account.wallet}`}))`
    const [prior] =
      await sql`select data from private.linked_accounts where provider=${account.provider} and provider_user_id=${account.providerUserId} for update`
    if (expectedId && prior?.data.id !== expectedId)
      throw new ApiError(409, 'WRONG_X_ACCOUNT', 'This reconnect request is no longer valid.')
    if (prior && prior.data.wallet !== account.wallet)
      throw new ApiError(409, 'ACCOUNT_ALREADY_LINKED', 'This account is linked to another Clout wallet.')
    if (prior) {
      account.id = prior.data.id
      account.createdAt = prior.data.createdAt
      account.since = prior.data.since
      account.sinceId = prior.data.sinceId
      await sql`update private.linked_accounts set data=${this.json(account)} where id=${account.id}`
      return
    }
    const [count] =
      await sql`select count(*)::int as value from private.linked_accounts where wallet=${account.wallet}`
    if (count.value >= 3)
      throw new ApiError(409, 'ACCOUNT_LIMIT', 'You can link up to three accounts in total.')
    await sql`insert into private.linked_accounts(id,wallet,provider,provider_user_id,data) values (${account.id},${account.wallet},${account.provider},${account.providerUserId},${this.json(account)})`
  }
  async change(id: string, wallet: string, action: 'pause' | 'resume' | 'disconnect') {
    if (action === 'disconnect') {
      const rows = await this
        .sql`delete from private.linked_accounts where id=${id} and wallet=${wallet} returning id`
      if (!rows.length) throw missing()
      return
    }
    const rows = await this
      .sql`update private.linked_accounts set data=data || ${this.json({ status: action === 'pause' ? 'paused' : 'active', nextPollAt: 0, leaseToken: null, leaseUntil: 0 })} where id=${id} and wallet=${wallet} and (${action} <> 'resume' or data->>'status' <> 'reauthorization_required') returning id`
    if (!rows.length) {
      const row = await this.get(id)
      if (row?.wallet === wallet && row.status === 'reauthorization_required')
        throw new ApiError(409, 'X_REAUTH_REQUIRED', 'Reconnect this account first.')
      throw missing()
    }
  }
  async acquire(id: string, now: number): Promise<LinkedAccount | null> {
    const [row] = await this
      .sql`update private.linked_accounts set data=data || ${this.json({ leaseToken: randomUUID(), leaseUntil: now + 15 * 60_000 })} where id=${id} and data->>'status'='active' and coalesce((data->>'leaseUntil')::bigint,0)<=${now} and coalesce((data->>'nextPollAt')::bigint,0)<=${now} returning data`
    return row?.data ?? null
  }
  async save(id: string, lease: string, patch: Partial<LinkedAccount>) {
    const rows = await this
      .sql`update private.linked_accounts set data=data || ${this.json(patch)} where id=${id} and data->>'leaseToken'=${lease} returning id`
    return rows.length === 1
  }
  async release(id: string, lease: string) {
    await this
      .sql`update private.linked_accounts set data=data || '{"leaseToken":null,"leaseUntil":0}'::jsonb where id=${id} and data->>'leaseToken'=${lease}`
  }
  async reserve(job: ImportJob) {
    return (await this.sql.begin(async (sql) => {
      const rows =
        await sql`insert into private.link_imports(id,account_id,wallet,provider,source_id,post_id,data) values (${job.id},${job.accountId},${job.wallet},${job.provider},${job.sourceId},${job.post.id},${this.json(job)}) on conflict(wallet,provider,source_id) do nothing returning id`
      if (!rows.length) return false
      const p = job.post
      await sql`insert into public.posts(id,creator_wallet,stream_uid,status,data,created_at) values (${p.id},${p.creatorWallet},null,${p.status},${this.json(p)},${p.createdAt})`
      return true
    })) as unknown as boolean
  }
  async jobs(id: string): Promise<ImportJob[]> {
    return (
      await this
        .sql`select data from private.link_imports where account_id=${id} and data->>'state' in ('queued','submitting','processing') order by created_at limit 100`
    ).map((row) => row.data)
  }
  async markSubmitting(id: string) {
    return (
      (
        await this
          .sql`update private.link_imports set data=data || '{"state":"submitting"}'::jsonb where id=${id} and data->>'state'='queued' returning id`
      ).length === 1
    )
  }
  async getJob(id: string): Promise<ImportJob | null> {
    const [row] = await this.sql`select data from private.link_imports where id=${id}`
    return row?.data ?? null
  }
  async jobByStream(uid: string): Promise<ImportJob | null> {
    const [row] = await this.sql`select data from private.link_imports where data->>'streamUid'=${uid}`
    return row?.data ?? null
  }
  async bind(id: string, uid: string) {
    return (await this.sql.begin(async (sql) => {
      const [row] =
        await sql`update private.link_imports set data=data || ${this.json({ streamUid: uid, state: 'processing' })} where id=${id} and data->>'state' in ('submitting','processing','needs_review') and (data->>'streamUid' is null or data->>'streamUid'=${uid}) returning post_id`
      if (!row) return false
      await sql`update public.posts set stream_uid=${uid},data=data || ${this.json({ streamUid: uid })} where id=${row.post_id} and (stream_uid is null or stream_uid=${uid})`
      return true
    })) as unknown as boolean
  }
  async finish(id: string, state: 'ready' | 'failed' | 'needs_review') {
    await this.sql.begin(async (sql) => {
      const [row] =
        await sql`update private.link_imports set data=data || ${this.json({ state })} where id=${id} and data->>'state'<>'ready' returning account_id`
      if (row && state === 'ready')
        await sql`update private.linked_accounts set data=(data - 'lastError') || ${this.json({ lastImportedAt: new Date().toISOString() })} where id=${row.account_id}`
    })
  }
}
