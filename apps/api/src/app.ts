import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import {
  MarketError,
  type MarketService,
  type TradeQuote,
  type TransactionEnvelope,
  type BuiltTrade,
  type BuiltTip,
} from '@clout/markets'
import { Connection, PublicKey } from '@solana/web3.js'
import { AuthService, walletAddress } from './auth.js'
import { ApiError, newProfile, type Post, type Repository, type TransactionIntent } from './domain.js'
import { type MediaService, verifyStreamWebhook } from './media.js'
import type { SeekerVerifier } from './seeker.js'
import { reconcileIntent } from './transactions.js'
import type { IdentityResolver } from './identity.js'
import { publicClaim, type RewardService } from './rewards.js'
import { linkedUnavailable, type LinkedAccountService } from './linked-accounts.js'
import { unavailableFaucet, type FaucetService } from './faucet.js'
import { handleSampleMedia } from './sample-media.js'

export interface AppOptions {
  repository: Repository
  origin: string
  mode: 'demo' | 'connected'
  allowedOrigins?: string[]
  media?: MediaService
  webhookSecret?: string
  seeker?: SeekerVerifier
  identity?: IdentityResolver
  markets?: MarketService
  chain?: Connection
  quoteMint?: string
  rewards?: RewardService
  quoteDecimals?: number
  linkedAccounts?: LinkedAccountService
  faucet?: FaucetService
}
const text = (value: unknown, name: string, max = 280): string => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    throw new ApiError(400, 'INVALID_INPUT', `${name} must contain 1–${max} characters.`)
  return value.trim()
}
const toRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(400, 'INVALID_BODY', 'A JSON object is required.')
  return value as Record<string, unknown>
}
async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > 64 * 1024) throw new ApiError(413, 'BODY_TOO_LARGE', 'Request is too large.')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}
class RateLimiter {
  private rows = new Map<string, { count: number; expires: number }>()
  check(key: string, limit: number) {
    const now = Date.now()
    if (this.rows.size > 10000) for (const [id, row] of this.rows) if (row.expires < now) this.rows.delete(id)
    const prior = this.rows.get(key)
    const row = prior && prior.expires > now ? prior : { count: 0, expires: now + 60_000 }
    if (++row.count > limit) throw new ApiError(429, 'RATE_LIMIT', 'Please wait a moment and try again.')
    if (this.rows.size >= 20000 && !this.rows.has(key))
      throw new ApiError(429, 'RATE_LIMIT', 'Please try again shortly.')
    this.rows.set(key, row)
  }
}

