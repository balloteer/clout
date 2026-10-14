import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { ApiError, type Repository, type Session } from './domain.js'
import type { MediaService } from './media.js'
import { TokenVault, isXVideoUrl, type LinkedProvider, type ProviderTokens } from './linked-provider.js'
import type { LinkedAccount, LinkedStore } from './linked-store.js'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const tokenContext = (account: Pick<LinkedAccount, 'wallet' | 'provider' | 'providerUserId'>) =>
  `${account.wallet}:${account.provider}:${account.providerUserId}`
export const linkedUnavailable = {
  limit: 3,
  providers: {
    x: { available: false, reason: 'X importing needs server OAuth and video processing configuration.' },
    fomo: {
      available: false,
      reason: 'Fomo integration is awaiting the exact service and supported account API.',
    },
  },
  accounts: [],
}
export class LinkedAccountService {
  constructor(
    private store: LinkedStore,
    private repository: Repository,
    private provider: LinkedProvider,
    private vault: TokenVault,
    private media: MediaService,
    private origin: string,
  ) {
    if (!media.copyVideo) throw new Error('Linked imports require Cloudflare Stream copy support.')
  }
  async list(wallet: string) {
    return {
      limit: 3,
      providers: { ...linkedUnavailable.providers, x: { available: true } },
      accounts: (await this.store.list(wallet)).map(
        ({ id, provider, handle, displayName, status, createdAt, lastImportedAt, lastError }) => ({
          id,
          provider,
          handle,
          displayName,
          status,
          createdAt,
          lastImportedAt,
          lastError,
        }),
      ),
    }
  }
  async connect(session: Session, provider: string, clientChallenge: string, accountId?: string) {
    if (provider !== 'x')
      throw new ApiError(503, 'PROVIDER_UNAVAILABLE', linkedUnavailable.providers.fomo.reason)
    if (!/^[a-f0-9]{64}$/.test(clientChallenge))
      throw new ApiError(400, 'OAUTH_CHALLENGE', 'Start account linking from Clout.')
    const accounts = await this.store.list(session.wallet)
    if (accountId && !accounts.some((row) => row.id === accountId && row.provider === provider))
      throw new ApiError(404, 'LINK_NOT_FOUND', 'Linked account not found.')
    if (!accountId && accounts.length >= 3)
      throw new ApiError(409, 'ACCOUNT_LIMIT', 'You can link up to three accounts in total.')
    const state = randomBytes(32).toString('base64url')
    const verifier = randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + 10 * 60_000
    await this.store.putOAuth({
      hash: hash(state),
      wallet: session.wallet,
      sessionHash: session.hash,
      clientChallenge,
      secret: this.vault.seal({ verifier }, hash(state)),
      expiresAt,
      accountId,
    })
    return {
      authorizationUrl: `${this.origin}/v1/linked-accounts/x/start?state=${state}`,
      expiresAt: new Date(expiresAt).toISOString(),
      state,
    }
  }
  async begin(state: string) {
    const browserToken = randomBytes(32).toString('base64url')
    const attempt = await this.store.beginOAuth(hash(state), hash(browserToken), Date.now())
    if (!attempt)
      throw new ApiError(400, 'OAUTH_EXPIRED', 'This account-link request expired. Start again in Clout.')
    const { verifier } = this.vault.open<{ verifier: string }>(attempt.secret, attempt.hash)
    return {
      location: this.provider.authorizationUrl(
        state,
        createHash('sha256').update(verifier).digest('base64url'),
      ),
      browserToken,
    }
  }
  async callback(state: string, browserToken: string, code: string) {
    const attempt = await this.store.consumeOAuth(hash(state), hash(browserToken), Date.now())
    if (!attempt)
      throw new ApiError(400, 'OAUTH_INVALID', 'Account linking could not be verified. Start again in Clout.')
    const session = await this.repository.getSession(attempt.sessionHash, Date.now())
    if (!session || session.wallet !== attempt.wallet)
      throw new ApiError(401, 'AUTH_REQUIRED', 'Reconnect your Clout wallet and link the account again.')
    const { verifier } = this.vault.open<{ verifier: string }>(attempt.secret, attempt.hash)
    const tokens = await this.provider.exchange(code, verifier)
    const identity = await this.provider.identity(tokens.accessToken)
    if (identity.protected)
      throw new ApiError(
        409,
        'PRIVATE_ACCOUNT',
        'Only public owned accounts can import into the public Clout feed.',
      )
    const target = attempt.accountId ? await this.store.get(attempt.accountId) : null
    if (
      attempt.accountId &&
      (!target || target.wallet !== attempt.wallet || target.providerUserId !== identity.id)
    )
      throw new ApiError(
        409,
        'WRONG_X_ACCOUNT',
        'Reconnect the same X account, or add a different account separately.',
      )
    const now = new Date().toISOString()
    const account: LinkedAccount = {
      id: target?.id ?? randomUUID(),
      wallet: attempt.wallet,
      provider: 'x',
      providerUserId: identity.id,
      handle: identity.handle,
      displayName: identity.displayName,
      status: 'active',
      createdAt: now,
      since: now,
      nextPollAt: 0,
      tokens: '',
    }
    account.tokens = this.vault.seal(tokens, tokenContext(account))
    const completion = randomBytes(32).toString('base64url')
    await this.store.putCompletion({
      ...attempt,
      secret: '',
      browserHash: undefined,
      expiresAt: Date.now() + 2 * 60_000,
      completionHash: hash(completion),
      grant: this.vault.seal(account, `${attempt.hash}:grant`),
    })
    // The only plaintext delivery is the OAuth callback browser's app redirect.
    // Neither the initiating wallet nor a polling endpoint can fetch this secret.
    return {
      location: `clout://linked-accounts?attempt=${encodeURIComponent(state)}&completion=${completion}`,
    }
  }
  async complete(session: Session, state: string, completion: string, verifier: string) {
    if (!/^[a-f0-9]{64}$/.test(verifier) || !/^[A-Za-z0-9_-]{43}$/.test(completion))
      throw new ApiError(400, 'OAUTH_INVALID', 'Account linking could not be verified. Start again in Clout.')
    const proof = {
      hash: hash(state),
      wallet: session.wallet,
      sessionHash: session.hash,
      completionHash: hash(completion),
      clientChallenge: hash(verifier),
      now: Date.now(),
    }
    const attempt = await this.store.getCompletion(proof)
    const liveSession = await this.repository.getSession(session.hash, Date.now())
    if (!attempt || liveSession?.wallet !== session.wallet)
      throw new ApiError(400, 'OAUTH_INVALID', 'Account linking could not be verified. Start again in Clout.')
    if (attempt.completedAccountId) return { ok: true }
    if (!attempt.grant) throw new ApiError(400, 'OAUTH_INVALID', 'Account authorization is not complete.')
    const account = this.vault.open<LinkedAccount>(attempt.grant, `${attempt.hash}:grant`)
    if (attempt.accountId) {
      const target = await this.store.get(attempt.accountId)
      if (!target || target.wallet !== session.wallet || target.providerUserId !== account.providerUserId)
        throw new ApiError(
          409,
          'WRONG_X_ACCOUNT',
          'This reconnect request is no longer valid. Start again in Clout.',
        )
    }
    if (!(await this.store.finishCompletion(proof, account)))
      throw new ApiError(400, 'OAUTH_INVALID', 'Account linking could not be verified. Start again in Clout.')
    return { ok: true }
  }
  change(wallet: string, id: string, action: 'pause' | 'resume' | 'disconnect') {
    return this.store.change(id, wallet, action)
  }
  async run(maxAccounts = Number.POSITIVE_INFINITY) {
    let checked = 0
    let failed = 0
    for (const candidate of (await this.store.list()).slice(0, maxAccounts)) {
      const account = await this.store.acquire(candidate.id, Date.now())
      if (!account?.leaseToken) continue
      checked++
      const lease = account.leaseToken
      try {
        let tokens = this.vault.open<ProviderTokens>(account.tokens, tokenContext(account))
        if (tokens.expiresAt < Date.now() + 60_000) {
          tokens = await this.provider.refresh(tokens.refreshToken)
          if (
            !(await this.store.save(account.id, lease, {
              tokens: this.vault.seal(tokens, tokenContext(account)),
            }))
          )
            continue
        }
        // Ownership and public visibility are rechecked on every poll, not trusted from linking time.
        const identity = await this.provider.identity(tokens.accessToken)
        if (identity.id !== account.providerUserId || identity.protected) {
          await this.store.save(account.id, lease, {
            status: 'paused',
            lastError: 'Importing paused because account ownership or public visibility changed.',
          })
          continue
        }
        let jobs = await this.store.jobs(account.id)
        if (this.media.inspectVideo)
          for (const job of jobs.filter((row) => row.state === 'processing' && row.streamUid).slice(0, 10)) {
            const video = await this.media.inspectVideo(job.streamUid!)
            await this.webhook(
              { ...video, meta: { importId: job.id, postId: job.post.id, creator: job.wallet } },
              job.streamUid!,
            )
          }
        if (!jobs.some((job) => job.state === 'queued')) {
          const page = await this.provider.videos(
            tokens.accessToken,
            account.providerUserId,
            account.since,
            account.sinceId,
            account.pageToken ?? undefined,
          )
          for (const video of page.videos) {
            if (video.authorId !== account.providerUserId || !isXVideoUrl(video.url)) continue
            const current = await this.store.get(account.id)
            if (current?.leaseToken !== lease || current.status !== 'active') break
            const id = randomUUID()
            await this.store.reserve({
              id,
              accountId: account.id,
              wallet: account.wallet,
              provider: account.provider,
              sourceId: video.id,
              videoUrl: video.url,
              state: 'queued',
              post: {
                id: randomUUID(),
                creatorWallet: account.wallet,
                caption: video.caption,
                videoUrl: null,
                thumbnailUrl: null,
                streamUid: null,
                status: 'processing',
                createdAt: new Date().toISOString(),
                demo: false,
                tags: ['Imported from X'],
                market: null,
                source: {
                  provider: 'x',
                  accountHandle: identity.handle,
                  postId: video.id,
                  url: video.sourceUrl,
                },
              },
            })
          }
          // Persist page checkpoint only after every import reservation; duplicates are unique in SQL.
          const newest = account.pageNewestId ?? page.newestId ?? account.sinceId
          if (
            !(await this.store.save(
              account.id,
              lease,
              page.nextToken
                ? { pageToken: page.nextToken, pageNewestId: newest }
                : { pageToken: null, pageNewestId: null, sinceId: newest },
            ))
          )
            continue
          jobs = await this.store.jobs(account.id)
        }
        for (const job of jobs.filter((row) => row.state === 'submitting'))
          await this.store.finish(job.id, 'needs_review')
        for (const job of jobs.filter((row) => row.state === 'queued').slice(0, 10)) {
          const current = await this.store.get(account.id)
          if (current?.leaseToken !== lease || current.status !== 'active') break
          if (!(await this.store.markSubmitting(job.id))) continue
          // Persist submitting BEFORE the non-idempotent external request. Ambiguous responses never retry the copy.
          try {
            const result = await this.media.copyVideo!({
              postId: job.post.id,
              wallet: job.wallet,
              importId: job.id,
              url: job.videoUrl,
            })
            await this.store.bind(job.id, result.uid)
          } catch {
            failed++
            await this.store.finish(job.id, 'needs_review')
            await this.store.save(account.id, lease, {
              lastError:
                'An import needs review after an uncertain video-processing response. It will not be duplicated.',
            })
          }
        }
        await this.store.save(account.id, lease, { nextPollAt: Date.now() + 5 * 60_000 })
      } catch (error) {
        failed++
        await this.store.save(account.id, lease, {
          status:
            error instanceof ApiError && error.code === 'X_REAUTH_REQUIRED'
              ? 'reauthorization_required'
              : 'active',
          lastError:
            error instanceof ApiError
              ? error.message
              : 'Importing is temporarily unavailable. It will retry later.',
          nextPollAt: Date.now() + 15 * 60_000,
        })
      } finally {
        await this.store.release(account.id, lease)
      }
    }
    return { checked, failed }
  }
  // Called only after the existing Cloudflare signature check. It can recover a lost copy response.
  async webhook(input: Record<string, unknown>, uid: string): Promise<boolean> {
    const meta = input.meta as Record<string, unknown> | undefined
    const referenced =
      meta && typeof meta.importId === 'string' ? await this.store.getJob(meta.importId) : null
    const job = referenced ?? (await this.store.jobByStream(uid))
    if (!job) return false
    // Known imports must never fall through to the generic publisher without duration checks.
    if (!meta || meta.importId !== job.id || meta.postId !== job.post.id || meta.creator !== job.wallet)
      return true
    if (!(await this.store.bind(job.id, uid))) return true
    const status = input.status as { state?: string } | undefined
    if (status?.state === 'ready' && input.readyToStream === true) {
      const valid = typeof input.duration === 'number' && input.duration > 0 && input.duration <= 60
      await this.repository.updateStream(
        uid,
        valid ? 'ready' : 'failed',
        valid ? `https://videodelivery.net/${uid}/manifest/video.m3u8` : null,
        valid ? `https://videodelivery.net/${uid}/thumbnails/thumbnail.jpg` : null,
      )
      await this.store.finish(job.id, valid ? 'ready' : 'failed')
    } else if (status?.state === 'error') {
      await this.repository.updateStream(uid, 'failed', null, null)
      await this.store.finish(job.id, 'failed')
    }
    return true
  }
}
