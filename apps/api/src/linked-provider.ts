import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { ApiError } from './domain.js'

export const X_SCOPES = ['tweet.read', 'users.read', 'offline.access']
export interface ProviderTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
}
export interface ProviderIdentity {
  id: string
  handle: string
  displayName: string
  protected: boolean
}
export interface ImportVideo {
  id: string
  authorId: string
  caption: string
  url: string
  createdAt: string
  sourceUrl: string
}
export interface VideoPage {
  videos: ImportVideo[]
  nextToken?: string
  newestId?: string
}
export interface LinkedProvider {
  authorizationUrl(state: string, challenge: string): string
  exchange(code: string, verifier: string): Promise<ProviderTokens>
  refresh(token: string): Promise<ProviderTokens>
  identity(token: string): Promise<ProviderIdentity>
  videos(token: string, userId: string, since: string, sinceId?: string, page?: string): Promise<VideoPage>
}

// AEAD binds ciphertext to its wallet/account or OAuth purpose; swapping rows fails authentication.
export class TokenVault {
  private key: Buffer
  constructor(encoded: string) {
    this.key = Buffer.from(encoded, 'base64')
    if (this.key.length !== 32 || this.key.toString('base64') !== encoded)
      throw new Error('LINKED_ACCOUNTS_ENCRYPTION_KEY must be a base64 32-byte key.')
  }
  seal(value: unknown, context: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(context))
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.')
  }
  open<T>(value: string, context: string): T {
    const [version, iv, tag, encrypted] = value.split('.')
    if (version !== 'v1' || !iv || !tag || !encrypted) throw new Error('Invalid encrypted token envelope.')
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'))
    decipher.setAAD(Buffer.from(context))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    return JSON.parse(
      Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString(
        'utf8',
      ),
    ) as T
  }
}
export function isXVideoUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.hostname === 'video.twimg.com' &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      url.pathname.endsWith('.mp4')
    )
  } catch {
    return false
  }
}
export class XProvider implements LinkedProvider {
  constructor(
    private clientId: string,
    private clientSecret: string,
    private redirectUri: string,
    private request: typeof fetch = fetch,
  ) {}
  authorizationUrl(state: string, challenge: string) {
    const url = new URL('https://x.com/i/oauth2/authorize')
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: X_SCOPES.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString()
    return url.toString()
  }
  private async json(url: string, init: RequestInit = {}) {
    const response = await this.request(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) {
      if (response.status === 401 || response.status === 400)
        throw new ApiError(409, 'X_REAUTH_REQUIRED', 'Reconnect this X account to continue importing.')
      throw new ApiError(
        503,
        'X_UNAVAILABLE',
        response.status === 429
          ? 'X rate limit reached. Importing will retry later.'
          : 'X is unavailable or this app lacks API access. Importing will retry later.',
      )
    }
    return (await response.json()) as Record<string, any>
  }
  private async tokens(fields: Record<string, string>): Promise<ProviderTokens> {
    const data = await this.json('https://api.x.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(fields).toString(),
    })
    if (
      typeof data.access_token !== 'string' ||
      typeof data.refresh_token !== 'string' ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0 ||
      data.token_type?.toLowerCase() !== 'bearer' ||
      !X_SCOPES.every((scope) => String(data.scope).split(' ').includes(scope))
    )
      throw new ApiError(
        502,
        'X_SCOPE_MISSING',
        'X did not grant the read and refresh permissions required for importing.',
      )
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    }
  }
  exchange(code: string, verifier: string) {
    return this.tokens({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      code_verifier: verifier,
    })
  }
  refresh(token: string) {
    return this.tokens({ grant_type: 'refresh_token', refresh_token: token })
  }
  async identity(token: string): Promise<ProviderIdentity> {
    const { data } = await this.json('https://api.x.com/2/users/me?user.fields=protected', {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (
      !data ||
      !/^\d+$/.test(data.id) ||
      typeof data.username !== 'string' ||
      typeof data.protected !== 'boolean'
    )
      throw new ApiError(502, 'X_IDENTITY_INVALID', 'X account ownership could not be verified.')
    return {
      id: data.id,
      handle: data.username,
      displayName: String(data.name ?? data.username).slice(0, 80),
      protected: data.protected,
    }
  }
  async videos(
    token: string,
    userId: string,
    since: string,
    sinceId?: string,
    page?: string,
  ): Promise<VideoPage> {
    if (!/^\d+$/.test(userId)) throw new Error('Invalid X user ID.')
    const url = new URL(`https://api.x.com/2/users/${userId}/tweets`)
    url.search = new URLSearchParams({
      max_results: '100',
      exclude: 'retweets,replies',
      'tweet.fields': 'author_id,created_at,referenced_tweets,attachments',
      expansions: 'attachments.media_keys',
      'media.fields': 'type,duration_ms,variants',
      ...(sinceId ? { since_id: sinceId } : { start_time: since }),
      ...(page ? { pagination_token: page } : {}),
    }).toString()
    const data = await this.json(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
    if (data.errors?.length)
      throw new ApiError(
        503,
        'X_PARTIAL_RESPONSE',
        'X returned incomplete posts. Importing will retry later.',
      )
    const videos: ImportVideo[] = []
    for (const post of data.data ?? []) {
      if (
        post.author_id !== userId ||
        post.referenced_tweets?.length ||
        !/^\d+$/.test(post.id) ||
        !Number.isFinite(Date.parse(post.created_at)) ||
        Date.parse(post.created_at) < Date.parse(since)
      )
        continue
      // Only a single original, owned, public video up to Clout's 60-second limit.
      const keys = post.attachments?.media_keys ?? []
      if (keys.length !== 1 || post.attachments?.media_source_tweet_id?.length) continue
      const media = (data.includes?.media ?? []).find((item: any) => item.media_key === keys[0])
      if (
        media?.type !== 'video' ||
        !Number.isFinite(media.duration_ms) ||
        media.duration_ms <= 0 ||
        media.duration_ms > 60000
      )
        continue
      const variant = (media.variants ?? [])
        .filter(
          (item: any) =>
            item.content_type === 'video/mp4' && typeof item.url === 'string' && isXVideoUrl(item.url),
        )
        .sort((a: any, b: any) => (b.bit_rate ?? 0) - (a.bit_rate ?? 0))[0]
      if (!variant) continue
      videos.push({
        id: post.id,
        authorId: userId,
        caption: String(post.text ?? '').slice(0, 280) || 'Imported from X',
        url: variant.url,
        createdAt: post.created_at,
        sourceUrl: `https://x.com/i/status/${post.id}`,
      })
    }
    return { videos, nextToken: data.meta?.next_token, newestId: data.meta?.newest_id }
  }
}