export function createApp(options: AppOptions) {
  const { repository } = options
  const auth = new AuthService(repository, options.origin)
  const limiter = new RateLimiter()
  const marketService = () => {
    if (!options.markets)
      throw new ApiError(503, 'MARKETS_UNAVAILABLE', 'Test SKR markets are not configured yet.')
    return options.markets
  }
  const requirePost = async (id: string) => {
    const post = await repository.getPost(id)
    if (!post || post.status !== 'ready') throw new ApiError(404, 'POST_NOT_FOUND', 'Post not found.')
    return post
  }
  const reference = (post: Post) => {
    if (!post.market) throw new ApiError(409, 'NO_MARKET', 'This post has no active market.')
    return { postId: post.id, ...post.market }
  }
  const presentPost = async (post: Post, wallet?: string) => ({
    ...post,
    videoUrl: post.videoUrl?.startsWith('/v1/samples/media/')
      ? new URL(post.videoUrl, options.origin).toString()
      : post.videoUrl,
    thumbnailUrl: post.thumbnailUrl?.startsWith('/v1/samples/media/')
      ? new URL(post.thumbnailUrl, options.origin).toString()
      : post.thumbnailUrl,
    creator: await repository.getProfile(post.creatorWallet),
    likes: await repository.likes(post.id, wallet),
    commentCount: (await repository.listComments(post.id)).length,
  })
  const saveIntent = async (
    envelope: TransactionEnvelope,
    kind: TransactionIntent['kind'],
    postId: string,
    requestedId?: string,
  ): Promise<Record<string, unknown> & { intentId: string }> => {
    const id = requestedId ?? (kind === 'trade' ? (envelope as BuiltTrade).quoteId : randomUUID())
    const intent: TransactionIntent = {
      id,
      wallet: envelope.owner,
      kind,
      postId,
      envelope: envelope as unknown as Record<string, unknown>,
      signature: null,
      state: 'prepared',
      createdAt: new Date().toISOString(),
    }
    await repository.putIntent(intent)
    const stored =
      kind === 'launch' ? await repository.getActiveLaunch(postId) : await repository.getIntent(id)
    if (!stored || stored.wallet !== envelope.owner)
      throw new ApiError(409, 'INTENT_CONFLICT', 'Transaction request conflicts with an existing request.')
    return { ...stored.envelope, intentId: stored.id }
  }

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Referrer-Policy', 'no-referrer')
    const origin = request.headers.origin
    const origins = options.allowedOrigins ?? [options.origin]
    if (origin && origins.includes(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin)
      response.setHeader('Vary', 'Origin')
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range')
      response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PATCH, DELETE, OPTIONS')
    }
    const send = (status: number, data: unknown) => {
      response.statusCode = status
      response.end(JSON.stringify(data))
    }
    try {
      if (origin && !origins.includes(origin))
        throw new ApiError(403, 'ORIGIN_NOT_ALLOWED', 'Origin is not allowed.')
      if (request.method === 'OPTIONS') {
        response.statusCode = 204
        response.end()
        return
      }
      const url = new URL(request.url ?? '/', options.origin)
      const route = url.pathname
      const method = request.method ?? 'GET'
      const key = request.socket.remoteAddress ?? 'unknown'
      limiter.check(key, 180)
      if (await handleSampleMedia(request, response)) return
      if (route.startsWith('/v1/auth/')) limiter.check(`auth:${key}`, 20)
      const session = await auth.session(request.headers.authorization)
      const requireWallet = () => {
        if (!session) throw new ApiError(401, 'AUTH_REQUIRED', 'Connect your wallet to continue.')
        limiter.check(`write:${session.wallet}`, 60)
        return session.wallet
      }
      let raw: Buffer | undefined
      let parsed: Record<string, unknown> | undefined
      const body = async () => {
        if (parsed) return parsed
        if (!(request.headers['content-type'] ?? '').startsWith('application/json'))
          throw new ApiError(415, 'JSON_REQUIRED', 'Use application/json.')
        raw ??= await readBody(request)
        try {
          parsed = toRecord(JSON.parse(raw.toString('utf8')))
        } catch (error) {
          if (error instanceof ApiError) throw error
          throw new ApiError(400, 'INVALID_JSON', 'Invalid JSON body.')
        }
        return parsed
      }

      if (method === 'GET' && (route === '/health' || route === '/v1/config')) {
        send(200, {
          name: 'Clout',
          slogan: 'Seek the best content, win SKR',
          mode: options.mode,
          network: 'devnet',
          rewardSymbol: 'SKR',
          quoteTokenLabel: 'Test SKR',
          quoteMint: options.quoteMint ?? null,
          quoteDecimals: options.quoteDecimals ?? 6,
          features: {
            trading: !!options.markets,
            uploads: !!options.media,
            seekerVerification: !!options.seeker,
            rewards: !!options.rewards,
            linkedAccounts: !!options.linkedAccounts,
            faucet: !!options.faucet,
          },
        })
        return
      }
      if (method === 'POST' && route === '/v1/auth/challenge') {
        send(201, await auth.issue((await body()).address))
        return
      }
      if (method === 'POST' && route === '/v1/auth/verify') {
        const result = await auth.verify(await body())
        if (options.identity) {
          try {
            const names = await options.identity.names(result.profile.wallet)
            result.profile.handle = names[0] ?? newProfile(result.profile.wallet).handle
            await repository.saveProfile(result.profile)
          } catch {
            /* Wallet authentication remains usable when identity RPC is unavailable. */
          }
        }
        send(200, result)
        return
      }
      if (method === 'POST' && route === '/v1/auth/logout') {
        requireWallet()
        await repository.revokeSession(session!.hash)
        send(200, { ok: true })
        return
      }
      if (method === 'GET' && route === '/v1/linked-accounts') {
        const wallet = requireWallet()
        send(200, options.linkedAccounts ? await options.linkedAccounts.list(wallet) : linkedUnavailable)
        return
      }
      if (method === 'GET' && route === '/v1/faucet') {
        send(200, options.faucet ? await options.faucet.status(session?.wallet) : unavailableFaucet)
        return
      }
      if (method === 'POST' && route === '/v1/faucet/claims') {
        const wallet = requireWallet()
        limiter.check(`faucet:${wallet}`, 5)
        if (!options.faucet) throw new ApiError(503, 'FAUCET_UNAVAILABLE', unavailableFaucet.reason)
        if (Object.keys(await body()).length)
          throw new ApiError(
            400,
            'INVALID_INPUT',
            'Faucet allocation and recipient are fixed by the server and authenticated wallet.',
          )
        send(200, await options.faucet.claim(wallet))
        return
      }
      const faucetClaim = route.match(/^\/v1\/faucet\/claims\/([a-f0-9-]{36})$/)
      if (method === 'GET' && faucetClaim) {
        const wallet = requireWallet()
        if (!options.faucet) throw new ApiError(503, 'FAUCET_UNAVAILABLE', unavailableFaucet.reason)
        send(200, await options.faucet.get(wallet, faucetClaim[1]))
        return
      }
      const linkConnect = route.match(/^\/v1\/linked-accounts\/(x|fomo)\/connect$/)
      if (method === 'POST' && linkConnect) {
        requireWallet()
        if (!options.linkedAccounts)
          throw new ApiError(503, 'LINKING_UNAVAILABLE', linkedUnavailable.providers.x.reason)
        const input = await body()
        const accountId = input.accountId === undefined ? undefined : text(input.accountId, 'Account ID', 64)
        send(
          200,
          await options.linkedAccounts.connect(
            session!,
            linkConnect[1],
            text(input.clientChallenge, 'Client challenge', 64),
            accountId,
          ),
        )
        return
      }
      if (method === 'GET' && route === '/v1/linked-accounts/x/start') {
        if (!options.linkedAccounts)
          throw new ApiError(503, 'LINKING_UNAVAILABLE', 'Account linking is unavailable.')
        const result = await options.linkedAccounts.begin(text(url.searchParams.get('state'), 'State', 128))
        response.setHeader(
          'Set-Cookie',
          `clout_link=${result.browserToken}; HttpOnly; SameSite=Lax; Path=/v1/linked-accounts/x/callback; Max-Age=600${options.origin.startsWith('https://') ? '; Secure' : ''}`,
        )
        response.statusCode = 302
        response.setHeader('Location', result.location)
        response.end()
        return
      }
      if (method === 'GET' && route === '/v1/linked-accounts/x/callback') {
        if (!options.linkedAccounts)
          throw new ApiError(503, 'LINKING_UNAVAILABLE', 'Account linking is unavailable.')
        const cookie = (request.headers.cookie ?? '')
          .split(';')
          .map((part) => part.trim())
          .find((part) => part.startsWith('clout_link='))
          ?.slice('clout_link='.length)
        response.setHeader(
          'Set-Cookie',
          `clout_link=; HttpOnly; SameSite=Lax; Path=/v1/linked-accounts/x/callback; Max-Age=0${options.origin.startsWith('https://') ? '; Secure' : ''}`,
        )
        if (url.searchParams.has('error'))
          throw new ApiError(
            400,
            'OAUTH_CANCELLED',
            'X connection was cancelled. Return to Clout and try again.',
          )
        const result = await options.linkedAccounts.callback(
          text(url.searchParams.get('state'), 'State', 128),
          text(cookie, 'Browser verification', 128),
          text(url.searchParams.get('code'), 'Code', 4096),
        )
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.setHeader(
          'Content-Security-Policy',
          "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        )
        response.statusCode = 302
        response.setHeader('Location', result.location)
        response.end()
        return
      }
      if (method === 'POST' && route === '/v1/linked-accounts/x/complete') {
        requireWallet()
        if (!options.linkedAccounts)
          throw new ApiError(503, 'LINKING_UNAVAILABLE', 'Account linking is unavailable.')
        const input = await body()
        send(
          200,
          await options.linkedAccounts.complete(
            session!,
            text(input.state, 'State', 128),
            text(input.completion, 'Completion', 128),
            text(input.verifier, 'Verifier', 128),
          ),
        )
        return
      }
      const linkAction = route.match(/^\/v1\/linked-accounts\/([a-f0-9-]{36})\/(pause|resume|disconnect)$/)
      if (method === 'POST' && linkAction) {
        const wallet = requireWallet()
        if (!options.linkedAccounts)
          throw new ApiError(503, 'LINKING_UNAVAILABLE', 'Account linking is unavailable.')
        await options.linkedAccounts.change(
          wallet,
          linkAction[1],
          linkAction[2] as 'pause' | 'resume' | 'disconnect',
        )
        send(200, { ok: true })
        return
      }
      if (method === 'GET' && route === '/v1/me') {
        const wallet = requireWallet()
        send(200, {
          profile: await repository.ensureProfile(wallet),
          following: await repository.following(wallet),
        })
        return
      }
      if (method === 'GET' && (route === '/v1/feed' || route === '/v1/discover')) {
        let posts = await repository.listPosts()
        if (url.searchParams.get('tab') === 'following') {
          const followed = await repository.following(requireWallet())
          posts = posts.filter((post) => followed.includes(post.creatorWallet))
        }
        const query = (url.searchParams.get('q') ?? '').trim().slice(0, 100).toLowerCase()
        if (query)
          posts = posts.filter((post) =>
            `${post.caption} ${post.tags.join(' ')}`.toLowerCase().includes(query),
          )
        send(200, {
          posts: await Promise.all(posts.map((post) => presentPost(post, session?.wallet))),
          creators: route === '/v1/discover' ? await repository.listProfiles() : undefined,
          following: session ? await repository.following(session.wallet) : [],
          mode: options.mode,
        })
        return
      }
      const postMatch = route.match(/^\/v1\/posts\/([^/]+)$/)
      if (method === 'GET' && postMatch) {
        send(200, await presentPost(await requirePost(postMatch[1]), session?.wallet))
        return
      }
      const profileMatch = route.match(/^\/v1\/profiles\/([^/]+)$/)
      if (method === 'GET' && profileMatch) {
        const profile = await repository.getProfile(profileMatch[1])
        if (!profile) throw new ApiError(404, 'PROFILE_NOT_FOUND', 'Profile not found.')
        send(200, {
          profile,
          posts: await Promise.all(
            (session?.wallet === profile.wallet
              ? await repository.listOwnPosts(profile.wallet)
              : (await repository.listPosts()).filter((post) => post.creatorWallet === profile.wallet)
            ).map((post) => presentPost(post, session?.wallet)),
          ),
        })
        return
      }
      if (method === 'PATCH' && route === '/v1/me') {
        const wallet = requireWallet()
        const input = await body()
        const profile = await repository.ensureProfile(wallet)
        if ('displayName' in input) profile.displayName = text(input.displayName, 'Display name', 40)
        if ('bio' in input) {
          if (typeof input.bio !== 'string' || input.bio.length > 160)
            throw new ApiError(400, 'INVALID_INPUT', 'Bio must be at most 160 characters.')
          profile.bio = input.bio.trim()
        }
        // handle and Seeker verification are never user editable.
        await repository.saveProfile(profile)
        send(200, { profile })
        return
      }
      const commentsMatch = route.match(/^\/v1\/posts\/([^/]+)\/comments$/)
      if (commentsMatch && (method === 'GET' || method === 'POST')) {
        const post = await requirePost(commentsMatch[1])
        if (method === 'POST') {
          const wallet = requireWallet()
          await repository.addComment({
            id: randomUUID(),
            postId: post.id,
            wallet,
            body: text((await body()).body, 'Comment', 500),
            createdAt: new Date().toISOString(),
          })
        }
        const comments = await repository.listComments(post.id)
        send(method === 'POST' ? 201 : 200, {
          comments: await Promise.all(
            comments.map(async (comment) => ({
              ...comment,
              creator: await repository.getProfile(comment.wallet),
              earlyBacker: (await repository.getEvents(comment.wallet)).some(
                (event) => event.postId === post.id && event.kind === 'buy' && event.finality === 'finalized',
              ),
            })),
          ),
        })
        return
      }
      const likesMatch = route.match(/^\/v1\/posts\/([^/]+)\/likes$/)
      if (likesMatch && (method === 'POST' || method === 'DELETE')) {
        const wallet = requireWallet()
        const post = await requirePost(likesMatch[1])
        await repository.setLike(post.id, wallet, method === 'POST')
        send(200, await repository.likes(post.id, wallet))
        return
      }
      const followsMatch = route.match(/^\/v1\/profiles\/([^/]+)\/follow$/)
      if (followsMatch && (method === 'POST' || method === 'DELETE')) {
        const wallet = requireWallet()
        const target = followsMatch[1]
        if (wallet === target || !(await repository.getProfile(target)))
          throw new ApiError(400, 'INVALID_FOLLOW', 'Choose another creator to follow.')
        await repository.setFollow(wallet, target, method === 'POST')
        send(200, { following: method === 'POST' })
        return
      }
      if (method === 'POST' && route === '/v1/uploads') {
        const wallet = requireWallet()
        if (!options.media)
          throw new ApiError(503, 'UPLOADS_UNAVAILABLE', 'Video uploads are not configured yet.')
        const input = await body()
        const caption = text(input.caption, 'Caption', 280)
        const id = randomUUID()
        const upload = await options.media.issueUpload({ postId: id, wallet })
        const post: Post = {
          id,
          creatorWallet: wallet,
          caption,
          tags: [],
          videoUrl: null,
          thumbnailUrl: null,
          streamUid: upload.uid,
          status: 'processing',
          createdAt: new Date().toISOString(),
          demo: false,
          market: null,
        }
        await repository.insertPost(post)
        send(201, { post, postId: post.id, uploadUrl: upload.uploadUrl })
        return
      }
      if (method === 'POST' && route === '/v1/webhooks/stream') {
        if (!options.webhookSecret)
          throw new ApiError(503, 'WEBHOOK_UNAVAILABLE', 'Video processing is not configured.')
        raw = await readBody(request)
        const signature = request.headers['webhook-signature']
        if (
          !verifyStreamWebhook(
            raw,
            typeof signature === 'string' ? signature : undefined,
            options.webhookSecret,
          )
        )
          throw new ApiError(401, 'INVALID_WEBHOOK', 'Webhook signature is invalid.')
        const input = toRecord(JSON.parse(raw.toString('utf8')))
        const uid = text(input.uid, 'Stream UID', 64)
        if (!/^[a-f0-9]{32}$/.test(uid)) throw new ApiError(400, 'INVALID_INPUT', 'Invalid Stream UID.')
        if (await options.linkedAccounts?.webhook(input, uid)) {
          send(200, { ok: true })
          return
        }
        const state = toRecord(input.status).state
        if (state === 'ready' && input.readyToStream === true)
          await repository.updateStream(
            uid,
            'ready',
            `https://videodelivery.net/${uid}/manifest/video.m3u8`,
            `https://videodelivery.net/${uid}/thumbnails/thumbnail.jpg`,
          )
        else if (state === 'error') await repository.updateStream(uid, 'failed', null, null)
        send(200, { ok: true })
        return
      }
      if (method === 'POST' && route === '/v1/eligibility') {
        const wallet = requireWallet()
        if (!options.seeker)
          throw new ApiError(503, 'VERIFICATION_UNAVAILABLE', 'Seeker verification is not configured yet.')
        let eligibility
        try {
          eligibility = await options.seeker.check(wallet)
        } catch {
          throw new ApiError(
            503,
            'VERIFICATION_UNAVAILABLE',
            'Seeker verification is temporarily unavailable.',
          )
        }
        const profile = await repository.ensureProfile(wallet)
        profile.seekerVerified = eligibility.hasSGT
        await repository.saveProfile(profile)
        send(200, eligibility)
        return
      }
      if (method === 'GET' && route === '/v1/rewards/campaign') {
        send(
          200,
          options.rewards
            ? await options.rewards.status(session?.wallet)
            : { available: false, campaign: null, reason: 'A funded Test SKR campaign is not configured.' },
        )
        return
      }
      if (method === 'POST' && route === '/v1/claims') {
        const wallet = requireWallet()
        if (!options.rewards)
          throw new ApiError(
            503,
            'REWARDS_UNAVAILABLE',
            'SKR rewards will open when a funded campaign is available.',
          )
        const input = await body()
        if (input.campaignId !== undefined && input.campaignId !== options.rewards.campaign.id)
          throw new ApiError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found.')
        send(200, await options.rewards.claim(wallet))
        return
      }
      const claimMatch = route.match(/^\/v1\/claims\/([^/]+)$/)
      if (method === 'GET' && claimMatch) {
        const wallet = requireWallet()
        const claim = await repository.getClaim(claimMatch[1])
        if (!claim || claim.wallet !== wallet) throw new ApiError(404, 'CLAIM_NOT_FOUND', 'Claim not found.')
        send(200, publicClaim(claim))
        return
      }
      const activityMatch = route.match(/^\/v1\/posts\/([^/]+)\/activity$/)
      if (method === 'GET' && activityMatch) {
        const post = await requirePost(activityMatch[1])
        const events = (await repository.getPostEvents(post.id)).map(
          ({ signature, slot, kind, baseAmount, quoteAmount, finality }) => ({
            signature,
            slot,
            kind,
            baseAmount,
            quoteAmount,
            finality,
          }),
        )
        send(200, {
          events,
          baseDecimals: 6,
          quoteDecimals: options.quoteDecimals ?? 6,
          source: 'clout-transactions',
        })
        return
      }
      const quoteMatch = route.match(/^\/v1\/posts\/([^/]+)\/quote$/)
      if (method === 'POST' && quoteMatch) {
        const wallet = requireWallet()
        const post = await requirePost(quoteMatch[1])
        const input = await body()
        if (input.side !== 'buy' && input.side !== 'sell')
          throw new ApiError(400, 'INVALID_SIDE', 'Choose buy or sell.')
        if (!Number.isInteger(input.slippageBps))
          throw new ApiError(400, 'INVALID_SLIPPAGE', 'Slippage must be integer basis points.')
        send(
          200,
          await marketService().quote({
            market: reference(post),
            owner: wallet,
            side: input.side,
            amountIn: text(input.amountIn, 'Amount', 30),
            slippageBps: input.slippageBps as number,
          }),
        )
        return
      }
      if (method === 'POST' && route === '/v1/trades/build') {
        const wallet = requireWallet()
        const input = await body()
        const quoteId = text(input.quoteId, 'Quote ID', 64)
        const previous = await repository.getIntent(quoteId)
        if (previous) {
          if (previous.wallet !== wallet || previous.kind !== 'trade')
            throw new ApiError(403, 'WRONG_OWNER', 'Quote belongs to another wallet or request.')
          if (['confirmed', 'finalized', 'failed', 'expired'].includes(previous.state))
            throw new ApiError(409, 'INTENT_COMPLETE', 'Request a new quote for a new trade.')
          send(200, { ...previous.envelope, intentId: previous.id })
          return
        }
        const built = await marketService().buildTrade({ quoteId, owner: wallet })
        send(201, await saveIntent(built, 'trade', built.quote.market.postId))
        return
      }
      if (method === 'POST' && route === '/v1/tips/build') {
        const wallet = requireWallet()
        const input = await body()
        const recipient = walletAddress(input.recipient)
        const amountIn = text(input.amountIn, 'Amount', 30)
        const requestId = text(input.requestId, 'Request ID', 64)
        if (!/^[a-f0-9-]{36}$/i.test(requestId))
          throw new ApiError(400, 'INVALID_REQUEST_ID', 'Provide a fresh UUID for each tip.')
        const hash = createHash('sha256').update(`tip:${wallet}:${requestId}`).digest('hex')
        const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
        const previous = await repository.getIntent(id)
        if (previous) {
          const tip = previous.envelope as unknown as BuiltTip
          if (tip.recipient !== recipient || tip.amountIn !== amountIn)
            throw new ApiError(
              409,
              'IDEMPOTENCY_CONFLICT',
              'This tip request already uses different details.',
            )
          if (['confirmed', 'finalized', 'failed', 'expired'].includes(previous.state))
            throw new ApiError(409, 'INTENT_COMPLETE', 'Use a new request ID for another tip.')
          send(200, { ...previous.envelope, intentId: previous.id })
          return
        }
        const built = await marketService().buildTip({ owner: wallet, recipient, amountIn })
        const saved = await saveIntent(built, 'tip', '', id)
        if (saved.recipient !== recipient || saved.amountIn !== amountIn)
          throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This tip request already uses different details.')
        send(201, saved)
        return
      }
      const launchMatch = route.match(/^\/v1\/posts\/([^/]+)\/launch$/)
      if (method === 'POST' && launchMatch) {
        const wallet = requireWallet()
        const post = await requirePost(launchMatch[1])
        const input = await body()
        if (post.creatorWallet !== wallet)
          throw new ApiError(403, 'NOT_CREATOR', 'Only the creator can launch this market.')
        if (post.market) throw new ApiError(409, 'MARKET_EXISTS', 'This post already has a market.')
        const name = text(input.name, 'Market name', 32)
        const symbol = text(input.symbol, 'Market symbol', 10)
        const previous = await repository.getActiveLaunch(post.id)
        if (previous) {
          if (previous.envelope.metadataName !== name || previous.envelope.metadataSymbol !== symbol)
            throw new ApiError(
              409,
              'LAUNCH_CONFLICT',
              'A launch is already prepared with another name or ticker. Finish it or wait for its transaction to expire.',
            )
          send(200, { ...previous.envelope, intentId: previous.id })
          return
        }
        const metadataUri = `${options.origin}/v1/posts/${encodeURIComponent(post.id)}/metadata`
        const built = await marketService().buildLaunch({
          postId: post.id,
          creator: wallet,
          name,
          symbol,
          metadataUri,
        })
        const withMetadata = { ...built, metadataName: name, metadataSymbol: symbol }
        const saved = await saveIntent(withMetadata, 'launch', post.id)
        if (saved.metadataName !== name || saved.metadataSymbol !== symbol)
          throw new ApiError(
            409,
            'LAUNCH_CONFLICT',
            'A launch is already prepared with another name or ticker. Finish it or wait for its transaction to expire.',
          )
        send(201, saved)
        return
      }
      const metadataMatch = route.match(/^\/v1\/posts\/([^/]+)\/metadata$/)
      if (method === 'GET' && metadataMatch) {
        const post = await requirePost(metadataMatch[1])
        const launch = await repository.getActiveLaunch(post.id)
        send(200, {
          name: launch?.envelope.metadataName ?? post.caption.slice(0, 32),
          symbol: launch?.envelope.metadataSymbol ?? 'CLOUTPOST',
          description: post.caption,
          image: post.thumbnailUrl,
          animation_url: post.videoUrl,
          external_url: `${options.origin}/v1/posts/${encodeURIComponent(post.id)}`,
          attributes: [{ trait_type: 'Creator', value: post.creatorWallet }],
        })
        return
      }
      const feeMatch = route.match(/^\/v1\/posts\/([^/]+)\/fees\/build$/)
      if (method === 'POST' && feeMatch) {
        const wallet = requireWallet()
        const post = await requirePost(feeMatch[1])
        if (post.creatorWallet !== wallet)
          throw new ApiError(403, 'NOT_CREATOR', 'Only the creator can claim these fees.')
        const transactions = await marketService().buildClaim({ market: reference(post), creator: wallet })
        send(201, {
          transactions: await Promise.all(
            transactions.map((transaction) => saveIntent(transaction, 'fee-claim', post.id)),
          ),
        })
        return
      }
      const confirmMatch = route.match(/^\/v1\/transactions\/([^/]+)\/confirm$/)
      if (method === 'POST' && confirmMatch) {
        const wallet = requireWallet()
        const input = await body()
        const intent = await repository.getIntent(confirmMatch[1])
        if (!intent || intent.wallet !== wallet)
          throw new ApiError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found.')
        const signature = text(input.signature, 'Signature', 88)
        if (!/^[1-9A-HJ-NP-Za-km-z]{80,88}$/.test(signature))
          throw new ApiError(400, 'INVALID_SIGNATURE', 'Invalid transaction signature.')
        if (intent.signature && intent.signature !== signature)
          throw new ApiError(409, 'SIGNATURE_MISMATCH', 'This request already tracks another signature.')
        const result = await reconcileIntent(repository, marketService(), intent, signature, options.chain)
        send(200, result)
        return
      }
      const transactionMatch = route.match(/^\/v1\/transactions\/([^/]+)$/)
      if (method === 'GET' && transactionMatch) {
        const wallet = requireWallet()
        const intent = await repository.getIntent(transactionMatch[1])
        if (!intent || intent.wallet !== wallet)
          throw new ApiError(404, 'TRANSACTION_NOT_FOUND', 'Transaction not found.')
        send(200, {
          intentId: intent.id,
          kind: intent.kind,
          state: intent.state,
          signature: intent.signature,
          transaction: intent.envelope,
        })
        return
      }
      if (method === 'GET' && route === '/v1/portfolio') {
        const wallet = requireWallet()
        const events = await repository.getEvents(wallet)
        if (!options.chain || !options.quoteMint) {
          send(200, { events, positions: [], valuationAvailable: false, balance: null, network: 'devnet' })
          return
        }
        if ((await options.chain.getGenesisHash()) !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')
          throw new ApiError(503, 'WRONG_NETWORK', 'The configured market RPC is not devnet.')
        const owner = new PublicKey(wallet)
        const [accounts, gas] = await Promise.all([
          options.chain.getParsedTokenAccountsByOwner(owner, {
            programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
          }),
          options.chain.getBalance(owner, 'confirmed'),
        ])
        const amounts = new Map<string, bigint>()
        for (const entry of accounts.value) {
          const info = entry.account.data.parsed.info
          amounts.set(info.mint, (amounts.get(info.mint) ?? 0n) + BigInt(info.tokenAmount.amount))
        }
        const positions = await Promise.all(
          (await repository.listPosts())
            .filter((post) => post.market && (amounts.get(post.market.baseMint) ?? 0n) > 0n)
            .map(async (post) => {
              const amount = amounts.get(post.market!.baseMint)!.toString()
              let sellQuote: TradeQuote | null = null
              try {
                sellQuote = await marketService().quote({
                  market: reference(post),
                  owner: wallet,
                  side: 'sell',
                  amountIn: amount,
                  slippageBps: 100,
                })
              } catch {
                /* An unquotable holding is still a holding. */
              }
              return {
                post,
                amount,
                sellQuote,
                earlyBacker: events.some(
                  (event) =>
                    event.postId === post.id && event.kind === 'buy' && event.finality === 'finalized',
                ),
              }
            }),
        )
        send(200, {
          events,
          positions,
          valuationAvailable: positions.every((position) => !!position.sellQuote),
          balance: {
            amount: (amounts.get(options.quoteMint) ?? 0n).toString(),
            decimals: options.quoteDecimals ?? 6,
            symbol: 'Test SKR',
            mint: options.quoteMint,
          },
          gasLamports: String(gas),
          network: 'devnet',
        })
        return
      }
      throw new ApiError(404, 'NOT_FOUND', 'Route not found.')
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 429) response.setHeader('Retry-After', '60')
        send(error.status, { error: { code: error.code, message: error.message } })
      } else if (error instanceof MarketError)
        send(400, { error: { code: error.code, message: error.message } })
      else {
        console.error('API request failed', { name: error instanceof Error ? error.name : 'UnknownError' })
        send(500, { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } })
      }
    }
  })
  server.requestTimeout = 30000
  server.headersTimeout = 10000
  return { server, auth }
}
